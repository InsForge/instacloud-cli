// The Claude Code hooks schema executes `command` as ONE shell string ($CLAUDE_PROJECT_DIR is an
// env var the shell expands). A command:'node' + args array carrying a ${CLAUDE_PROJECT_DIR}
// template is expanded by nothing, so node would throw MODULE_NOT_FOUND after EVERY tool call in
// every linked project.
import { test, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installObserve } from '../src/observe/install.js'
import { projectRootFor } from '../src/observe/hook.js'
import { auditRoot, installRoot } from '../src/commands/observe.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const posixTest = process.platform === 'win32' ? test.skip : test

// The install materializes ./.insta/observe (this CLI version's hook, regenerated on every link)
// and the hook appends ./.insta/audit.jsonl (this machine's findings: partial fingerprints +
// redacted context). Neither is project source, so both are gitignored. ./.insta/project.json is
// the team binding and must NOT be caught by these entries.
test('install gitignores the machine-local .insta state but not project.json, idempotently', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')
  const first = installObserve({ cwd, assetDir: fakeAssets() })
  expect(first.ignored).toEqual(['.insta/observe/', '.insta/audit.jsonl'])
  const gi = readFileSync(join(cwd, '.gitignore'), 'utf8')
  expect(gi).toMatch(/^node_modules$/m) // existing content preserved
  expect(gi).toMatch(/^\.insta\/observe\/$/m)
  expect(gi).toMatch(/^\.insta\/audit\.jsonl$/m)
  expect(gi).not.toMatch(/^\.insta\/?$/m) // never the whole dir: project.json stays committable
  expect(installObserve({ cwd, assetDir: fakeAssets() }).ignored).toEqual([]) // re-link adds nothing
})

// Codex has no $CLAUDE_PROJECT_DIR, and .codex/hooks.json is a file teams commit, so the command
// must not bake in an absolute project path. It must also survive a monorepo where the insta
// project root is below the git root (`git rev-parse --show-toplevel` finds the wrong dir → hook
// silently dead), and Windows, where Codex hands `command` verbatim to cmd.exe unless a
// `commandWindows` override exists (POSIX `[ ! -f … ]` → parse error after every tool call). So:
// one shell-neutral `node -e` that climbs from the session cwd. These tests run the command
// through the platform shell (`shell: true` → sh on POSIX, cmd.exe on Windows), so the Windows CI
// job exercises the real thing.
const codexCommand = (cwd: string): string =>
  JSON.parse(readFileSync(join(cwd, '.codex', 'hooks.json'), 'utf8')).hooks.PostToolUse.at(-1).hooks[0].command
const runHook = (cmd: string, cwd: string, input = '{}') => spawnSync(cmd, { cwd, shell: true, input })

test('codex hook entry is shell-neutral: no absolute path, no POSIX syntax, nothing sh or cmd.exe rewrites', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  installObserve({ cwd, assetDir: fakeAssets() })
  const cmd = codexCommand(cwd)
  expect(cmd).not.toContain(cwd)
  expect(cmd).toMatch(/^node -e "[^"]+"$/) // one double-quoted script, no inner quotes
  expect(cmd).not.toMatch(/[$`%!]/) // $ and ` expand in sh; % and ! in cmd.exe
  expect(cmd).not.toContain('[ ') // no test(1)
  expect(cmd).toContain('.insta/observe/hook.js') // keeps the legacy-entry marker isInstaHook keys on
})

test('codex hook climbs to the insta root from a nested monorepo project and passes stdin through', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'obs-mono-')))
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0) // git root ≠ project root
  const project = join(root, 'apps', 'api')
  mkdirSync(project, { recursive: true })
  installObserve({ cwd: project, assetDir: fakeAssets() })
  writeFileSync(join(project, '.insta', 'observe', 'hook.js'),
    "process.stdin.on('data', (d) => process.stdout.write('got:' + d))")
  const cmd = codexCommand(project)
  // from the project dir, and from a subdirectory of it (the session cwd is wherever Codex runs)
  const sub = join(project, 'src', 'routes')
  mkdirSync(sub, { recursive: true })
  for (const dir of [project, sub]) {
    const r = runHook(cmd, dir, '{"tool_name":"Bash"}')
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('got:{"tool_name":"Bash"}')
  }
  // from the git root itself there is no .insta above → silent no-op, not an error
  const atRoot = runHook(cmd, root)
  expect(atRoot.status).toBe(0)
  expect(atRoot.stdout.toString() + atRoot.stderr.toString()).toBe('')
})

// Finding the right hook.js is only half of it: the hook must also WRITE to that project root.
// Codex's event.cwd is the session cwd, so a root taken from it for a session started in
// apps/api/src/routes would leave an unignored apps/api/src/routes/.insta/audit.jsonl behind. The
// hook derives the root from its own entry path (<root>/.insta/observe/hook.js); the env and the
// event cwd are only fallbacks.
test('projectRootFor: the materialized entry path wins; env / event cwd are only fallbacks', () => {
  const root = join(tmpdir(), 'proj')
  expect(projectRootFor(join(root, '.insta', 'observe', 'hook.js'), { CLAUDE_PROJECT_DIR: '/elsewhere' }, '/session'))
    .toBe(root)
  expect(projectRootFor('/somewhere/else/hook.js', { CLAUDE_PROJECT_DIR: '/claude' }, '/session')).toBe('/claude')
  expect(projectRootFor('/somewhere/else/hook.js', {}, '/session')).toBe('/session')
  expect(projectRootFor(undefined, {}, undefined)).toBe('.')
})

// End to end with the REAL hook source (loaded through tsx via NODE_OPTIONS so no build step is
// needed): the generated Codex command, run from a nested session cwd with a Codex-shaped event
// carrying a credential, must append to <project root>/.insta/audit.jsonl and nothing else.
test('codex command from a nested session cwd records findings at the linked project root', () => {
  const mono = realpathSync(mkdtempSync(join(tmpdir(), 'obs-mono-')))
  const project = join(mono, 'apps', 'api')
  mkdirSync(project, { recursive: true })
  installObserve({ cwd: project, assetDir: fakeAssets() })
  // materialized entry → the real hook's main(), so process.argv[1] is <project>/.insta/observe/hook.js
  const hookSrc = pathToFileURL(resolve(__dirname, '..', 'src', 'observe', 'hook.ts')).href
  writeFileSync(join(project, '.insta', 'observe', 'hook.js'), `import { main } from ${JSON.stringify(hookSrc)}\nmain()\n`)
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
  const session = join(project, 'src', 'routes')
  mkdirSync(session, { recursive: true })
  const event = JSON.stringify({ tool_name: 'Bash', cwd: session, tool_input: { command: 'psql postgres://user:secretpass@db:5432/app' } })
  const r = spawnSync(codexCommand(project), { cwd: session, shell: true, input: event,
    env: { ...process.env, NODE_OPTIONS: `--import ${tsxLoader}`, CLAUDE_PROJECT_DIR: '' } })
  expect(r.stderr.toString()).toBe('')
  expect(r.status).toBe(0)
  const audit = join(project, '.insta', 'audit.jsonl')
  expect(existsSync(audit)).toBe(true)
  expect(readFileSync(audit, 'utf8')).toMatch(/"fingerprint":/)
  expect(readFileSync(audit, 'utf8')).not.toContain('secretpass') // redacted, never raw
  expect(existsSync(join(session, '.insta'))).toBe(false) // nothing written at the session cwd
})

// The other half of "record at the project root": report/sync must READ from the same root the
// hook writes to, from any subdirectory. The hook writes at the NEAREST materialized hook above
// the session cwd, so that is the anchor; the link file is only where the next install will
// land (fallback), then cwd. The fourth case — link file and hook at different depths — is the
// one where precedence is observable.
test('auditRoot: nearest materialized hook, else link file, else cwd — resolved from a subdirectory', async () => {
  const linked = realpathSync(mkdtempSync(join(tmpdir(), 'obs-linked-')))
  mkdirSync(join(linked, '.insta'), { recursive: true })
  writeFileSync(join(linked, '.insta', 'project.json'), '{"projectId":"p","orgId":"o","branch":"main"}')
  mkdirSync(join(linked, 'src', 'routes'), { recursive: true })
  expect(await auditRoot(join(linked, 'src', 'routes'))).toBe(linked) // link file only

  const unlinked = realpathSync(mkdtempSync(join(tmpdir(), 'obs-unlinked-')))
  installObserve({ cwd: unlinked, assetDir: fakeAssets() }) // hook materialized, no project.json
  mkdirSync(join(unlinked, 'src', 'routes'), { recursive: true })
  expect(await auditRoot(join(unlinked, 'src', 'routes'))).toBe(unlinked)

  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'obs-bare-')))
  expect(await auditRoot(bare)).toBe(bare)

  // link file at the repo root, hook materialized below it: the hook wins — that is where the
  // Codex wrapper / Claude entry run and where projectRootFor writes
  const mono = realpathSync(mkdtempSync(join(tmpdir(), 'obs-mono-')))
  mkdirSync(join(mono, '.insta'), { recursive: true })
  writeFileSync(join(mono, '.insta', 'project.json'), '{"projectId":"p","orgId":"o","branch":"main"}')
  const project = join(mono, 'apps', 'api')
  mkdirSync(join(project, 'src'), { recursive: true })
  installObserve({ cwd: project, assetDir: fakeAssets() })
  expect(await auditRoot(join(project, 'src'))).toBe(project)
  expect(await auditRoot(mono)).toBe(mono) // above the hook, the link file still anchors
})

// The installers do not create that split in the first place: inside a linked project,
// install anchors at the link root (like writeProject), so a re-link or `observe install` from a
// subdirectory refreshes the project's hook instead of minting a second one.
test('installRoot: the linked project root from a subdirectory, else cwd', async () => {
  const linked = realpathSync(mkdtempSync(join(tmpdir(), 'obs-linked-')))
  mkdirSync(join(linked, '.insta'), { recursive: true })
  writeFileSync(join(linked, '.insta', 'project.json'), '{"projectId":"p","orgId":"o","branch":"main"}')
  mkdirSync(join(linked, 'apps', 'api'), { recursive: true })
  expect(await installRoot(join(linked, 'apps', 'api'))).toBe(linked)
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'obs-bare-')))
  expect(await installRoot(bare)).toBe(bare)
})

test('codex hook is a silent no-op on a fresh clone with no ./.insta anywhere above', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  installObserve({ cwd, assetDir: fakeAssets() })
  const bare = mkdtempSync(join(tmpdir(), 'obs-clone-'))
  const r = runHook(codexCommand(cwd), bare)
  expect(r.status).toBe(0)
  expect(r.stdout.toString() + r.stderr.toString()).toBe('')
})

// A .gitignore entry does nothing for a path git already tracks — and the repos that most need
// these entries are the ones where audit.jsonl was committed before the CLI ignored it. The
// install reports those so the command can print the `git rm --cached` hint.
posixTest('install reports LOCAL_PATHS entries git already tracks', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'obs-proj-')))
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })
  expect(git('init', '-q').status).toBe(0)
  mkdirSync(join(cwd, '.insta'), { recursive: true })
  writeFileSync(join(cwd, '.insta', 'audit.jsonl'), '{}\n')
  expect(git('add', '-f', '.insta/audit.jsonl').status).toBe(0) // -f: immune to a global excludes file
  expect(git('commit', '-q', '-m', 'oops').status).toBe(0)
  const r = installObserve({ cwd, assetDir: fakeAssets() })
  expect(r.tracked).toEqual(['.insta/audit.jsonl']) // observe/ is untracked → not reported
  const fresh = installObserve({ cwd: mkdtempSync(join(tmpdir(), 'obs-nogit-')), assetDir: fakeAssets() })
  expect(fresh.tracked).toEqual([]) // not a repo → nothing to report, no error
})

function fakeAssets(): string {
  const d = mkdtempSync(join(tmpdir(), 'obs-assets-'))
  writeFileSync(join(d, 'hook.js'), '// hook')
  writeFileSync(join(d, 'scanner.js'), '// scanner')
  return d
}

test('claude hook entry is a single shell-string command with $CLAUDE_PROJECT_DIR (no args array)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const hook = settings.hooks.PostToolUse.at(-1).hooks[0]
  expect(hook.args).toBeUndefined()
  expect(hook.command).toBe(
    '[ ! -f "$CLAUDE_PROJECT_DIR/.insta/observe/hook.js" ] || node "$CLAUDE_PROJECT_DIR/.insta/observe/hook.js"')
})

// .claude/settings.json is often committed while ./.insta stays local-only, so a fresh clone
// (cloud code session, teammate checkout) has the hook registered but no hook.js — the command
// must no-op there, not spam MODULE_NOT_FOUND after every tool call. Found live (2026-07-15).
posixTest('hook command exits 0 when .insta/observe/hook.js is absent, runs it when present', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const cmd = settings.hooks.PostToolUse.at(-1).hooks[0].command
  const run = (projectDir: string) =>
    spawnSync('sh', ['-c', cmd], { env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir } })
  const bare = mkdtempSync(join(tmpdir(), 'obs-clone-')) // fresh clone: no .insta at all
  expect(run(bare).status).toBe(0)
  expect(run(bare).stderr.toString()).toBe('')
  writeFileSync(join(cwd, '.insta', 'observe', 'hook.js'), 'process.stdout.write("ran")')
  expect(run(cwd).stdout.toString()).toBe('ran')
})

test('re-install replaces a broken legacy args-array entry instead of stacking', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.insta/observe/hook.js'], _insta: 'insta-observe' }] }] },
  }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const all = settings.hooks.PostToolUse.flatMap((g: any) => g.hooks)
  expect(all).toHaveLength(1)
  expect(all[0].args).toBeUndefined()
})
