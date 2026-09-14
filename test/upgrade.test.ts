import { test, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmpSemver, decideAction, detectChannel, readCache, writeCache, type CheckCache, skipsUpdateCheck } from '../src/commands/upgrade.js'
import { ENSURE_CERT_COMMAND } from '../src/commands/compute.js'

beforeEach(() => {
  process.env.INSTA_UPDATE_CACHE = join(mkdtempSync(join(tmpdir(), 'insta-up-')), 'update-check.json')
})

test('cmpSemver orders dotted versions numerically', () => {
  expect(cmpSemver('0.0.4', '0.0.3')).toBe(1)
  expect(cmpSemver('0.0.4', '0.0.4')).toBe(0)
  expect(cmpSemver('0.0.4', '0.0.10')).toBe(-1) // numeric, not lexicographic
  expect(cmpSemver('1.0.0', '0.9.9')).toBe(1)
  expect(cmpSemver('0.1', '0.1.0')).toBe(0)
})

test('detectChannel: bun binary vs npm global vs source', () => {
  expect(detectChannel('/Users/x/.insta/bin/insta', 'file:///snapshot/whatever.js')).toBe('binary')
  expect(detectChannel('/usr/local/bin/node', 'file:///usr/lib/node_modules/insta/dist/commands/upgrade.js')).toBe('npm')
  expect(detectChannel('/usr/local/bin/node', 'file:///Users/x/insta-cli/src/commands/upgrade.ts')).toBe('source')
})

test('cache round-trips through INSTA_UPDATE_CACHE override', () => {
  expect(readCache()).toBeNull()
  writeCache({ checkedAt: 42, latest: '0.0.9' })
  expect(readCache()).toEqual({ checkedAt: 42, latest: '0.0.9' })
})

test('decideAction: none when current is latest or no cache', () => {
  expect(decideAction(null, '0.0.4', true, 'binary')).toBe('none')
  expect(decideAction({ checkedAt: 1, latest: '0.0.4' }, '0.0.4', true, 'binary')).toBe('none')
  expect(decideAction({ checkedAt: 1, latest: '0.0.3' }, '0.0.4', true, 'binary')).toBe('none')
})

test('decideAction: auto by default on binary/npm; nudge when off or source', () => {
  const cache: CheckCache = { checkedAt: 1, latest: '0.0.9' }
  expect(decideAction(cache, '0.0.4', true, 'binary')).toBe('auto')
  expect(decideAction(cache, '0.0.4', true, 'npm')).toBe('auto')
  expect(decideAction(cache, '0.0.4', false, 'binary')).toBe('nudge')
  expect(decideAction(cache, '0.0.4', true, 'source')).toBe('nudge')
})

test('decideAction: auto is throttled after a recent attempt', () => {
  const now = 1_000_000_000
  const recent: CheckCache = { checkedAt: 1, latest: '0.0.9', lastAutoAt: now - 60_000 }
  const stale: CheckCache = { checkedAt: 1, latest: '0.0.9', lastAutoAt: now - 2 * 60 * 60 * 1000 }
  expect(decideAction(recent, '0.0.4', true, 'binary', now)).toBe('nudge')
  expect(decideAction(stale, '0.0.4', true, 'binary', now)).toBe('auto')
})

// Internal commands must never nudge about an update or spawn a background one.
test('the update machinery itself is exempt from the update check', () => {
  expect(skipsUpdateCheck('upgrade')).toBe(true)
  expect(skipsUpdateCheck('autoupdate')).toBe(true)
  expect(skipsUpdateCheck('__update-check')).toBe(true)
})

test('the ssh renewal hook is exempt, by the name the config block invokes', () => {
  // OpenSSH runs it while PARSING ssh_config on every ssh/scp/`ssh -G`/IDE
  // connection, so a nudge lands in the ssh session's stderr and an
  // auto-upgrade spawns a detached process mid-connection. Read from the
  // constant, so renaming the command without keeping `__` fails here.
  const leaf = ENSURE_CERT_COMMAND.split(/\s+/).find((t) => t.startsWith('__'))!
  expect(skipsUpdateCheck(leaf), 'the ssh renewal hook runs the update check').toBe(true)
  expect(skipsUpdateCheck('__anything-added-later'), 'the rule is not a prefix rule').toBe(true)
})

test('an ordinary command still checks for updates', () => {
  // The positive control: a rule broad enough to exempt every internal command
  // could also exempt every real one, and that failure is invisible from a
  // table of exemptions.
  for (const cmd of ['deploy', 'compute', 'login', 'secrets', undefined]) {
    expect(skipsUpdateCheck(cmd), `${cmd} stopped checking for updates`).toBe(false)
  }
})
