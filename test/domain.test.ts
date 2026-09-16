import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { domainSearch, domainBuy, domainAttach, domainList, domainStatus, domainRecordsAdd, domainRecordsList, domainRecordsRemove, domainRecordsSet, ownerOf, searchLines } from '../src/commands/domain.js'
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
  // The platform answers `unavailable` for every unpurchasable row — a name that is taken and a
  // name whose extension is not sold read alike — so echoing it prints the word twice.
  it('does not print the platform default reason twice', () => {
    expect(searchLines([{ domainName: 'myapp.site', purchasable: false, reason: 'unavailable' } as never]))
      .toEqual(['  myapp.site  unavailable'])
    expect(searchLines([{ domainName: 'myapp.dev', purchasable: false, reason: 'Domain unavailable' } as never]))
      .toEqual(['  myapp.dev  unavailable — Domain unavailable'])
  })
})

describe('domain buy', () => {
  // Buying binds nothing, so it names no service and asks for no branch or group.
  it('orders the name alone and prints the checkout link', async () => {
    const { deps: d, calls } = deps()
    await domainBuy('myapp.com', { years: '2', open: false }, d)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/projects/p1/domains/orders' })
    // toEqual, not toMatchObject: the point of this change is the fields that are NOT sent.
    expect(calls[0]!.body).toEqual({ domainName: 'myapp.com', years: 2 })
    expect(out()).toContain('myapp.com — $15.59 for 1 year, then $23.99/yr')
    expect(out()).toContain('https://checkout.test/o1')
    expect(out()).toContain('then attach it: insta domain attach myapp.com')
  })
  it('a gated order prints the approval hint on stderr and exits 2', async () => {
    const { deps: d } = deps({}, { status: 202, body: { status: 'approval_required', approvalId: 'ap1', action: 'domain.purchase' } })
    await domainBuy('myapp.com', {}, d)
    expect(stderr.join('')).toContain('insta approvals approve ap1')
    expect(process.exitCode).toBe(2)
    expect(out()).toBe('')
  })
  it('refuses a malformed --years locally rather than sending NaN', async () => {
    const { deps: d, calls } = deps()
    await expect(domainBuy('myapp.com', { years: 'abc' }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('--years must be a whole number of years, not abc')
    expect(calls).toEqual([])
  })
  it('--json is the platform body, nothing else', async () => {
    const { deps: d } = deps()
    await domainBuy('myapp.com', { json: true }, d)
    expect(JSON.parse(out())).toEqual({ order, quote })
  })
})

describe('domain attach', () => {
  const inventory = { '/projects/p1/domains': { items: [{ domainName: 'myapp.com', status: 'registered', hostnames: [], expiresAt: null, autorenew: true }] } }
  it('a bought name binds it and its www', async () => {
    const { deps: d, calls } = deps(inventory, { status: 200, body: { domainName: 'myapp.com', status: 'registered', hostnames: [{ hostname: 'myapp.com', state: 'pending', service: 'web' }, { hostname: 'www.myapp.com', state: 'pending', service: 'web' }] } })
    await domainAttach('myapp.com', { group: 'web' }, d)
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/projects/p1/domains/myapp.com/attach', body: { hostname: undefined, branch: 'main', group: 'web' } })
    expect(out()).toContain('myapp.com and www.myapp.com will attach to web')
  })
  // The whole point: the subdomain is sent, and the route is still the bought name it sits under.
  it('a subdomain binds only itself, under the name that owns it', async () => {
    const { deps: d, calls } = deps(inventory, { status: 200, body: { domainName: 'myapp.com', status: 'registered', hostnames: [{ hostname: 'www.myapp.com', state: 'active', service: 'api' }, { hostname: 'docs.myapp.com', state: 'pending', service: 'web' }] } })
    await domainAttach('Docs.MyApp.com', { group: 'web' }, d)
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/projects/p1/domains/myapp.com/attach', body: { hostname: 'docs.myapp.com', branch: 'main', group: 'web' } })
    // Only what this request asked for is announced; a hostname the answer carries is not it.
    expect(out()).toContain('docs.myapp.com will attach to web')
    expect(out()).not.toContain('www.myapp.com')
  })
  it('a hostname under no bought name is refused before any service lookup', async () => {
    const { deps: d, calls } = deps({ '/domains/orders': { items: [] }, ...inventory })
    await expect(domainAttach('api.other.com', { group: 'web' }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('no domain this org bought covers api.other.com')
    expect(stderr.join('')).toContain('insta compute set-domain api.other.com')
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET'])
  })
  // `buy` says to run this next; before the registrar answers the name is an order, and ours.
  it('a bought name still registering is refused as an order, not as someone else\'s domain', async () => {
    const { deps: d, calls } = deps({ '/domains/orders': { items: [{ ...order, status: 'registering' }] }, '/projects/p1/domains': { items: [] } })
    await expect(domainAttach('MyApp.com', { group: 'web' }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('myapp.com is not registered yet — its order is registering: insta domain status myapp.com')
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET'])
  })
  it('matches a bought name only on a label boundary', () => {
    const own = (domainName: string) => ({ domainName }) as never
    expect(ownerOf('a.b.myapp.com', [own('myapp.com')])!.domainName).toBe('myapp.com')
    expect(ownerOf('notmyapp.com', [own('myapp.com')])).toBeNull()
  })
})

describe('domain list / status', () => {
  const purchased = { domainName: 'myapp.com', status: 'attaching', expiresAt: '2027-09-10T00:00:00Z', autorenew: true,
    hostnames: [{ hostname: 'api.myapp.com', state: 'active', service: 'api' }, { hostname: 'www.myapp.com', state: 'failed', service: 'web', reason: 'already attached to another compute service' }] }
  it('list prints one block per domain with the service of each hostname, and the hint only where nothing serves', async () => {
    const empty = { domainName: 'old.com', status: 'registered', expiresAt: null, autorenew: true, hostnames: [] }
    const moving = { domainName: 'new.com', status: 'attaching', expiresAt: null, autorenew: true,
      hostnames: [{ hostname: 'new.com', state: 'pending', service: 'web' }] }
    const sub = { domainName: 'sub.com', status: 'attach_failed', expiresAt: null, autorenew: true,
      hostnames: [{ hostname: 'api.sub.com', state: 'failed', service: 'api', reason: 'dns publish failed' }] }
    const both = { domainName: 'both.com', status: 'attach_failed', expiresAt: null, autorenew: true,
      hostnames: [{ hostname: 'both.com', state: 'failed', service: 'web' }, { hostname: 'www.both.com', state: 'failed', service: 'web' }] }
    const { deps: d } = deps({ '/projects/p1/domains': { items: [purchased, empty, moving, sub, both] } })
    await domainList({}, d)
    expect(out()).toContain('myapp.com  attaching  (expires 2027-09-10, auto-renews)')
    expect(out()).toContain('api.myapp.com  active → api')
    expect(out()).toContain('www.myapp.com  failed → web — already attached to another compute service')
    expect(out()).toContain('nothing serving — insta domain attach old.com\n')
    // An attach in flight is not "nothing serving": that line would tell you to re-run what you ran.
    expect(out()).not.toContain('insta domain attach new.com')
    expect(out()).not.toContain('insta domain attach myapp.com')
    // The repair is the hostname that failed: attaching sub.com would bind it and its www instead.
    expect(out()).toContain('nothing serving — insta domain attach api.sub.com\n')
    // The bought name re-attaches its www, so it is not asked for twice.
    expect(out()).toContain('nothing serving — insta domain attach both.com\n')
  })
  it('status shows the domain once it exists, else the order', async () => {
    const { deps: d } = deps({ '/domains/orders': { items: [{ ...order, status: 'attaching' }] }, '/projects/p1/domains': { items: [purchased] } })
    await domainStatus('MyApp.com', {}, d)
    expect(out()).not.toContain('order o1')
    expect(out()).toContain('api.myapp.com  active → api')
  })
  it('a canceled checkout says how to order again', async () => {
    const { deps: d } = deps({ '/domains/orders': { items: [{ ...order, status: 'canceled', failedReason: 'checkout expired before payment' }] }, '/projects/p1/domains': { items: [] } })
    await domainStatus('myapp.com', {}, d)
    expect(out()).toContain('canceled — checkout expired before payment')
    expect(out()).toContain('order again: insta domain buy myapp.com')
  })
  it('status of a name never bought here fails plainly, --json included', async () => {
    const { deps: d } = deps({ '/domains/orders': { items: [] }, '/projects/p1/domains': { items: [] } })
    await expect(domainStatus('other.com', { json: true }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('other.com was not bought through this org')
    expect(out()).toBe('')
  })
})

describe('domain records', () => {
  const zone = [
    { id: 101, type: 'CNAME', fqdn: 'www.myapp.com', answer: 'edge.instacloud.com', ttl: 300, managed: true, hostname: 'www.myapp.com' },
    { id: 102, type: 'TXT', fqdn: '_stale.myapp.com', answer: 'gone', ttl: 300, managed: true },
    { id: 103, type: 'MX', fqdn: 'myapp.com', answer: 'mx1.mail.test', ttl: 3600, priority: 10, managed: false },
  ]
  it('lists the zone of the linked org with managed records marked; --org overrides and --json is the platform body', async () => {
    const { deps: d, calls } = deps({ '/records': { items: zone } })
    await domainRecordsList('myapp.com', {}, d)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/orgs/org1/domains/myapp.com/records' })
    const lines = out().split('\n')
    expect(lines[0]).toContain('101  CNAME  www.myapp.com     edge.instacloud.com  300')
    expect(lines[0]).toContain('(managed — published for www.myapp.com)')
    expect(lines[1]).toContain('(managed — no hostname claims it; remove drops it)')
    expect(lines[2]).toMatch(/103  MX {5}myapp.com {9}mx1.mail.test {8}3600  10$/)
    await domainRecordsList('myapp.com', { org: 'org9', json: true }, d)
    expect(calls[1]!.path.startsWith('/orgs/org9/')).toBe(true)
    expect(JSON.parse(stdout.at(-1)!)).toEqual({ items: zone })
  })
  it('says how to add the first record of an empty zone, naming the domain', async () => {
    const { deps: d } = deps({ '/records': { items: [] } })
    await domainRecordsList('myapp.com', {}, d)
    expect(out()).toContain('no records in myapp.com — add one: insta domain records add myapp.com A @ <ip>')
  })
  it('adds a record with the type upper-cased and the numbers as numbers, and prints it back', async () => {
    const created = { id: 104, type: 'MX', fqdn: 'myapp.com', answer: 'mx2.mail.test', ttl: 600, priority: 20, managed: false }
    const { deps: d, calls } = deps({ '/records': created })
    await domainRecordsAdd('myapp.com', 'mx', '@', 'mx2.mail.test', { ttl: '600', priority: '20' }, d)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/orgs/org1/domains/myapp.com/records' })
    expect(calls[0]!.body).toEqual({ type: 'MX', host: '@', answer: 'mx2.mail.test', ttl: 600, priority: 20 })
    expect(out()).toContain('104  MX  myapp.com  mx2.mail.test  600  20')
  })
  it('omits a flag that was not given, so the platform applies its default', async () => {
    const { deps: d, calls } = deps({ '/records': zone[2] })
    await domainRecordsAdd('myapp.com', 'A', 'www', '203.0.113.7', {}, d)
    expect(calls[0]!.body).toEqual({ type: 'A', host: 'www', answer: '203.0.113.7' })
  })
  it('refuses a malformed --ttl or --priority locally, sending nothing', async () => {
    const { deps: d, calls } = deps()
    await expect(domainRecordsAdd('myapp.com', 'A', '@', '203.0.113.7', { ttl: 'soon' }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('--ttl must be a whole number, not soon')
    await expect(domainRecordsAdd('myapp.com', 'MX', '@', 'mx.test', { priority: 'high' }, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('--priority must be a whole number, not high')
    expect(calls).toEqual([])
  })
  it('changes only the fields given, upper-casing a type, and refuses a set that names none', async () => {
    const { deps: d, calls } = deps({ '/records/103': { ...zone[2], ttl: 600 } })
    await domainRecordsSet('myapp.com', '103', { type: 'mx', ttl: '600' }, d)
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/orgs/org1/domains/myapp.com/records/103' })
    expect(calls[0]!.body).toEqual({ type: 'MX', ttl: 600 })
    expect(out()).toContain('103  MX  myapp.com  mx1.mail.test  600  10')
    await expect(domainRecordsSet('myapp.com', '103', {}, d)).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('nothing to change')
    expect(calls).toHaveLength(1)
  })
  it('removes a record by id', async () => {
    const { deps: d, calls } = deps({ '/records/103': { ok: true } })
    await domainRecordsRemove('myapp.com', '103', {}, d)
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/orgs/org1/domains/myapp.com/records/103' })
    expect(out()).toContain('removed record 103 from myapp.com')
    await domainRecordsRemove('myapp.com', '103', { json: true }, d)
    expect(JSON.parse(stdout.at(-1)!)).toEqual({ ok: true })
  })
})
