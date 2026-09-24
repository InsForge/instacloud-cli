// `insta tokens list|create|revoke` — scoped API tokens (spec 2026-09-23-scoped-api-tokens §9).
// The platform client is injected (repo pattern: DI fakes, no disk/network). What is pinned here:
//  * parseExpires — the --expires grammar.
//  * create's default-org rule: --project → its org; --org; the bound org of an org-scoped login;
//    the linked project's org; the only org from GET /orgs; otherwise stop and ask. --account is
//    the explicit "no org", exclusive with --org/--project.
//  * output: the plaintext goes to stdout ONCE; the note goes to stderr; --json is one document.
//  * list's scope column, revoke's DELETE, and the guard's rendering of a 403 token_scope.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeTokenScope, parseExpires, scopeColumn, tokenScopeErrorLines,
  tokensCreate, tokensList, tokensRevoke, type TokenRecord, type TokenScopeInfo, type TokensApi,
} from '../src/commands/tokens.js'
import { ApiError } from '../src/api.js'

const RECORD: TokenRecord = {
  id: 'tok_0123456789abcdef', name: 'ci', scope: 'account', orgId: null, projectId: null, access: 'full',
  prefix: 'insta_ab', lastUsedAt: null, expiresAt: '2026-12-22T00:00:00.000Z', revokedAt: null, createdAt: '2026-09-23T00:00:00.000Z',
}
const ORG_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'a', role: 'owner' }
const ORG_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'b', role: 'member' }
const PROJECT_P = { id: 'pppppppp-0000-0000-0000-000000000003', org_id: ORG_B.id, name: 'shop', status: 'active' }

type Script = { orgs?: unknown[]; projects?: Record<string, unknown>; tokens?: TokenRecord[]; tokenScope?: TokenScopeInfo }

// Serves the routes the tokens commands touch and records every call. POST /tokens echoes the
// request into the record the way the platform does, so assertions can read the wire body.
function fakeApi(script: Script = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = []
  const api: TokensApi = {
    config: { tokenScope: script.tokenScope },
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'GET' && path === '/orgs') return { orgs: script.orgs ?? [] }
      if (method === 'GET' && path.startsWith('/projects/')) {
        const project = script.projects?.[path.slice('/projects/'.length)]
        if (!project) throw new ApiError(404, 'not_found', { error: 'not_found' })
        return { project, branches: [], resources: [], nextActions: [] }
      }
      if (method === 'GET' && path === '/tokens') return { tokens: script.tokens ?? [] }
      if (method === 'POST' && path === '/tokens') {
        const b = body as any
        return {
          token: 'insta_plaintext_secret',
          record: { ...RECORD, name: b.name, orgId: b.orgId ?? null, projectId: b.projectId ?? null, access: b.access ?? 'full', scope: b.projectId ? 'project' : b.orgId ? 'org' : 'account' },
        }
      }
      if (method === 'DELETE' && path.startsWith('/tokens/')) return { ok: true }
      throw new Error(`unexpected request ${method} ${path}`)
    },
  }
  return { api, calls }
}

const unlinked = async () => null
const linkedTo = (orgId: string) => async () => ({ projectId: 'linked-project', orgId, branch: 'main' })
const created = (calls: Array<{ method: string; path: string; body?: any }>) => calls.find((c) => c.method === 'POST' && c.path === '/tokens')?.body

function capture() {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { err.push(String(c)); return true })
  return { out: () => out.join(''), err: () => err.join('') }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('parseExpires', () => {
  it.each([['30d', 30], ['90d', 90], ['1y', 365], ['never', undefined], [undefined, undefined]] as const)('%s → %s', (input, days) => {
    expect(parseExpires(input)).toBe(days)
  })
  it('rejects anything outside the grammar with a usage error', () => {
    expect(() => parseExpires('abc')).toThrow(/--expires/)
    expect(() => parseExpires('0d')).toThrow(/--expires/)
    expect(() => parseExpires('30')).toThrow(/--expires/)
  })
})

describe('tokensCreate — default org', () => {
  it('(a) --account sends no orgId and touches no other route', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B] })
    await tokensCreate('ci', { account: true, json: true }, { api, linked: unlinked })
    expect(created(calls)).not.toHaveProperty('orgId')
    expect(created(calls)).not.toHaveProperty('projectId')
    expect(calls.map((c) => c.path)).toEqual(['/tokens']) // no GET /orgs, no link read needed
  })

  it('(b) --org X binds to X', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B] })
    await tokensCreate('ci', { org: ORG_B.id, json: true }, { api, linked: unlinked })
    expect(created(calls)).toMatchObject({ name: 'ci', orgId: ORG_B.id })
    expect(created(calls)).not.toHaveProperty('projectId')
  })

  it('(c) in a linked directory the link\'s org is the default', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B] })
    await tokensCreate('ci', { json: true }, { api, linked: linkedTo(ORG_B.id) })
    expect(created(calls)).toMatchObject({ orgId: ORG_B.id })
    expect(calls.some((c) => c.path === '/orgs')).toBe(false)
  })

  it('(d) unlinked with exactly one org: that org', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { json: true }, { api, linked: unlinked })
    expect(created(calls)).toMatchObject({ orgId: ORG_A.id })
  })

  it('(e) unlinked with several orgs: stops and asks for --org or --account, without minting', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B] })
    await expect(tokensCreate('ci', {}, { api, linked: unlinked })).rejects.toThrow('exit 1')
    expect(err()).toMatch(/--org/)
    expect(err()).toMatch(/--account/)
    expect(created(calls)).toBeUndefined()
  })

  it('(e\') unlinked with no org at all: stops and asks for --account, without minting', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi({ orgs: [] })
    await expect(tokensCreate('ci', {}, { api, linked: unlinked })).rejects.toThrow('exit 1')
    expect(err()).toMatch(/--account/)
    expect(created(calls)).toBeUndefined()
  })

  it('(f) --account with --org or --project is a usage error before any request', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A] })
    await expect(tokensCreate('ci', { account: true, org: ORG_A.id }, { api, linked: unlinked })).rejects.toThrow('exit 1')
    await expect(tokensCreate('ci', { account: true, project: PROJECT_P.id }, { api, linked: unlinked })).rejects.toThrow('exit 1')
    expect(err()).toMatch(/mutually exclusive|--account/)
    expect(calls).toEqual([])
  })

  it('(g) --project P resolves P\'s org via GET /projects/P and sends both', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B], projects: { [PROJECT_P.id]: PROJECT_P } })
    await tokensCreate('ci', { project: PROJECT_P.id, json: true }, { api, linked: unlinked })
    expect(calls[0]).toMatchObject({ method: 'GET', path: `/projects/${PROJECT_P.id}` })
    expect(created(calls)).toMatchObject({ orgId: ORG_B.id, projectId: PROJECT_P.id })
    expect(calls.some((c) => c.path === '/orgs')).toBe(false)
  })

  it('(g\') --project with a contradicting --org stops instead of sending a pair the platform would 404', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi({ projects: { [PROJECT_P.id]: PROJECT_P } })
    await expect(tokensCreate('ci', { project: PROJECT_P.id, org: ORG_A.id }, { api, linked: unlinked })).rejects.toThrow('exit 1')
    expect(err()).toMatch(new RegExp(ORG_B.id))
    expect(created(calls)).toBeUndefined()
  })

  it('(h) --read-only sends access read_only; the default is full', async () => {
    capture()
    const ro = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { readOnly: true, json: true }, { api: ro.api, linked: unlinked })
    expect(created(ro.calls)).toMatchObject({ access: 'read_only' })
    const full = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { json: true }, { api: full.api, linked: unlinked })
    expect(created(full.calls)).toMatchObject({ access: 'full' })
  })

  it('logged in with an org-scoped token, the bound org is the default (spec §9.2) — no GET /orgs', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B], tokenScope: { scope: 'org', orgId: ORG_B.id, access: 'full' } })
    await tokensCreate('ci', { json: true }, { api, linked: unlinked })
    expect(created(calls)).toMatchObject({ orgId: ORG_B.id })
    expect(calls.some((c) => c.path === '/orgs')).toBe(false)
  })

  it('logged in with a project-scoped token, create stops with a clear error — it never asks for an org token', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A], tokenScope: { scope: 'project', orgId: ORG_A.id, projectId: 'proj-1', access: 'read_only' } })
    await expect(tokensCreate('ci', { json: true }, { api, linked: unlinked })).rejects.toThrow(/exit 1/)
    expect(err()).toMatch(/project-scoped token .* cannot mint/)
    expect(calls).toEqual([])
  })

  it('--expires becomes expiresInDays (default 90d); never omits it', async () => {
    capture()
    const dflt = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { json: true }, { api: dflt.api, linked: unlinked })
    expect(created(dflt.calls)).toMatchObject({ expiresInDays: 90 })
    const year = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { expires: '1y', json: true }, { api: year.api, linked: unlinked })
    expect(created(year.calls)).toMatchObject({ expiresInDays: 365 })
    const never = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { expires: 'never', json: true }, { api: never.api, linked: unlinked })
    expect(created(never.calls)).not.toHaveProperty('expiresInDays')
  })

  it('a bad --expires is refused before any request', async () => {
    capture()
    const { api, calls } = fakeApi({ orgs: [ORG_A] })
    await expect(tokensCreate('ci', { expires: 'soon' }, { api, linked: unlinked })).rejects.toThrow(/--expires/)
    expect(calls).toEqual([])
  })
})

describe('tokensCreate — output', () => {
  it('human mode: the plaintext alone on stdout, the shown-once note on stderr', async () => {
    const { out, err } = capture()
    const { api } = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', {}, { api, linked: unlinked })
    expect(out()).toBe('insta_plaintext_secret\n')
    expect(err()).toMatch(/shown once/i)
    expect(err()).not.toContain('insta_plaintext_secret') // the secret is printed exactly once, on stdout
  })

  it('--json: stdout is exactly one JSON document { token, record }, nothing else', async () => {
    const { out, err } = capture()
    const { api } = fakeApi({ orgs: [ORG_A] })
    await tokensCreate('ci', { json: true }, { api, linked: unlinked })
    const doc = JSON.parse(out())
    expect(doc.token).toBe('insta_plaintext_secret')
    expect(doc.record).toMatchObject({ name: 'ci', scope: 'org', orgId: ORG_A.id })
    expect(err()).toBe('')
  })
})

describe('tokensList', () => {
  const tokens: TokenRecord[] = [
    RECORD,
    { ...RECORD, id: 'tok_org', name: 'org-ci', scope: 'org', orgId: ORG_B.id, access: 'read_only', lastUsedAt: '2026-09-22T10:00:00.000Z' },
    { ...RECORD, id: 'tok_proj', name: 'proj-ci', scope: 'project', orgId: ORG_B.id, projectId: PROJECT_P.id, expiresAt: null, revokedAt: '2026-09-23T01:00:00.000Z' },
  ]

  it('renders the scope column as account / org:<id8> / <id8>/<id8>, plus access and revocation', async () => {
    const { out } = capture()
    const { api, calls } = fakeApi({ tokens })
    await tokensList({}, { api })
    expect(calls).toEqual([{ method: 'GET', path: '/tokens', body: undefined }])
    const text = out()
    expect(text).toContain('account')
    expect(text).toContain(`org:${ORG_B.id.slice(0, 8)}`)
    expect(text).toContain(`${ORG_B.id.slice(0, 8)}/${PROJECT_P.id.slice(0, 8)}`)
    expect(text).toContain('read_only')
    expect(text).toMatch(/revoked/)
    expect(text).toMatch(/never/) // no expiry on the project token
  })

  it('--json prints the records as one array', async () => {
    const { out } = capture()
    const { api } = fakeApi({ tokens })
    await tokensList({ json: true }, { api })
    expect(JSON.parse(out())).toEqual(tokens)
  })

  it('scopeColumn is pure', () => {
    expect(scopeColumn(RECORD)).toBe('account')
    expect(scopeColumn({ ...RECORD, scope: 'org', orgId: ORG_A.id })).toBe(`org:${ORG_A.id.slice(0, 8)}`)
    expect(scopeColumn({ ...RECORD, scope: 'project', orgId: ORG_A.id, projectId: PROJECT_P.id })).toBe(`${ORG_A.id.slice(0, 8)}/${PROJECT_P.id.slice(0, 8)}`)
  })
})

describe('tokensRevoke', () => {
  it('DELETEs /tokens/<id>', async () => {
    const { out } = capture()
    const { api, calls } = fakeApi()
    await tokensRevoke('tok_0123456789abcdef', {}, { api })
    expect(calls).toEqual([{ method: 'DELETE', path: '/tokens/tok_0123456789abcdef', body: undefined }])
    expect(out()).toMatch(/revoked/)
  })
  it('--json answers { ok, id }', async () => {
    const { out } = capture()
    const { api } = fakeApi()
    await tokensRevoke('tok_x', { json: true }, { api })
    expect(JSON.parse(out())).toEqual({ ok: true, id: 'tok_x' })
  })
})

describe('403 token_scope rendering (what the command guard prints)', () => {
  it('relays the platform message verbatim and adds ONE hint line naming the stored scope', () => {
    const lines = tokenScopeErrorLines(
      { error: 'token_scope', message: 'this token is bound to org bbbbbbbb-0000-0000-0000-000000000002' },
      { scope: 'org', orgId: ORG_B.id, access: 'read_only' },
    ).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('this token is bound to org bbbbbbbb-0000-0000-0000-000000000002')
    expect(lines[1]).toContain(ORG_B.id)
    expect(lines[1]).toContain('read-only')
    expect(lines[1]).toContain('insta tokens create')
    expect(lines[1]).toContain('--account')
    expect(lines[1]).toContain('insta login')
    // Not a permissions message: a scope refusal must not send anyone to check membership roles.
    expect(lines.join('\n')).not.toMatch(/permission|role|member/i)
  })
  it('still hints when no scope was stored (a key adopted before this CLI recorded scopes)', () => {
    const text = tokenScopeErrorLines({ error: 'token_scope', message: 'nope' }, undefined)
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('nope')
    expect(text).toContain('insta login')
  })
  it('describeTokenScope', () => {
    expect(describeTokenScope(undefined)).toBe('account-wide')
    expect(describeTokenScope({ scope: 'account', access: 'full' })).toBe('account-wide')
    expect(describeTokenScope({ scope: 'org', orgId: 'o1', access: 'full' })).toBe('org o1')
    expect(describeTokenScope({ scope: 'org', orgId: 'o1', access: 'read_only' })).toBe('org o1, read-only')
    expect(describeTokenScope({ scope: 'project', orgId: 'o1', projectId: 'p1', access: 'full' })).toBe('project p1 (org o1)')
  })
})
