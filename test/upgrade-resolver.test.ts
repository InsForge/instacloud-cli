// Regression tests for the self-update version resolver.
//
// Bug being fixed: existing installs sat on 0.0.45 while npm's `latest` dist-tag said 0.0.47.
// The background check had recorded `latest: "0.0.45"` (true at the moment it ran, 44 minutes
// before 0.0.47 was published) and a 24h TTL then froze that answer, so nothing re-checked and
// no upgrade was offered. Separately, the binary channel resolved its own idea of "latest" from
// GitHub /releases/latest while the npm channel used npm's dist-tag — two sources that have
// already drifted (v0.0.46 was merged but never tagged, so it exists on neither).
//
// Namespace import on purpose: several of these APIs are new, and a namespace import makes the
// pre-fix run fail as readable assertions rather than an ESM binding error that kills the file.
import { test, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import * as up from '../src/commands/upgrade.js'

let cacheFile: string

beforeEach(() => {
  cacheFile = join(mkdtempSync(join(tmpdir(), 'insta-up-')), 'update-check.json')
  process.env.INSTA_UPDATE_CACHE = cacheFile
  delete process.env.INSTA_NO_AUTOUPDATE
})

// The registry as it actually looks today: `latest` is 0.0.47, `next` is a prerelease.
const DIST_TAGS = { next: '0.0.23-rc.1', latest: '0.0.47' }

test('Windows npm upgrades re-enter npm through node instead of spawning the .cmd shim', () => {
  const nodeDir = mkdtempSync(join(tmpdir(), 'insta-up-node-'))
  const node = join(nodeDir, 'node.exe')
  const npmCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  mkdirSync(dirname(npmCli), { recursive: true })
  writeFileSync(npmCli, '')
  const env = { PATH: nodeDir }

  expect(up.resolveRunSpec(
    { cmd: 'npm', args: ['install', '-g', 'insta@0.0.48'], env },
    '',
    node,
    'win32',
  )).toEqual({
    cmd: node,
    args: [npmCli, 'install', '-g', 'insta@0.0.48'],
    env,
  })
})

// The post-upgrade probe (`observeInstalled`) hands resolveRunSpec a COPY of the environment
// (`{ ...process.env, INSTA_NO_AUTOUPDATE: '1' }`). On Windows that copy is an ordinary object
// carrying Windows' own casing — `Path`, not `PATH` — so a PATH lookup that only reads `env.PATH`
// resolves nothing and the probe spawns the bare `insta` .cmd shim this PR exists to stop.
test('the Windows version probe resolves the installed shim through a copied `Path` environment', () => {
  const shimBin = mkdtempSync(join(tmpdir(), 'insta-shim-'))
  const shim = join(shimBin, 'insta.CMD')
  writeFileSync(shim, '@echo off\n')
  const cmdExe = win32.join(process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const wrapped = { cmd: cmdExe, args: ['/d', '/v:off', '/s', '/c', `""${shim}" "--version""`], windowsVerbatimArguments: true }

  // Windows' real casing, as a spread of process.env preserves it.
  const copied = { Path: shimBin, PATHEXT: '.CMD', INSTA_NO_AUTOUPDATE: '1' }
  expect(up.resolveRunSpec({ cmd: 'insta', args: ['--version'], env: copied }, '', 'C:\\Program Files\\nodejs\\node.exe', 'win32'))
    .toEqual({ ...wrapped, env: copied })

  // PATHEXT is just as case-free on Windows, and either spelling of PATH must work.
  const mixed = { PATH: shimBin, PathExt: '.CMD' }
  expect(up.resolveRunSpec({ cmd: 'insta', args: ['--version'], env: mixed }, '', 'C:\\Program Files\\nodejs\\node.exe', 'win32'))
    .toEqual({ ...wrapped, env: mixed })

  // POSIX stays case-SENSITIVE: a stray `Path` must not be mistaken for `PATH` there.
  expect(up.resolveRunSpec({ cmd: 'insta', args: ['--version'], env: { Path: shimBin } }, '', '/usr/bin/node', 'linux'))
    .toEqual({ cmd: 'insta', args: ['--version'], env: { Path: shimBin } })
})

function fakeRegistry(
  tags: Record<string, string> | null,
  manifest: { version?: string } | null = { version: '0.0.45' },
): { fetchImpl: up.Fetcher; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    const body = url.includes('/-/package/') ? tags : manifest
    if (body === null) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as up.Fetcher
  return { fetchImpl, urls }
}

// ---- 1. the resolver reads npm's `latest` dist-tag ----

test("resolveLatest returns npm's latest dist-tag", async () => {
  const { fetchImpl, urls } = fakeRegistry(DIST_TAGS)
  await expect(up.resolveLatest(fetchImpl)).resolves.toBe('0.0.47')
  expect(urls[0]).toBe('https://registry.npmjs.org/-/package/insta/dist-tags')
})

test('resolveLatest falls back to the latest manifest when dist-tags is unavailable', async () => {
  const { fetchImpl } = fakeRegistry(null, { version: '0.0.47' })
  await expect(up.resolveLatest(fetchImpl)).resolves.toBe('0.0.47')
})

test('resolveLatest returns null (never a guess) when the registry is unreachable', async () => {
  const boom = (async () => {
    throw new Error('ENOTFOUND')
  }) as up.Fetcher
  await expect(up.resolveLatest(boom)).resolves.toBeNull()
})

// ---- 2. a prerelease / the `next` tag is never "latest" ----

test('the `next` prerelease tag is never selected as latest', () => {
  expect(up.pickLatestDistTag(DIST_TAGS)).toBe('0.0.47')
  expect(up.pickLatestDistTag({ next: '0.0.23-rc.1' })).toBeNull()
  expect(up.pickLatestDistTag({ latest: '0.0.48-rc.1', next: '0.0.23-rc.1' })).toBeNull()
  expect(up.isStableVersion('0.0.23-rc.1')).toBe(false)
  expect(up.isStableVersion('0.0.47')).toBe(true)
})

test('a prerelease cache entry never triggers an upgrade', () => {
  expect(up.decideAction({ checkedAt: 1, latest: '0.0.48-rc.1' }, '0.0.47', true, 'binary')).toBe('none')
})

// ---- 3. real semver comparison ----

test('cmpSemver orders releases numerically, not lexicographically', () => {
  expect(up.cmpSemver('0.0.45', '0.0.47')).toBe(-1) // the version pair from this bug
  expect(up.cmpSemver('0.0.47', '0.0.45')).toBe(1)
  expect(up.cmpSemver('0.0.9', '0.0.10')).toBe(-1) // string compare would say 0.0.9 > 0.0.10
  expect(up.cmpSemver('0.0.10', '0.0.9')).toBe(1)
  expect(up.cmpSemver('0.9.9', '0.10.0')).toBe(-1)
})

test('cmpSemver: a release outranks a prerelease of the same version', () => {
  expect(up.cmpSemver('0.0.23-rc.1', '0.0.23')).toBe(-1)
  expect(up.cmpSemver('0.0.23', '0.0.23-rc.1')).toBe(1)
  expect(up.cmpSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
  expect(up.cmpSemver('0.0.47', '0.0.23-rc.1')).toBe(1)
})

// ---- 4. a stale cache must not suppress a real upgrade ----

test('cacheIsFresh: an entry older than the TTL is not usable', () => {
  const now = 2_000_000_000_000
  expect(up.cacheIsFresh({ checkedAt: now - 60_000, latest: '0.0.45' }, '0.0.45', now)).toBe(true)
  // The exact shape of the reported bug: checked ~16h ago, `latest` recorded as our own version.
  expect(up.cacheIsFresh({ checkedAt: now - 16 * 3600_000, latest: '0.0.45' }, '0.0.45', now)).toBe(false)
})

test('cacheIsFresh: a cache claiming a `latest` older than the running build is never trusted', () => {
  const now = 2_000_000_000_000
  expect(up.cacheIsFresh({ checkedAt: now - 1000, latest: '0.0.45' }, '0.0.47', now)).toBe(false)
  expect(up.cacheIsFresh({ checkedAt: now - 1000, latest: 'not-a-version' }, '0.0.45', now)).toBe(false)
  expect(up.cacheIsFresh(null, '0.0.45', now)).toBe(false)
})

test('a cached latest of 0.0.45 does not suppress the real 0.0.47 upgrade', async () => {
  const now = 2_000_000_000_000
  up.writeCache({ checkedAt: now - 1000, latest: '0.0.45' }) // fresh-looking, but stale content
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const calls: Array<[string, string]> = []
  const action = await up.backgroundCheck('0.0.45', {
    fetchImpl,
    channel: 'binary',
    auto: true,
    now,
    runUpgrade: async (current, latest) => {
      calls.push([current, latest])
    },
  })
  expect(action).toBe('auto')
  expect(calls).toEqual([['0.0.45', '0.0.47']])
  // and the cache now carries the true answer
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ latest: '0.0.47', checkedAt: now })
})

test('backgroundCheck nudges instead of upgrading when autoupdate is off', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  let ran = false
  const action = await up.backgroundCheck('0.0.45', {
    fetchImpl,
    channel: 'binary',
    auto: false,
    now: 2_000_000_000_000,
    runUpgrade: async () => {
      ran = true
    },
  })
  expect(action).toBe('nudge')
  expect(ran).toBe(false)
})

// ---- 5. explicit `insta upgrade` bypasses the cache and hits both channels identically ----

// An observer standing in for `<installDir>/insta --version` on the freshly installed binary.
const installed = (v: string | null): up.Observer => async () => v

test('insta upgrade ignores the cache and installs npm’s latest on the binary channel', async () => {
  const now = 2_000_000_000_000
  up.writeCache({ checkedAt: now, latest: '0.0.45' }) // maximally fresh, and wrong
  const { fetchImpl, urls } = fakeRegistry(DIST_TAGS)
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now,
    installDir: '/home/u/.insta/bin',
    observe: installed('0.0.47'),
    run: async (spec) => {
      runs.push(spec)
    },
  })
  expect(urls.length).toBeGreaterThan(0) // it went to the registry rather than reading the cache
  expect(runs).toHaveLength(1)
  expect(runs[0].cmd).toBe('sh')
  // pinned to the exact version npm serves — not GitHub's independent /releases/latest
  expect(runs[0].env.INSTA_VERSION).toBe('v0.0.47')
  expect(runs[0].env.INSTA_INSTALL_DIR).toBe('/home/u/.insta/bin')
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ latest: '0.0.47' })
})

test('insta upgrade installs the same resolved version on the npm channel', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'npm',
    now: 2_000_000_000_000,
    observe: installed('0.0.47'),
    run: async (spec) => {
      runs.push(spec)
    },
  })
  expect(runs).toHaveLength(1)
  expect(runs[0].cmd).toBe('npm')
  expect(runs[0].args).toEqual(['install', '-g', 'insta@0.0.47'])
})

test('insta upgrade is a no-op when already on the resolved latest', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.47', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    run: async (spec) => {
      runs.push(spec)
    },
  })
  expect(runs).toEqual([])
})

test('a pinned binary install that fails falls back to the newest published release', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    installDir: '/home/u/.insta/bin',
    observe: installed('0.0.45'),
    run: async (spec) => {
      runs.push(spec)
      if (spec.env.INSTA_VERSION) throw new Error('download failed')
    },
  })
  expect(runs).toHaveLength(2)
  expect(runs[0].env.INSTA_VERSION).toBe('v0.0.47')
  expect(runs[1].env.INSTA_VERSION).toBeUndefined()
})

test('insta upgrade still upgrades when the registry is unreachable', async () => {
  const boom = (async () => {
    throw new Error('ENOTFOUND')
  }) as up.Fetcher
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.45', {
    fetchImpl: boom,
    channel: 'npm',
    now: 2_000_000_000_000,
    observe: installed('0.0.47'),
    run: async (spec) => {
      runs.push(spec)
    },
  })
  expect(runs[0].args).toEqual(['install', '-g', 'insta@latest'])
})

// ---- 5b. the report quotes what is ON DISK, never what was asked for ----

// The v0.0.46-style drift, end to end: npm's dist-tag is ahead of GitHub Releases. The pinned
// install 404s; the unpinned retry hits install.sh's "already current?" short-circuit (current
// v0.0.45 == GitHub /releases/latest v0.0.45), installs nothing, exits 0.
function driftInstaller(runs: up.RunSpec[]): up.Runner {
  return async (spec) => {
    runs.push(spec)
    if (spec.env.INSTA_VERSION) throw new Error('upgrade failed (exit 1)') // asset 404
    // unpinned: "✓ insta v0.0.45 already installed — up to date", exit 0, nothing written
  }
}

test('drift: the fallback that installed nothing reports "still 0.0.45" with the npm hint, not "→ 0.0.47"', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const runs: up.RunSpec[] = []
  const out: string[] = []
  const now = 2_000_000_000_000
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now,
    installDir: '/home/u/.insta/bin',
    run: driftInstaller(runs),
    observe: installed('0.0.45'), // what `insta --version` really says afterwards
    report: (m) => out.push(m),
  })
  expect(runs).toHaveLength(2) // pinned, then unpinned
  const text = out.join('\n')
  expect(text).not.toMatch(/upgraded 0\.0\.45 → 0\.0\.47/)
  expect(text).not.toMatch(/✓ insta upgraded/)
  expect(text).toMatch(/insta is still 0\.0\.45/)
  expect(text).toMatch(/0\.0\.47.*published on npm/)
  expect(text).toMatch(/binary assets are not on GitHub Releases yet/)
  expect(text).toMatch(/npm i -g insta@latest/)
  // The cache carries the OBSERVED version — the newest this channel could actually install —
  // so start-up does not keep advertising a build the user cannot get.
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ latest: '0.0.45', checkedAt: now })
})

test('happy pinned path: the report quotes the observed transition', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const out: string[] = []
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    installDir: '/home/u/.insta/bin',
    run: async (spec) => {
      runs.push(spec)
    },
    observe: installed('0.0.47'),
    report: (m) => out.push(m),
  })
  expect(runs).toHaveLength(1)
  expect(out.join('\n')).toMatch(/✓ insta upgraded 0\.0\.45 → 0\.0\.47/)
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ latest: '0.0.47' })
})

test('the report names the version the installer actually left, even when it differs from latest', async () => {
  // Pinned 0.0.47 failed; unpinned landed 0.0.46 (a release that exists on GitHub but is behind npm).
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const out: string[] = []
  const runs: up.RunSpec[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    run: driftInstaller(runs),
    observe: installed('0.0.46'),
    report: (m) => out.push(m),
  })
  const text = out.join('\n')
  expect(text).toMatch(/✓ insta upgraded 0\.0\.45 → 0\.0\.46/)
  // the pre-install "upgrading … → 0.0.47" line states intent; the OUTCOME line must not claim it
  expect(text).not.toMatch(/upgraded .* → 0\.0\.47/)
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ latest: '0.0.46' })
})

test('when the installed version cannot be read, no transition is claimed', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const out: string[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    run: async () => {},
    observe: installed(null),
    report: (m) => out.push(m),
  })
  const text = out.join('\n')
  expect(text).not.toMatch(/✓ insta upgraded/)
  expect(text).toMatch(/could not be read/)
  expect(text).toMatch(/insta --version/)
})

test('npm channel: an install that did not change the version says so instead of claiming latest', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const out: string[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'npm',
    now: 2_000_000_000_000,
    run: async () => {},
    observe: installed('0.0.45'),
    report: (m) => out.push(m),
  })
  const text = out.join('\n')
  expect(text).toMatch(/insta is still 0\.0\.45/)
  expect(text).not.toMatch(/✓ insta upgraded/)
})

// ---- 6. installed NEWER than the cached `latest` (the state a fresh `insta upgrade` leaves) ----

test('an installed version newer than the cached latest never triggers an upgrade', () => {
  // 0.0.47 installed, cache still says 0.0.45 — the exact state a pre-fix `insta upgrade` left.
  expect(up.decideAction({ checkedAt: 1, latest: '0.0.45' }, '0.0.47', true, 'binary')).toBe('none')
  expect(up.decideAction({ checkedAt: 1, latest: '0.0.9' }, '0.0.10', true, 'binary')).toBe('none')
  // …but it must not be treated as a usable cache either, or the next release stays invisible.
  const now = 2_000_000_000_000
  expect(up.cacheIsFresh({ checkedAt: now - 1000, latest: '0.0.45' }, '0.0.47', now)).toBe(false)
})

test('a successful upgrade rewrites the cache instead of leaving it claiming the old latest', async () => {
  const stamped = 1_787_707_409_036 // the real stamp from the reported machine
  up.writeCache({ checkedAt: stamped, latest: '0.0.45', lastAutoAt: 1_787_613_328_905 })
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const now = 2_000_000_000_000
  await up.upgrade('0.0.45', { fetchImpl, channel: 'binary', now, run: async () => {}, observe: installed('0.0.47') })
  const after = JSON.parse(readFileSync(cacheFile, 'utf8'))
  expect(after.latest).toBe('0.0.47')
  expect(after.checkedAt).toBe(now)
  expect(after.lastAutoAt).toBe(1_787_613_328_905) // the auto-throttle stamp is preserved
})

test('even a no-op upgrade refreshes the cache (it still learned the true latest)', async () => {
  up.writeCache({ checkedAt: 1, latest: '0.0.45' })
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const now = 2_000_000_000_000
  await up.upgrade('0.0.47', { fetchImpl, channel: 'binary', now, run: async () => {}, observe: installed('0.0.47') })
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ latest: '0.0.47', checkedAt: now })
})

// ---- 7. `insta upgrade` reports the version transition ----

test('insta upgrade reports what it upgraded from and to', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const out: string[] = []
  await up.upgrade('0.0.45', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    run: async () => {},
    observe: installed('0.0.47'),
    report: (m) => out.push(m),
  })
  // The installer prints a generic onboarding banner, so the transition must be stated by us.
  expect(out.join('\n')).toMatch(/upgraded 0\.0\.45 → 0\.0\.47/)
})

test('insta upgrade says plainly when there is nothing to do', async () => {
  const { fetchImpl } = fakeRegistry(DIST_TAGS)
  const out: string[] = []
  await up.upgrade('0.0.47', {
    fetchImpl,
    channel: 'binary',
    now: 2_000_000_000_000,
    run: async () => {},
    report: (m) => out.push(m),
  })
  expect(out.join('\n')).toMatch(/0\.0\.47 is already the latest release/)
})

// ---- 8. the TTL is short enough that a release is picked up the same day ----

test('the re-check TTL is at most a few hours, not a day', () => {
  expect(up.CHECK_TTL_MS).toBeLessThanOrEqual(6 * 60 * 60 * 1000)
})
