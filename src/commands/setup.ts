// `insta setup agent` — make this machine's coding agents InstaCloud-native in one step
// (the Railway `railway setup agent` pattern). Installs the `insta` skill USER-GLOBALLY for
// every agent the skills tool knows: the skill is pure product knowledge with brand-gated
// triggers — no project state in it (the project binding is carried by ./.insta/project.json
// at command time), so one machine-level copy is strictly better than per-project copies.
// Stack skills (tigris/better-auth) intentionally stay per-project: their presence in a
// project doubles as its stack manifest — that install happens on `project create|link`.
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { createInterface } from 'node:readline'
import { ApiClient } from '../api.js'
import { setupProjectAgentSession } from '../agent.js'
import { readPersistedGlobal, resolveEnv, type GlobalConfig } from '../config.js'
import { DEFAULT_ENV, ENVS, ENV_NAMES, envForApiUrl, envFromEnvVar, isEnvName, mcpServerName, type EnvName } from '../env.js'
import { fail, info, openUrl } from '../util.js'
import { isRunnableFile, resolveSpawnable } from '../spawn.js'
import { loginDevice } from './auth.js'
import { projectCreate, projectLink, slugifyName } from './project.js'
import { envUse } from './env.js'
import { installAgentConfigs } from './mcp.js'
import { detectChannel, type Channel } from './upgrade.js'

export { resolveSpawnable, whichOnPath } from '../spawn.js'

// The `skills` tool we shell out to prints a clack UI: a frame-by-frame clone spinner, an
// "Installing to all N agents" banner, a full N-line install-path box, and a third-party
// "Security Risk Assessment" that flags our OWN first-party skill as "Critical Risk". Streamed
// verbatim during onboarding that reads as noisy and alarming — the opposite of Railway's two
// clean ✓ lines. So we CAPTURE its output and print our own one-line summary instead. This
// classifier decides which captured lines are worth showing if the install FAILS (surface the
// real error; drop the expected no-global-support noise).
export function classifyInstallLine(line: string): 'keep' | 'skip' {
  if (/does not support global skill installation/.test(line)) return 'skip'
  if (/Failed to install \d+/.test(line)) return 'skip'
  return 'keep'
}

// Map a skill-install target directory to a human agent name. `-a '*'` installs to every agent
// dir the tool knows (~70+); we name the well-known ones (Railway-style) and roll the long tail
// into "+N more" rather than dumping every path. Order = display priority.
const AGENT_NAMES: Array<[RegExp, string]> = [
  [/\.agents\b/, 'Universal (.agents)'],
  [/\.claude\b/, 'Claude Code'],
  [/\.codex\b/, 'OpenAI Codex'],
  [/\.cursor\b/, 'Cursor'],
  [/opencode\b/, 'OpenCode'],
  [/copilot\b/, 'GitHub Copilot'],
  [/\.gemini\b/, 'Gemini CLI'],
  [/windsurf\b/, 'Windsurf'],
  [/\.factory\b/, 'Factory Droid'],
  [/goose\b/, 'Goose'],
  [/aider\b/, 'Aider'],
  [/\.continue\b/, 'Continue'],
  [/\.roo\b/, 'Roo'],
  [/kilocode\b/, 'Kilo Code'],
  [/\.qwen\b/, 'Qwen'],
]

// Pull install-target paths out of the skills tool's summary lines ("→ ~/.claude/skills/insta")
// and resolve the well-known ones to names. Returns the total install count + named agents.
export function parseInstalledAgents(output: string): { count: number; names: string[] } {
  const paths = new Set<string>()
  for (const line of output.split('\n')) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '')
    // The tool boxes each line ("│    → ~/.claude/skills/insta   │"), so don't anchor to EOL.
    // Separator-agnostic: on Windows the tool prints C:\Users\…\.claude\skills\insta — a
    // forward-slash-only match found nothing there, collapsing the summary to a nameless
    // "Agents set up" (user report).
    const m = plain.match(/→\s*(\S+)[\\/]skills[\\/][A-Za-z0-9_-]+/)
    if (m && m[1]) paths.add(m[1])
  }
  const names: string[] = []
  for (const [re, name] of AGENT_NAMES) {
    if ([...paths].some((p) => re.test(p))) names.push(name)
  }
  return { count: paths.size, names }
}

// The Railway-style one-liner: a few named agents, the rest as "+N more".
export function summarizeInstall(output: string): string {
  const { count, names } = parseInstalledAgents(output)
  if (count === 0) return '✓ Agents set up'
  const shown = names.slice(0, 6)
  const more = count - shown.length
  const list = shown.length
    ? shown.join(', ') + (more > 0 ? `, +${more} more` : '')
    : `${count} agent${count === 1 ? '' : 's'}`
  return `✓ Agents — ${list}`
}

export type Runner = (cmd: string, args: string[]) => Promise<{ ok: boolean; output?: string }>

// ---- CLI self-install (makes `npx -y insta setup agent` a complete one-liner) ----

// Under npx the CLI runs from the npm cache and vanishes when the process exits — but the skill
// installed below tells every agent to run `insta …`, which then wouldn't exist. So when this
// process came from the npm channel and no DURABLE `insta` is on PATH, install ourselves
// globally first. The scan must ignore any PATH entry under a node_modules directory: npx
// prepends its cache's node_modules/.bin (where this very process's `insta` shim lives), while
// durable installs (npm -g bin, nvm/volta/fnm, the native binary's ~/.insta/bin) never sit
// under one.
// On POSIX a PATH hit only counts if it would actually run: a plain non-executable file (or a
// directory) named `insta` must not suppress the self-install. Mode bits, not access(X_OK) —
// access() answers "can THIS process exec it", which for root is always yes, so a root-run
// setup would wrongly treat a non-executable file as a durable install. On Windows execute
// permission is extension-driven, so existence of a regular file is the right check.
export function findDurableOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const win = platform === 'win32'
  const dirs = (env.PATH ?? '').split(win ? ';' : ':')
  // npm on Windows writes insta.cmd/insta.ps1 plus an extensionless sh shim; PATHEXT covers the
  // former, the bare name the latter.
  const exts = win ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';'), ''] : ['']
  for (const dir of dirs) {
    // Case-insensitive: Windows paths (and the npx cache) may carry any casing.
    if (!dir || dir.toLowerCase().includes('node_modules')) continue
    for (const ext of exts) if (isRunnableFile(join(dir, bin + ext), win)) return true
  }
  return false
}

const cliVersion = (): string => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
  } catch { return 'latest' }
}

/** Best-effort: a failed global install must not block the skill/MCP setup below — the npx run
 *  itself still completes the agent onboarding, and the manual fallback is one line. */
export async function ensureCliInstalled(
  run: Runner,
  channel: Channel = detectChannel(),
  onPath = findDurableOnPath('insta'),
  recheck: () => boolean = () => findDurableOnPath('insta'),
): Promise<void> {
  if (channel !== 'npm' || onPath) return
  info('installing the insta CLI globally (npm) …')
  // Pinned to THIS version so the one-liner installs exactly what it ran. The logical `npm` is
  // resolved to a spawnable invocation ONCE, inside the default runner (resolveSpawnable) —
  // handing it a pre-resolved node/npm-cli.js path here would make the runner resolve it a
  // second time and, on Windows, wrap the real node.exe in cmd.exe.
  const spec = `insta@${cliVersion()}`
  const res = await run('npm', ['install', '-g', spec])
  if (res.ok) {
    // A clean `npm i -g` can still land in a bin dir that isn't on PATH (custom npm prefix) —
    // exactly the machines this path exists for. Only claim success after re-finding the shim.
    if (recheck()) {
      info('✓ insta CLI — installed globally (`insta` now works in any shell)')
    } else {
      info('✓ insta CLI — installed globally, but npm\'s global bin dir is not on PATH')
      info('    add it to PATH (POSIX: `$(npm prefix -g)/bin`; Windows: the dir `npm prefix -g` prints), then verify with `insta --version`')
    }
    return
  }
  info('  global CLI install failed — continuing with agent setup; install manually with:')
  info(`    npm install -g ${spec}`)
  if (/EACCES|permission denied/i.test(res.output ?? '')) {
    info('    (permission error: the npm prefix is system-owned — use a Node version manager, or elevate that one command)')
  }
}

// Capture stdout+stderr silently (don't stream) so we can print our own clean summary.
// stdin is 'ignore', NOT 'inherit': under the canonical `curl … | sh` install, stdin is the
// piped install script itself — a child that inherits it (npx/skills reads for keypresses even
// with -y) consumes the rest of the script, so the shell never runs the trailing "Get started"
// guidance. Ignoring stdin keeps the installer's own output intact. (-y means no prompt anyway.)
const defaultRunner: Runner = (cmdIn, argsIn) =>
  new Promise((resolve) => {
    const { cmd, args } = resolveSpawnable(cmdIn, argsIn)
    const env: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: process.env.AI_AGENT || 'insta', FORCE_COLOR: '0' }
    // When THIS process was launched by npx, npx exports its flags as npm_config_* env vars.
    // npm_config_package pins package resolution for every nested npm/npx child — the inner
    // `npx -y skills …` would then resolve `skills` against the insta package and degrade to
    // `sh: skills: command not found`. Scrub the resolution-pinning vars; keep prefix/registry
    // (deliberate user configuration).
    delete env.npm_config_package
    delete env.npm_config_call
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let output = ''
    const grab = (chunk: Buffer) => { output += chunk.toString() }
    p.stdout?.on('data', grab)
    p.stderr?.on('data', grab)
    p.on('error', () => resolve({ ok: false, output }))
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })

// Leading -y is npx's OWN flag: on a machine where the `skills` package isn't already in the
// npx cache, non-TTY `npx skills …` refuses to auto-install and degrades to a shell lookup
// (`sh: skills: command not found`) — the trailing -y only answers the skills TOOL's prompt.
// -g = user-level (machine-global); -a '*' = every agent dir the skills tool supports
// (Claude Code, Codex, Cursor, OpenCode, Copilot, …); --copy = real files, not cache symlinks.
// `spec` is the skill source for the resolved environment (`owner/repo` or `owner/repo@ref`), so a
// staging install reads the staging skill text rather than what's published on main.
export const setupArgs = (spec: string): string[] =>
  ['-y', 'skills', 'add', spec, '-s', 'insta', '-a', '*', '-g', '-y', '--copy']

/** Production's args. Kept as a named export because it is the installed-base default and is
 *  asserted directly by tests; runtime goes through `setupArgs(resolveEnv().skills)`. */
export const SETUP_ARGS = setupArgs(ENVS[DEFAULT_ENV].skills)

// ---- remote MCP registration ----

// Prod's name/URL, kept as named exports because they are the installed-base defaults and are
// asserted directly by tests. Everything at runtime goes through `resolveMcpTarget()` instead, so
// a staging install registers staging's MCP server under its own name rather than reusing prod's.
export const MCP_SERVER_NAME = mcpServerName(DEFAULT_ENV)
export const DEFAULT_MCP_URL = ENVS[DEFAULT_ENV].mcp

/** The MCP server this machine should register, derived from the SAME resolved environment as the
 *  control-plane API. Returning name and url together is deliberate: they must never be chosen
 *  independently, or a staging machine ends up registering prod's URL under prod's name. */
export async function resolveMcpTarget(): Promise<{ name: string; url: string }> {
  const { env, mcpUrl } = await resolveEnv()
  return { name: mcpServerName(env ?? DEFAULT_ENV), url: mcpUrl }
}

// Headless fallback only (`--mcp-token`): the MCP config outlives the CLI's refreshable
// session, so a static-header registration needs a durable `insta_` API token — minted once,
// named after this machine. Null means no credential, not a denied/failed mint. Let API errors
// reach the command guard so their status/body survive and automation gets a nonzero exit.
export type TokenMinter = () => Promise<string | null>
export async function mintMcpToken(api: Pick<ApiClient, 'config' | 'request'>): Promise<string | null> {
  if (!api.config.accessToken) return null
  const result = await api.request<{ token?: unknown }>('POST', '/tokens', { name: `mcp-${os.hostname()}` })
  if (typeof result?.token !== 'string' || !result.token.trim()) {
    throw new Error('MCP token creation did not return a token; registration was not written')
  }
  return result.token
}
const defaultMinter: TokenMinter = async () => mintMcpToken(await ApiClient.load())

// Register the insta-cloud remote MCP server with Claude Code (user scope, so it follows the
// machine like the skill install above). Default is OAuth: register with NO credential — the
// platform's Better Auth MCP authorization server is discovered via RFC 9728 and Claude runs
// the browser flow on first `/mcp` use, so no static token ever lands on disk. `--mcp-token`
// avoids MCP browser auth by minting a durable token into the header instead, but requires
// token-creation permission; agent governance still applies. Existing registrations stay intact.
/** Outcome of the Claude Code MCP registration. `announce` controls the SUCCESS lines only —
 *  `setup agent` passes false and folds Claude Code into one combined MCP line with the
 *  config-file agents; `insta mcp install` keeps the default self-narration. Failure surfaces
 *  (manual-add fallback, missing token) always print — silence there would read as success. */
export type McpStatus = 'new' | 'existing' | 'no-claude' | 'no-token' | 'failed'
export async function registerMcp(run: Runner = defaultRunner, mint: TokenMinter = defaultMinter, useToken = false, announce = true): Promise<McpStatus> {
  const { name, url } = await resolveMcpTarget()
  if (!(await run('claude', ['--version'])).ok) return 'no-claude' // no Claude Code on this machine
  if ((await run('claude', ['mcp', 'get', name])).ok) {
    if (announce) info(`✓ MCP — ${name} already registered with Claude Code`)
    return 'existing'
  }
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, url]
  if (useToken) {
    const token = await mint()
    if (!token) {
      info('  MCP not registered (--mcp-token needs a login) — run `insta login`, then `insta setup agent --mcp-token` again')
      return 'no-token'
    }
    args.push('--header', `Authorization: Bearer ${token}`)
  }
  const res = await run('claude', args)
  if (!res.ok) {
    info(`  MCP registration failed — add manually:\n    claude mcp add --transport http ${name} ${url}`)
    return 'failed'
  }
  if (announce) {
    info(`✓ MCP — ${name} registered with Claude Code (\`claude mcp list\` to verify)`)
    if (!useToken) info('  first use: run `/mcp` in Claude Code and authorize in the browser (--mcp-token requires token-creation permission)')
  }
  return 'new'
}

/** Callers decide when an optional probe becomes a required registration (after the interactive
 *  login retry in setup). An OAuth registration for another client cannot satisfy --mcp-token. */
export function requireMcpRegistration(status: McpStatus): boolean {
  if (status === 'new' || status === 'existing') return true
  fail(status === 'no-claude'
    ? 'Claude Code MCP registration incomplete: Claude Code is not available on PATH'
    : 'Claude Code MCP registration incomplete; see the error above')
  return false
}

/** The environment `setup agent` should target, and whether the machine must be switched to it
 *  first. Pure — decides only; the caller performs the switch.
 *
 *  The contract (CLI ≥ 0.0.38): the public one-liner `npx -y insta setup agent` means PRODUCTION,
 *  full stop — a leftover `insta env use staging` from last month must not silently give a new
 *  onboarding run staging skills. Staging is an explicit ask: `--env staging` (or $INSTA_ENV).
 *  Two deliberate exceptions leave the machine alone:
 *  - an explicit $INSTA_API_URL (insta-oss, a preview) with no --env — a hand-written URL is the
 *    most specific instruction there is;
 *  - a persisted CUSTOM apiUrl with no --env — same reasoning, chosen via login --api-url. */
export function planSetupEnv(
  flagEnv: string | undefined,
  persistedApiUrl: string,
  apiUrlOverride = process.env.INSTA_API_URL,
  envVar = envFromEnvVar(),
): { target: EnvName; switch: boolean } | { target: null; switch: false } {
  if (flagEnv !== undefined) {
    const want = flagEnv.trim().toLowerCase()
    if (!isEnvName(want)) throw new Error(`unknown --env "${flagEnv}" — expected one of: ${ENV_NAMES.join(', ')}`)
    // A contradicting ambient override must ERROR, not lose quietly: everything after this plan
    // resolves through resolveEnv(), where $INSTA_API_URL (and $INSTA_ENV) outrank the persisted
    // config — proceeding would persist one environment and install another's skills/MCP.
    if (apiUrlOverride) throw new Error(`--env ${want} conflicts with $INSTA_API_URL=${apiUrlOverride} — unset one`)
    if (envVar && envVar !== want) throw new Error(`--env ${want} conflicts with $INSTA_ENV=${envVar} — unset one`)
    return { target: want, switch: envForApiUrl(persistedApiUrl) !== want }
  }
  if (apiUrlOverride) return { target: null, switch: false }
  const persisted = envForApiUrl(persistedApiUrl)
  if (persisted === null) return { target: null, switch: false } // custom host, chosen deliberately
  const target = envVar ?? DEFAULT_ENV
  return { target, switch: persisted !== target }
}

type ProjectStep = { kind: 'none' } | { kind: 'link'; id: string } | { kind: 'create'; name?: string }

/** The project step. Only a contradictory flag pair throws: rejecting a nameless `--create` here
 *  would abort the whole setup, and `projectCreate` already guides that case. */
export function planProject(opts: { project?: string; create?: string | boolean }): ProjectStep {
  if (opts.create !== undefined && opts.project !== undefined) {
    throw new Error('--create and --project are mutually exclusive — create a new project, or link an existing one')
  }
  if (opts.project) return { kind: 'link', id: opts.project }
  if (opts.create === undefined) return { kind: 'none' }
  return { kind: 'create', name: typeof opts.create === 'string' ? opts.create : undefined }
}

/** Whether setup should flow straight into login: an interactive human terminal with no session.
 *  Pure. Non-TTY (agents, CI, pipes) and -y runs never prompt — a browser OAuth flow cannot work
 *  there anyway; they get the printed `next:` hint instead, and prompt.md walks agents through
 *  login as its own step (relaying the sign-in link to the human). */
export function shouldOfferLogin(yes: boolean, loggedIn: boolean, stdinTty: boolean, stdoutTty: boolean): boolean {
  return !yes && !loggedIn && stdinTty && stdoutTty
}

// One Enter continues into the browser login; only an explicit n/no declines. Matches the
// curl-installer feel: the single command carries you as far as automation can go, and the one
// genuinely human step (authorizing in the browser) starts itself instead of being homework.
// Where to read the answer from. Under `curl … | sh` stdin is the SCRIPT pipe, not the human —
// but the controlling terminal can still answer, via /dev/tty (the standard installer trick;
// Homebrew prompts the same way). Never on Windows (no /dev/tty, and the curl path doesn't exist
// there), and never without one (agents, CI, cron — openSync fails, so they can't be prompted).
/** Wrap an already-open fd as a prompt input with SINGLE-OWNER cleanup: the stream owns the fd
 *  (autoClose), close() only destroys the stream, and post-close stream errors are swallowed.
 *  ReadStream.destroy() closes the fd asynchronously on Node 20, so a second closeSync here
 *  would race it into an unhandled EBADF right after the user answers. */
export function makePromptSource(fd: number): { input: NodeJS.ReadableStream; close: () => void } {
  const stream = createReadStream('', { fd, autoClose: true })
  stream.on('error', () => { /* post-close EBADF and friends — never unhandled */ })
  return { input: stream, close: () => { try { stream.destroy() } catch { /* already destroyed */ } } }
}

const openPromptInput = (): { input: NodeJS.ReadableStream; close: () => void } | null => {
  if (process.stdin.isTTY) return { input: process.stdin, close: () => {} }
  if (process.platform === 'win32') return null
  try {
    return makePromptSource(openSync('/dev/tty', 'r'))
  } catch { return null }
}

/** Whether a human can answer a prompt at all: an interactive stdin, or a reachable /dev/tty
 *  (the curl|sh case). The stdout-TTY requirement lives in shouldOfferLogin — an agent piping
 *  our output must never be prompted even though its process may have a controlling terminal. */
export function canPromptViaTty(): boolean {
  if (process.stdin.isTTY) return true
  if (process.platform === 'win32') return false
  try { closeSync(openSync('/dev/tty', 'r')); return true } catch { return false }
}

const defaultAsk = async (question: string): Promise<boolean> => {
  const src = openPromptInput()
  if (!src) return false // gate said yes but the terminal vanished — decline, never hang
  const rl = createInterface({ input: src.input, output: process.stdout })
  // EOF (Ctrl-D) closes the interface without ever answering the question — resolve that as a
  // decline instead of hanging forever after the checkmarks.
  const answer: string = await new Promise((resolve) => {
    rl.on('close', () => resolve('n'))
    rl.question(question, resolve)
  })
  rl.close()
  src.close()
  return !/^n/i.test(answer.trim())
}

export type LoginFlow = {
  ask: (question: string) => Promise<boolean>
  login: () => Promise<void>
  stdinTty: boolean
  stdoutTty: boolean
}

export async function setupAgent(
  opts: { yes?: boolean; mcpToken?: boolean; env?: string; project?: string; create?: string | boolean },
  run: Runner = defaultRunner,
  mint?: TokenMinter,
  installConfigs: (agent?: string) => Promise<string[]> = installAgentConfigs,
  ensure: (run: Runner) => Promise<void> = (r) => ensureCliInstalled(r),
  readStored: () => Promise<GlobalConfig> = readPersistedGlobal,
  switchEnv: (name: string) => Promise<void> = (n) => envUse(n),
  loginFlow: LoginFlow = {
    ask: defaultAsk,
    login: () => loginDevice({}, openUrl),
    stdinTty: canPromptViaTty(),
    stdoutTty: !!process.stdout.isTTY,
  },
  link: (id: string) => Promise<void> = projectLink,
  create: (name?: string) => Promise<void> = (n) => projectCreate(n, {}),
  enroll: () => Promise<boolean> = async () => setupProjectAgentSession(await ApiClient.load()),
): Promise<void> {
  if (!opts.yes && !process.stdout.isTTY) {
    info('non-interactive shell — assuming -y')
  }
  // Reject an impossible --project/--create request here, while the machine is still untouched.
  const project = planProject(opts)
  // Pin the environment BEFORE anything is installed (see planSetupEnv). A required switch goes
  // through `env use` — the one path that persists the choice and drops the now-foreign session —
  // and announces itself, so the machine can never end up with its CLI on one deployment and its
  // skills/MCP on another.
  const plan = planSetupEnv(opts.env, (await readStored()).apiUrl)
  if (plan.switch && plan.target) await switchEnv(plan.target)
  // BEFORE the skill install: the skill tells agents to run `insta …`, so a durable CLI must
  // exist by the time it lands.
  await ensure(run)
  // One resolve for the whole step, so the skills and the MCP registration below cannot disagree
  // about which environment this machine belongs to.
  const { env, skills } = await resolveEnv()
  const args = setupArgs(skills)
  info(env && env !== DEFAULT_ENV
    ? `setting up your coding agents (${env}) …`
    : 'setting up your coding agents …')
  const res = await run('npx', args)
  if (!res.ok) {
    info('  skill install failed — install manually with:')
    info(`    npx ${args.map((a) => (a === '*' ? '"*"' : a)).join(' ')}`)
    // Surface the REAL error: the captured tail, minus the expected no-global-support noise.
    const tail = (res.output ?? '')
      .split('\n')
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
      .filter((l) => l.trim() && classifyInstallLine(l) === 'keep')
      .slice(-6)
    for (const l of tail) info('    ' + l)
    process.exitCode = 1
    return
  }
  // Register everything first, then summarize ONCE below: the skill files, Claude Code's
  // `claude mcp add`, and the config-file MCP entries are three mechanisms with one outcome —
  // "your agents are ready" — so they get one line, not three inventories of agent names.
  let claude = await registerMcp(run, mint, !!opts.mcpToken, false)
  const others = await installConfigs()
  // Default into login on an interactive terminal (see shouldOfferLogin) BEFORE the MCP summary:
  // a --mcp-token registration needs the session to mint, so a post-login retry must land in the
  // same combined line instead of announcing Claude Code separately. Best-effort: a declined
  // prompt or a failed browser flow leaves the manual hint. Explicit --mcp-token still requires
  // registration to finish; without that flag, login remains optional.
  const stored = await readStored()
  let loggedIn = !!(stored.accessToken || stored.user)
  if (shouldOfferLogin(!!opts.yes, loggedIn, loginFlow.stdinTty, loginFlow.stdoutTty)) {
    if (await loginFlow.ask('log in now in the browser? (Y/n) ')) {
      try {
        await loginFlow.login()
        loggedIn = true
      } catch (e) {
        info(`  login did not complete (${e instanceof Error ? e.message : String(e)})`)
        info('  run `insta login` to try again — the sign-in link it prints works from a browser on any device.')
      }
      // Keep token-creation errors outside the browser-login catch. A signed-in caller can be
      // forbidden from minting; relabeling that as a login failure hides the real platform error.
      if (opts.mcpToken && loggedIn) claude = await registerMcp(run, mint, true, false)
    }
  }
  if (opts.mcpToken && !requireMcpRegistration(claude)) return
  // --project / --create: bind this directory to a project inside the SAME process. Never split
  // this back into `setup agent && insta project <cmd>` as one paste: no shell joiner survives
  // every Windows shell, and in shells without bracketed paste the queued second line is eaten
  // as the answer to the login prompt above (console PR #290). Both need the session: without
  // one the manual command is the hint, never a hang; a failure (bad id, no access, name taken)
  // is a REAL error — binding a project is the entire point of the flag — so it sets the exit
  // code instead of pretending setup succeeded.
  if (project.kind !== 'none') {
    const linking = project.kind === 'link'
    const retry = linking
      ? `insta project link ${project.id}`
      : `insta project create${project.name ? ` ${slugifyName(project.name)}` : ''}`
    if (!loggedIn) {
      info(`  not logged in — project not ${linking ? 'linked' : 'created'}; run \`insta login\`, then \`${retry}\``)
    } else {
      try {
        if (project.kind === 'link') await link(project.id)
        else await create(project.name)
      } catch (e) {
        // Stop here — like the skill-install failure above, finishing with the success summary
        // and a cheerful `next:` after an error is mixed messaging. Setup itself did succeed,
        // so say exactly that alongside the retry command.
        info(`  project ${linking ? 'link' : 'create'} failed (${e instanceof Error ? e.message : String(e)}) — agent setup itself is done; run \`${retry}\` to retry the ${linking ? 'link' : 'create'}`)
        process.exitCode = 1
        return
      }
    }
  }
  if (loggedIn) {
    if (await enroll()) info('✓ Project agent session ready (expires in 24 hours; refresh with insta setup agent)')
  } else {
    info('  project agent session not created — run `insta login`, then `insta setup agent`')
  }
  // THE summary line. The restart note exists because config-file agents only read their MCP
  // config at startup; the skill files need no restart.
  const mcpOk = claude === 'new' || claude === 'existing' || others.length > 0
  info(`${summarizeInstall(res.output ?? '')} — ready to use InstaCloud${mcpOk ? ' (CLI + skill + MCP; restart any open tools)' : ''}`)
  if (claude === 'new' && !opts.mcpToken) {
    info('  Claude Code first use: run `/mcp` and authorize in the browser (--mcp-token requires token-creation permission)')
  }
  // The user's next move: one concrete action, not a concept. The agents drive `insta` themselves
  // (project create/link, deploys, login via the device flow), so the human just asks for the
  // thing they actually want.
  info(loggedIn
    ? 'next: open your coding agent inside your app and start building — ask it to "deploy this app on InstaCloud" when you\'re ready'
    : 'next: open your coding agent inside your app and start building — ask it to "deploy this app on InstaCloud" when you\'re ready (it will walk you through `insta login`)')
}
