import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { installSkills, ensureGitignore } from '../src/ensure-skills.js'
import { ENVS } from '../src/env.js'

const originalEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const key of ['INSTA_API_URL', 'INSTA_SKILLS_REPO']) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.INSTA_API_URL = ENVS.prod.api
})
afterEach(() => {
  for (const key of ['INSTA_API_URL', 'INSTA_SKILLS_REPO']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

function fakeRun() {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { ok: true } }
  return { calls, run }
}

test('installSkills adds insta + the service stack skills, non-interactively, and gitignores them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const out: string[] = []
  const { calls, run } = fakeRun()
  await installSkills({ cwd: dir, run, print: (s) => out.push(s) })

  expect(calls.map((c) => c.cmd)).toEqual(['npx', 'npx', 'npx'])
  // Leading -y is npx's OWN auto-install flag; the trailing -y answers the skills tool.
  expect(calls.map((c) => c.args.join(' '))).toEqual([
    '-y skills add InsForge/instacloud-skills -s insta -a claude-code -a codex -y --copy',
    '-y skills add tigrisdata/skills -s tigris-object-operations -s file-storage -s tigris-sdk-guide -s tigris-security-access-control -s tigris-image-optimization -s tigris-s3-migration -s tigris-static-assets -s tigris-agent-kit -a claude-code -a codex -y --copy',
    '-y skills add better-auth/skills -s better-auth-best-practices -s email-and-password-best-practices -s better-auth-security-best-practices -a claude-code -a codex -y --copy',
  ])
  // every invocation is non-interactive: agents pinned + skip-prompt flags present
  for (const c of calls) {
    expect(c.args).toContain('-y')
    expect(c.args).toContain('--copy')
    expect(c.args.join(' ')).toMatch(/-a claude-code/)
    expect(c.args.join(' ')).toMatch(/-a codex/)
  }
  expect(out.join('\n')).toMatch(/insta ✓/)
  // the installed (regenerable) skill dirs are gitignored
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect(gi).toMatch(/\.claude\/skills\//)
  expect(gi).toMatch(/\.agents\/skills\//)
  expect(gi).toMatch(/\.github\/skills\//)
  // …and so is the skills-lock.json the tool writes at the project root: a lockfile whose payload
  // is ignored (and which pins only a content hash, not our per-env source) is noise in `git status`.
  expect(gi).toMatch(/^skills-lock\.json$/m)
  expect(out.join('\n')).toMatch(/\.gitignore \+= .*skills-lock\.json/)
})

test('a failed skill add still continues to the rest and reports the failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const out: string[] = []
  const run = async (_cmd: string, args: string[]) => ({ ok: !args.includes('tigrisdata/skills') })
  await installSkills({ cwd: dir, run, print: (s) => out.push(s) })
  expect(out.join('\n')).toMatch(/tigris failed — add manually: npx -y skills add tigrisdata\/skills/)
  expect(out.join('\n')).toMatch(/better-auth ✓/) // reached the skill after the failure
})

test('when every skill add fails nothing was written, so nothing is gitignored and no += line is printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const out: string[] = []
  await installSkills({ cwd: dir, run: async () => ({ ok: false }), print: (s) => out.push(s) })
  expect(existsSync(join(dir, '.gitignore'))).toBe(false)
  expect(out.join('\n')).not.toMatch(/\.gitignore \+=/)
})

test('an offline run still prints the git rm --cached hint: tracked files are independent of today\'s adds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
  expect(git('init', '-q').status).toBe(0)
  writeFileSync(join(dir, 'skills-lock.json'), '{}\n')
  expect(git('add', '-f', 'skills-lock.json').status).toBe(0)
  expect(git('commit', '-q', '-m', 'oops').status).toBe(0)
  const out: string[] = []
  await installSkills({ cwd: dir, run: async () => ({ ok: false }), print: (s) => out.push(s) })
  expect(out.join('\n')).toMatch(/git rm -r --cached skills-lock\.json/)
  expect(out.join('\n')).not.toMatch(/\.gitignore \+=/) // the ignore entries still wait for a successful add
})

test('skills already committed before the CLI ignored them get the git rm --cached hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
  expect(git('init', '-q').status).toBe(0)
  writeFileSync(join(dir, 'skills-lock.json'), '{}\n')
  mkdirSync(join(dir, '.claude', 'skills', 'insta'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 'insta', 'SKILL.md'), '# insta\n')
  expect(git('add', '-f', '-A').status).toBe(0) // -f: a global excludes file must not blank the test
  expect(git('commit', '-q', '-m', 'oops').status).toBe(0)
  const out: string[] = []
  await installSkills({ cwd: dir, run: fakeRun().run, print: (s) => out.push(s) })
  expect(out.join('\n')).toMatch(/git rm -r --cached \.claude\/skills\/ skills-lock\.json/)
})

test('ensureGitignore appends missing entries idempotently, preserving existing content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.env\n')
  const added1 = ensureGitignore(dir, ['.claude/skills/', '.env']) // .env already present
  expect(added1).toEqual(['.claude/skills/'])
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect(gi).toMatch(/^node_modules$/m)
  expect((gi.match(/^\.env$/gm) || []).length).toBe(1) // not duplicated
  expect(ensureGitignore(dir, ['.claude/skills/', '.env'])).toEqual([]) // re-run adds nothing
})

test('ensureGitignore writes its comment header once per block, and creates the file when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const c = '# InstaCloud: test block'
  expect(ensureGitignore(dir, ['a/'], c)).toEqual(['a/']) // no .gitignore yet → created
  expect(ensureGitignore(dir, ['a/', 'b'], c)).toEqual(['b']) // later addition under the same block
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect((gi.match(/^# InstaCloud: test block$/gm) || []).length).toBe(1) // header not repeated
  expect(gi).toMatch(/^a\/$/m)
  expect(gi).toMatch(/^b$/m)
})
