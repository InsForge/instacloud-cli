// The COMMAND-level flow of the three domain verbs, through the injected API seam (r2d2 round 1
// Suggestion — the pure renderers are covered in compute-domain-region.test.ts, this covers what
// the commands actually send and print): the preflight service lookup, the explicit `group` on
// every call so the platform's `default` fallback is never relied on, --json passing the platform
// body through untouched, and 409 → the release-then-rebind message.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { setDomain, checkDomain, removeDomain, type DomainDeps } from '../src/commands/compute.js'
import { ApiError } from '../src/api.js'

const services = [
  { id: 's1', type: 'compute', name: 'api', status: 'running', region: 'us-east', domain: 'api.compute.instacloud.com', port: 8080 },
  { id: 's2', type: 'compute', name: 'web', status: 'running', region: 'us-west', domain: 'web.compute.instacloud.com', port: 3000 },
]
const view = {
  hostname: 'app.customer.com', flyApp: 'api-main-1a2b', configured: false, status: 'pending_dns',
  service: 'api', region: 'us-east', ssl: 'initializing',
  dns: [{ type: 'TXT', name: '_insta-verify.app.customer.com', value: 'insta-verify=tok', status: 'missing' }],
}

type Call = { method: string; path: string; body?: unknown }
function deps(over: { get?: unknown; post?: unknown; del?: unknown; only?: boolean } = {}) {
  const calls: Call[] = []
  const throwIf = (v: unknown) => { if (v instanceof Error) throw v; return v }
  const api = {
    request: async (method: string, path: string) => {
      calls.push({ method, path })
      if (path.includes('/services?') || path.endsWith('/services')) return { services: over.only ? [services[0]] : services }
      return throwIf(over.get ?? view)
    },
    rawRequest: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return { status: 200, body: throwIf(method === 'DELETE' ? (over.del ?? { hostname: 'app.customer.com', flyApp: 'api-main-1a2b' }) : (over.post ?? view)) }
    },
  }
  return { deps: { api, project: { projectId: 'p1', branch: 'main' } } as unknown as DomainDeps, calls }
}

const stdout: string[] = []
const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
afterEach(() => { stdout.length = 0 })
afterAll(() => { outSpy.mockRestore() })
const out = () => stdout.join('')

describe('setDomain flow', () => {
  it('looks the services up first, then sends the RESOLVED group (never the platform default)', async () => {
    const { deps: d, calls } = deps()
    await setDomain('app.customer.com', { group: 'web' }, d)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/projects/p1/services?branch=main' })
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/projects/p1/compute/domain', body: { hostname: 'app.customer.com', branch: 'main', group: 'web' } })
    expect(out()).toContain('add these DNS records at your DNS provider:')
  })

  it('an ambiguous project is refused BEFORE any write reaches the platform', async () => {
    const { deps: d, calls } = deps()
    await expect(setDomain('app.customer.com', {}, d)).rejects.toThrow(/pass --group to choose which one serves/)
    expect(calls.map((c) => c.method)).toEqual(['GET']) // nothing was attached
  })

  it('a sole compute service needs no --group', async () => {
    const { deps: d, calls } = deps({ only: true })
    await setDomain('app.customer.com', {}, d)
    expect(calls[1]).toMatchObject({ body: { group: 'api' } })
  })

  it('--json prints the platform body verbatim, no prose', async () => {
    const { deps: d } = deps({ only: true })
    await setDomain('app.customer.com', { json: true }, d)
    expect(JSON.parse(out())).toEqual(view)
    expect(out()).not.toContain('add these DNS records')
  })

  it('a 409 becomes the release-then-rebind message, carrying the owner group and the branch', async () => {
    // The owner (`web`) IS a service in this project, so the message can name the exact command.
    const { deps: d } = deps({ post: new ApiError(409, 'app.customer.com is already attached to web in us-west; remove it there first') })
    await expect(setDomain('app.customer.com', { group: 'api', branch: 'preview' }, d)).rejects.toThrow(
      /domains are not moved; release it first: insta domain detach app\.customer\.com --group web --branch preview/,
    )
  })

  it('a 409 naming a service that is NOT in this project points at an operator, not a command', async () => {
    const { deps: d } = deps({ only: true, post: new ApiError(409, 'app.customer.com is already attached to old-api in us-east; remove it there first') })
    await expect(setDomain('app.customer.com', {}, d)).rejects.toThrow(
      /not a service in this project — it is held by a deleted service .*ask an operator to release the hostname/,
    )
  })

  it('a non-409 API error is not reworded', async () => {
    const { deps: d } = deps({ only: true, post: new ApiError(400, 'invalid domain: nope') })
    await expect(setDomain('app.customer.com', {}, d)).rejects.toThrow('invalid domain: nope')
  })
})

describe('checkDomain flow', () => {
  it('sends hostname + resolved group + branch, and renders the stages', async () => {
    const { deps: d, calls } = deps({ only: true })
    await checkDomain('app.customer.com', {}, d)
    expect(calls[1]!.path).toBe('/projects/p1/compute/domain?hostname=app.customer.com&group=api&branch=main')
    expect(out()).toContain('  ownership   pending')
  })

  it('--json is the platform body verbatim', async () => {
    const { deps: d } = deps({ only: true })
    await checkDomain('app.customer.com', { json: true }, d)
    expect(JSON.parse(out())).toEqual(view)
  })
})

describe('removeDomain flow', () => {
  it('sends the resolved group and names the service and region it was removed from', async () => {
    const { deps: d, calls } = deps({ only: true })
    await removeDomain('app.customer.com', {}, d)
    expect(calls[1]).toMatchObject({ method: 'DELETE', body: { hostname: 'app.customer.com', branch: 'main', group: 'api' } })
    expect(out()).toContain('removed custom domain app.customer.com from api (us-east)')
  })
})
