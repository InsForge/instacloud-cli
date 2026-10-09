import { describe, expect, it, vi, afterEach, afterAll } from 'vitest'
import * as clack from '@clack/prompts'
import { ApiError } from '../src/api.js'
import { upgradePlanLines, templateUpgrade, templateRollback } from '../src/commands/template.js'

vi.mock('@clack/prompts', async (orig) => ({ ...(await orig<typeof import('@clack/prompts')>()), confirm: vi.fn(async () => true) }))

const plan = (over: Record<string, unknown> = {}) => ({
  from_version: '1.3.2', to_version: '1.4.0', to_digest: 'a'.repeat(64), removed: [], refusals: [],
  services: [{
    key: 'app', service_id: 'svc_1', service_name: 'n8n', gone: false, added: false, missing_variables: [],
    fields: [{ field: 'image', label: 'Image', deployed: 'n8nio/n8n:2.36.5', live: 'n8nio/n8n:2.36.5', next: 'n8nio/n8n:2.41.0', drifted: false, verdict: 'applied' }],
  }],
  ...over,
})

describe('upgradePlanLines', () => {
  it('prints the version move and the applied change', () => {
    const lines = upgradePlanLines(plan())
    expect(lines[0]).toContain('1.3.2 → 1.4.0')
    expect(lines.join('\n')).toContain('n8n  Image  n8nio/n8n:2.36.5 → n8nio/n8n:2.41.0')
  })

  it('marks a field the user changed', () => {
    const p = plan()
    p.services[0].fields[0] = { ...p.services[0].fields[0], live: 'n8nio/n8n:custom', drifted: true }
    expect(upgradePlanLines(p).join('\n')).toContain('you changed this')
  })

  it('prints a declared setting it will write', () => {
    const p = plan()
    p.services[0].fields.push({ field: 'always_on', label: 'Always on', deployed: null, live: 'off', next: 'on', drifted: false, verdict: 'applied' })
    expect(upgradePlanLines(p).join('\n')).toContain('Always on  off → on')
  })

  it('leads with the refusals when there are any', () => {
    const p = plan({ refusals: ['service app would change type from web to worker'] })
    expect(upgradePlanLines(p)[0]).toContain('cannot run')
    expect(upgradePlanLines(p).join('\n')).toContain('would change type')
  })

  it('names required variables with no value', () => {
    const p = plan()
    p.services[0].missing_variables = ['N8N_ENCRYPTION_KEY']
    expect(upgradePlanLines(p).join('\n')).toContain('N8N_ENCRYPTION_KEY')
  })
})

const PROJECT = { projectId: 'proj_1', orgId: 'org_1', branch: 'main' }
const NO_WAIT = async () => {}

function fakeApi(opts: { plan?: any; services?: any[] } = {}) {
  const posts: { path: string; body: any }[] = []
  const gets: string[] = []
  const api = {
    request: async (_m: string, path: string) => {
      gets.push(path)
      if (path.startsWith('/projects/')) return { services: opts.services ?? [{ name: 'n8n', template_deployment_id: 'dep_9' }] }
      if (path.endsWith('/upgrade')) return { plan: opts.plan ?? plan() }
      return { status: 'succeeded', step: 'done', template_version: '1.3.2' }
    },
    rawRequest: async (_m: string, path: string, body?: unknown) => {
      posts.push({ path, body })
      return { status: 202, body: { deploymentId: 'dep_9' } }
    },
  }
  return { api, posts, gets }
}

describe('upgrade and rollback flows', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined; vi.mocked(clack.confirm).mockClear() })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })
  const deps = (api: any) => ({ api, project: PROJECT, wait: NO_WAIT })

  it('refusals print, exit non-zero, and neither prompt nor POST', async () => {
    const { api, posts } = fakeApi({ plan: plan({ refusals: ['service app would change type from web to worker'] }) })
    await templateUpgrade('n8n', {}, deps(api))
    expect(stdout.join('')).toContain('cannot run')
    expect(process.exitCode).toBe(1)
    expect(posts).toEqual([])
    expect(clack.confirm).not.toHaveBeenCalled()
  })

  it('POSTs the version and digest from the plan it printed', async () => {
    const { api, posts } = fakeApi()
    await templateUpgrade('n8n', { yes: true }, deps(api))
    expect(posts).toEqual([{
      path: '/projects/proj_1/template-deployments/dep_9/upgrade',
      body: { variables: {}, expectedVersion: '1.4.0', expectedDigest: 'a'.repeat(64) },
    }])
  })

  it('--json alone prints the plan and does not upgrade', async () => {
    const { api, posts } = fakeApi()
    await templateUpgrade('n8n', { json: true }, deps(api))
    expect(JSON.parse(stdout.join('')).to_version).toBe('1.4.0')
    expect(posts).toEqual([])
  })

  it('--json --yes upgrades and prints exactly one JSON document, the deployment', async () => {
    const { api, posts } = fakeApi()
    await templateUpgrade('n8n', { json: true, yes: true }, deps(api))
    expect(posts).toHaveLength(1)
    expect(posts[0].body.expectedVersion).toBe('1.4.0')
    expect(JSON.parse(stdout.join('')).status).toBe('succeeded')
  })

  it('rollback names every setting it writes, and both warnings, before it asks to confirm', async () => {
    const { api, posts } = fakeApi()
    const order: string[] = []
    vi.mocked(clack.confirm).mockImplementationOnce((async () => { order.push(`confirm after: ${stdout.join('')}`); return true }) as any)
    const inTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const outTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      await templateRollback('n8n', {}, deps(api))
    } finally {
      for (const [s, d] of [[process.stdin, inTty], [process.stdout, outTty]] as const) {
        if (d) Object.defineProperty(s, 'isTTY', d); else delete (s as any).isTTY
      }
    }
    expect(order).toHaveLength(1)
    // Rollback prints NO plan, so this text is the user's only notice of what it rewrites. It
    // runs the same planner as the upgrade, so always-on, public access and the mount path are
    // written too whenever the older manifest declares them.
    expect(order[0]).toContain('the image, the start command, the port')
    expect(order[0]).toContain('always-on')
    expect(order[0]).toContain('public access')
    expect(order[0]).toContain('the volume mount path')
    expect(order[0]).toContain('the recorded variables')
    expect(order[0]).toContain('does not declare keeps its current value')
    expect(order[0]).toContain('does not restore data the app migrated')
    expect(order[0]).toContain('a volume only grows')
    expect(posts[0].path).toBe('/projects/proj_1/template-deployments/dep_9/rollback')
  })

  it('a service not deployed from a template says so, naming the command that was run, with no POST', async () => {
    const { api, posts } = fakeApi({ services: [{ name: 'n8n', template_deployment_id: null }] })
    // One lookup serves both verbs, so the sentence has to follow the verb: telling someone who
    // ran `rollback` that there is nothing to UPGRADE sends them to the wrong command.
    await expect(templateUpgrade('n8n', { yes: true }, deps(api))).rejects.toThrow(/was not deployed from a template, so there is nothing to upgrade/)
    await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(/was not deployed from a template, so there is nothing to roll back/)
    expect(posts).toEqual([])
  })

  it('rollback --json without --yes rolls back nothing and fails', async () => {
    const { api, posts } = fakeApi()
    await expect(templateRollback('n8n', { json: true }, deps(api))).rejects.toThrow(/--yes/)
    expect(posts).toEqual([])
    expect(stdout.join('')).toBe('')
  })

  it('rollback --json --yes emits exactly one JSON document and no progress lines', async () => {
    const { api, posts } = fakeApi()
    await templateRollback('n8n', { json: true, yes: true }, deps(api))
    expect(posts).toHaveLength(1)
    expect(JSON.parse(stdout.join('')).status).toBe('succeeded')
  })

  it('a stale pin says the template was republished', async () => {
    const { api } = fakeApi()
    api.rawRequest = async () => { throw new ApiError(409, 'changed', { code: 'template_version_changed' }) }
    await expect(templateUpgrade('n8n', { yes: true }, deps(api))).rejects.toThrow(/republished since the plan was shown/)
  })

  it('rollback explains the 409s a user will hit', async () => {
    const { api } = fakeApi()
    api.rawRequest = async () => { throw new ApiError(409, 'x', { code: 'template_version_not_recorded' }) }
    await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(/no longer recorded/)
  })

  // template_no_step_back has two causes and only the platform can tell them apart: never upgraded,
  // or already rolled back — the second names the version to upgrade back to. Replacing the sentence
  // printed one cause for both, and the wrong one after a rollback.
  it('rollback keeps the platform sentence for whichever no-step-back cause it was', async () => {
    for (const msg of [
      'this instance was not upgraded from anything, so there is no version to return to',
      'this instance was already rolled back to 1.6.0, so there is no older version to return to — upgrade it to move forward',
    ]) {
      const { api } = fakeApi()
      api.rawRequest = async () => { throw new ApiError(409, msg, { code: 'template_no_step_back' }) }
      await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(
        new RegExp(`${msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Nothing was changed\\.`),
      )
    }
  })

  it('a superseded deployment keeps the platform sentence naming the one to act on', async () => {
    // The platform's message is the only place the successor is named, so it is printed as given
    // rather than replaced by wording of ours; a bare `conflict (HTTP 409)` would strand the user.
    const said = 'this deployment was already replaced by n8n@1.5.0 — act on that deployment instead'
    const { api, posts } = fakeApi()
    api.rawRequest = async () => { throw new ApiError(409, said, { error: said, code: 'template_superseded' }) }
    await expect(templateUpgrade('n8n', { yes: true }, deps(api))).rejects.toThrow(/already replaced by n8n@1\.5\.0/)
    await expect(templateUpgrade('n8n', { yes: true }, deps(api))).rejects.toThrow(/Nothing was changed/)
    expect(posts).toEqual([])
  })

  it('the PREVIEW reads a superseded 409 too — it is a GET on another code path', async () => {
    const said = 'this deployment was already replaced by n8n@1.5.0 — act on that deployment instead'
    const { api, posts } = fakeApi()
    const plainGet = api.request
    api.request = async (m: string, path: string) => {
      if (path.endsWith('/upgrade')) throw new ApiError(409, said, { error: said, code: 'template_superseded' })
      return plainGet(m, path)
    }
    await expect(templateUpgrade('n8n', { yes: true }, deps(api))).rejects.toThrow(/already replaced by n8n@1\.5\.0 — act on that deployment instead\. Nothing was changed/)
    expect(posts).toEqual([])
  })

  it('a republished older version refuses the rollback in the platform\'s own words', async () => {
    const said = 'n8n@1.3.2 was republished with different content after this instance ran it, so the recorded manifest is not what it was running — deploy the version you want as a new copy instead'
    const { api } = fakeApi()
    api.rawRequest = async () => { throw new ApiError(409, said, { error: said, code: 'template_version_content_changed' }) }
    await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(/republished with different content/)
    await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(/Nothing was changed/)
  })

  it('rollback sends --set values and prompts from the platform\'s missing list on a terminal', async () => {
    // A version that DROPPED a required variable deleted its value, and the older manifest still
    // requires it: the 400 is the only place those names exist, since rollback prints no plan.
    const { api, posts } = fakeApi()
    let first = true
    api.rawRequest = async (_m: string, path: string, body?: unknown) => {
      // Snapshot: the command fills the same `variables` object on the retry, so holding the
      // reference would make both entries read as the second one.
      posts.push({ path, body: structuredClone(body) })
      if (first) {
        first = false
        throw new ApiError(400, 'missing_variables', { error: 'missing_variables', missing: [{ name: 'ADMIN_TOKEN', key: 'ADMIN_TOKEN', description: 'admin API token' }] })
      }
      return { status: 202, body: { deploymentId: 'dep_9' } }
    }
    const inTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const outTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      await templateRollback('n8n', { set: ['SMTP_HOST=mail.example.com'] }, { ...deps(api), ask: async () => 'tok' })
    } finally {
      for (const [s, d] of [[process.stdin, inTty], [process.stdout, outTty]] as const) {
        if (d) Object.defineProperty(s, 'isTTY', d); else delete (s as any).isTTY
      }
    }
    expect(posts).toHaveLength(2)
    expect(posts[0].body).toEqual({ variables: { SMTP_HOST: 'mail.example.com' } })
    expect(posts[1].body).toEqual({ variables: { SMTP_HOST: 'mail.example.com', ADMIN_TOKEN: 'tok' } })
  })

  it('rollback with no terminal prints the --set list instead of rolling back blind', async () => {
    const { api, posts } = fakeApi()
    api.rawRequest = async (_m: string, path: string, body?: unknown) => {
      posts.push({ path, body })
      throw new ApiError(400, 'missing_variables', { error: 'missing_variables', missing: [{ name: 'ADMIN_TOKEN', key: 'ADMIN_TOKEN', description: 'admin API token' }] })
    }
    await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(/--set NAME=value/)
    await expect(templateRollback('n8n', { yes: true }, deps(api))).rejects.toThrow(/ADMIN_TOKEN/)
  })

  it('a typo\'d --set on rollback fails before any network access', async () => {
    const { api, posts, gets } = fakeApi()
    await expect(templateRollback('n8n', { yes: true, set: ['lowercase=1'] }, deps(api))).rejects.toThrow(/--set expects NAME=value/)
    expect(posts).toEqual([])
    expect(gets).toEqual([])
  })

  it('rollback without a terminal or --yes rolls back nothing and fails', async () => {
    const { api, posts } = fakeApi()
    await expect(templateRollback('n8n', {}, deps(api))).rejects.toThrow(/--yes/)
    expect(posts).toEqual([])
  })
})
