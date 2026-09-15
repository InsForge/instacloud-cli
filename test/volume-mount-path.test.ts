import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ request: vi.fn(), rawRequest: vi.fn() }))
vi.mock('../src/api.js', async (original) => ({
  ...await original<typeof import('../src/api.js')>(),
  ApiClient: { load: async () => fake },
  requireProject: async () => ({ projectId: 'p1', branch: 'main' }),
}))
vi.mock('../src/util.js', async (original) => ({ ...await original<typeof import('../src/util.js')>(), info: vi.fn(), printJson: vi.fn() }))
import { computeVolume } from '../src/commands/compute.js'
import { servicesAdd, serviceAddedLine } from '../src/commands/services.js'
beforeEach(() => {
  fake.request.mockReset(); fake.rawRequest.mockReset()
  fake.request.mockResolvedValue({ services: [{ id: 's1', type: 'compute', name: 'web' }] })
  fake.rawRequest.mockResolvedValue({ status: 200, body: { service: { id: 's1', type: 'compute', name: 'web', volume_gib: 1, volume_mount_path: '/app/storage' }, attached: true, volume: { sizeGib: 1, mountPath: '/app/storage' }, cap: { volumeGib: 10 } } })
})
describe('volume mount path requests', () => {
  it('sends a custom path for initial attachment', async () => {
    await computeVolume('web', { size: '1', mountPath: '/app/storage' })
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/volume', { sizeGib: 1, mountPath: '/app/storage' })
  })
  it('leaves the path unspecified for old resize calls', async () => {
    await computeVolume('web', { size: '2' })
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/volume', { sizeGib: 2 })
  })
  it('keeps the no-flag command read-only', async () => {
    fake.request.mockResolvedValueOnce({ services: [{ id: 's1', type: 'compute', name: 'web' }] }).mockResolvedValueOnce({ volume: null, cap: { volumeGib: 10 } })
    await computeVolume('web', {})
    expect(fake.rawRequest).not.toHaveBeenCalled()
  })
  it('sends and displays the custom path on creation', async () => {
    await servicesAdd('compute', 'web', { volume: '1', mountPath: '/app/storage' })
    expect(fake.rawRequest).toHaveBeenCalledWith('POST', '/projects/p1/services', expect.objectContaining({ volumeGib: 1, volumeMountPath: '/app/storage' }))
    expect(serviceAddedLine('compute', 'web', 'main', { id: 's1', type: 'compute', volume_gib: 1, volume_mount_path: '/app/storage' })).toContain('at /app/storage')
  })
})
