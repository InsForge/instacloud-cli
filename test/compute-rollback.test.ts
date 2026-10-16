import { describe, expect, it, vi, afterEach, afterAll } from 'vitest'
import * as clack from '@clack/prompts'
import { ApiError } from '../src/api.js'
import { pickRollbackTarget, rollbackDisclosure, computeRollback, type ServiceDeploymentView } from '../src/commands/compute.js'

vi.mock('@clack/prompts', async (orig) => ({ ...(await orig<typeof import('@clack/prompts')>()), confirm: vi.fn(async () => true) }))

const LIVE = '3f2a9c1e-0000-4000-8000-000000000001'
const OLD = '7d41e0b2-0000-4000-8000-000000000002'
const OLD2 = '7d41e0b2-1111-4000-8000-000000000004'
const FAILED = 'c09b11f4-0000-4000-8000-000000000003'
const row = (over: Partial<ServiceDeploymentView> = {}): ServiceDeploymentView => ({
  id: OLD, status: 'succeeded', trigger: 'github', image: 'registry/web:abc', pinnedImage: 'registry/web@sha256:51aa7c90ffff',
  commitSha: '9f8e7d6aaaa', buildId: null, buildSource: 'github', port: 8080, startCommand: null, actor: null, rollbackOf: null,
  error: null, backfilled: false, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), live: false, rollbackEligible: true,
  variablesChangedSince: 2, ...over,
})
const live = row({ id: LIVE, live: true, rollbackEligible: false, ineligibleReason: 'live' })
const failed = row({ id: FAILED, status: 'failed', rollbackEligible: false, ineligibleReason: 'failed' })
const same = row({ id: 'aaaaaaaa-0000-4000-8000-000000000009', rollbackEligible: false, ineligibleReason: 'same_image' })

describe('pickRollbackTarget', () => {
  it('defaults to the first eligible row after the live one', () => {
    expect(pickRollbackTarget([live, failed, same, row()], undefined).id).toBe(OLD)
  })
  it('takes an exact id or a unique prefix of 8+ chars', () => {
    expect(pickRollbackTarget([live, row()], OLD).id).toBe(OLD)
    expect(pickRollbackTarget([live, row()], OLD.slice(0, 8)).id).toBe(OLD)
  })
  it('refuses an ambiguous prefix', () => {
    expect(() => pickRollbackTarget([live, row(), row({ id: OLD2 })], '7d41e0b2')).toThrow('deployment id prefix 7d41e0b2 matches 2 deployments')
  })
  it('refuses an unknown id', () => {
    expect(() => pickRollbackTarget([live, row()], 'deadbeef', 'web')).toThrow('no deployment deadbeef on web')
  })
  it('refuses the live, failed and same-image rows with the server messages', () => {
    expect(() => pickRollbackTarget([live, row()], LIVE)).toThrow('that deployment is already live')
    expect(() => pickRollbackTarget([live, failed], FAILED)).toThrow('that deployment failed, so there is nothing to roll back to')
    expect(() => pickRollbackTarget([live, same], same.id)).toThrow('that deployment runs the same image as the live one, use restart to redeploy it')
  })
  it('says so when there is no default target', () => {
    expect(() => pickRollbackTarget([live, failed], undefined)).toThrow(/nothing to roll back to/)
  })
})

describe('rollbackDisclosure', () => {
  it('prints the four lines and omits the pause line without auto-deploy', () => {
    const lines = rollbackDisclosure(row(), { port: 8080, autoDeployBranch: 'main', service: 'web', now: new Date() })
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^Rolling back web to 7d41e0b2 \(commit 9f8e7d6, 2 hours ago\)$/)
    expect(lines[1]).toBe('  restores  image, port 8080, start command')
    expect(lines[2]).toBe('  keeps     variables (2 changed since), scale, domains, volume, databases')
    expect(lines[3]).toBe('  pauses    auto-deploy from main')
    expect(rollbackDisclosure(row(), { port: 8080, autoDeployBranch: null, service: 'web', now: new Date() })).toHaveLength(3)
  })
  it('warns when the image was never pinned', () => {
    const lines = rollbackDisclosure(row({ pinnedImage: null }), { port: null, autoDeployBranch: null, service: 'web', now: new Date() })
    expect(lines).toContain('  warning   this deployment used the tag registry/web:abc, which may point to a different image now')
  })
})

describe('computeRollback', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined; vi.mocked(clack.confirm).mockClear() })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })
  const PROJECT = { projectId: 'proj_1', branch: 'main' }
  const fake = (o: { status?: number; paused?: boolean; source?: any; sourceErr?: number } = {}) => {
    const posts: { path: string; body: any }[] = []
    const gets: string[] = []
    const api: any = {
      request: async (_m: string, path: string) => {
        gets.push(path)
        if (path.endsWith('/source') || path.includes('/source?')) {
          if (o.sourceErr) throw new ApiError(o.sourceErr, 'no source')
          return { source: o.source ?? { type: 'github', owner: 'a', repo: 'b', branch: 'main', root_dir: null, auto_deploy: true, public: false } }
        }
        if (path.includes('/deployments')) return { deployments: [live, row()], autoDeployPausedByRollback: false }
        return { services: [{ id: 'svc_1', type: 'compute', name: 'web' }] }
      },
      rawRequest: async (_m: string, path: string, body?: unknown) => {
        posts.push({ path, body })
        if (o.status === 202) return { status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'ap_1' } }
        return { status: 200, body: { deployment: row({ id: 'beefbeef-0000-4000-8000-0000000000aa', live: true, trigger: 'rollback' }), service: { id: 'svc_1' }, autoDeployPaused: o.paused ?? true } }
      },
    }
    return { api, posts, gets }
  }
  const withTty = async (fn: () => Promise<void>) => {
    const i = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), o = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try { await fn() } finally {
      for (const [s, d] of [[process.stdin, i], [process.stdout, o]] as const) { if (d) Object.defineProperty(s, 'isTTY', d); else delete (s as any).isTTY }
    }
  }

  it('--json without --yes throws and makes no request', async () => {
    const { api, posts, gets } = fake()
    await expect(computeRollback('web', { json: true }, { api, project: PROJECT })).rejects.toThrow(/--yes/)
    expect(posts).toEqual([])
    expect(gets).toEqual([])
    expect(stdout.join('')).toBe('')
  })

  it('--json --yes prints exactly one JSON document', async () => {
    const { api, posts } = fake()
    await computeRollback('web', { json: true, yes: true }, { api, project: PROJECT })
    expect(posts).toEqual([{ path: '/projects/proj_1/services/svc_1/rollback', body: { deploymentId: OLD } }])
    expect(JSON.parse(stdout.join('')).autoDeployPaused).toBe(true)
  })

  it('prints the disclosure before it confirms, then the success and paused lines', async () => {
    const { api } = fake()
    let seen = ''
    vi.mocked(clack.confirm).mockImplementationOnce((async () => { seen = stdout.join(''); return true }) as any)
    await withTty(() => computeRollback('web', {}, { api, project: PROJECT }))
    expect(seen).toContain('Rolling back web to 7d41e0b2')
    expect(seen).toContain('pauses    auto-deploy from main')
    const out = stdout.join('')
    expect(out).toContain('rolled back web to 7d41e0b2. beefbeef is live.')
    expect(out).toContain('auto-deploy is paused. Turn it back on in the console: Settings → Source')
  })

  it('no pauses line without a github source, and no paused line when not paused', async () => {
    const { api } = fake({ sourceErr: 404, paused: false })
    await computeRollback('web', { yes: true }, { api, project: PROJECT })
    const out = stdout.join('')
    expect(out).not.toContain('pauses')
    expect(out).not.toContain('auto-deploy is paused')
    expect(out).toContain('rolled back web to 7d41e0b2. beefbeef is live.')
  })

  it('auto_deploy false means no pauses line', async () => {
    const { api } = fake({ source: { type: 'github', owner: 'a', repo: 'b', branch: 'main', root_dir: null, auto_deploy: false, public: false } })
    await computeRollback('web', { yes: true }, { api, project: PROJECT })
    expect(stdout.join('')).not.toContain('pauses')
  })

  it('a full uuid skips the deployments lookup', async () => {
    const { api, posts, gets } = fake()
    await computeRollback('web', { to: OLD, yes: true }, { api, project: PROJECT })
    expect(gets.some((g) => g.includes('/deployments'))).toBe(false)
    expect(posts[0]!.body).toEqual({ deploymentId: OLD })
  })

  it('a prefix resolves through the first page at limit=100', async () => {
    const { api, posts, gets } = fake()
    await computeRollback('web', { to: OLD.slice(0, 8), yes: true }, { api, project: PROJECT })
    expect(gets).toContain('/projects/proj_1/services/svc_1/deployments?limit=100')
    expect(posts[0]!.body).toEqual({ deploymentId: OLD })
  })

  it('declining the confirm posts nothing', async () => {
    const { api, posts } = fake()
    vi.mocked(clack.confirm).mockImplementationOnce((async () => false) as any)
    await withTty(() => computeRollback('web', {}, { api, project: PROJECT }))
    expect(posts).toEqual([])
  })

  it('a 202 goes through handleApproval', async () => {
    const { api } = fake({ status: 202 })
    await computeRollback('web', { yes: true }, { api, project: PROJECT })
    expect(process.exitCode).toBe(2)
    expect(stderr.join('')).toContain('approval required')
    expect(stdout.join('')).not.toContain('rolled back')
  })

  it('refuses without a terminal and without --yes', async () => {
    const { api, posts } = fake()
    await expect(computeRollback('web', {}, { api, project: PROJECT })).rejects.toThrow(/--yes/)
    expect(posts).toEqual([])
  })
})
