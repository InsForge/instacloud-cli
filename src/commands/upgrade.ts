// Self-update: `insta upgrade` updates the CLI in place, channel-aware (native binary via the
// release installer; npm via `npm i -g`). A background version check (detached, cached in
// ~/.insta/update-check.json) powers an update nudge — and, since the CLI is young and moves
// fast, AUTO-UPDATE IS ON BY DEFAULT: when a newer version is known, a quiet upgrade runs in the
// background. `insta config autoupdate off` (or INSTA_NO_AUTOUPDATE=1) disables that, leaving just the
// stderr nudge.
//
// ONE SOURCE OF TRUTH. "What is the latest insta?" is answered in exactly one place —
// `resolveLatest()`, reading npm's `latest` dist-tag, the same thing `npx insta@latest` and
// `npm i -g insta` resolve. Both the background check and `insta upgrade` go through it, and the
// binary channel then installs THAT version by tag (INSTA_VERSION=v<latest>) rather than asking
// GitHub independently for /releases/latest. Two independent resolvers is how the two paths
// drift apart: a version can be merged but never tagged, so it exists on neither npm nor GitHub.
//
// A CACHE MUST NOT LIE. ~/.insta/update-check.json is a cache of that one answer, never a second
// source. Every path that learns the real latest rewrites it (including a successful upgrade),
// and any entry that is old, malformed, or behind the running build is refused rather than used
// — a sticky wrong `latest` is what silently pinned existing installs to an old version.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readGlobal, readPersistedGlobal, writeGlobal } from '../config.js'
import { resolveSpawnable } from '../spawn.js'
import { info } from '../util.js'

const INSTALL_SH = 'https://raw.githubusercontent.com/InsForge/instacloud-cli/main/install.sh'
// The dist-tag document is the authoritative, tiny (~50 byte) answer for `latest`. The full
// `latest` manifest is the fallback if that route is ever unavailable.
const REGISTRY_DIST_TAGS = 'https://registry.npmjs.org/-/package/insta/dist-tags'
const REGISTRY_LATEST = 'https://registry.npmjs.org/insta/latest'
// Re-check at most this often. Deliberately short: releases ship every day or two, so a TTL
// measured in days strands every existing install whenever a release lands just after a check.
export const CHECK_TTL_MS = 3 * 60 * 60 * 1000
const AUTO_THROTTLE_MS = 60 * 60 * 1000 //  don't retry a failed auto-upgrade more than hourly
const FETCH_TIMEOUT_MS = 5000

export type Channel = 'binary' | 'npm' | 'source'
export type CheckCache = { checkedAt: number; latest: string; lastAutoAt?: number }
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
export type RunSpec = { cmd: string; args: string[]; env: NodeJS.ProcessEnv }
export type Runner = (spec: RunSpec) => Promise<void>

export function resolveRunSpec(
  spec: RunSpec,
  npmExecpath = spec.env.npm_execpath,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): RunSpec {
  const resolved = resolveSpawnable(spec.cmd, spec.args, npmExecpath, execPath, platform, spec.env)
  return { ...spec, ...resolved }
}

const cachePath = (): string => process.env.INSTA_UPDATE_CACHE ?? join(homedir(), '.insta', 'update-check.json')

// How is this CLI running? Bun standalone → execPath IS the insta binary (not node);
// npm global → the module lives under node_modules; anything else is a source checkout.
export function detectChannel(execPath = process.execPath, moduleUrl = import.meta.url): Channel {
  if (!/node(\.exe)?$/.test(execPath)) return 'binary'
  if (moduleUrl.includes('/node_modules/')) return 'npm'
  return 'source'
}

// A publishable, non-prerelease version. Anything carrying a `-suffix` (0.0.23-rc.1 — the `next`
// dist-tag today) is not a stable release and must never be offered as "latest".
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/
export function isStableVersion(v: unknown): v is string {
  return typeof v === 'string' && STABLE_VERSION_RE.test(v.trim().replace(/^v/, ''))
}

function parseVersion(v: string): { core: number[]; pre: string[] } {
  const noBuild =
    String(v ?? '')
      .trim()
      .replace(/^v/, '')
      .split('+')[0] ?? ''
  const dash = noBuild.indexOf('-')
  const coreStr = dash === -1 ? noBuild : noBuild.slice(0, dash)
  const preStr = dash === -1 ? '' : noBuild.slice(dash + 1)
  return {
    core: coreStr.split('.').map((n) => {
      const p = parseInt(n, 10)
      return Number.isFinite(p) ? p : 0
    }),
    pre: preStr ? preStr.split('.') : [],
  }
}

// -1 / 0 / 1 for a<b / a==b / a>b, by semver precedence: numeric core compare (so 0.0.9 < 0.0.10,
// which a string compare gets backwards), then a release outranks any prerelease of the same core
// (1.0.0 > 1.0.0-rc.1), then identifier by identifier.
export function cmpSemver(a: string, b: string): number {
  const A = parseVersion(a)
  const B = parseVersion(b)
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
    const d = (A.core[i] ?? 0) - (B.core[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1
  if (!B.pre.length) return -1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1 // a shorter prerelease series ranks lower
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10)
      if (d !== 0) return d < 0 ? -1 : 1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1 // numeric identifiers rank lower than alphanumeric
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// Pick `latest` — and only `latest` — out of npm's dist-tag document. `next` (a prerelease
// channel: 0.0.23-rc.1 today) must never win, and a `latest` that is itself a prerelease or
// malformed is refused rather than guessed at.
export function pickLatestDistTag(tags: unknown): string | null {
  const v = (tags as Record<string, unknown> | null | undefined)?.latest
  if (!isStableVersion(v)) return null
  return v.trim().replace(/^v/, '')
}

async function getJson<T>(url: string, fetchImpl: Fetcher, timeoutMs: number): Promise<T | null> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      // no-cache: an intermediary serving a stale dist-tag would re-create the very bug this
      // resolver exists to kill.
      const res = await fetchImpl(url, {
        signal: ctl.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      })
      if (!res.ok) return null
      return (await res.json()) as T
    } finally {
      clearTimeout(t)
    }
  } catch {
    return null
  }
}

// THE resolver: the live latest published version, or null when the registry can't be reached.
// Never consults the cache — callers decide whether a cached answer may stand in for this.
export async function resolveLatest(fetchImpl: Fetcher = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const tags = await getJson<Record<string, unknown>>(REGISTRY_DIST_TAGS, fetchImpl, timeoutMs)
  const fromTags = pickLatestDistTag(tags)
  if (fromTags) return fromTags
  const manifest = await getJson<{ version?: unknown }>(REGISTRY_LATEST, fetchImpl, timeoutMs)
  const v = manifest?.version
  return isStableVersion(v) ? v.trim().replace(/^v/, '') : null
}

export function readCache(): CheckCache | null {
  try {
    return JSON.parse(readFileSync(cachePath(), 'utf8')) as CheckCache
  } catch {
    return null
  }
}

export function writeCache(c: CheckCache): void {
  mkdirSync(dirname(cachePath()), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify(c))
}

// May this cached answer stand in for a live registry call? An entry that is old, malformed, or
// provably behind the build we are running must not suppress the check — that is exactly how a
// wrong `latest` pins an install to an old version indefinitely. Note the deliberate `>= 0`:
// `latest === current` is the ordinary up-to-date state and stays cacheable for the TTL, while a
// `latest` BELOW the running build (an out-of-band upgrade happened) is refused outright.
export function cacheIsFresh(cache: CheckCache | null, current: string, now = Date.now()): boolean {
  if (!cache || !isStableVersion(cache.latest)) return false
  if (!Number.isFinite(cache.checkedAt)) return false
  if (now < cache.checkedAt) return false // clock went backwards — don't trust the stamp
  if (now - cache.checkedAt > CHECK_TTL_MS) return false
  return cmpSemver(cache.latest, current) >= 0
}

// Pure decision for what start-up should do given the cache. Exported for tests.
export function decideAction(
  cache: CheckCache | null,
  current: string,
  autoUpdate: boolean,
  channel: Channel,
  now = Date.now(),
): 'none' | 'nudge' | 'auto' {
  if (!cache || !isStableVersion(cache.latest) || cmpSemver(cache.latest, current) <= 0) return 'none'
  if (!autoUpdate || channel === 'source') return 'nudge'
  if (cache.lastAutoAt && now - cache.lastAutoAt < AUTO_THROTTLE_MS) return 'nudge'
  return 'auto'
}

// Is auto-update on? (env kill-switch wins, then the persisted preference, default on.)
export function autoEnabled(home = homedir()): boolean {
  if (process.env.INSTA_NO_AUTOUPDATE) return false
  try {
    // config read is async elsewhere; a tiny sync read keeps start-up non-blocking
    const raw = JSON.parse(readFileSync(join(home, '.insta', 'config.json'), 'utf8')) as { autoUpdate?: boolean }
    return raw.autoUpdate !== false
  } catch {
    return true // no config yet
  }
}

const spawnRun: Runner = ({ cmd, args, env }) =>
  new Promise<void>((resolve, reject) => {
    const resolved = resolveRunSpec({ cmd, args, env })
    const p = spawn(resolved.cmd, resolved.args, { stdio: 'inherit', env })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`upgrade failed (exit ${code})`))))
  })

// Ask the freshly installed CLI what version it is. This is the ONLY thing the upgrade report may
// quote: the installer can exit 0 without changing anything (its "already current?" short-circuit
// against GitHub's /releases/latest), so "what we asked for" and "what is on disk" can differ.
// Returns null when the binary can't be run or prints nothing version-shaped — never a guess.
export type Observer = (channel: Channel, installDir: string) => Promise<string | null>
const observeInstalled: Observer = (channel, installDir) =>
  new Promise((resolve) => {
    const cmd = channel === 'binary' ? join(installDir, 'insta') : 'insta'
    let out = ''
    try {
      // INSTA_NO_AUTOUPDATE: the child must not kick off yet another upgrade while we are reading it.
      const env: NodeJS.ProcessEnv = { ...process.env, INSTA_NO_AUTOUPDATE: '1' }
      const resolved = resolveRunSpec({ cmd, args: ['--version'], env })
      const p = spawn(resolved.cmd, resolved.args, { stdio: ['ignore', 'pipe', 'ignore'], env })
      p.stdout.on('data', (d) => (out += String(d)))
      p.on('error', () => resolve(null))
      p.on('close', () => {
        const last = out.trim().split('\n').pop()?.trim().replace(/^v/, '')
        resolve(isStableVersion(last) ? last : null)
      })
    } catch {
      resolve(null)
    }
  })

export type UpgradeDeps = {
  fetchImpl?: Fetcher
  run?: Runner
  observe?: Observer
  channel?: Channel
  /** Pre-resolved target (the background path already asked). Omit to resolve live. */
  latest?: string | null
  now?: number
  installDir?: string
  report?: (msg: string) => void
}

// `insta upgrade` — synchronous, visible self-update on the detected channel.
//
// ALWAYS resolves the target live: an explicitly requested upgrade must never be answered out of
// ~/.insta/update-check.json, or the documented remedy for a stale cache would itself be stale.
//
// NEVER REPORTS A VERSION IT DID NOT OBSERVE. After any install path it reads the installed
// binary's actual `--version` and prints the transition from THAT. In the drift case (npm's tag
// ahead of GitHub Releases) the pinned install 404s and the unpinned retry legitimately exits 0
// having installed nothing — the honest line is "still 0.0.45", not "upgraded → 0.0.47". The
// cache is rewritten from the observed version too: it then says the newest version THIS channel
// can actually install, and the start-up nudge stops advertising a build the user cannot get.
export async function upgrade(current: string, deps: UpgradeDeps = {}): Promise<void> {
  const say = deps.report ?? info
  const channel = deps.channel ?? detectChannel()
  if (channel === 'source') {
    say('running from a source checkout — `git pull` to update')
    return
  }
  const latest = deps.latest !== undefined ? deps.latest : await resolveLatest(deps.fetchImpl ?? fetch)
  const now = deps.now ?? Date.now()

  if (latest) {
    // Record what we just learned so the start-up nudge can't keep quoting a stale answer.
    writeCache({ ...(readCache() ?? { checkedAt: 0, latest }), checkedAt: now, latest })
    if (cmpSemver(latest, current) <= 0) {
      say(`✓ insta ${current} is already the latest release — nothing to upgrade`)
      return
    }
  } else {
    say('could not reach the npm registry — installing the newest release available')
  }

  say(`upgrading insta ${current} → ${latest ?? 'latest'} via ${channel} …`)
  const run = deps.run ?? spawnRun
  const installDir = deps.installDir ?? dirname(process.execPath)

  if (channel === 'npm') {
    await run({ cmd: 'npm', args: ['install', '-g', `insta@${latest ?? 'latest'}`], env: process.env })
  } else {
    const shellEnv = { ...process.env, INSTA_INSTALL_DIR: installDir }
    const sh = { cmd: 'sh', args: ['-c', `curl -fsSL ${INSTALL_SH} | sh`] }
    if (!latest) {
      await run({ ...sh, env: shellEnv })
    } else {
      try {
        // Pin the binary install to the EXACT version npm's `latest` dist-tag names, so the two
        // channels cannot land on different builds.
        await run({ ...sh, env: { ...shellEnv, INSTA_VERSION: `v${latest}` } })
      } catch (e) {
        // Release assets can lag the npm tag. Retry unpinned so the user at least gets the newest
        // binary that IS published — and let the observation below say what that turned out to be.
        say(`pinned install of v${latest} failed (${(e as Error).message}) — retrying with the newest published release`)
        await run({ ...sh, env: shellEnv })
      }
    }
  }

  // Report only what is actually on disk now. The installer prints its own generic onboarding
  // banner and can exit 0 without changing anything, so its exit code proves nothing.
  const observed = await (deps.observe ?? observeInstalled)(channel, installDir)
  if (!observed) {
    say(`insta install finished, but the installed version could not be read — run \`insta --version\` to confirm`)
    return
  }
  writeCache({ ...(readCache() ?? { checkedAt: 0, latest: observed }), checkedAt: now, latest: observed })
  if (cmpSemver(observed, current) > 0) {
    say(`✓ insta upgraded ${current} → ${observed}`)
    return
  }
  const target = latest ?? 'the newest release'
  if (channel === 'binary') {
    say(
      `insta is still ${observed} — the newest release (${target}) is published on npm but its binary assets are not on GitHub Releases yet; ` +
        `try again later or install via npm (npm i -g insta@latest)`,
    )
  } else {
    say(`insta is still ${observed} — npm reports ${target} as latest but the install did not change the version; try again later`)
  }
}

export type CheckDeps = {
  fetchImpl?: Fetcher
  channel?: Channel
  auto?: boolean
  now?: number
  runUpgrade?: (current: string, latest: string) => Promise<void>
}

// Hidden `insta __update-check` — runs detached in the background: resolve latest, refresh the
// cache, and ACT on what it just learned. Acting here (rather than only priming the cache for
// some later invocation) is what stops a release that lands just after a check from stranding the
// install for a whole TTL plus one more run.
export async function backgroundCheck(current: string, deps: CheckDeps = {}): Promise<'none' | 'nudge' | 'auto'> {
  const latest = await resolveLatest(deps.fetchImpl ?? fetch)
  if (!latest) return 'none' // offline / registry down — try again next TTL
  const now = deps.now ?? Date.now()
  const cache: CheckCache = { ...(readCache() ?? { checkedAt: 0, latest }), checkedAt: now, latest }
  writeCache(cache)

  const channel = deps.channel ?? detectChannel()
  const action = decideAction(cache, current, deps.auto ?? autoEnabled(), channel, now)
  if (action !== 'auto') return action
  writeCache({ ...cache, lastAutoAt: now })
  try {
    await (deps.runUpgrade ?? ((c, l) => upgrade(c, { latest: l, channel })))(current, latest)
  } catch {
    /* best-effort; the hourly throttle retries */
  }
  return 'auto'
}

// `insta config autoupdate [on|off]` — toggle / show the auto-update preference (default: on).
export async function autoupdate(mode?: string): Promise<void> {
  if (mode === 'on' || mode === 'off') {
    // Read-modify-write must use the PERSISTED config (like `env use` does), not readGlobal()'s
    // runtime view: readGlobal() folds in a --api-url/INSTA_API_URL override and, when that override
    // points at a different deployment, scrubs the stored session. Writing that view back to disk
    // here would silently re-point ~/.insta/config.json at the override and log the user out just
    // from toggling autoupdate.
    const cfg = await readPersistedGlobal()
    await writeGlobal({ ...cfg, autoUpdate: mode === 'on' })
    info(`autoupdate ${mode}`)
    return
  }
  const cfg = await readGlobal()
  const enabled = cfg.autoUpdate !== false && !process.env.INSTA_NO_AUTOUPDATE
  info(`autoupdate: ${enabled ? 'on' : 'off'} (default on while the CLI is pre-1.0 — \`insta config autoupdate off\` to disable)`)
}

/** Commands that must never nudge about an update or spawn a background one.
 *
 *  `upgrade`/`autoupdate` are the update machinery itself. Every `__` command
 *  is internal machinery rather than a user at a prompt, and the rule is
 *  written as a PREFIX so the next such command inherits it instead of
 *  rediscovering it:
 *  `__ssh-ensure-cert` is run by OpenSSH while it PARSES ssh_config, on every
 *  ssh, scp, `ssh -G` and IDE connection, so a nudge here is written straight
 *  into the ssh session's stderr and an auto-upgrade spawns a detached process
 *  mid-connection. Same prefix rule trackCommand already applies to telemetry.
 */
export function skipsUpdateCheck(cmd: string | undefined, sub?: string | undefined): boolean {
  // `insta config autoupdate off` must not run the very check it is being typed to switch off
  // (it could auto-upgrade before the handler lands); the retired top-level spelling stays exempt too.
  if (cmd === 'config' && sub === 'autoupdate') return true
  return cmd === 'upgrade' || cmd === 'autoupdate' || !!cmd?.startsWith('__')
}

// Called once at CLI start-up. Never blocks: reads the cache synchronously, prints at most one
// stderr line, and (when due) spawns detached children for the registry check / quiet upgrade.
export function maybeUpdate(current: string, argv: string[]): void {
  if (skipsUpdateCheck(argv[2], argv[3])) return
  const channel = detectChannel()
  const cache = readCache()
  const now = Date.now()

  // Re-resolve unless the cached answer is genuinely usable (fresh, well-formed, not behind us).
  // The child refreshes the cache AND performs the upgrade if one is due.
  if (!cacheIsFresh(cache, current, now)) respawnDetached(['__update-check'])

  const action = decideAction(cache, current, autoEnabled(), channel, now)
  if (action === 'nudge') {
    console.error(`↑ insta ${cache!.latest} is available (you have ${current}) — run \`insta upgrade\``)
  } else if (action === 'auto') {
    writeCache({ ...cache!, lastAutoAt: now })
    respawnDetached(['upgrade'])
    console.error(`↑ auto-updating insta ${current} → ${cache!.latest} in the background (\`insta config autoupdate off\` to disable)`)
  }
}

// Re-invoke this same CLI (binary or node+script) detached, output discarded.
function respawnDetached(args: string[]): void {
  try {
    const script = process.argv[1]
    const argv = /node(\.exe)?$/.test(process.execPath) && script ? [script, ...args] : args
    const p = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' })
    p.unref()
  } catch {
    /* best-effort */
  }
}
