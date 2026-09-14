import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { domainSearch, domainBuy, domainAttach, domainList, domainStatus, domainContactSet, contactFromOpts, searchLines } from '../src/commands/domain.js'
import type { DomainDeps } from '../src/commands/compute.js'

const services = [
  { id: 's1', type: 'compute', name: 'api', status: 'running', region: 'us-east', domain: 'api.compute.instacloud.com', port: 8080 },
  { id: 's2', type: 'compute', name: 'web', status: 'running', region: 'us-west', domain: 'web.compute.instacloud.com', port: 3000 },
]
const quote = { domainName: 'myapp.com', tld: 'com', purchasable: true, premium: false, priceCents: 1559, renewalPriceCents: 2399, currency: 'usd' }
const order = { id: 'o1', domainName: 'myapp.com', years: 1, status: 'pending_payment', priceCents: 1559, renewalPriceCents: 2399, currency: 'usd', service: 'web', branch: 'main', checkoutUrl: 'https://checkout.test/o1', createdAt: 't', paidAt: null, registeredAt: null, failedReason: null }

type Call = { method: string; path: string; body?: unknown }
function deps(answers: Record<string, unknown> = {}, raw: { status: number; body: unknown } = { status: 200, body: { order, quote } }) {
  const calls: Call[] = []
  const api = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (path.includes('/services')) return { services }
      const hit = Object.entries(answers).find(([k]) => path.includes(k))
      if (!hit) throw new Error(`unexpected ${method} ${path}`)
      return hit[1]
    },
    rawRequest: async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); return raw },
  }
  return { deps: { api, project: { projectId: 'p1', orgId: 'org1', branch: 'main' } } as unknown as DomainDeps, calls }
}

const stdout: string[] = []
const stderr: string[] = []
const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = 0 })
afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })
const out = () => stdout.join('')

describe('domain search', () => {
  it('queries the org with the keyword and TLD filter, and prints prices with renewals', async () => {
    const { deps: d, calls } = deps({ '/domains/search': { results: [quote, { domainName: 'myapp.dev', purchasable: false, reason: 'Domain unavailable' }] } })
    await domainSearch('MyApp', { tlds: 'com,dev' }, d)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/orgs/org1/domains/search?q=MyApp&tlds=com%2Cdev' })
    expect(out()).toContain('myapp.com  $15.59  (renews $23.99/yr)')
    expect(out()).toContain('myapp.dev  unavailable — Domain unavailable')
    expect(out()).toContain('buy one: insta domain buy myapp.com')
  })
  it('--org overrides the linked org; --json is the platform body', async () => {
    const { deps: d, calls } = deps({ '/domains/search': { results: [quote] } })
    await domainSearch('myapp', { org: 'org9', json: true }, d)
    expect(calls[0]!.path.startsWith('/orgs/org9/')).toBe(true)
    expect(JSON.parse(out())).toEqual({ results: [quote] })
  })
  it('renders an empty result honestly', () => {
    expect(searchLines([])).toEqual(['no results'])
  })
})

describe('domain buy', () => {
  it('resolves the target service first, then orders with the RESOLVED group and prints the checkout link', async () => {
    const { deps: d, calls } = deps()
    await domainBuy('myapp.com', { group: 'web', years: '2', open: false }, d)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/projects/p1/services?branch=main' })
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/projects/p1/domains/orders', body: { domainName: 'myapp.com', years: 2, branch: 'main', group: 'web' } })
    expect(out()).toContain('myapp.com — $15.59 for 1 year, then $23.99/yr')
    expect(out()).toContain('attaches to web (branch main) as myapp.com and www.myapp.com once paid')
    expect(out()).toContain('https://checkout.test/o1')
    expect(out()).toContain('then: insta domain status myapp.com')
  })
  it('an ambiguous project is refused BEFORE any order is placed', async () => {
    const { deps: d, calls } = deps()
    await expect(domainBuy('myapp.com', {}, d)).rejects.toThrow(/pass --group/)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
  it('a gated order prints the approval hint on stderr and exits 2', async () => {
    const { deps: d } = deps({}, { status: 202, body: { status: 'approval_required', approvalId: 'ap1', action: 'domain.purchase' } })
    await domainBuy('myapp.com', { group: 'web' }, d)
    expect(stderr.join('')).toContain('insta approvals approve ap1')
    expect(process.exitCode).toBe(2)
    expect(out()).toBe('')
  })
  it('refuses a malformed --years locally rather than sending NaN', async () => {
    const { deps: d, calls } = deps()
    await expect(domainBuy('myapp.com', { group: 'web', years: 'abc' }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('--years must be a whole number of years, not abc')
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })
  it('--json is the platform body, nothing else', async () => {
    const { deps: d } = deps()
    await domainBuy('myapp.com', { group: 'web', json: true }, d)
    expect(JSON.parse(out())).toEqual({ order, quote })
  })
})

describe('domain attach', () => {
  it('resolves the service, then POSTs the attach', async () => {
    const { deps: d, calls } = deps({}, { status: 200, body: { domainName: 'myapp.com', status: 'registered', service: 'web', hostnames: [{ hostname: 'myapp.com', state: 'pending' }, { hostname: 'www.myapp.com', state: 'pending' }] } })
    await domainAttach('myapp.com', { group: 'web' }, d)
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/projects/p1/domains/myapp.com/attach', body: { branch: 'main', group: 'web' } })
    expect(out()).toContain('myapp.com will attach to web as myapp.com and www.myapp.com')
  })
})

describe('contactFromOpts', () => {
  const flags = { firstName: 'Ada', lastName: 'Lovelace', address1: '1 Analytical Way', city: 'Seattle', state: 'WA', zip: '98101', country: 'US', email: 'ada@example.com', phone: '+12065550100' }
  it('builds the contact from the flags given; the platform validates', () => {
    expect(contactFromOpts({ ...flags, companyName: 'Acme' })).toEqual({ ...flags, companyName: 'Acme' })
    expect(contactFromOpts({ firstName: 'Ada' })).toEqual({ firstName: 'Ada' })
  })
  it('a file wins over flags', () => {
    expect(contactFromOpts({ firstName: 'Ada' }, { firstName: 'X' })).toEqual({ firstName: 'X' })
  })
  it('no flags and no file means "no contact given"', () => {
    expect(contactFromOpts({})).toBeUndefined()
  })
})

describe('domain contact set', () => {
  it('PUTs the org contact and refuses an empty one locally', async () => {
    const flags = { firstName: 'Ada', lastName: 'Lovelace', address1: '1 Analytical Way', city: 'Seattle', state: 'WA', zip: '98101', country: 'US', email: 'ada@example.com', phone: '+12065550100' }
    const { deps: d, calls } = deps({ '/domains/contact': { contact: { ...flags } } })
    await domainContactSet(flags, d)
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/orgs/org1/domains/contact', body: flags })
    expect(out()).toContain('registrant contact saved:')
    expect(out()).toContain('Ada Lovelace')
    await expect(domainContactSet({}, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('pass the contact as flags')
  })
})

describe('domain list / status', () => {
  const purchased = { domainName: 'myapp.com', status: 'attaching', service: 'web', expiresAt: '2027-09-10T00:00:00Z', autorenew: true,
    hostnames: [{ hostname: 'myapp.com', state: 'attached' }, { hostname: 'www.myapp.com', state: 'failed', reason: 'already attached to another compute service' }] }
  it('list prints one block per domain with the per-hostname state, and the attach hint for a detached one', async () => {
    const detached = { domainName: 'old.com', status: 'detached', service: null, expiresAt: null, autorenew: true, hostnames: [] }
    const { deps: d } = deps({ '/domains': { items: [purchased, detached] } })
    await domainList({}, d)
    expect(out()).toContain('myapp.com  attaching  → web  (expires 2027-09-10, auto-renews)')
    expect(out()).toContain('www.myapp.com  failed — already attached to another compute service')
    expect(out()).toContain('old.com  detached')
    expect(out()).toContain('attach it again: insta domain attach old.com\n')
  })
  it('status shows the domain once it exists, else the order', async () => {
    const { deps: d } = deps({ '/domains/orders': { items: [{ ...order, status: 'attaching' }] }, '/domains': { items: [purchased] } })
    await domainStatus('MyApp.com', {}, d)
    expect(out()).not.toContain('order o1')
    expect(out()).toContain('myapp.com  attaching  → web')
  })
  it('a canceled checkout says how to order again', async () => {
    const { deps: d } = deps({ '/domains/orders': { items: [{ ...order, status: 'canceled', failedReason: 'checkout expired before payment' }] }, '/domains': { items: [] } })
    await domainStatus('myapp.com', {}, d)
    expect(out()).toContain('canceled — checkout expired before payment')
    expect(out()).toContain('order again: insta domain buy myapp.com')
  })
  it('status of a name never bought here fails plainly, --json included', async () => {
    const { deps: d } = deps({ '/domains/orders': { items: [] }, '/domains': { items: [] } })
    await expect(domainStatus('other.com', { json: true }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('other.com was not bought through this project')
    expect(out()).toBe('')
  })
})
