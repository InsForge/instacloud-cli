// `insta redis|mysql|mongodb status` — the platform's /services/:id/state is compute-only, so this
// reads the project's runtime-health and picks the service's entry. DI seam, no network.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { managedStatus, statusLine, type ManagedDeps } from '../src/commands/managed-db.js'

const services = [
  { id: 'r1', type: 'redis', name: 'cache', status: 'running' },
  { id: 'm1', type: 'mysql', name: 'db', status: 'running' },
  { id: 'c1', type: 'compute', name: 'api', status: 'running' },
]
const health = { services: [
  { serviceId: 'r1', status: 'standby', machines: 1, failing: 0 },
  { serviceId: 'm1', status: 'crashed', machines: 1, failing: 1 },
  { serviceId: 'c1', status: 'healthy', machines: 2, failing: 0, desiredReplicas: 2 },
] }
function deps() {
  const calls: string[] = []
  const api = {
    request: async (_m: string, path: string) => {
      calls.push(path)
      return path.includes('/runtime-health') ? health : { services }
    },
  }
  return { deps: { api, project: { projectId: 'p1', branch: 'main' } } as unknown as ManagedDeps, calls }
}

const stdout: string[] = []
const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
afterEach(() => { stdout.length = 0 })
afterAll(() => outSpy.mockRestore())
const out = () => stdout.join('')

describe('statusLine', () => {
  it('names the type, the service, the status and the machine counts', () => {
    expect(statusLine('redis', 'cache', { serviceId: 'r1', status: 'standby', machines: 1, failing: 0 }))
      .toBe('redis cache: standby  (1 machine, 0 failing)')
    expect(statusLine('mysql', 'db', { serviceId: 'm1', status: 'crashed', machines: 2, failing: 1 }))
      .toBe('mysql db: crashed  (2 machines, 1 failing)')
  })
  it('says unknown when the health read omitted the service', () => {
    expect(statusLine('mongodb', 'docs', undefined)).toContain('mongodb docs: unknown')
  })
})

describe('managedStatus', () => {
  it('resolves the sole service of the type, then reads runtime-health for the branch', async () => {
    const { deps: d, calls } = deps()
    await managedStatus('redis', undefined, {}, d)
    expect(calls[0]).toBe('/projects/p1/services?branch=main')
    expect(calls[1]).toBe('/projects/p1/runtime-health?branch=main')
    expect(out()).toContain('redis cache: standby  (1 machine, 0 failing)')
  })
  it("--json prints that service's entry verbatim", async () => {
    const { deps: d } = deps()
    await managedStatus('mysql', 'db', { json: true }, d)
    expect(JSON.parse(out())).toEqual({ serviceId: 'm1', status: 'crashed', machines: 1, failing: 1 })
  })
  it('refuses a name of another type, and a type with no service', async () => {
    const { deps: d } = deps()
    await expect(managedStatus('redis', 'db', {}, d)).rejects.toThrow('redis service not found: db')
    await expect(managedStatus('mongodb', undefined, {}, d)).rejects.toThrow(/no mongodb service/)
  })
})
