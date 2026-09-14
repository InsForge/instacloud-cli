// requireProject is the caller every project command goes through, and the place a link for the
// WRONG control plane did damage: treated as "unlinked", it fell into auto-resolve, which with one
// project on the new plane picks it with no prompt and saves — replacing the committed team link
// on a read-only command. These cases pin the caller, not just the config module.
import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireProject } from '../src/api.js'
import { writeProject } from '../src/config.js'
import { CliExit } from '../src/util.js'

const CLOUD = 'https://api.cloud.example'
const BOX = 'https://api.box.example'
const proj = { projectId: 'p-1', orgId: 'o-1', branch: 'main' }

afterEach(() => { delete process.env.INSTA_API_URL })

function counter() {
  let calls = 0
  return { calls: () => calls, autoResolve: async () => { calls++; return { ...proj, projectId: 'p-box' } } }
}

test('a link made on another control plane stops the command instead of auto-linking over it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-req-'))
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, dir)
  const before = readFileSync(join(dir, '.insta', 'project.json'), 'utf8')

  process.env.INSTA_API_URL = BOX
  const c = counter()
  await expect(requireProject({ cwd: dir, autoResolve: c.autoResolve })).rejects.toBeInstanceOf(CliExit)
  expect(c.calls()).toBe(0) // never reached auto-resolve, so nothing was saved
  expect(readFileSync(join(dir, '.insta', 'project.json'), 'utf8')).toBe(before)
})

test('a link on the same control plane is returned without resolving anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-req-'))
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, dir)
  const c = counter()
  await expect(requireProject({ cwd: dir, autoResolve: c.autoResolve })).resolves.toMatchObject({ projectId: 'p-1' })
  expect(c.calls()).toBe(0)
})

test('an unlinked directory still auto-resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-req-unlinked-'))
  const c = counter()
  await expect(requireProject({ cwd: dir, autoResolve: c.autoResolve })).resolves.toMatchObject({ projectId: 'p-box' })
  expect(c.calls()).toBe(1)
})
