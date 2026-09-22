import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ request: vi.fn(), rawRequest: vi.fn(), load: vi.fn() }))
vi.mock('../src/api.js', async (original) => ({
  ...await original<typeof import('../src/api.js')>(),
  ApiClient: { load: fake.load },
  requireProject: async () => ({ projectId: 'p1', branch: 'main' }),
}))
vi.mock('../src/util.js', async (original) => ({ ...await original<typeof import('../src/util.js')>(), info: vi.fn(), printJson: vi.fn() }))
import { info, printJson } from '../src/util.js'
import { computeVolume, computeStartCommand } from '../src/commands/compute.js'
import { servicesAdd, serviceAddedLine, serviceListLine } from '../src/commands/services.js'
beforeEach(() => {
  fake.request.mockReset(); fake.rawRequest.mockReset(); fake.load.mockReset().mockResolvedValue(fake)
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

describe('mount path validation and list display', () => {
  it('sends a path-only edit without an implicit resize', async () => {
    fake.request.mockResolvedValueOnce({ services: [{ id: 's1', type: 'compute', name: 'web' }] }).mockResolvedValueOnce({ volume: { sizeGib: 1, mountPath: '/data' } })
    await computeVolume('web', { mountPath: '/cache' })
    expect(fake.rawRequest).toHaveBeenCalledWith('PUT', '/projects/p1/services/s1/volume', { mountPath: '/cache', sizeGib: undefined })
  })
  it.each(['/app/storage', '/data', null, undefined])('shows the recorded compute volume path (%j), defaulting legacy rows to /data', (path) => {
    const line = serviceListLine({ type: 'compute', name: 'web', status: 'active', id: 's1', machine_count: 1, volume_gib: 1, volume_mount_path: path })
    expect(line).toContain(`vol 1Gi at ${path ?? '/data'}`)
  })
  it('does not display a mount path without an attached volume', () => {
    const line = serviceListLine({ type: 'compute', name: 'web', status: 'active', id: 's1', machine_count: 1, volume_gib: null, volume_mount_path: '/cache' })
    expect(line).not.toContain('vol ')
    expect(line).not.toContain('/cache')
  })
})

describe('startup command staging', () => {
  it('saves a command without deploying and honors branch selection', async () => {
    await computeStartCommand('web', { set: 'exec postgres -D /new/pg', branch: 'preview' })
    expect(fake.request).toHaveBeenCalledWith('GET', '/projects/p1/services?branch=preview')
    expect(fake.rawRequest).toHaveBeenCalledTimes(1)
    expect(fake.rawRequest).toHaveBeenCalledWith('PATCH', '/projects/p1/services/s1', { startCommand: 'exec postgres -D /new/pg' })
  })
  it('clears to the image default', async () => {
    await computeStartCommand('web', { clear: true })
    expect(fake.rawRequest).toHaveBeenCalledWith('PATCH', '/projects/p1/services/s1', { startCommand: '' })
  })
  it('reads without mutation and rejects conflicting options before loading credentials', async () => {
    await computeStartCommand('web', {})
    expect(fake.rawRequest).not.toHaveBeenCalled()
    fake.load.mockClear()
    await expect(computeStartCommand('web', { set: 'x', clear: true })).rejects.toThrow('not both')
    expect(fake.load).not.toHaveBeenCalled()
  })
})

it('rejects path-only attachment before issuing a write', async () => {
  fake.request.mockResolvedValueOnce({ services: [{ id: 's1', type: 'compute', name: 'web' }] }).mockResolvedValueOnce({ volume: null })
  await expect(computeVolume('web', { mountPath: '/cache' })).rejects.toThrow('no volume attached')
  expect(fake.rawRequest).not.toHaveBeenCalled()
})
it('rejects an explicitly empty size', async () => {
  await expect(computeVolume('web', { size: '', mountPath: '/cache' })).rejects.toThrow('--size must not be empty')
  expect(fake.load).not.toHaveBeenCalled()
})

it('reads the saved startup command in text and JSON', async () => {
  const service = { id: 's1', type: 'compute', name: 'web', start_command: 'exec app' }
  fake.request.mockResolvedValue({ services: [service] })
  await computeStartCommand('web', {})
  expect(info).toHaveBeenCalledWith('compute web: startup command exec app')
  await computeStartCommand('web', { json: true })
  expect(printJson).toHaveBeenCalledWith({ service })
})
