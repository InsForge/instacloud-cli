import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { ApiError } from './api.js'
import { readGlobal, readProject, type GlobalConfig, type ProjectConfig } from './config.js'
import { ENVS, envForApiUrl, isEnvName, normalizeUrl, type EnvName } from './env.js'
import { COMPONENTS, SEVERITIES, TYPES } from './commands/feedback.js'
import { SERVICE_TYPES } from './commands/services.js'
import { detectChannel } from './commands/upgrade.js'
import { CliCancel, CliExit } from './util.js'

export const POSTHOG_HOST = 'https://us.i.posthog.com'
// The console's project keys (insta-frontend src/lib/analytics.ts), so a CLI event lands on the
// person the console identified. Write-only capture tokens: safe to ship in a public binary.
const PROJECT_KEYS: Record<EnvName, string> = {
  prod: 'phc_yHWfNfkDuQpJ34yKQ4equid3j64zj3tBRtpej3b5i8QH',
  staging: 'phc_BeXdaHFfeaCJFAH26TyEi3LB9xwHj23U6LdfKWP46G4U',
}
// The send is awaited before the process exits, so it gets one bounded attempt and no retry.
const SEND_TIMEOUT_MS = 1500
const ID_FILE = join(os.homedir(), '.insta', 'telemetry.json')
const REDACTED = '[REDACTED]'

// Only ids, enums and numbers leave the machine, and only when the value has that shape; every other
// string is the user's (names, branches, keys, paths, secret values, free text) and is dropped.
type Check = (v: string) => boolean
const oneOf = (values: readonly string[]): Check => (v) => values.includes(v)
const ID: Check = (v) => /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|[a-z]+_[\w-]{1,64}|(?=.*\d)[\w-]{1,64})$/i.test(v)
const SLUG: Check = (v) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v)
const NUMBER: Check = (v) => /^\d+(?:\.\d+)?[a-z]{0,3}$/i.test(v)
const REGION: Check = (v) => /^[a-z]{2,3}(?:-[a-z0-9]+)+$/.test(v)
const SERVICE = oneOf(SERVICE_TYPES)
// `login`/`env use` accept the name case-insensitively; so does this.
const ENV: Check = (v) => isEnvName(v.trim().toLowerCase())
const ON_OFF = oneOf(['on', 'off'])
const TARGET = oneOf(['db', 'compute', 'redis', 'mysql', 'mongodb'])
const POLICY_ACTION: Check = (v) => /^(?:secrets|deploy|project|branch|service|storage)(?:\.[a-zA-Z]+)?$/.test(v)

const SAFE_ARGS: Record<string, Record<number, Check>> = {
  'env use': { 0: ENV }, 'project link': { 0: ID },
  'services add': { 0: SERVICE }, 'services remove': { 0: SERVICE }, 'services rename': { 0: SERVICE }, 'services secrets': { 0: SERVICE },
  'services set-access': { 0: SERVICE, 2: oneOf(['public', 'private']) },
  'services scale': { 0: SERVICE, 2: NUMBER, 3: REGION }, 'services upgrade': { 0: SERVICE, 2: SLUG },
  'compute always-on': { 0: ON_OFF }, 'db always-on': { 0: ON_OFF }, metrics: { 0: TARGET }, logs: { 0: TARGET },
  'template info': { 0: SLUG }, 'billing upgrade': { 0: oneOf(['pro', 'team']) },
  'approvals approve': { 0: ID }, 'approvals deny': { 0: ID },
  'agent-policy rule set': { 0: POLICY_ACTION, 1: oneOf(['allow', 'deny', 'approve']) }, autoupdate: { 0: ON_OFF },
}
const SAFE_OPTIONS: Record<string, Check> = {
  org: ID, project: ID, region: REGION, env: ENV, oauth: oneOf(['github', 'google']),
  agent: oneOf(['claude-code', 'cursor', 'codex', 'opencode', 'copilot', 'factory-droid']),
  type: oneOf(TYPES), component: oneOf(COMPONENTS), severity: oneOf(SEVERITIES),
  status: oneOf(['pending', 'granted', 'denied', 'consumed']),
  limit: NUMBER, step: NUMBER, since: NUMBER, port: NUMBER, memory: NUMBER, cpu: NUMBER, size: NUMBER, volume: NUMBER, years: NUMBER,
}

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.DO_NOT_TRACK || env.INSTA_NO_TELEMETRY)
}

/** The PostHog project of the environment `apiUrl` belongs to; a custom host (insta-oss, a preview
 *  deployment) captures nothing. */
export function telemetryKey(apiUrl: string): string | undefined {
  const name = envForApiUrl(apiUrl)
  return name ? PROJECT_KEYS[name] : undefined
}

export function redactOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'boolean' || typeof v === 'number') out[k] = v
    else if (typeof v === 'string' && SAFE_OPTIONS[k]?.(v)) out[k] = v
    else out[k] = REDACTED
  }
  return out
}

export function redactArgs(command: string, args: unknown[]): unknown[] {
  const checks = SAFE_ARGS[command] ?? {}
  return args.map((a, i) => (a === undefined ? null : typeof a === 'string' && checks[i]?.(a) ? a : REDACTED))
}

/** The deployment a `login --env|--api-url` targets. It is persisted only when the login succeeds, so
 *  a failed attempt must be routed from the options, never from the previous configuration. */
export function loginTarget(command: string, opts: Record<string, unknown>): string | undefined {
  if (command !== 'login') return undefined
  if (typeof opts.apiUrl === 'string') return opts.apiUrl
  const env = typeof opts.env === 'string' ? opts.env.trim().toLowerCase() : ''
  return isEnvName(env) ? ENVS[env].api : undefined
}

/** `secrets set`, `services add`, … — the subcommand chain without the program name. */
export function commandPath(cmd: Command): string {
  const names: string[] = []
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name())
  return names.join(' ')
}

export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE) return 'claude-code'
  if (env.CURSOR_TRACE_ID) return 'cursor'
  return null
}

export type Outcome = { error?: unknown; durationMs: number; exitCode: number; childExitCode?: number }

export type EventContext = {
  cliVersion: string
  channel: string
  config: GlobalConfig
  project: ProjectConfig | null
  anonymousId: string
  env: NodeJS.ProcessEnv
  tty: boolean
}

export type CommandEvent = {
  event: 'cli_command'
  distinct_id: string
  timestamp: string
  properties: Record<string, unknown>
}

function errorProps(error: unknown): Record<string, unknown> {
  if (error === undefined || error instanceof CliCancel) return {}
  if (error instanceof ApiError) return { error_type: 'api', http_status: error.status }
  if (error instanceof CliExit) return { error_type: 'cli' }
  const e = error as { name?: string; cause?: { code?: string } }
  return { error_type: e?.name ?? 'unknown', ...(e?.cause?.code ? { error_code: e.cause.code } : {}) }
}

function hostOf(url: string): string | null {
  try { return new URL(url).host } catch { return null }
}

export function buildCommandEvent(
  command: string,
  args: unknown[],
  options: Record<string, unknown>,
  outcome: Outcome,
  ctx: EventContext,
): CommandEvent {
  const token = ctx.config.accessToken
  const cancelled = outcome.error instanceof CliCancel
  const ranChild = outcome.childExitCode !== undefined && outcome.error === undefined
  return {
    event: 'cli_command',
    distinct_id: ctx.config.user?.id ?? ctx.anonymousId,
    timestamp: new Date().toISOString(),
    properties: {
      command,
      args: redactArgs(command, args),
      options: redactOptions(options),
      success: !cancelled && (outcome.exitCode === 0 || ranChild),
      cancelled,
      exit_code: outcome.exitCode,
      child_exit_code: outcome.childExitCode ?? null,
      duration_ms: outcome.durationMs,
      ...errorProps(outcome.error),
      cli_version: ctx.cliVersion,
      channel: ctx.channel,
      node_version: process.version,
      os: os.platform(),
      os_release: os.release(),
      arch: os.arch(),
      env: envForApiUrl(ctx.config.apiUrl) ?? 'custom',
      api_host: hostOf(ctx.config.apiUrl),
      logged_in: !!token,
      auth_kind: token ? (token.startsWith('insta_') ? 'api_key' : 'session') : null,
      project_id: ctx.project?.projectId ?? null,
      org_id: ctx.project?.orgId ?? null,
      ...(ctx.project ? { $groups: { project: ctx.project.projectId, ...(ID(ctx.project.orgId) ? { org: ctx.project.orgId } : {}) } } : {}),
      tty: ctx.tty,
      ci: !!ctx.env.CI,
      agent: detectAgent(ctx.env),
      term_program: ctx.env.TERM_PROGRAM ?? null,
      $lib: 'insta-cli',
      $lib_version: ctx.cliVersion,
      ...(ctx.config.user?.id ? {} : { $process_person_profile: false }),
    },
  }
}

/** The pre-login id events are sent under, and the account it has been merged into, if any. */
export type TelemetryState = { anonymousId: string; identifiedAs?: string }

export async function readState(file = ID_FILE): Promise<TelemetryState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as TelemetryState
    if (typeof parsed.anonymousId === 'string' && parsed.anonymousId) return parsed
  } catch {}
  return writeState({ anonymousId: randomUUID() }, file)
}

async function writeState(state: TelemetryState, file = ID_FILE): Promise<TelemetryState> {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(state, null, 2))
  } catch {}
  return state
}

export async function sendBatch(key: string, batch: object[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, batch }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

export type TrackDeps = {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  loadConfig?: () => Promise<GlobalConfig>
  loadProject?: () => Promise<ProjectConfig | null>
  idFile?: string
  channel?: string
  tty?: boolean
}

/** Report one finished command. Never throws and never changes the exit code: analytics must not
 *  fail the user's actual task. */
export async function trackCommand(cmd: Command, args: unknown[], outcome: Outcome, cliVersion: string, deps: TrackDeps = {}): Promise<void> {
  try {
    const env = deps.env ?? process.env
    if (telemetryDisabled(env)) return
    const command = commandPath(cmd)
    if (command.startsWith('__')) return
    let config = await (deps.loadConfig ?? readGlobal)()
    const target = loginTarget(command, cmd.opts())
    if (target && normalizeUrl(target) !== normalizeUrl(config.apiUrl)) config = { apiUrl: target }
    const key = telemetryKey(config.apiUrl)
    if (!key) return
    const project = await (deps.loadProject ?? readProject)()
    const userId = config.user?.id
    let state = await readState(deps.idFile)
    // Session gone or switched: the id belongs to the account that left, so later commands get a fresh one.
    if (state.identifiedAs && state.identifiedAs !== userId) state = await writeState({ anonymousId: randomUUID() }, deps.idFile)
    const event = buildCommandEvent(command, args.flat(), cmd.opts(), outcome, {
      cliVersion,
      channel: deps.channel ?? detectChannel(),
      config,
      project,
      anonymousId: state.anonymousId,
      env,
      tty: deps.tty ?? !!process.stdout.isTTY,
    })
    const batch: object[] = [event]
    const merge = userId !== undefined && state.identifiedAs !== userId
    if (merge) batch.push({ event: '$identify', distinct_id: userId, timestamp: event.timestamp, properties: { $anon_distinct_id: state.anonymousId } })
    const sent = await sendBatch(key, batch, deps.fetchImpl)
    if (merge && sent) await writeState({ ...state, identifiedAs: userId }, deps.idFile)
  } catch {}
}
