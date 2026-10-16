// --endpoint udp | tcp+udp: a compute service reached as raw UDP (or TCP and UDP on the one port) at
// its own IPv6 address — the same v6 lane as tcp with a different protocol set. As for tcp, the
// platform owns which ports are allowed (it refuses the udp amplification and platform lists); the
// CLI only spells the flag, sends it, and shows where such a service answers, one scheme per protocol.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseEndpoint, servicesAdd, servicesAddRequestBody, servicesList, serviceListLine, serviceAddedLine, tcpAddress, v6Address } from '../src/commands/services.js'
import { deployRequestBody, deployedTarget, deploy } from '../src/commands/deploy.js'
import { deployArchive } from '../src/deploy-archive.js'
import * as apiModule from '../src/api.js'
import { ApiClient } from '../src/api.js'

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined })

const HOST = 'prod-main-dns-aa6a3.ip.us-east-1.compute.instacloud.tech'

describe('parseEndpoint: udp and tcp+udp', () => {
  it.each([['udp', 'udp'], ['tcp+udp', 'tcp+udp'], [' UDP ', 'udp'], ['TCP+UDP', 'tcp+udp']])('%j is %s', (raw, want) => {
    expect(parseEndpoint(raw)).toBe(want)
  })
  // The platform spells the pair one way only; a near miss is a typo, refused locally.
  it.each(['udp+tcp', 'tcp+', 'tcp,udp', 'tcp udp', 'quic'])('%j is refused', (raw) => {
    expect(() => parseEndpoint(raw)).toThrow(`--endpoint must be http, tcp, udp or tcp+udp, got: ${raw}`)
  })
})

describe('service add --endpoint udp | tcp+udp', () => {
  it.each([['udp'], ['tcp+udp']])('sends endpoint %s', (endpoint) => {
    expect(servicesAddRequestBody('compute', 'dns', 'main', { port: '5000', endpoint })).toMatchObject({ port: 5000, endpoint })
  })

  // No port refusal here: which ports udp accepts is the platform's answer (as for tcp), so a
  // udp-denied port like 53 is sent as given and refused server-side.
  it('does not mirror the platform port list', () => {
    expect(servicesAddRequestBody('compute', 'dns', 'main', { port: '53', endpoint: 'udp' })).toMatchObject({ port: 53, endpoint: 'udp' })
  })

  it.each([
    ['udp on a managed database', 'redis', { endpoint: 'udp' }, '--endpoint is only valid for compute services'],
    ['tcp+udp on storage', 'storage', { endpoint: 'tcp+udp' }, '--endpoint is only valid for compute services'],
    ['a reversed pair', 'compute', { endpoint: 'udp+tcp' }, '--endpoint must be http, tcp, udp or tcp+udp, got: udp+tcp'],
  ])('%s fails locally', async (_label, type, opts, error) => {
    await expect(servicesAdd(type, 'x', opts)).rejects.toThrow(error)
  })

  it('the added line shows a udp service as udp://', () => {
    const line = serviceAddedLine('compute', 'dns', 'main', { id: 's1', type: 'compute', image: 'd', port: 5000, endpoint: 'udp', endpoint_host: HOST, domain: 'ignored.example' })
    expect(line).toBe(`added compute service dns on main (s1)  running d:5000 — udp://${HOST}:5000`)
  })
  it('the added line shows a tcp+udp service under both schemes', () => {
    const line = serviceAddedLine('compute', 'dns', 'main', { id: 's1', type: 'compute', image: 'd', port: 5000, endpoint: 'tcp+udp', endpoint_host: HOST })
    expect(line).toBe(`added compute service dns on main (s1)  running d:5000 — tcp://${HOST}:5000, udp://${HOST}:5000`)
  })
  it('the added line before a deploy has confirmed the host', () => {
    expect(serviceAddedLine('compute', 'dns', 'main', { id: 's1', type: 'compute', port: 5000, endpoint: 'udp' })).toBe('added compute service dns on main (s1) — udp/5000 (address after the first deploy)')
  })
})

describe('service list: udp and tcp+udp rows', () => {
  const base = { type: 'compute', name: 'dns', status: 'active', id: 's1', machine_count: 1, image: 'd', port: 5000 }
  it.each<[string, Record<string, unknown>, string]>([
    ['udp', { endpoint: 'udp', endpoint_host: HOST }, `compute/dns  [active]  x1  running d:5000  udp://${HOST}:5000  s1`],
    ['tcp+udp', { endpoint: 'tcp+udp', endpoint_host: HOST }, `compute/dns  [active]  x1  running d:5000  tcp://${HOST}:5000, udp://${HOST}:5000  s1`],
    ['udp, not yet deployed', { endpoint: 'udp', endpoint_host: null }, 'compute/dns  [active]  x1  running d:5000  udp/5000 (address after the first deploy)  s1'],
    ['tcp+udp, not yet deployed', { endpoint: 'tcp+udp', endpoint_host: null }, 'compute/dns  [active]  x1  running d:5000  tcp+udp/5000 (address after the first deploy)  s1'],
    // A v6 service has no HTTP domain; a stray one on the row must not be shown as its address.
    ['udp with a stray domain', { endpoint: 'udp', endpoint_host: HOST, domain: 'dns.example.com' }, `compute/dns  [active]  x1  running d:5000  udp://${HOST}:5000  s1`],
    // tcp is exactly what it was before udp existed.
    ['tcp (unchanged)', { endpoint: 'tcp', endpoint_host: HOST }, `compute/dns  [active]  x1  running d:5000  tcp://${HOST}:5000  s1`],
    ['http (unchanged)', { endpoint: 'http', domain: 'dns.example.com' }, 'compute/dns  [active]  x1  running d:5000  dns.example.com  s1'],
  ])('%s', (_label, extra, want) => {
    expect(serviceListLine({ ...base, ...extra })).toBe(want)
  })

  it('v6Address for tcp is tcpAddress, with and without a host', () => {
    expect(v6Address({ endpoint: 'tcp', endpoint_host: HOST, port: 7000 })).toBe(tcpAddress({ endpoint_host: HOST, port: 7000 }))
    expect(v6Address({ endpoint: 'tcp', endpoint_host: null, port: 7000 })).toBe(tcpAddress({ endpoint_host: null, port: 7000 }))
  })

  it('--json passes endpoint and endpoint_host through untouched', async () => {
    const rows = [{ ...base, endpoint: 'tcp+udp', endpoint_host: HOST }]
    vi.spyOn(ApiClient, 'load').mockResolvedValue({ request: async () => ({ services: rows }) } as unknown as ApiClient)
    vi.spyOn(apiModule, 'requireProject').mockResolvedValue({ projectId: 'p1', branch: 'main' } as Awaited<ReturnType<typeof apiModule.requireProject>>)
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true })
    await servicesList({ json: true })
    expect(JSON.parse(out.join(''))).toEqual(rows)
  })
})

describe('deploy --endpoint udp | tcp+udp', () => {
  it.each([['udp'], ['tcp+udp']])('rides the deploy body as %s', (endpoint) => {
    expect(deployRequestBody({ image: 'img' }, 'main', { port: '5000', endpoint })).toMatchObject({ endpoint, port: 5000 })
  })

  // An older platform: the result names the host but not the endpoint, so --endpoint is the fallback.
  it.each<[string, { url?: string; endpointHost?: string | null }, string | undefined, 'tcp' | 'udp' | 'tcp+udp' | undefined, string]>([
    ['a udp deploy', { url: '', endpointHost: HOST }, '5000', 'udp', `udp://${HOST}:5000`],
    ['a tcp+udp deploy', { url: '', endpointHost: HOST }, '5000', 'tcp+udp', `tcp://${HOST}:5000, udp://${HOST}:5000`],
    ['a udp deploy with no --port', { url: '', endpointHost: HOST }, undefined, 'udp', `udp://${HOST}:?`],
    // The deploy result names the host, not the protocol: without --endpoint the service kept
    // whatever v6 endpoint it had, so no scheme is guessed (tcp:// would lie about a udp service).
    ['a v6 redeploy without --endpoint', { url: '', endpointHost: HOST }, '5000', undefined, `${HOST}:5000 (endpoint unchanged; \`insta service list\` shows its protocol)`],
  ])('reports %s', (_label, r, port, endpoint, want) => {
    expect(deployedTarget(r, port, endpoint)).toBe(want)
  })
})

// instacloud-platform#681: the result carries `endpoint` beside `endpointHost`, including on a
// redeploy that passed none, and it wins over the flag.
describe('deployedTarget reads the endpoint from the result', () => {
  type Row = [string, { url?: string; endpointHost?: string | null; endpoint?: unknown }, 'http' | 'tcp' | 'udp' | 'tcp+udp' | undefined, string]
  it.each<Row>([
    ['result tcp, no flag (byte-for-byte the tcp line)', { url: '', endpointHost: HOST, endpoint: 'tcp' }, undefined, `tcp://${HOST}:5000`],
    ['result udp, no flag', { url: '', endpointHost: HOST, endpoint: 'udp' }, undefined, `udp://${HOST}:5000`],
    ['result tcp+udp, no flag', { url: '', endpointHost: HOST, endpoint: 'tcp+udp' }, undefined, `tcp://${HOST}:5000, udp://${HOST}:5000`],
    ['flag tcp, result udp: the result wins', { url: '', endpointHost: HOST, endpoint: 'udp' }, 'tcp', `udp://${HOST}:5000`],
    ['flag udp, result tcp+udp: the result wins', { url: '', endpointHost: HOST, endpoint: 'tcp+udp' }, 'udp', `tcp://${HOST}:5000, udp://${HOST}:5000`],
    ['host without endpoint, flag udp (older platform): the flag', { url: '', endpointHost: HOST }, 'udp', `udp://${HOST}:5000`],
    ['host without endpoint, no flag (older platform): no scheme', { url: '', endpointHost: HOST }, undefined, `${HOST}:5000 (endpoint unchanged; \`insta service list\` shows its protocol)`],
    ['a result endpoint this CLI does not know is treated as absent', { url: '', endpointHost: HOST, endpoint: 'sctp' }, undefined, `${HOST}:5000 (endpoint unchanged; \`insta service list\` shows its protocol)`],
    ['http: the URL, unchanged', { url: 'https://app.example' }, undefined, 'https://app.example'],
    ['http with --endpoint http: the URL, unchanged', { url: 'https://app.example' }, 'http', 'https://app.example'],
  ])('%s', (_label, r, flag, want) => {
    expect(deployedTarget(r, '5000', flag)).toBe(want)
  })
})

describe('archive deploy of a udp / tcp+udp service', () => {
  const ref = { archiveSha256: 'a'.repeat(64), build: { type: 'dockerfile' as const } }
  const api = (live: Record<string, unknown>) => {
    const calls: Array<{ method: string; path: string; body?: any }> = []
    const script = [{ status: 202, body: { operationId: 'op_1' } }, { status: 200, body: { state: 'live', imageRef: 'img@sha256:aa', branch: 'main', group: 'dns', ...live } }]
    let i = 0
    return { calls, api: { rawRequest: async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); return script[Math.min(i++, 1)]! } } }
  }
  const noWait = async () => undefined

  it.each([['udp'], ['tcp+udp']])('sends endpoint %s and accepts an empty URL when the platform names the host', async (endpoint) => {
    const { api: a, calls } = api({ url: '', endpointHost: HOST })
    await expect(deployArchive(a, 'p1', ref, 'main', { port: '5000', endpoint }, Date.now, noWait)).resolves.toMatchObject({ url: '', endpointHost: HOST })
    expect(calls[0]!.body).toMatchObject({ endpoint, port: 5000 })
  })

  it.each<[string, unknown, string | undefined]>([
    ['carries the read\'s endpoint', 'udp', 'udp'],
    ['an older platform omits it', undefined, undefined],
    ['an unknown value is dropped', 'sctp', undefined],
  ])('%s', async (_label, endpoint, want) => {
    const { api: a } = api({ url: '', endpointHost: HOST, ...(endpoint !== undefined ? { endpoint } : {}) })
    const out = await deployArchive(a, 'p1', ref, 'main', { port: '5000' }, Date.now, noWait)
    expect((out as { endpoint?: string }).endpoint).toBe(want)
  })
})

// End to end through deploy(): the line a person reads and the JSON an agent reads, for each lane.
describe('deploy() output for a udp service', () => {
  function srcDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'insta-endpoint-udp-'))
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
    return dir
  }

  function fakeApi(resultEndpoint: string | undefined = undefined) {
    const ep = resultEndpoint === undefined ? {} : { endpoint: resultEndpoint }
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const rawRequest = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (path.includes('/source-build')) return { status: 200, body: { lane: 'archive', limits: { maxArchiveBytes: 1e6, maxExtractedBytes: 1e6, maxFiles: 100 } } }
      if (path.includes('/builds/archive/')) return { status: 200, body: { state: 'unsupported', buildState: 'succeeded', steps: [], entries: [] } }
      if (path.includes('/build-uploads/')) return { status: 200, body: { state: 'valid' } }
      if (path.includes('/archive-deploys/')) return { status: 200, body: { state: 'live', imageRef: 'img@sha256:aa', url: '', endpointHost: HOST, ...ep, branch: 'main', group: 'dns' } }
      if (path.includes('/archive-deploys')) return { status: 202, body: { operationId: 'op_1' } }
      if (method === 'POST' && path === '/projects/p1/deploy') return { status: 200, body: { url: '', endpointHost: HOST, ...ep, branch: 'main', group: 'dns', machineId: 'm1' } }
      throw new Error(`unexpected call: ${method} ${path}`)
    })
    return { calls, rawRequest }
  }

  function mockPlatform(rawRequest: ReturnType<typeof vi.fn>) {
    const load = vi.spyOn(ApiClient, 'load').mockResolvedValue({ rawRequest } as unknown as ApiClient)
    const requireProject = vi.spyOn(apiModule, 'requireProject').mockResolvedValue({ projectId: 'p1', branch: 'main' } as Awaited<ReturnType<typeof apiModule.requireProject>>)
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    return { load, requireProject, out }
  }

  it('an invalid pair (udp+tcp) dies before ApiClient.load and requireProject', async () => {
    const { calls, rawRequest } = fakeApi()
    const { load, requireProject } = mockPlatform(rawRequest)
    await expect(deploy(srcDir(), { port: '5000', endpoint: 'udp+tcp' })).rejects.toThrow()
    expect(calls).toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(requireProject).not.toHaveBeenCalled()
  })

  it('archive lane: a normalized udp reaches the body and the line prints udp://', async () => {
    const { calls, rawRequest } = fakeApi()
    const { out } = mockPlatform(rawRequest)
    await deploy(srcDir(), { port: '5000', endpoint: ' UDP ' })
    expect(calls.find((c) => c.method === 'POST' && c.path === '/projects/p1/archive-deploys')?.body).toMatchObject({ endpoint: 'udp', port: 5000 })
    expect(out.join('')).toContain(`deployed img@sha256:aa -> udp://${HOST}:5000 (branch main, group dns)`)
  })

  it('archive lane --json carries endpointHost', async () => {
    const { rawRequest } = fakeApi()
    const { out } = mockPlatform(rawRequest)
    await deploy(srcDir(), { port: '5000', endpoint: 'udp', json: true })
    expect(JSON.parse(out.join(''))).toMatchObject({ image: 'img@sha256:aa', url: '', endpointHost: HOST })
  })

  it('image lane: tcp+udp rides the body and the line prints both schemes', async () => {
    const { calls, rawRequest } = fakeApi()
    const { out } = mockPlatform(rawRequest)
    await deploy(undefined, { image: 'img:2', port: '5000', endpoint: 'tcp+udp' })
    expect(calls.find((c) => c.path === '/projects/p1/deploy')?.body).toMatchObject({ endpoint: 'tcp+udp', port: 5000 })
    expect(out.join('')).toContain(`deployed img:2 -> tcp://${HOST}:5000, udp://${HOST}:5000 (branch main, group dns)`)
  })

  it('image lane --json passes endpointHost through', async () => {
    const { rawRequest } = fakeApi()
    const { out } = mockPlatform(rawRequest)
    await deploy(undefined, { image: 'img:2', port: '5000', endpoint: 'udp', json: true })
    expect(JSON.parse(out.join(''))).toEqual({ image: 'img:2', url: '', endpointHost: HOST, branch: 'main', group: 'dns', machineId: 'm1' })
  })

  it('image lane, plain redeploy of a tcp service: the result endpoint restores the exact tcp:// line', async () => {
    const { calls, rawRequest } = fakeApi('tcp')
    const { out } = mockPlatform(rawRequest)
    await deploy(undefined, { image: 'img:2', port: '5000' })
    expect((calls.find((c) => c.path === '/projects/p1/deploy')?.body as Record<string, unknown>).endpoint).toBeUndefined()
    expect(out.join('')).toBe(`deployed img:2 -> tcp://${HOST}:5000 (branch main, group dns)\n`)
  })

  it('archive lane, plain redeploy of a udp service: udp:// from the read, and --json carries endpoint', async () => {
    const { rawRequest } = fakeApi('udp')
    const { out } = mockPlatform(rawRequest)
    await deploy(srcDir(), { port: '5000' })
    expect(out.join('')).toContain(`deployed img@sha256:aa -> udp://${HOST}:5000 (branch main, group dns)`)
    out.length = 0
    await deploy(srcDir(), { port: '5000', json: true })
    expect(JSON.parse(out.join(''))).toMatchObject({ endpointHost: HOST, endpoint: 'udp' })
  })
})
