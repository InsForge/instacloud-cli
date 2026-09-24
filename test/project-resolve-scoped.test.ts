// Implicit project resolution under a SCOPED login (spec 2026-09-23-scoped-api-tokens §9.2).
// requireProject's unlinked path used to start with GET /orgs. A project-scoped insta_ key gets a
// 403 token_scope from that route, and an org-scoped one sees exactly one org anyway — so the
// resolution reads the stored tokenScope first. Exercised through a real ApiClient over a fake
// fetch (repo pattern: injected transport, no global mocks), recording every path it requests.
import { describe, expect, it } from 'vitest'
import { ApiClient, resolveProjectFromApi } from '../src/api.js'
import type { GlobalConfig, ProjectConfig } from '../src/config.js'

const BASE = 'https://api.test'
const ORG_1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const ORG_2 = 'bbbbbbbb-0000-0000-0000-000000000002'
const P1 = 'pppppppp-0000-0000-0000-000000000001'

type Route = (body: unknown) => { status?: number; body: unknown }

function client(cfg: Omit<GlobalConfig, 'apiUrl'>, routes: Record<string, Route>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url.slice(BASE.length)}`
    calls.push(key)
    const route = routes[key]
    if (!route) return new Response(JSON.stringify({ error: 'unexpected', message: key }), { status: 500 })
    const r = route(init.body ? JSON.parse(String(init.body)) : undefined)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { api: new ApiClient({ apiUrl: BASE, accessToken: 'insta_x', ...cfg }, fetchImpl), calls }
}

function deps() {
  const saved: ProjectConfig[] = []
  return {
    saved,
    deps: {
      save: async (c: ProjectConfig) => { saved.push(c) },
      promptChoice: async () => { throw new Error('prompt must not be called') },
      tty: false,
    },
  }
}

// The guard on the platform answers a scoped key's GET /orgs with this; the CLI must never send it.
const scopeRefusal: Route = () => ({ status: 403, body: { error: 'token_scope', message: 'this token is bound to a project' } })

describe('resolveProjectFromApi', () => {
  it('project token: never calls GET /orgs — builds the link from GET /projects/<id>, default branch from the project', async () => {
    const { api, calls } = client(
      { tokenScope: { scope: 'project', orgId: ORG_1, projectId: P1, access: 'full' } },
      {
        'GET /orgs': scopeRefusal,
        [`GET /projects/${P1}`]: () => ({
          body: {
            project: { id: P1, org_id: ORG_1, name: 'shop', status: 'active' },
            branches: [{ id: 'b1', name: 'main', is_default: false }, { id: 'b2', name: 'trunk', is_default: true }],
            resources: [], nextActions: [],
          },
        }),
      },
    )
    const d = deps()
    const link = await resolveProjectFromApi(api, d.deps)
    expect(link).toEqual({ projectId: P1, orgId: ORG_1, branch: 'trunk' })
    expect(calls).toEqual([`GET /projects/${P1}`])
    expect(d.saved).toEqual([link]) // remembered like any auto-resolved link
  })

  it('project token: falls back to main when the project reports no default branch', async () => {
    const { api } = client(
      { tokenScope: { scope: 'project', orgId: ORG_1, projectId: P1, access: 'read_only' } },
      { [`GET /projects/${P1}`]: () => ({ body: { project: { id: P1, org_id: ORG_1 }, branches: [] } }) },
    )
    expect(await resolveProjectFromApi(api, deps().deps)).toEqual({ projectId: P1, orgId: ORG_1, branch: 'main' })
  })

  it('org token: skips GET /orgs and lists the bound org\'s projects', async () => {
    const { api, calls } = client(
      { tokenScope: { scope: 'org', orgId: ORG_2, access: 'full' } },
      {
        'GET /orgs': () => ({ body: { orgs: [{ id: ORG_2 }] } }),
        [`GET /orgs/${ORG_2}/projects`]: () => ({ body: { projects: [{ id: P1, name: 'solo' }] } }),
      },
    )
    const link = await resolveProjectFromApi(api, deps().deps)
    expect(link).toEqual({ projectId: P1, orgId: ORG_2, branch: 'main' })
    expect(calls).toEqual([`GET /orgs/${ORG_2}/projects`])
  })

  it('account login (no stored scope): the original GET /orgs → first org → its projects path', async () => {
    const { api, calls } = client(
      {},
      {
        'GET /orgs': () => ({ body: { orgs: [{ id: ORG_1 }, { id: ORG_2 }] } }),
        [`GET /orgs/${ORG_1}/projects`]: () => ({ body: { projects: [{ id: P1, name: 'solo' }] } }),
      },
    )
    const link = await resolveProjectFromApi(api, deps().deps)
    expect(link).toEqual({ projectId: P1, orgId: ORG_1, branch: 'main' })
    expect(calls).toEqual(['GET /orgs', `GET /orgs/${ORG_1}/projects`])
  })

  it('an account-scoped token record (scope: account) behaves exactly like no scope', async () => {
    const { api, calls } = client(
      { tokenScope: { scope: 'account', access: 'full' } },
      {
        'GET /orgs': () => ({ body: { orgs: [{ id: ORG_1 }] } }),
        [`GET /orgs/${ORG_1}/projects`]: () => ({ body: { projects: [{ id: P1, name: 'solo' }] } }),
      },
    )
    await resolveProjectFromApi(api, deps().deps)
    expect(calls[0]).toBe('GET /orgs')
  })
})
