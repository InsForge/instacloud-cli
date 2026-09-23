import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { zoneDelegate, zoneList, zoneRecords, zoneRelease, zoneLines, zoneRecordLines } from '../src/commands/domain.js'
import type { DomainDeps } from '../src/commands/compute.js'

const awaiting = {
  domainName: 'byo.example',
  status: 'awaiting_ns' as const,
  nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
  delegated: false,
}

type Call = { method: string; path: string; body?: unknown; scope?: unknown }
function deps(answers: Record<string, unknown> = {}, raw: { status: number; body: unknown } = { status: 200, body: awaiting }) {
  const calls: Call[] = []
  const api = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      const hit = Object.entries(answers).find(([k]) => path.includes(k))
      if (!hit) throw new Error(`unexpected ${method} ${path}`)
      return hit[1]
    },
    rawRequest: async (method: string, path: string, body?: unknown, scope?: unknown) => { calls.push({ method, path, body, scope }); return raw },
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

describe('domain zone delegate', () => {
  it('posts the domain, signs for the linked project (zone.delegate reads there), and prints the switch instructions', async () => {
    const { deps: d, calls } = deps({}, { status: 200, body: awaiting })
    await zoneDelegate('Byo.Example', {}, d)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/orgs/org1/zones', body: { domainName: 'Byo.Example' }, scope: { projectId: 'p1' } })
    expect(out()).toContain('waiting for nameservers')
    expect(out()).toContain('ada.ns.cloudflare.com, bob.ns.cloudflare.com')
    // The review-then-switch contract is the safety of the whole flow — it prints every time.
    expect(out()).toContain('insta domain zone records byo.example')
    expect(out()).toContain('only then switch the nameservers')
  })
  it('under --org naming ANOTHER org the call goes projectless — the wrong project must not sign', async () => {
    const { deps: d, calls } = deps({}, { status: 200, body: awaiting })
    await zoneDelegate('byo.example', { org: 'org9' }, d)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/orgs/org9/zones' })
    expect((calls[0] as { scope?: unknown }).scope).toBeUndefined()
  })
  it('stops at approval_required like the other gated verbs', async () => {
    const { deps: d } = deps({}, { status: 202, body: { status: 'approval_required', approvalId: 'ap1', action: 'zone.delegate' } })
    await zoneDelegate('byo.example', {}, d)
    expect(process.exitCode).toBe(2)
  })
  it('--json is the platform body, verbatim', async () => {
    const { deps: d } = deps({}, { status: 200, body: awaiting })
    await zoneDelegate('byo.example', { json: true }, d)
    expect(JSON.parse(out())).toEqual(awaiting)
  })
})

describe('domain zone list', () => {
  it('prints each zone with its state, and an honest empty line', async () => {
    const { deps: d, calls } = deps({ '/zones': { items: [awaiting, { ...awaiting, domainName: 'live.example', status: 'active', delegated: true }] } })
    await zoneList({}, d)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/orgs/org1/zones' })
    expect(out()).toContain('byo.example  waiting for nameservers')
    expect(out()).toContain('live.example  delegated (ada.ns.cloudflare.com, bob.ns.cloudflare.com)')
    stdout.length = 0
    const { deps: d2 } = deps({ '/zones': { items: [] } })
    await zoneList({}, d2)
    expect(out()).toContain('no delegated zones')
  })
})

describe('domain zone records', () => {
  it('lists EVERY type (the review must see CAA) and prints the add-then-reimport reminder', async () => {
    const { deps: d, calls } = deps({
      '/zones/byo.example/records': { items: [
        { type: 'CNAME', host: '@', answer: 'edge.example', proxied: true },
        { type: 'CAA', host: '@', answer: '0 issue "letsencrypt.org"' },
        { type: 'TXT', host: 'mail', answer: 'v=spf1 -all', ttl: 300 },
      ] },
    })
    await zoneRecords('byo.example', {}, d)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/orgs/org1/zones/byo.example/records' })
    expect(out()).toContain('CAA')
    expect(out()).toContain('(proxied)')
    expect(out()).toContain('re-run `insta domain zone delegate` to re-import')
  })
  it('says plainly when the scan has not landed yet', () => {
    expect(zoneRecordLines([])[0]).toContain('run this again in a moment')
  })
})

describe('domain zone release', () => {
  it('deletes the zone and prints the re-point instruction', async () => {
    const { deps: d, calls } = deps({}, { status: 200, body: { domainName: 'byo.example', released: true } })
    await zoneRelease('byo.example', {}, d)
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/orgs/org1/zones/byo.example', scope: { projectId: 'p1' } })
    expect(out()).toContain('byo.example  released')
    expect(out()).toContain('point the domain\'s nameservers back')
  })
  it('stops at approval_required', async () => {
    const { deps: d } = deps({}, { status: 202, body: { status: 'approval_required', approvalId: 'ap2', action: 'zone.delegate' } })
    await zoneRelease('byo.example', {}, d)
    expect(process.exitCode).toBe(2)
  })
})

describe('zoneLines', () => {
  it('carries --org into the review hint so the copy-paste works from any directory', () => {
    const lines = zoneLines(awaiting, 'org9')
    expect(lines.join('\n')).toContain('insta domain zone records byo.example --org org9')
  })
})
