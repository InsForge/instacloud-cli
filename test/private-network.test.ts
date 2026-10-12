// `insta compute public-access` / `insta <redis|mysql|mongodb> public-access`, and the private address
// on `services list`. Pins the platform call each mode makes, that closing asks first (a
// non-interactive caller must pass --yes), that the platform's coded refusals read as CLI
// instructions, and that the private address is the platform's own (never composed here).
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
import { closeWarning, publicAccessErrorMessage, publicAccessLines, servicePublicAccess } from '../src/commands/private-network.js'
import { serviceListLine } from '../src/commands/services.js'

const API = { id: 's1', type: 'compute', name: 'api', public: true, port: 8080, private_host: 'api.insta.internal', private_fqdn: 'api.0123abcd.insta.internal' }
const CACHE = { id: 's2', type: 'redis', name: 'cache', public: true, port: 6379, private_host: 'cache-redis.insta.internal', private_fqdn: 'cache-redis.0123abcd.insta.internal' }
const printed = () => vi.mocked(info).mock.calls.map((c) => c[0]).join('\n')

beforeEach(() => {
  vi.mocked(info).mockClear(); vi.mocked(printJson).mockClear(); vi.mocked(refuse).mockClear()
  fake.request.mockReset(); fake.rawRequest.mockReset(); fake.load.mockReset().mockResolvedValue(fake)
  fake.request.mockImplementation(async (_m: string, path: string) => {
    if (path.startsWith('/projects/p1/services?')) return { services: [API, CACHE] }
    throw new Error(`unexpected ${path}`)
  })
  fake.rawRequest.mockResolvedValue({ status: 200, body: { service: { ...API, public: false }, notice: "public access is closed: the service's URL answers 403 and does not wake it. Services in this branch reach it at api.insta.internal:8080." } })
})

describe('show', () => {
  it('prints public access and the platform-reported private address', async () => {
    await servicePublicAccess('compute', undefined, undefined, {})
    expect(fake.rawRequest).not.toHaveBeenCalled()
    expect(printed()).toContain('compute api: public access on')
    expect(printed()).toContain('private: api.insta.internal:8080')
    expect(printed()).toContain('fqdn:    api.0123abcd.insta.internal')
  })
  it('a service the platform reports no private address for says so, and invents none', () => {
    const lines = publicAccessLines({ id: 's', type: 'compute', name: 'jobs', public: true, port: 0 })
    expect(lines.join('\n')).toContain('private: none yet')
    expect(lines.join('\n')).not.toContain('.insta.internal')
  })
  it('a closed database names the credential that stopped working and the one to use', () => {
    expect(publicAccessLines({ ...CACHE, public: false })[0]).toBe('redis cache: public access off — REDIS_URL does not connect; apps in this branch use REDIS_PRIVATE_URL')
  })
})

describe('off', () => {
  it('warns, asks, and closes on yes', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    await servicePublicAccess('compute', 'off', 'api', {}, { tty: true, confirm })
    expect(confirm).toHaveBeenCalledOnce()
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/access', { public: false })
    expect(printed()).toContain('answer 403')
    expect(printed()).toContain('compute api: public access CLOSED')
    expect(printed()).toContain('api.insta.internal:8080')
  })
  it('changes nothing when the human declines', async () => {
    await servicePublicAccess('compute', 'off', undefined, {}, { tty: true, confirm: async () => false })
    expect(fake.rawRequest).not.toHaveBeenCalled()
    expect(printed()).toContain('public access unchanged')
  })
  it('refuses without --yes when nobody can answer, and under --json', async () => {
    await expect(servicePublicAccess('compute', 'off', undefined, {}, { tty: false })).rejects.toThrow('refused')
    await expect(servicePublicAccess('compute', 'off', undefined, { json: true }, { tty: true })).rejects.toThrow('refused')
    expect(fake.rawRequest).not.toHaveBeenCalled()
    expect(vi.mocked(refuse).mock.calls[0]![0].join('\n')).toContain('--yes')
  })
  it('--yes closes without asking', async () => {
    const confirm = vi.fn()
    await servicePublicAccess('redis', 'off', 'cache', { yes: true }, { tty: false, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s2/access', { public: false })
  })
  it('a database warning names the credential it breaks', () => {
    expect(closeWarning(CACHE)).toContain('REDIS_URL (the public address) stops connecting')
    expect(closeWarning(CACHE)).toContain('REDIS_PRIVATE_URL')
  })
})

describe('on', () => {
  it('re-opens without asking', async () => {
    const confirm = vi.fn()
    fake.rawRequest.mockResolvedValue({ status: 200, body: { service: API } })
    await servicePublicAccess('compute', 'on', 'api', {}, { tty: true, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/access', { public: true })
    expect(printed()).toContain('compute api: public access open')
  })
})

describe('refusals read as CLI instructions: one row per code', () => {
  const err = (status: number, code: string | undefined, message = 'x') => new ApiError(status, message, { error: message, ...(code ? { code } : {}) })
  it.each<[string, ApiError, RegExp]>([
    ['private_network_disabled', err(409, 'private_network_disabled'), /not yet available on this deployment — compute api stays public/],
    ['private_network_unavailable_in_region', err(409, 'private_network_unavailable_in_region'), /region of compute api has no private network yet/],
    ['no_private_name', err(400, 'no_private_name'), /no private network name.*insta service rename compute api <new-name> --branch dev/],
    ['private_name_taken', err(409, 'private_name_taken', 'the private network name api.insta.internal is already used'), /already used — rename one of the services/],
    ['anything else', err(502, undefined, 'boom'), /closing public access failed \(502\): boom/],
  ])('%s', (_code, e, want) => {
    expect(publicAccessErrorMessage(e, { type: 'compute', service: 'api', branch: 'dev', what: 'closing public access' })).toMatch(want)
  })
  it('the command surfaces the mapped message', async () => {
    fake.rawRequest.mockRejectedValue(err(409, 'private_network_disabled'))
    await expect(servicePublicAccess('compute', 'off', 'api', { yes: true })).rejects.toThrow(/stays public/)
  })
})

describe('services list shows the private address', () => {
  const base = { status: 'active', id: 'x' }
  it('a compute row: URL, then the private address', () => {
    expect(serviceListLine({ ...base, type: 'compute', name: 'api', machine_count: 1, port: 8080, domain: 'api.example.com', private_host: 'api.insta.internal', public: true }))
      .toBe('compute/api  [active]  x1  api.example.com  private api.insta.internal:8080  x')
  })
  it('a closed compute row says public off', () => {
    expect(serviceListLine({ ...base, type: 'compute', name: 'api', machine_count: 1, port: 8080, domain: 'api.example.com', private_host: 'api.insta.internal', public: false }))
      .toContain('api.example.com  public off  private api.insta.internal:8080')
  })
  it('a managed database row', () => {
    expect(serviceListLine({ ...base, type: 'redis', name: 'cache', port: 6379, private_host: 'cache-redis.insta.internal' }))
      .toContain('private cache-redis.insta.internal:6379')
  })
  it('no private_host: nothing is printed (and the line is exactly as before)', () => {
    expect(serviceListLine({ ...base, type: 'compute', name: 'api', machine_count: 1, port: 8080, domain: 'api.example.com' }))
      .toBe('compute/api  [active]  x1  api.example.com  x')
  })
})
