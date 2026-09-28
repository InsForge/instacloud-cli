import { test, expect, afterEach, vi } from 'vitest'
import * as apiModule from '../src/api.js'
import { ApiClient } from '../src/api.js'
import { branchCreate } from '../src/commands/branch.js'

afterEach(() => { vi.restoreAllMocks() })

const run = async (status: string): Promise<string> => {
  const request = vi.fn(async () => ({
    branch: { id: 'b-1', name: 'feat', status },
    nextActions: [{ op: 'deploy', reason: 'Deploy an image to the new branch.', args: { branch: 'feat' } }],
  }))
  vi.spyOn(ApiClient, 'load').mockResolvedValue({ request } as unknown as ApiClient)
  vi.spyOn(apiModule, 'requireProject').mockResolvedValue({ projectId: 'p', branch: 'main' } as Awaited<ReturnType<typeof apiModule.requireProject>>)
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out += String(s); return true })
  await branchCreate('feat', {})
  return out
}

test('branch create says a creating branch is not deployable yet', async () => {
  const out = await run('creating')
  expect(out).toContain('[creating]')
  expect(out).toContain('shows it active')
  expect(out).not.toContain('insta deploy') // the platform's deploy hint would 404 now
})

test('branch create adds no wait note for a branch that is already active', async () => {
  const out = await run('active')
  expect(out).not.toContain('still provisioning')
  expect(out).toContain('insta deploy --branch feat')
})
