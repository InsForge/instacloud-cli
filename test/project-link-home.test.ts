// `insta project link` in the home directory must stop BEFORE anything with side effects. In agent
// mode the session is saved, and .gitignore edited, at the link root first; refusing only inside
// writeProject left ~/.insta/agent-session.json and ~/.gitignore behind after the command failed.
//
// ApiClient.load is stubbed so the session CAN be issued: without the pre-flight, projectLink would
// really write it into the fake home, so this test fails for the right reason, not a network error.
import { test, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureAgent } from '../src/agent.js'
import { ApiClient } from '../src/api.js'
import { projectLink } from '../src/commands/project.js'
import { CliExit } from '../src/util.js'

// Without the guard, projectLink goes on to install the observe hook and the agent skills, which are
// slow real installs. Stubbed so an unguarded link fails on the assertions below, not on a timeout.
vi.mock('../src/ensure-skills.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ensure-skills.js')>()),
  installSkills: vi.fn(async () => {}),
}))
vi.mock('../src/observe/install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/observe/install.js')>()),
  installObserve: vi.fn(() => ({ claude: false, codex: false, ignored: [], tracked: [] })),
}))

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
const dirs: string[] = []
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

afterEach(() => {
  configureAgent(null)
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})

test('agent-mode project link in the home directory stops before writing a session or editing .gitignore', async () => {
  const home = tempDir('insta-home-link-')
  process.env.HOME = home
  process.env.USERPROFILE = home
  vi.spyOn(process, 'cwd').mockReturnValue(home)
  configureAgent({ source: 'cli-explicit', client: 'codex' })

  const request = vi.fn(async (_method: string, path: string) => path === '/agent/sessions'
    ? { token: 't', agentSessionId: 'ags_home', projectId: 'p-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    : { project: { id: 'p-1', org_id: 'o', name: 'demo' } })
  vi.spyOn(ApiClient, 'load').mockResolvedValue({ apiUrl: 'https://test.invalid', request } as unknown as ApiClient)

  await expect(projectLink('p-1')).rejects.toBeInstanceOf(CliExit)
  expect(request).not.toHaveBeenCalled()
  expect(existsSync(join(home, '.insta', 'agent-session.json'))).toBe(false)
  expect(existsSync(join(home, '.gitignore'))).toBe(false)
  expect(existsSync(join(home, '.insta', 'project.json'))).toBe(false)
})

// The same guarantee when an ancestor of home holds a link: `findProjectRoot` must stop at home, or
// the target resolves to that ancestor, the home check passes, and the ancestor's link is overwritten.
test('agent-mode project link in the home directory stops even when an ancestor of home is linked', async () => {
  const ancestor = tempDir('insta-above-home-link-')
  mkdirSync(join(ancestor, '.insta'), { recursive: true })
  const link = join(ancestor, '.insta', 'project.json')
  writeFileSync(link, JSON.stringify({ projectId: 'p-above', orgId: 'o', branch: 'main' }))
  const before = readFileSync(link, 'utf8')
  const home = join(ancestor, 'home')
  mkdirSync(home)
  process.env.HOME = home
  process.env.USERPROFILE = home
  vi.spyOn(process, 'cwd').mockReturnValue(home)
  configureAgent({ source: 'cli-explicit', client: 'codex' })

  const request = vi.fn(async (_method: string, path: string) => path === '/agent/sessions'
    ? { token: 't', agentSessionId: 'ags_home', projectId: 'p-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    : { project: { id: 'p-1', org_id: 'o', name: 'demo' } })
  vi.spyOn(ApiClient, 'load').mockResolvedValue({ apiUrl: 'https://test.invalid', request } as unknown as ApiClient)

  await expect(projectLink('p-1')).rejects.toBeInstanceOf(CliExit)
  expect(request).not.toHaveBeenCalled()
  expect(readFileSync(link, 'utf8')).toBe(before)
  expect(existsSync(join(ancestor, '.insta', 'agent-session.json'))).toBe(false)
  expect(existsSync(join(home, '.insta', 'agent-session.json'))).toBe(false)
  expect(existsSync(join(ancestor, '.gitignore'))).toBe(false)
})
