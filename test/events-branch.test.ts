import { test, expect, afterEach, vi } from 'vitest'
import * as apiModule from '../src/api.js'
import { ApiClient } from '../src/api.js'
import { events } from '../src/commands/govern.js'
import { CliExit } from '../src/util.js'

afterEach(() => { vi.restoreAllMocks() })

const stub = () => {
  const request = vi.fn(async (_m: string, path: string) => path.endsWith('/branches')
    ? { branches: [{ id: '11111111-1111-4111-8111-111111111111', name: 'main' }] }
    : { events: [] })
  vi.spyOn(ApiClient, 'load').mockResolvedValue({ request } as unknown as ApiClient)
  vi.spyOn(apiModule, 'requireProject').mockResolvedValue({ projectId: 'p' } as Awaited<ReturnType<typeof apiModule.requireProject>>)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return request
}

test('agent events --branch sends the branch id the API requires, given a name', async () => {
  const request = stub()
  await events({ branch: 'main', json: true })
  expect(request).toHaveBeenLastCalledWith('GET', '/projects/p/events?branch=11111111-1111-4111-8111-111111111111')
})

test('agent events --branch passes an id through, so a deleted branch keeps its history', async () => {
  const request = stub()
  await events({ branch: '22222222-2222-4222-8222-222222222222', json: true })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenLastCalledWith('GET', '/projects/p/events?branch=22222222-2222-4222-8222-222222222222')
})

test('agent events --branch refuses an unknown branch instead of forwarding it', async () => {
  const request = stub()
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await expect(events({ branch: 'nope' })).rejects.toBeInstanceOf(CliExit)
  expect(request).not.toHaveBeenCalledWith('GET', expect.stringContaining('/events'))
})
