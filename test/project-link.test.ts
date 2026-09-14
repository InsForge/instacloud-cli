// "Link once and it works" requires git-style ancestor lookup: commands run from any
// subdirectory of a linked project must resolve the SAME link, and updates (branch switch)
// must rewrite the link at the project root — never mint a nested .insta in the subdir.
import { test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProject, resolveProjectLink, writeProject } from '../src/config.js'
import { CliExit } from '../src/util.js'

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

// ---- the control plane lives in a machine-local sidecar, not the committed binding --------------
// A project id is only meaningful on the control plane that minted it. INSTA_API_URL outranks the
// persisted config (config.ts readGlobal), so it pins "which plane the CLI is pointed at".

const CLOUD = 'https://api.cloud.example'
const BOX = 'https://api.box.example'
const linkFile = (dir: string) => join(dir, '.insta', 'project.json')
const planeFile = (dir: string) => join(dir, '.insta', 'link-plane.json')
const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

afterEach(() => {
  delete process.env.INSTA_API_URL
  for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

test('project.json keeps only the shared binding; the control plane goes in a gitignored sidecar', async () => {
  process.env.INSTA_API_URL = BOX
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  // The committed team file is unchanged in shape — a URL one machine chose never lands in it.
  expect(readJson(linkFile(root))).toEqual(proj)
  expect(readJson(planeFile(root))).toEqual({ apiUrl: BOX })
  const gi = readFileSync(join(root, '.gitignore'), 'utf8')
  expect(gi).toContain('.insta/link-plane.json')
  expect(gi).not.toMatch(/^\.insta\/project\.json$/m)
})

test('a link made on another control plane is reported foreign, and resolves again back on its own', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toBeNull()
  expect((await resolveProjectLink(root))?.foreign).toMatchObject({ projectId: 'p-1', linkedApiUrl: CLOUD, currentApiUrl: BOX })
  process.env.INSTA_API_URL = CLOUD + '/' // trailing slashes do not make a different plane
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('a link with no sidecar — legacy, or a teammate who just cloned — resolves on any control plane', async () => {
  const { root } = linkedProjectWithSubdir()
  mkdirSync(join(root, '.insta'), { recursive: true })
  writeFileSync(linkFile(root), JSON.stringify(proj))
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('a malformed sidecar is ignored instead of crashing every command', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  writeFileSync(planeFile(root), JSON.stringify({ apiUrl: 42 }))
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('credentials in INSTA_API_URL are never persisted, and do not change which plane it is', async () => {
  process.env.INSTA_API_URL = 'https://user:s3cret@api.box.example'
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  const stored = readFileSync(planeFile(root), 'utf8')
  expect(stored).not.toContain('s3cret')
  expect(stored).not.toContain('user@')
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('a subdirectory relink still updates the project root link: one tree, one binding', async () => {
  // Deliberately unchanged. A nested link would split the link from the agent session saved at
  // the root before it (project link saves the session first), which is how a session strands.
  const { root, sub } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  await writeProject({ ...proj, projectId: 'p-2' }, sub)
  expect(readJson(linkFile(root)).projectId).toBe('p-2')
  expect(existsSync(join(sub, '.insta'))).toBe(false)
})

test('re-linking in the link\'s own directory replaces it', async () => {
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  await writeProject({ ...proj, projectId: 'p-2' }, root)
  expect(readJson(linkFile(root)).projectId).toBe('p-2')
})

// ---- the home directory is never a project root ----------------------------------------------
// ~/.insta is the CLI's global config directory. homedir() reads HOME on POSIX and USERPROFILE on
// Windows, so both are pinned.

function fakeHome(): { home: string; sub: string } {
  const home = mkdtempSync(join(tmpdir(), 'insta-home-'))
  const sub = join(home, 'code', 'app')
  mkdirSync(sub, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  return { home, sub }
}

test('a project.json in the home directory is not a link for the directories below it', async () => {
  const { home, sub } = fakeHome()
  mkdirSync(join(home, '.insta'), { recursive: true })
  writeFileSync(linkFile(home), JSON.stringify(proj))
  expect(await readProject(sub)).toBeNull()
})

test('linking below the home directory never overwrites a stray ~/.insta/project.json', async () => {
  const { home, sub } = fakeHome()
  mkdirSync(join(home, '.insta'), { recursive: true })
  writeFileSync(linkFile(home), JSON.stringify({ ...proj, projectId: 'p-home' }))
  await writeProject({ ...proj, projectId: 'p-2' }, sub)
  expect(readJson(linkFile(home)).projectId).toBe('p-home')
  expect(readJson(linkFile(sub)).projectId).toBe('p-2')
})

test('linking the home directory itself is refused', async () => {
  const { home } = fakeHome()
  await expect(writeProject(proj, home)).rejects.toBeInstanceOf(CliExit)
  expect(existsSync(linkFile(home))).toBe(false)
})
