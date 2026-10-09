// --endpoint tcp: a compute service reached as raw TCP on its port at its own IPv6 address. The
// platform owns which ports are allowed; the CLI only spells the flag, sends it, and shows where
// such a service answers (it has no URL).
import { describe, it, expect, afterEach } from 'vitest'
import { parseEndpoint, servicesAdd, servicesAddRequestBody, serviceListLine, serviceAddedLine, tcpAddress } from '../src/commands/services.js'
import { deployRequestBody, deployedTarget } from '../src/commands/deploy.js'
import { deployArchive } from '../src/deploy-archive.js'

afterEach(() => { process.exitCode = undefined })

const HOST = 'prod-main-game-aa6a3.ip.us-east-1.compute.instacloud.tech'

describe('parseEndpoint', () => {
  it.each([['http', 'http'], ['tcp', 'tcp'], [' TCP ', 'tcp']])('%j is %s', (raw, want) => {
    expect(parseEndpoint(raw)).toBe(want)
  })
  it.each(['udp', 'v6', '', 'https'])('%j is refused', (raw) => {
    expect(() => parseEndpoint(raw)).toThrow(/--endpoint must be http or tcp/)
  })
})

describe('service add --endpoint', () => {
  it('sends the endpoint only when the flag was given', () => {
    expect(servicesAddRequestBody('compute', 'game', 'main', { port: '25565', endpoint: 'tcp' })).toMatchObject({ port: 25565, endpoint: 'tcp' })
    expect(servicesAddRequestBody('compute', 'api', 'main', { port: '3000' })).not.toHaveProperty('endpoint')
  })

  // Refused before any config or network access: the test has neither, so reaching either would
  // fail differently.
  it.each([
    ['on a managed database', 'redis', { endpoint: 'tcp' }, '--endpoint is only valid for compute services'],
    ['with a typo', 'compute', { endpoint: 'tpc' }, '--endpoint must be http or tcp, got: tpc'],
  ])('%s fails locally', async (_label, type, opts, error) => {
    await expect(servicesAdd(type, 'x', opts)).rejects.toThrow(error)
  })

  it('the added line shows the tcp address, not a domain', () => {
    const line = serviceAddedLine('compute', 'game', 'main', { id: 's1', type: 'compute', image: 'mc', port: 25565, endpoint: 'tcp', endpoint_host: HOST })
    expect(line).toContain(`— tcp://${HOST}:25565`)
  })
})

describe('service list', () => {
  const base = { type: 'compute', name: 'game', status: 'active', id: 's1', machine_count: 1, image: 'mc', port: 25565 }
  it('a tcp row shows where to dial it', () => {
    expect(serviceListLine({ ...base, endpoint: 'tcp', endpoint_host: HOST })).toContain(`  tcp://${HOST}:25565  s1`)
  })
  it('a tcp row not yet deployed says so instead of inventing an address', () => {
    expect(serviceListLine({ ...base, endpoint: 'tcp', endpoint_host: null })).toContain('tcp/25565 (address after the first deploy)')
  })
  it('an http row is unchanged', () => {
    expect(serviceListLine({ ...base, domain: 'game.example.com' })).toBe('compute/game  [active]  x1  running mc:25565  game.example.com  s1')
    expect(serviceListLine({ ...base, endpoint: 'http', domain: 'game.example.com' })).toBe('compute/game  [active]  x1  running mc:25565  game.example.com  s1')
  })
  it('tcpAddress', () => {
    expect(tcpAddress({ endpoint_host: HOST, port: 7000 })).toBe(`tcp://${HOST}:7000`)
  })
})

describe('deploy --endpoint', () => {
  it('rides the deploy body only when given', () => {
    expect(deployRequestBody({ image: 'img' }, 'main', { port: '7000', endpoint: 'tcp' })).toMatchObject({ endpoint: 'tcp', port: 7000 })
    expect(deployRequestBody({ image: 'img' }, 'main', { port: '7000' }).endpoint).toBeUndefined()
    expect(() => deployRequestBody({ image: 'img' }, 'main', { endpoint: 'udp' })).toThrow(/--endpoint must be http or tcp/)
  })

  it.each<[string, { url?: string; endpointHost?: string | null }, string | undefined, string]>([
    ['a tcp deploy', { url: '', endpointHost: HOST }, '7000', `tcp://${HOST}:7000`],
    ['an http deploy', { url: 'https://app.example' }, '7000', 'https://app.example'],
    ['a worker', { url: '' }, '0', '(no URL: a worker)'],
  ])('reports %s', (_label, r, port, want) => {
    expect(deployedTarget(r, port)).toBe(want)
  })
})

describe('archive deploy of a tcp service', () => {
  const ref = { archiveSha256: 'a'.repeat(64), build: { type: 'dockerfile' as const } }
  const api = (live: Record<string, unknown>) => {
    const calls: Array<{ method: string; path: string; body?: any }> = []
    const script = [{ status: 202, body: { operationId: 'op_1' } }, { status: 200, body: { state: 'live', imageRef: 'img@sha256:aa', branch: 'main', group: 'game', ...live } }]
    let i = 0
    return { calls, api: { rawRequest: async (method: string, path: string, body?: unknown) => { calls.push({ method, path, body }); return script[Math.min(i++, 1)]! } } }
  }
  const noWait = async () => undefined

  it('sends the endpoint and accepts an empty URL when the platform names the tcp host', async () => {
    const { api: a, calls } = api({ url: '', endpointHost: HOST })
    await expect(deployArchive(a, 'p1', ref, 'main', { port: '7000', endpoint: 'tcp' }, Date.now, noWait)).resolves.toMatchObject({ url: '', endpointHost: HOST })
    expect(calls[0]!.body).toMatchObject({ endpoint: 'tcp', port: 7000 })
  })

  // The control: the same empty URL with no tcp host is still the "no URL" failure it always was.
  it('still refuses an empty URL with no tcp host', async () => {
    const { api: a } = api({ url: '' })
    await expect(deployArchive(a, 'p1', ref, 'main', { port: '7000' }, Date.now, noWait)).rejects.toThrow(/no image or URL/)
  })
})
