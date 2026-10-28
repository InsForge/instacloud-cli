import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect, vi } from 'vitest'
import { ensureCliInstalled, findDurableOnPath, resolveSpawnable, setupAgent, SETUP_ARGS } from '../src/commands/setup.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
const posixTest = process.platform === 'win32' ? test.skip : test

posixTest('findDurableOnPath finds a real global shim and ignores npx cache entries', () => {
  const globalBin = mkdtempSync(join(tmpdir(), 'insta-bin-'))
  const npxBin = join(mkdtempSync(join(tmpdir(), 'insta-npx-')), 'node_modules', '.bin')
  mkdirSync(npxBin, { recursive: true })
  writeFileSync(join(npxBin, 'insta'), '#!/bin/sh\n', { mode: 0o755 })

  // Only the npx cache shim exists — the durable scan must NOT count it.
  expect(findDurableOnPath('insta', { PATH: `${npxBin}:${globalBin}` }, 'linux')).toBe(false)
  // An executable shim in a real bin dir does count.
  writeFileSync(join(globalBin, 'insta'), '#!/bin/sh\n', { mode: 0o755 })
  expect(findDurableOnPath('insta', { PATH: `${npxBin}:${globalBin}` }, 'linux')).toBe(true)
})

test('findDurableOnPath ignores an npx cache shim on Windows but finds a global insta.cmd', () => {
  const globalBin = mkdtempSync(join(tmpdir(), 'insta-win-global-'))
  const npxBin = join(mkdtempSync(join(tmpdir(), 'insta-win-npx-')), 'node_modules', '.bin')
  mkdirSync(npxBin, { recursive: true })
  writeFileSync(join(npxBin, 'insta.CMD'), '@echo off\n')
  const env = { PATH: `${npxBin};${globalBin}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }

  expect(findDurableOnPath('insta', env, 'win32')).toBe(false)
  writeFileSync(join(globalBin, 'insta.CMD'), '@echo off\n')
  expect(findDurableOnPath('insta', env, 'win32')).toBe(true)
})

posixTest('findDurableOnPath rejects POSIX PATH hits that could not actually run', () => {
  const bin = mkdtempSync(join(tmpdir(), 'insta-noexec-'))
  writeFileSync(join(bin, 'insta'), 'not a program\n', { mode: 0o644 }) // no exec bit
  expect(findDurableOnPath('insta', { PATH: bin }, 'linux')).toBe(false)
  const bin2 = mkdtempSync(join(tmpdir(), 'insta-dir-'))
  mkdirSync(join(bin2, 'insta')) // a DIRECTORY named insta
  expect(findDurableOnPath('insta', { PATH: bin2 }, 'linux')).toBe(false)
})

test('findDurableOnPath resolves Windows shims via PATHEXT (insta.cmd) and the extensionless sh shim', () => {
  const bin = mkdtempSync(join(tmpdir(), 'insta-win-'))
  writeFileSync(join(bin, 'insta.CMD'), '@echo off\n')
  const env = { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  expect(findDurableOnPath('insta', env, 'win32')).toBe(true)
  // npm also writes an extensionless sh shim — found even without a PATHEXT match.
  const bin2 = mkdtempSync(join(tmpdir(), 'insta-win2-'))
  writeFileSync(join(bin2, 'insta'), '#!/bin/sh\n')
  expect(findDurableOnPath('insta', { PATH: bin2, PATHEXT: '.COM;.EXE' }, 'win32')).toBe(true)
})

test('resolveSpawnable resolves a logical npm via npm_execpath (npx-cli.js → sibling npm-cli.js)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'insta-execpath-'))
  const npxCli = join(bin, 'npx-cli.js')
  const npmCli = join(bin, 'npm-cli.js')
  writeFileSync(npxCli, '')
  writeFileSync(npmCli, '')
  expect(resolveSpawnable('npm', ['install', '-g', 'insta@1.2.3'], npxCli, '/nvm/v20/bin/node', 'linux'))
    .toEqual({ cmd: '/nvm/v20/bin/node', args: [npmCli, 'install', '-g', 'insta@1.2.3'] })
})

test('resolveSpawnable never re-enters a non-npm launcher (yarn.js, pnpm.cjs, bun, none)', () => {
  const fallback = { cmd: 'npm', args: ['install', '-g', 'insta@1.2.3'] }
  const fakeNode = '/fake/prefix/bin/node' // no npm beside it → bare-npm last resort (POSIX)
  expect(resolveSpawnable('npm', fallback.args, '', fakeNode, 'linux')).toEqual(fallback)
  expect(resolveSpawnable('npm', fallback.args, '/fake/tools/bun', '/fake/tools/bun', 'linux')).toEqual(fallback)
  // yarn classic sets npm_execpath to yarn.js — `node yarn.js install -g` is not a valid
  // invocation of anything, so it must NOT be re-entered.
  expect(resolveSpawnable('npm', fallback.args, '/usr/lib/yarn/bin/yarn.js', fakeNode, 'linux')).toEqual(fallback)
  expect(resolveSpawnable('npm', fallback.args, '/usr/lib/pnpm/dist/pnpm.cjs', fakeNode, 'linux')).toEqual(fallback)
})

test('resolveSpawnable never node-re-enters when execPath is not node (native binary channel)', () => {
  // npm scripts export npm_execpath to children — a native `insta` run from an npm script must
  // NOT spawn `insta npx-cli.js …`. With a non-node execPath, npm/npx take the shim path.
  const bin = mkdtempSync(join(tmpdir(), 'insta-native-'))
  const realNpxCli = join(bin, 'npx-cli.js')
  writeFileSync(realNpxCli, '')
  expect(resolveSpawnable('npx', ['-y', 'skills', 'add'], realNpxCli, '/usr/local/bin/insta', 'linux'))
    .toEqual({ cmd: 'npx', args: ['-y', 'skills', 'add'] })
})

test('resolveSpawnable without npm_execpath uses the npm shipped beside the running node (spawnable on Windows)', () => {
  const ARGS = ['install', '-g', 'insta@1.2.3']
  // POSIX layout: <prefix>/bin/node + <prefix>/lib/node_modules/npm/bin/npm-cli.js
  const posixPrefix = mkdtempSync(join(tmpdir(), 'insta-node-'))
  const posixNpm = join(posixPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  mkdirSync(dirname(posixNpm), { recursive: true })
  writeFileSync(posixNpm, '')
  const posixNode = join(posixPrefix, 'bin', 'node')
  expect(resolveSpawnable('npm', ARGS, '', posixNode, 'linux'))
    .toEqual({ cmd: posixNode, args: [posixNpm, ...ARGS] })

  // Windows layout: <dir>\node.exe + <dir>\node_modules\npm\bin\npm-cli.js — bare `npm` would
  // be npm.cmd, which spawn() without a shell refuses.
  const winDir = mkdtempSync(join(tmpdir(), 'insta-nodew-'))
  const winNpm = join(winDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  mkdirSync(dirname(winNpm), { recursive: true })
  writeFileSync(winNpm, '')
  const winNode = join(winDir, 'node.exe')
  expect(resolveSpawnable('npm', ARGS, '', winNode, 'win32'))
    .toEqual({ cmd: winNode, args: [winNpm, ...ARGS] })

  // An ALREADY-RESOLVED node.exe invocation passing back through must NOT be cmd.exe-wrapped —
  // absolute paths and .exe targets are directly spawnable (the win32 wrapper is for bare shims).
  expect(resolveSpawnable(winNode, [winNpm, ...ARGS], '', winNode, 'win32'))
    .toEqual({ cmd: winNode, args: [winNpm, ...ARGS] })
})

test('ensureCliInstalled installs globally only on the npm channel with no durable insta', async () => {
  const runs: string[][] = []
  const runner = async (_cmd: string, args: string[]) => { runs.push(args); return { ok: true, output: '' } }

  await ensureCliInstalled(runner, 'npm', false, () => true)
  expect(runs).toHaveLength(1)
  expect(runs[0]!.slice(-3)).toEqual(['install', '-g', `insta@${VERSION}`]) // pinned to the running version

  runs.length = 0
  await ensureCliInstalled(runner, 'npm', true) // already durable — idempotent no-op
  await ensureCliInstalled(runner, 'binary', false) // native install — never npm-installs over it
  await ensureCliInstalled(runner, 'source', false) // dev checkout — never self-installs
  expect(runs).toHaveLength(0)
})

test('ensureCliInstalled only claims success after re-finding insta on PATH', async () => {
  const captured = async (fn: () => Promise<void>): Promise<string> => {
    let out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
    try { await fn() } finally { spy.mockRestore() }
    return out
  }
  // recheck true → the unqualified success line
  const okOut = await captured(() => ensureCliInstalled(async () => ({ ok: true, output: '' }), 'npm', false, () => true))
  expect(okOut).toContain('now works in any shell')

  // recheck false (custom npm prefix off PATH) → the add-to-PATH guidance, NOT the success claim
  const missOut = await captured(() => ensureCliInstalled(async () => ({ ok: true, output: '' }), 'npm', false, () => false))
  expect(missOut).toContain('not on PATH')
  expect(missOut).not.toContain('now works in any shell')
})

test('resolveSpawnable re-enters npm/npx as node scripts so Windows .cmd shims are never spawned', () => {
  // From npm_execpath: an npm-cli.js execpath resolves an `npx` call to its sibling npx-cli.js.
  const npmBin = mkdtempSync(join(tmpdir(), 'insta-npmbin-'))
  const npmCli = join(npmBin, 'npm-cli.js')
  const npxCli = join(npmBin, 'npx-cli.js')
  writeFileSync(npmCli, '')
  writeFileSync(npxCli, '')
  expect(resolveSpawnable('npx', ['skills', 'add'], npmCli, '/fake/bin/node', 'win32'))
    .toEqual({ cmd: '/fake/bin/node', args: [npxCli, 'skills', 'add'] })

  // Beside the running node (Windows layout), covering the default command path on win32.
  const winDir = mkdtempSync(join(tmpdir(), 'insta-winnode-'))
  const winNpx = join(winDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  mkdirSync(dirname(winNpx), { recursive: true })
  writeFileSync(winNpx, '')
  const winNode = join(winDir, 'node.exe')
  expect(resolveSpawnable('npx', ['skills', 'add'], '', winNode, 'win32'))
    .toEqual({ cmd: winNode, args: [winNpx, 'skills', 'add'] })

  // Non-npm commands on Windows (claude is an npm-installed .cmd shim too) go through cmd.exe,
  // resolved to the shim's ABSOLUTE PATH first — cmd.exe searches the current directory before
  // PATH, so a bare name would let a claude.cmd planted in the project dir shadow the real CLI.
  const shimBin = mkdtempSync(join(tmpdir(), 'insta-shim-'))
  const claudeShim = join(shimBin, 'claude.CMD')
  writeFileSync(claudeShim, '@echo off\n')
  const winEnv = { PATH: shimBin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  expect(resolveSpawnable('claude', ['mcp', 'add', '--header', 'Authorization: Bearer x'], npmCli, winNode, 'win32', winEnv, 'C:\\Windows'))
    .toEqual({ cmd: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/v:off', '/s', '/c', `""${claudeShim}" "mcp" "add" "--header" "Authorization: Bearer x""`], windowsVerbatimArguments: true })
  // Not on PATH → passthrough; the bare spawn fails and the probe treats it as not-installed.
  expect(resolveSpawnable('claude', ['--version'], npmCli, winNode, 'win32', { PATH: '' }))
    .toEqual({ cmd: 'claude', args: ['--version'] })
  // cmd.exe metacharacters can't be safely quoted through the wrapper (libuv re-quotes) —
  // such args skip it and the callers' best-effort degradation handles the failed bare spawn.
  expect(resolveSpawnable('claude', ['mcp', 'add', 'x', 'https://mcp.example.com/mcp?a=1&b=2'], npmCli, winNode, 'win32', winEnv))
    .toEqual({ cmd: 'claude', args: ['mcp', 'add', 'x', 'https://mcp.example.com/mcp?a=1&b=2'] })
  // The absolute shim path is cmd.exe input too. A metacharacter in a PATH directory must not
  // become a shell operator; skip the wrapper and let the caller degrade on a failed bare spawn.
  const hostileBin = join(mkdtempSync(join(tmpdir(), 'insta-shim-')), 'has&meta')
  mkdirSync(hostileBin)
  writeFileSync(join(hostileBin, 'claude.CMD'), '@echo off\n')
  expect(resolveSpawnable('claude', ['--version'], npmCli, winNode, 'win32', { PATH: hostileBin, PATHEXT: '.CMD' }, 'C:\\Windows'))
    .toEqual({ cmd: 'claude', args: ['--version'] })
  // On POSIX, non-npm commands and unresolvable environments pass through untouched.
  expect(resolveSpawnable('claude', ['--version'], npmCli, '/fake/bin/node', 'linux'))
    .toEqual({ cmd: 'claude', args: ['--version'] })
  expect(resolveSpawnable('npx', ['skills'], '', '/fake/bin/node', 'linux'))
    .toEqual({ cmd: 'npx', args: ['skills'] })
})

test('setupAgent self-installs the CLI BEFORE the skill install (the skill points agents at `insta`)', async () => {
  const runs: string[][] = []
  const runner = async (_cmd: string, args: string[]) => { runs.push(args); return { ok: true, output: '' } }
  await setupAgent(
    { yes: true },
    runner,
    undefined,
    async () => [],
    (r) => ensureCliInstalled(r, 'npm', false, () => true), // force the npx-with-no-durable-insta case
    async () => ({ apiUrl: 'https://api.instacloud.com' }), // isolated: never read the real ~/.insta
    async () => { throw new Error('unexpected env switch') },
  )
  expect(runs[0]!.slice(-3)).toEqual(['install', '-g', `insta@${VERSION}`])
  // Shape, not exact args: the skill source varies with the resolved environment, and
  // SETUP_ARGS' content is already asserted in setup-agent.test.ts. This test is about ORDER.
  expect(runs[1]!.slice(0, 2)).toEqual(SETUP_ARGS.slice(0, 2)) // ['-y', 'skills']
  expect(runs[1]!.join(' ')).toContain('-s insta')
})

test('ensureCliInstalled is best-effort: a failed install prints the fallback (and the EACCES hint) without an exit code', async () => {
  const prev = process.exitCode
  let out = ''
  let exitCodeAfter: typeof process.exitCode = 'unset-sentinel' as never
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
  try {
    await ensureCliInstalled(async () => ({ ok: false, output: 'npm ERR! EACCES permission denied' }), 'npm', false, () => false)
    exitCodeAfter = process.exitCode
  } finally {
    spy.mockRestore()
    process.exitCode = prev
  }
  expect(out).toContain('npm install -g insta') // the manual fallback line
  expect(out).toContain('permission error') // the targeted EACCES hint
  expect(exitCodeAfter).toBe(prev) // best-effort: no exit code was set
})
