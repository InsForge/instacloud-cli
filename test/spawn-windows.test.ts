import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { expect, test } from 'vitest'
import { resolveSpawnable } from '../src/spawn.js'
import { resolveRunSpec } from '../src/commands/upgrade.js'

test('native Windows shim invocations preserve their quoted command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta spaced '))
  try {
    const shim = join(dir, 'npx.CMD')
    writeFileSync(shim, '@echo off\r\n')
    expect(resolveSpawnable('npx', ['-y', 'two words', '', 'C:\\work dir\\'], '', 'insta.exe', 'win32', { PATH: dir, PATHEXT: '.CMD' }, 'C:\\Windows'))
      .toEqual({
        cmd: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/v:off', '/s', '/c', `""${shim}" "-y" "two words" "" "C:\\work dir\\\\""`],
        windowsVerbatimArguments: true,
      })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test.each(['&', '|', '<', '>', '^', '%', '"', '\r', '\n'])(
  'Windows shim wrapping refuses shell syntax %j in arguments', (character) => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-shim-'))
    try {
      writeFileSync(join(dir, 'npx.CMD'), '@echo off\r\n')
      const args = ['first', `x${character}y`]
      expect(resolveSpawnable('npx', args, '', 'insta.exe', 'win32', { PATH: dir, PATHEXT: '.CMD' }))
        .toEqual({ cmd: 'npx', args })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  },
)

test.skipIf(process.platform !== 'win32')('Windows executes spaced npm shims with literal arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta spaced (shim)! '))
  try {
    writeFileSync(join(dir, 'npx.CMD'), '@echo off\r\n"%INSTA_TEST_NODE%" "%~dp0argv.cjs" %*\r\n')
    writeFileSync(join(dir, 'argv.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const env = { ...process.env, PATH: dir, PATHEXT: '.CMD', INSTA_TEST_NODE: process.execPath, INSTA_TEST_EXPAND: 'expanded' }
    const args = ['-y', 'skills', 'add', 'two words', '', 'C:\\work dir\\', '*', '(parentheses)', '!INSTA_TEST_EXPAND!']
    const spec = resolveRunSpec({ cmd: 'npx', args, env }, '', join(dir, 'insta.exe'), 'win32')
    const result = spawnSync(spec.cmd, spec.args, { env, encoding: 'utf8', windowsVerbatimArguments: spec.windowsVerbatimArguments })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual(args)
    expect(spec.cmd).toBe(win32.join(process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows', 'System32', 'cmd.exe'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
