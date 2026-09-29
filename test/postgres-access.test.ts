// `insta postgres private-access` / `public-access` (instacloud#189). Pins the platform calls each
// mode makes, that closing previews the impact and asks first (and that a non-interactive caller
// must pass --yes), and that the platform's coded refusals read as CLI instructions.
import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ request: vi.fn(), rawRequest: vi.fn(), load: vi.fn() }))
vi.mock('../src/api.js', async (original) => ({
  ...await original<typeof import('../src/api.js')>(),
  ApiClient: { load: fake.load },
  requireProject: async () => ({ projectId: 'p1', branch: 'main' }),
}))
vi.mock('../src/util.js', async (original) => ({
  ...await original<typeof import('../src/util.js')>(),
  info: vi.fn(),
  printJson: vi.fn(),
  refuse: vi.fn((lines: string[]) => { throw Object.assign(new Error('refused'), { lines }) }),
}))
import { ApiError } from '../src/api.js'
import { info, printJson, refuse } from '../src/util.js'
import {
  accessErrorMessage, dbAccessLines, dbPrivateAccess, dbPublicAccess, impactLines, privateAccessSetLines, publicAccessSetLines,
} from '../src/commands/postgres.js'

const IMPACT = {
  warnings: [
    'compute/api reads DATABASE_URL from DATABASE_URL, the public connection string — rebind it to DATABASE_PRIVATE_URL and redeploy, or it will lose its database connection.',
    'External clients, CI and local development will no longer be able to connect: the database will not be reachable from the internet.',
  ],
  services: [{ name: 'api', provider: 'insta-compute', envName: 'DATABASE_URL', sourceName: 'DATABASE_URL', reason: 'bound-to-public-url' }],
}
const NOTICE = 'the change takes effect on the database proxy within about 30 seconds; connections opened before then may still use the previous setting'
const printed = () => vi.mocked(info).mock.calls.map((c) => c[0]).join('\n')

beforeEach(() => {
  vi.mocked(info).mockClear(); vi.mocked(printJson).mockClear(); vi.mocked(refuse).mockClear()
  fake.request.mockReset(); fake.rawRequest.mockReset(); fake.load.mockReset().mockResolvedValue(fake)
  fake.request.mockImplementation(async (_m: string, path: string) => {
    if (path.startsWith('/projects/p1/services?')) return { services: [{ id: 's1', type: 'postgres', name: 'db' }, { id: 's2', type: 'compute', name: 'api' }] }
    if (path.includes('/access/impact')) return IMPACT
    throw new Error(`unexpected ${path}`)
  })
  fake.rawRequest.mockResolvedValue({ status: 200, body: { service: { id: 's1', public: false }, impact: IMPACT, notice: NOTICE } })
})

describe('postgres public-access off', () => {
  it('previews the impact, asks, and closes on yes', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    await dbPublicAccess('off', undefined, {}, { tty: true, confirm })
    expect(fake.request).toHaveBeenCalledWith('GET', '/projects/p1/services/s1/access/impact?public=false')
    expect(confirm).toHaveBeenCalledOnce()
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/access', { public: false })
    expect(printed()).toContain('rebind it to DATABASE_PRIVATE_URL')
    expect(printed()).toContain('public access CLOSED — not reachable from the internet')
    expect(printed()).toContain('within about 30 seconds')
  })

  it('changes nothing when the human declines', async () => {
    await dbPublicAccess('off', 'db', {}, { tty: true, confirm: async () => false })
    expect(fake.rawRequest).not.toHaveBeenCalled()
    expect(printed()).toContain('public access unchanged')
  })

  it('refuses without --yes when nobody can answer, naming the impact', async () => {
    await expect(dbPublicAccess('off', undefined, {}, { tty: false, confirm: vi.fn() })).rejects.toThrow('refused')
    expect(fake.rawRequest).not.toHaveBeenCalled()
    const lines = vi.mocked(refuse).mock.calls[0]![0]
    expect(lines.join('\n')).toContain('External clients, CI and local development')
    expect(lines.join('\n')).toContain('--yes')
  })

  it('refuses under --json without --yes even on a terminal', async () => {
    await expect(dbPublicAccess('off', undefined, { json: true }, { tty: true, confirm: vi.fn() })).rejects.toThrow('refused')
    expect(fake.rawRequest).not.toHaveBeenCalled()
  })

  it('--yes still prints the preview, then closes without asking', async () => {
    const confirm = vi.fn()
    await dbPublicAccess('off', undefined, { yes: true }, { tty: false, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(fake.request).toHaveBeenCalledWith('GET', '/projects/p1/services/s1/access/impact?public=false')
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/access', { public: false })
    expect(printed()).toContain('closing public access will break:')
  })

  it('--json --yes prints the platform body (impact + notice) and nothing else', async () => {
    await dbPublicAccess('off', undefined, { yes: true, json: true }, { tty: false })
    expect(info).not.toHaveBeenCalled()
    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({ impact: IMPACT, notice: NOTICE }))
  })

  it('scopes the service lookup to --branch', async () => {
    await dbPublicAccess('off', undefined, { yes: true, branch: 'feat' }, { tty: false })
    expect(fake.request).toHaveBeenCalledWith('GET', '/projects/p1/services?branch=feat')
  })

  it('stops at an approval gate', async () => {
    fake.rawRequest.mockResolvedValueOnce({ status: 202, body: { status: 'approval_required', action: 'service.setAccess', approvalId: 'a1' } })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await dbPublicAccess('off', undefined, { yes: true }, { tty: false })
    stderr.mockRestore()
    expect(printed()).not.toContain('CLOSED')
    expect(process.exitCode).toBe(2)
    process.exitCode = 0
  })

  it('turns the "private access first" 400 into the CLI command to run', async () => {
    fake.rawRequest.mockRejectedValueOnce(new ApiError(400, 'turn on private network access first (PATCH /projects/{projectId}/database/settings {"privateAccess": true}) — closing public access without it would leave the database with no way to connect'))
    await expect(dbPublicAccess('off', undefined, { yes: true }, { tty: false })).rejects.toThrow('insta postgres private-access on db')
  })

  it('explains private_lane_disabled', async () => {
    fake.rawRequest.mockRejectedValueOnce(new ApiError(409, 'private network access for Postgres is not yet available on this deployment', { code: 'private_lane_disabled' }))
    await expect(dbPublicAccess('off', undefined, { yes: true }, { tty: false })).rejects.toThrow(/not yet available on this deployment — postgres db stays reachable/)
  })
})

describe('postgres public-access on', () => {
  it('re-opens without a preview or a prompt', async () => {
    const confirm = vi.fn()
    fake.rawRequest.mockResolvedValueOnce({ status: 200, body: { service: { id: 's1', public: true }, notice: NOTICE } })
    await dbPublicAccess('on', undefined, {}, { tty: true, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(fake.request).not.toHaveBeenCalledWith('GET', expect.stringContaining('/access/impact'))
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/access', { public: true })
    expect(printed()).toContain('public access open')
  })
})

describe('postgres public-access / private-access with no mode', () => {
  it('reads the instance for the resolved service and changes nothing', async () => {
    fake.rawRequest.mockResolvedValueOnce({ status: 200, body: { publicAccess: true, privateAccess: false, privateLane: { enabled: true, console: false } } })
    await dbPublicAccess(undefined, undefined, {})
    expect(fake.rawRequest).toHaveBeenCalledTimes(1)
    expect(fake.rawRequest).toHaveBeenCalledWith('GET', '/projects/p1/database/instance?branch=main&group=db')
    expect(printed()).toContain('public access on')
  })

  it('private-access with only a service name reads it', async () => {
    fake.rawRequest.mockResolvedValueOnce({ status: 200, body: { publicAccess: true, privateAccess: true, privateConnString: 'postgresql://postgres@x.us-east-1.private.pg.instadb.tech:5432/instadb' } })
    await dbPrivateAccess('db', undefined, {})
    expect(fake.rawRequest).toHaveBeenCalledWith('GET', '/projects/p1/database/instance?branch=main&group=db')
    expect(printed()).toContain('private: postgresql://postgres@x.us-east-1.private.pg.instadb.tech')
  })

  it('rejects a mode that is not on|off', async () => {
    await expect(dbPrivateAccess('db', 'maybe', {})).rejects.toThrow('mode must be on|off')
  })
})

describe('postgres private-access on|off', () => {
  it('on PATCHes privateAccess for the named service on the branch', async () => {
    fake.rawRequest.mockResolvedValueOnce({ status: 200, body: { privateAccess: true, publicAccess: true } })
    await dbPrivateAccess('on', 'db', { branch: 'feat' })
    expect(fake.rawRequest).toHaveBeenCalledWith('PATCH', '/projects/p1/database/settings?branch=feat&group=db', { privateAccess: true })
    expect(printed()).toContain('DATABASE_PRIVATE_URL minted beside DATABASE_URL (unchanged)')
    expect(printed()).toContain('--source-name DATABASE_PRIVATE_URL --to compute/<name>')
  })

  it('off prints the platform warnings about computes still bound to it', async () => {
    fake.rawRequest.mockResolvedValueOnce({ status: 200, body: { privateAccess: false, warnings: ['compute/api is still bound to DATABASE_PRIVATE_URL'] } })
    await dbPrivateAccess('off', undefined, {})
    expect(fake.rawRequest).toHaveBeenCalledWith('PATCH', '/projects/p1/database/settings?branch=main&group=db', { privateAccess: false })
    expect(printed()).toContain('! compute/api is still bound to DATABASE_PRIVATE_URL')
  })

  it('explains private_lane_unavailable_in_region', async () => {
    fake.rawRequest.mockRejectedValueOnce(new ApiError(409, 'no private lane in this region', { code: 'private_lane_unavailable_in_region' }))
    await expect(dbPrivateAccess('on', undefined, {})).rejects.toThrow(/no private network lane yet — private access was turned back off and nothing was minted/)
  })

  it('off while public is closed points at public-access on', async () => {
    fake.rawRequest.mockRejectedValueOnce(new ApiError(400, 're-open public access first (PUT /projects/{projectId}/services/{serviceId}/access {"public": true}) — turning private network access off while public access is closed would leave the database with no way to connect'))
    await expect(dbPrivateAccess('off', undefined, {})).rejects.toThrow('insta postgres public-access on db')
  })
})

describe('pure renderers', () => {
  it('dbAccessLines says "not reachable from the internet" for a closed database, never "isolated"', () => {
    const text = dbAccessLines('db', { publicAccess: false, privateAccess: true }).join('\n')
    expect(text).toContain('not reachable from the internet')
    expect(text).not.toMatch(/isolat/i)
  })
  it('dbAccessLines reports unknown for a daemon that predates the lane, and a disabled lane', () => {
    const lines = dbAccessLines('db', { privateLane: { enabled: false, console: false } })
    expect(lines[0]).toContain('public access unknown')
    expect(lines.join('\n')).toContain('not yet available on this deployment')
  })
  it('impactLines is empty when nothing breaks', () => {
    expect(impactLines({ warnings: [] })).toEqual([])
    expect(impactLines(undefined)).toEqual([])
  })
  it('publicAccessSetLines: a no-op re-open says nothing changed', () => {
    expect(publicAccessSetLines('db', 'on', { service: {} })[0]).toContain('nothing changed')
  })
  it('privateAccessSetLines never calls the private lane isolated', () => {
    expect(privateAccessSetLines('db', 'on', {}).join('\n')).not.toMatch(/isolat/i)
  })
  it('accessErrorMessage falls back to the platform message with context', () => {
    expect(accessErrorMessage(new ApiError(502, 'provider down'), { service: 'db', what: 'closing public access' }))
      .toBe('closing public access failed (502): provider down')
  })
})
