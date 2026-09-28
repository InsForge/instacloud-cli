import { test, expect, afterEach, vi } from 'vitest'
import * as apiModule from '../src/api.js'
import { ApiClient } from '../src/api.js'
import { projectRename } from '../src/commands/project.js'

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined })

const stub = (res: { status: number; body: unknown }) => {
  const rawRequest = vi.fn(async () => res)
  vi.spyOn(ApiClient, 'load').mockResolvedValue({ rawRequest } as unknown as ApiClient)
  vi.spyOn(apiModule, 'requireProject').mockResolvedValue({ projectId: 'p-linked' } as Awaited<ReturnType<typeof apiModule.requireProject>>)
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out += String(s); return true })
  return { rawRequest, out: () => out }
}

test('project rename PATCHes the linked project, or the one --project names', async () => {
  const s = stub({ status: 200, body: { project: { id: 'p-linked', name: 'shop' } } })
  await projectRename('shop', {})
  expect(s.rawRequest).toHaveBeenLastCalledWith('PATCH', '/projects/p-linked', { name: 'shop' })
  expect(s.out()).toContain('renamed project p-linked to shop')
  await projectRename('shop', { project: 'p-other' })
  expect(s.rawRequest).toHaveBeenLastCalledWith('PATCH', '/projects/p-other', { name: 'shop' })
})

test('project rename stops at an approval instead of claiming success', async () => {
  const s = stub({ status: 202, body: { status: 'approval_required', action: 'project.update', approvalId: 'a-1' } })
  await projectRename('shop', {})
  expect(s.out()).toContain('insta agent approvals approve a-1')
  expect(s.out()).not.toContain('renamed')
  expect(process.exitCode).toBe(2)
})
