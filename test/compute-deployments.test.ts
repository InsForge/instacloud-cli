import { describe, expect, it, vi, afterEach, afterAll } from 'vitest'
import { relativeTime } from '../src/util.js'
import { deploymentLines, computeDeployments, type ServiceDeploymentView } from '../src/commands/compute.js'

const NOW = new Date('2026-10-15T12:00:00Z')
const row = (over: Partial<ServiceDeploymentView> = {}): ServiceDeploymentView => ({
  id: '3f2a9c1e-0000-4000-8000-000000000001', status: 'succeeded', trigger: 'github',
  image: 'registry/web:abc', pinnedImage: 'registry/web@sha256:9c1e04abdeadbeef', commitSha: 'a1b2c3d4e5f6',
  buildId: null, buildSource: 'github', port: 8080, startCommand: null, actor: null, rollbackOf: null, error: null,
  backfilled: false, createdAt: '2026-10-15T11:55:00Z', live: false, rollbackEligible: true, ...over,
})

describe('relativeTime', () => {
  it('buckets', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
    expect(relativeTime(at(10_000), NOW)).toBe('just now')
    expect(relativeTime(at(5 * 60_000), NOW)).toBe('5 min ago')
    expect(relativeTime(at(2 * 3600_000), NOW)).toBe('2 hours ago')
    expect(relativeTime(at(3 * 86400_000), NOW)).toBe('3 days ago')
    expect(relativeTime('2026-08-01T10:00:00Z', NOW)).toBe('2026-08-01')
  })
})

describe('deploymentLines', () => {
  const rows = [
    row({ live: true, rollbackEligible: false, ineligibleReason: 'live' }),
    row({ id: '7d41e0b2-0000-4000-8000-000000000002', commitSha: '9f8e7d6aaaa', pinnedImage: 'registry/web@sha256:51aa7c90ffff', createdAt: '2026-10-15T10:00:00Z' }),
    row({ id: 'c09b11f4-0000-4000-8000-000000000003', status: 'failed', commitSha: null, pinnedImage: null, image: 'web:v2', error: 'app did not answer on port 8080', createdAt: '2026-10-15T09:00:00Z' }),
  ]
  it('lays out columns, live status, and the failed error', () => {
    const lines = deploymentLines(rows, NOW)
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+TRIGGER\s+COMMIT\s+IMAGE\s+WHEN$/)
    expect(lines[1]).toMatch(/^3f2a9c1e\s+live\s+github\s+a1b2c3d\s+…@sha256:9c1e04ab\s+5 min ago$/)
    expect(lines[2]).toMatch(/^7d41e0b2\s+succeeded\s+github\s+9f8e7d6\s+…@sha256:51aa7c90\s+2 hours ago$/)
    expect(lines[3]).toMatch(/^c09b11f4\s+failed\s+github\s+-\s+web:v2\s+3 hours ago\s+app did not answer on port 8080$/)
  })
  it('says so when empty', () => {
    expect(deploymentLines([], NOW)).toEqual(['(no deployments yet)'])
  })
})

describe('computeDeployments', () => {
  const stdout: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  afterEach(() => { stdout.length = 0 })
  afterAll(() => outSpy.mockRestore())
  const PROJECT = { projectId: 'proj_1', branch: 'main' }
  const fake = () => {
    const gets: string[] = []
    const api: any = {
      request: async (_m: string, path: string) => {
        gets.push(path)
        if (path.includes('/deployments')) return { deployments: [row({ live: true })], autoDeployPausedByRollback: false }
        return { services: [{ id: 'svc_1', type: 'compute', name: 'web' }] }
      },
    }
    return { api, gets }
  }
  it('passes --limit and prints the table', async () => {
    const { api, gets } = fake()
    await computeDeployments('web', { limit: '5' }, { api, project: PROJECT })
    expect(gets).toContain('/projects/proj_1/services/svc_1/deployments?limit=5')
    expect(stdout.join('')).toContain('3f2a9c1e')
  })
  it('--json prints the API body', async () => {
    const { api } = fake()
    await computeDeployments('web', { json: true }, { api, project: PROJECT })
    expect(JSON.parse(stdout.join('')).deployments).toHaveLength(1)
  })
  it('rejects a bad --limit before any request', async () => {
    const { api, gets } = fake()
    await expect(computeDeployments('web', { limit: '0' }, { api, project: PROJECT })).rejects.toThrow(/--limit/)
    expect(gets).toEqual([])
  })
})
