// "Link once and it works" requires git-style ancestor lookup: commands run from any
// subdirectory of a linked project must resolve the SAME link, and updates (branch switch)
// must rewrite the link at the project root — never mint a nested .insta in the subdir.
import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProject, writeProject } from '../src/config.js'

const proj = { projectId: 'p-1', orgId: 'o-1', branch: 'main' }

function linkedProjectWithSubdir(): { root: string; sub: string } {
  const root = mkdtempSync(join(tmpdir(), 'insta-link-'))
  const sub = join(root, 'src', 'deep')
  mkdirSync(sub, { recursive: true })
  return { root, sub }
}

test('readProject finds the link from a nested subdirectory', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  expect(await readProject(sub)).toMatchObject({ projectId: 'p-1' })
})

test('writeProject from a subdirectory updates the root link, not a nested copy', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  await writeProject({ ...proj, branch: 'feat' }, sub) // e.g. `insta branch switch feat` run in src/deep
  expect((await readProject(root))?.branch).toBe('feat')
  expect(existsSync(join(sub, '.insta'))).toBe(false) // no second link minted
})

test('unlinked directories still resolve to null (walk stops at fs root)', async () => {
  const lone = mkdtempSync(join(tmpdir(), 'insta-unlinked-'))
  expect(await readProject(lone)).toBeNull()
})

// ---- a link is bound to the control plane it was made against ----------------------------------
// A project id is only meaningful on the control plane that minted it: cloud, staging and every
// insta-oss box each have their own. INSTA_API_URL outranks the persisted config (config.ts
// readGlobal), so it pins "which control plane the CLI is pointed at" without touching ~/.insta.

const CLOUD = 'https://api.cloud.example'
const BOX = 'https://api.box.example'
const linkFile = (dir: string) => join(dir, '.insta', 'project.json')
const rawLink = (dir: string) => JSON.parse(readFileSync(linkFile(dir), 'utf8'))

afterEach(() => { delete process.env.INSTA_API_URL })

test('writeProject records the control plane the link was made against', async () => {
  process.env.INSTA_API_URL = BOX
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  expect(rawLink(root)).toMatchObject({ projectId: 'p-1', apiUrl: BOX })
})

test('a link made against a different control plane is ignored, not silently reused', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  // Pointed at a self-hosted box, the cloud project id names nothing: resolving it sent every
  // command to a project that does not exist there.
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toBeNull()
  // Back on the control plane it belongs to, it resolves again. Trailing slashes do not matter.
  process.env.INSTA_API_URL = CLOUD + '/'
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('a link written before apiUrl existed still resolves against any control plane', async () => {
  const { root } = linkedProjectWithSubdir()
  mkdirSync(join(root, '.insta'), { recursive: true })
  writeFileSync(linkFile(root), JSON.stringify({ projectId: 'p-legacy', orgId: 'o', branch: 'main' }))
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toMatchObject({ projectId: 'p-legacy' })
})

// ---- linking must not clobber somebody else's link ---------------------------------------------

test('linking a DIFFERENT project from a subdirectory leaves the ancestor link alone', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  // e.g. `insta project link p-2` run in a subdirectory of a tree that is already linked to p-1,
  // or anywhere under a home directory that holds a stray ~/.insta/project.json.
  await writeProject({ ...proj, projectId: 'p-2' }, sub)
  expect(rawLink(root).projectId).toBe('p-1')
  expect(rawLink(sub).projectId).toBe('p-2')
  expect(await readProject(sub)).toMatchObject({ projectId: 'p-2' }) // nearest link wins
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('the same project id on a different control plane is not the same binding either', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  process.env.INSTA_API_URL = BOX
  await writeProject(proj, sub)
  expect(rawLink(root)).toMatchObject({ projectId: 'p-1', apiUrl: CLOUD })
  expect(rawLink(sub)).toMatchObject({ projectId: 'p-1', apiUrl: BOX })
})

test('a branch switch from a subdirectory of a pre-apiUrl link still updates that link', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  mkdirSync(join(root, '.insta'), { recursive: true })
  writeFileSync(linkFile(root), JSON.stringify(proj))
  await writeProject({ ...proj, branch: 'feat' }, sub)
  expect(rawLink(root).branch).toBe('feat')
  expect(existsSync(join(sub, '.insta'))).toBe(false)
})

test('re-linking in the link\'s own directory still replaces it', async () => {
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  await writeProject({ ...proj, projectId: 'p-2' }, root)
  expect(rawLink(root).projectId).toBe('p-2')
})
