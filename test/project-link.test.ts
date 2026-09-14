// "Link once and it works" requires git-style ancestor lookup: commands run from any
// subdirectory of a linked project must resolve the SAME link, and updates (branch switch)
// must rewrite the link at the project root — never mint a nested .insta in the subdir.
import { test, expect, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foreignLinkMessage, persistAutoLink, readProject, resolveProjectLink, safeUrl, writeProject } from '../src/config.js'
import { normalizeUrl } from '../src/env.js'
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
  expect(readJson(planeFile(root))).toEqual({ projectId: 'p-1', apiUrl: BOX })
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
  expect((await resolveProjectLink(root))?.foreign).toMatchObject({ reason: 'plane', projectId: 'p-1', linkedApiUrl: CLOUD, currentApiUrl: BOX })
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
  writeFileSync(planeFile(root), JSON.stringify({ projectId: 'p-1', apiUrl: 42 }))
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

// ---- the record vouches for the project it was written for, and only that one -----------------
// project.json is committed and the record is not, so a pull or checkout can replace the project
// underneath it.

test('a checkout that replaces project.json is reported changed, on either control plane', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root) // this machine linked p-1 on cloud
  // A pull or checkout replaces the COMMITTED file; the ignored record is untouched.
  writeFileSync(linkFile(root), JSON.stringify({ ...proj, projectId: 'p-box' }))

  // Still on cloud, the cloud record must not vouch for p-box: that sent p-box's id to cloud.
  expect(await readProject(root)).toBeNull()
  expect((await resolveProjectLink(root))?.foreign).toMatchObject({ reason: 'changed', projectId: 'p-box', linkedProjectId: 'p-1' })
  // On the box, it is not refused as a CLOUD link either — the reason reported is the true one.
  process.env.INSTA_API_URL = BOX
  expect((await resolveProjectLink(root))?.foreign?.reason).toBe('changed')

  // Linking it confirms it for the current control plane.
  await writeProject({ ...proj, projectId: 'p-box' }, root)
  expect(await readProject(root)).toMatchObject({ projectId: 'p-box' })
})

test('a record without a project id is ignored: it cannot say which project it vouches for', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  writeFileSync(planeFile(root), JSON.stringify({ apiUrl: CLOUD }))
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('a hand-edited record cannot put credentials or escape sequences on the terminal', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  // A raw ESC also makes URL() reject the value, which is exactly when credentials must still go.
  writeFileSync(planeFile(root), JSON.stringify({ projectId: 'p-1', apiUrl: 'https://user:s3cret@api.box.example\u001b[31m' }))
  const f = (await resolveProjectLink(root))?.foreign
  expect(f?.reason).toBe('plane')
  const msg = foreignLinkMessage(f!)
  expect(msg).not.toContain('s3cret')
  expect(msg).not.toContain('\u001b')
})

// The record is sanitized when READ, not only when printed: the comparison uses it too. A copied
// record whose URL still carries userinfo names the same control plane as the bare URL, and must
// not be reported foreign because of it. (Printing sanitizes again, so only this case pins the
// read side.)
test('a record whose URL carries credentials still matches its own control plane', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  writeFileSync(planeFile(root), JSON.stringify({ projectId: 'p-1', apiUrl: 'https://user:pw@api.cloud.example' }))
  expect((await resolveProjectLink(root))?.foreign).toBeUndefined()
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

// ---- credentials never survive, in any form fetch would still send them ----------------------
// safeUrl used to strip userinfo with a pattern anchored at the start of the string. The WHATWG URL
// parser behind fetch is more lenient than that: each value below is one it accepts WITH the
// credentials attached (asserted first), and each defeated the pattern.

test.each([
  ['leading whitespace', ' https://user:token@api.box.example'],
  ['surrounding whitespace', '  https://user:token@api.box.example  '],
  ['an uppercase scheme', 'HTTPS://user:token@api.box.example'],
  ['backslashes for slashes', 'https:\\\\user:token@api.box.example'],
  ['no slashes after the scheme', 'https:user:token@api.box.example'],
  ['a password with no username', 'https://:token@api.box.example'],
])('safeUrl removes credentials given %s', (_label, raw) => {
  const accepted = new URL(raw.trim())
  expect(accepted.username || accepted.password).toBeTruthy() // fetch would send these
  const out = safeUrl(raw)
  expect(out).not.toContain('token')
  expect(out).not.toContain('user')
  expect(normalizeUrl(out)).toBe('https://api.box.example') // still the same control plane
})

test('a whitespace-padded credentialed INSTA_API_URL is not persisted with its credentials', async () => {
  process.env.INSTA_API_URL = ' https://user:token@api.box.example '
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  expect(readFileSync(planeFile(root), 'utf8')).not.toContain('token')
  process.env.INSTA_API_URL = BOX
  expect(await readProject(root)).toMatchObject({ projectId: 'p-1' })
})

test('a whitespace-padded credentialed record is not printed with its credentials', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  writeFileSync(planeFile(root), JSON.stringify({ projectId: 'p-1', apiUrl: ' https://user:token@api.box.example' }))
  const f = (await resolveProjectLink(root))?.foreign
  expect(f?.reason).toBe('plane')
  expect(foreignLinkMessage(f!)).not.toContain('token')
})

// ---- an auto-resolved choice in the home directory is used, not saved --------------------------
// Refusing the home directory inside the auto-resolve save made every project command run in ~ show
// the picker and then fail. An explicit `project link` still refuses; auto-resolution must not.

test('an auto-resolved choice in the home directory is used, not saved, and does not stop the command', async () => {
  const { home } = fakeHome()
  await expect(persistAutoLink(proj, home)).resolves.toBe(false)
  expect(existsSync(linkFile(home))).toBe(false)
})

test('an auto-resolved choice below the home directory is saved as usual', async () => {
  const { sub } = fakeHome()
  await expect(persistAutoLink(proj, sub)).resolves.toBe(true)
  expect(readJson(linkFile(sub))).toEqual(proj)
})

// ---- the foreign-link note -------------------------------------------------------------------
// Under --json, stdout must stay one parseable document, and the note is the only signal some paths
// give. It goes to stderr, once per link.

test('the foreign-link note goes to stderr, once per link, never to stdout', async () => {
  const { root } = linkedProjectWithSubdir()
  process.env.INSTA_API_URL = CLOUD
  await writeProject(proj, root)
  process.env.INSTA_API_URL = BOX
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await readProject(root)
    await readProject(root)
    const notes = (calls: unknown[][]) => calls.map((c) => String(c[0])).filter((line) => line.includes('links project p-1'))
    expect(notes(err.mock.calls)).toHaveLength(1)
    expect(notes(out.mock.calls)).toHaveLength(0)
  } finally {
    err.mockRestore()
    out.mockRestore()
  }
})

// ---- the record is owner-only ------------------------------------------------------------------

test.skipIf(process.platform === 'win32')('the record is readable only by its owner, like agent-session.json, even when it already existed', async () => {
  process.env.INSTA_API_URL = BOX
  const { root } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  expect(statSync(planeFile(root)).mode & 0o777).toBe(0o600)
  // An existing record keeps its old mode through writeFile, so the write must tighten it.
  chmodSync(planeFile(root), 0o644)
  await writeProject(proj, root)
  expect(statSync(planeFile(root)).mode & 0o777).toBe(0o600)
})
