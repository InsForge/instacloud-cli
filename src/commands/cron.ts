// `insta cron` — schedules that send one HTTP request on a cron expression, to a compute service of
// the project or to an external URL.
//
// Three properties of the platform API shape this whole module, and none of them is plumbing:
//
//   1. A job is addressed by NAME here and by ID on the wire (names are unique per project+branch),
//      so every subcommand resolves name → id from the branch listing first, exactly as
//      resolve-service.ts resolves a service.
//   2. Times are UTC. The expression is evaluated in UTC by the platform and this prints every
//      timestamp as UTC with the Z visible: a job pinned to UTC does NOT keep a fixed local time,
//      so a localised column would read correctly today and lie twice a year, in both directions.
//   3. Header VALUES are write-only — the request config is encrypted at rest and no read decrypts
//      it. `show` can therefore list header NAMES and nothing else, and `edit` REPLACES the request
//      rather than merging into one it cannot read (see cronEditWarnings). The one readable part is
//      `secretRefs` (header → project secret NAME, resolved at send time), which `edit` carries
//      forward because it can (see buildRequest).
import { randomUUID } from 'node:crypto'
import { ApiClient, ApiError, requireProject } from '../api.js'
import { die, handleApproval, info, printJson, refuse } from '../util.js'
import { q, resolveSoleService } from './services.js'

// ---- wire shapes (the fields this module reads; the platform sends more) ----

export type CronTarget =
  | { kind: 'external'; url: string }
  | { kind: 'service'; serviceId: string; path: string }

export type CronJob = {
  id: string
  name: string
  branch: string
  expression: string
  timezone: string
  enabled: boolean
  revision: number
  next_run_at: string | null
  target: CronTarget
  // headerNames is EVERY header, literal and secret-backed. secretRefs is absent on rows written
  // before refs existed — read it through refsOf, never directly.
  request: { method: 'GET' | 'POST'; headerNames: string[]; secretRefs?: Record<string, string> }
  request_timeout_ms: number
  retry_policy: {
    platformMaxRetries?: number
    applicationMaxRetries?: number
    retryableStatuses?: number[]
    maxRunAgeMs?: number
  }
  created_at: string
  updated_at: string
}

export type CronRun = {
  id: string
  scheduled_at: string
  trigger_type: 'scheduled' | 'manual'
  status: string
  skip_reason: string | null
  platform_retry_count: number
  application_retry_count: number
  started_at: string | null
  finished_at: string | null
  config: { target: CronTarget; method: 'GET' | 'POST'; headerNames: string[]; requestTimeoutMs: number }
}

export type CronAttempt = {
  attempt_no: number
  wake_ms: number | null
  request_ms: number | null
  failure_kind: string | null
  error_code: string | null
  http_status: number | null
}

export type CronPreview = { valid: boolean; error?: string; description: string; next: string[] }

// ---- pure, unit-tested helpers (throw plain Errors; the CLI guard turns them into clean output) ----

// The API's own bounds (openapi/schemas/cron.ts), enforced here so junk fails before any network or
// config access — the parsePort lesson: `Number('5s')` is NaN and NaN serializes to null on the wire.
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 300_000
const MAX_RUNS_PAGE = 100

export const CRON_METHODS = ['GET', 'POST'] as const
export type CronMethod = (typeof CRON_METHODS)[number]

/** Parse `--method`. Case-insensitive, because a method is conventionally written in caps and a
 *  shell user types what they read in the docs. */
export function parseMethod(raw: string): CronMethod {
  const m = raw.trim().toUpperCase()
  if (!(CRON_METHODS as readonly string[]).includes(m)) throw new Error(`method must be ${CRON_METHODS.join('|')}, got: ${raw}`)
  return m as CronMethod
}

/** Parse `--timeout <ms>`. Decimal digits only, as parsePort: `0x1388` is a typo, not 5000. */
export function parseTimeout(raw: string): number {
  const m = /^\s*(\d+)\s*$/.exec(raw)
  const n = m ? Number(m[1]) : NaN
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms, got: ${raw}`)
  }
  return n
}

/** Parse `--limit <n>` for run history, inside the page the API serves. */
export function parseRunLimit(raw: string): number {
  const m = /^\s*(\d+)\s*$/.exec(raw)
  const n = m ? Number(m[1]) : NaN
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS_PAGE) throw new Error(`--limit must be an integer 1..${MAX_RUNS_PAGE}, got: ${raw}`)
  return n
}

/**
 * Parse one `--header k=v`. Split on the FIRST `=` only: a header value is free-form and routinely
 * contains one (`authorization=Bearer a=b`, any base64 padding), so splitting on every `=` would
 * quietly truncate exactly the credentials this flag exists to carry.
 */
export function parseHeader(raw: string, flag = '--header'): [string, string] {
  const at = raw.indexOf('=')
  if (at < 1) throw new Error(`${flag} must be name=value, got: ${raw}`)
  const name = raw.slice(0, at).trim()
  if (!name) throw new Error(`${flag} must be name=value, got: ${raw}`)
  return [name, raw.slice(at + 1)]
}

/**
 * Collect repeated `--header` flags. A name given twice is an error rather than last-wins: the
 * request carries one value per header, and silently dropping one of two credentials an agent
 * passed is the failure that shows up later as a 401 nobody can explain.
 */
export function parseHeaders(list: readonly string[], flag = '--header'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of list) {
    const [name, value] = parseHeader(raw, flag)
    // Header names are case-insensitive on the wire, so a case-varied repeat is the same repeat.
    const clash = findHeader(out, name)
    if (clash !== undefined) throw new Error(`${flag} ${name} given twice (also as ${clash}) — a header carries one value`)
    out[name] = value
  }
  return out
}

/** The key of `rec` naming header `name`, case-insensitively (header names are, on the wire). */
function findHeader(rec: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase())
}

/**
 * Collect repeated `--secret-ref header=SECRET_NAME`. Same grammar as `--header`, and an EMPTY secret
 * name means "remove this header's ref" on an edit — a secret cannot be named "", so the spelling is
 * unambiguous, and it keeps removal on the flag that sets refs rather than adding a second one.
 */
export function parseSecretRefs(list: readonly string[]): Record<string, string> {
  const out = parseHeaders(list, '--secret-ref')
  for (const k of Object.keys(out)) {
    const raw = out[k]!
    const trimmed = raw.trim()
    // Only a LITERALLY empty value means "remove" — that's what makes the spelling unambiguous.
    // A value that is merely whitespace is a fat-fingered secret name, not that same intent, and
    // trimming it to '' would silently take the removal branch instead of naming the typo.
    if (raw !== '' && trimmed === '') throw new Error(`--secret-ref ${k}=${raw} names a blank secret — a secret name cannot be blank (use --secret-ref ${k}= with nothing after '=' to remove the ref)`)
    out[k] = trimmed
  }
  return out
}

/** A job's refs, `{}` for a row written before refs existed. */
export function refsOf(r: CronJob['request']): Record<string, string> {
  return r.secretRefs ?? {}
}

/** Resolve a cron job by the name the CLI addresses it with (mirrors resolveServiceId). */
export function resolveJob(jobs: CronJob[], name: string): CronJob {
  const job = jobs.find((j) => j.name === name)
  if (!job) throw new Error(`cron job not found: ${name}`)
  return job
}

/**
 * A timestamp as UTC, with the marker visible: `2026-09-17 14:05:00Z`.
 *
 * Never localised. The expression is evaluated in UTC, so `0 3 * * *` fires at 03:00Z year-round —
 * rendering that as a local time would show two different wall clocks across a DST boundary for a
 * schedule that never moved, and the operator reading the column would blame the scheduler.
 */
export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso)
  return m ? `${m[1]} ${m[2]}Z` : iso
}

/**
 * One-line rendering of where a job sends its request. The service and its path are separated by an
 * arrow rather than concatenated: `compute/api/api/cron` hides where the service name ends, and the
 * service half is the part a reader has to match against `insta services list`.
 */
export function targetLine(t: CronTarget, serviceName?: string): string {
  return t.kind === 'external' ? t.url : `${serviceName ? `compute/${serviceName}` : `service ${t.serviceId}`} → ${t.path}`
}

/** One `cron list` row. Pure, so the columns are unit-tested (a template string nothing asserts on
 *  silently loses a segment — the serviceListLine lesson). */
export function jobListLine(j: CronJob, serviceName?: string): string {
  return `${j.name}  [${j.enabled ? 'enabled' : 'paused'}]  ${j.expression}  next ${fmtUtc(j.next_run_at)}  ${targetLine(j.target, serviceName)}  ${j.id}`
}

/** The retry policy in one cell, with the platform's own defaults named when the job sets none. */
export function retryLine(p: CronJob['retry_policy']): string {
  const statuses = p.retryableStatuses?.length ? `  retry on ${p.retryableStatuses.join(',')}` : ''
  const age = p.maxRunAgeMs !== undefined ? `  give up after ${p.maxRunAgeMs}ms` : ''
  return `platform ${p.platformMaxRetries ?? 2}, application ${p.applicationMaxRetries ?? 0}${statuses}${age}`
}

/** `cron show`, as lines. */
export function jobShowLines(j: CronJob, serviceName?: string): string[] {
  const lines = [
    `cron/${j.name}  [${j.enabled ? 'enabled' : 'paused'}]  on ${j.branch}  ${j.id}`,
    `  expression   ${j.expression}  (${j.timezone})`,
    `  next run     ${fmtUtc(j.next_run_at)}`,
    `  target       ${targetLine(j.target, serviceName)}`,
    `  request      ${j.request.method}  timeout ${j.request_timeout_ms}ms`,
  ]
  // Literal headers: names, never values — the request config is encrypted at rest and no read
  // decrypts it. Saying so beats an empty "value" column that reads as "this header is set to
  // nothing". Secret-backed headers get a row each, because the secret NAME is readable and is the
  // thing an operator needs when a rotation or a missing secret is the question.
  const refs = Object.entries(refsOf(j.request))
  const literal = j.request.headerNames.filter((n) => findHeader(refsOf(j.request), n) === undefined)
  const rows = [
    ...(literal.length ? [`${literal.join(', ')}  (names only — values are encrypted at rest and never returned)`] : []),
    ...refs.map(([h, s]) => `${h} ← secret ${s}  (resolved at send time)`),
  ]
  if (!rows.length) lines.push('  headers      (none)')
  rows.forEach((r, i) => lines.push(`  ${i ? '           ' : 'headers    '}  ${r}`))
  lines.push(`  retry        ${retryLine(j.retry_policy)}`)
  lines.push(`  revision     ${j.revision}  (the If-Match an edit is conditioned on)`)
  lines.push(`  created      ${fmtUtc(j.created_at)}   updated ${fmtUtc(j.updated_at)}`)
  return lines
}

/** A run plus the attempts it made. `attempts: null` means they could not be read (see cronRuns). */
export type RunRow = { run: CronRun; attempts: CronAttempt[] | null }

/**
 * One `cron runs` row. This is the surface an operator (or an agent) reads when a job is
 * misbehaving, so it carries the facts that separate the possible causes: the wake and the request
 * are timed apart because a slow cold start is the platform's problem and a slow response is the
 * target's, and the HTTP status distinguishes "your endpoint said no" from "nothing was ever sent".
 */
export function runListLine(row: RunRow): string {
  const { run, attempts } = row
  const last = attempts?.length ? attempts[attempts.length - 1] : undefined
  // Fall back to the counters when the attempts could not be read: a retried run has made
  // 1 + retries attempts, and the count is still worth printing without them.
  const count = attempts ? attempts.length : run.platform_retry_count + run.application_retry_count + 1
  const timing = last
    ? `wake ${last.wake_ms ?? '—'}ms  req ${last.request_ms ?? '—'}ms`
    : attempts ? 'wake —  req —' : 'wake ?  req ?'
  const outcome = last?.http_status != null
    ? `http ${last.http_status}`
    : last?.failure_kind
      ? `${last.failure_kind}${last.error_code ? ` (${last.error_code})` : ''}`
      : run.skip_reason ? `skipped: ${run.skip_reason}` : '—'
  return [
    fmtUtc(run.scheduled_at),
    // 10, the width of the longest status the platform has (`retry_wait`): a column padded to the
    // second-longest is a column that jumps exactly when the history gets interesting.
    run.status.padEnd(10),
    run.trigger_type.padEnd(9),
    `${count} attempt${count === 1 ? '' : 's'}`.padEnd(11),
    timing.padEnd(24),
    outcome.padEnd(16),
    run.id,
  ].join('  ')
}

/** `cron preview`, as lines. Invalid is an ANSWER here, not a transport error (the API says so too). */
export function previewLines(expression: string, p: CronPreview): string[] {
  if (!p.valid) return [`invalid cron expression: ${p.error ?? 'unparseable'}`]
  return [`${expression}  ${p.description}  (UTC)`, ...p.next.map((n) => `  ${fmtUtc(n)}`)]
}

/** What to say when a PATCH loses the If-Match race. Never a silent re-read: the schedule moved
 *  under this command, and re-reading to retry is how one of the two edits disappears. */
export function conflictLines(name: string, revision: number, what: string): string[] {
  return [
    `refusing to ${what}: cron job ${name} changed since revision ${revision} — someone (or something) else edited it while this command was running.`,
    `nothing was written. read it again and decide:  insta cron show ${name}`,
  ]
}

export type TargetOpts = { url?: string; service?: string; path?: string }
export type RequestOpts = { method?: string; body?: string; header?: string[]; secretRef?: string[]; timeout?: string }
export type CreateOpts = TargetOpts & RequestOpts & { branch?: string; json?: boolean }
// `create` takes the name and the expression positionally; an edit has to name them as flags, and
// `--name` is the rename (the positional argument is still the job being edited).
export type EditOpts = CreateOpts & { expression?: string; name?: string }
export type CommonOpts = { branch?: string; json?: boolean }

/** True when any flag that shapes the stored request was given. */
export function namesRequest(o: RequestOpts): boolean {
  return o.method !== undefined || o.body !== undefined || (o.header?.length ?? 0) > 0 || (o.secretRef?.length ?? 0) > 0
}

/** True when any flag that names a target was given. */
export function namesTarget(o: TargetOpts): boolean {
  return o.url !== undefined || o.service !== undefined || o.path !== undefined
}

/**
 * Validate the target flags. Not merged with target building: building needs the service listing
 * (a network round trip), and a command whose flags contradict each other must fail before it.
 * `partial` is the edit case, where naming no target at all means "leave it alone".
 */
export function assertTargetFlags(o: TargetOpts, partial = false): void {
  if (o.url && o.service) throw new Error('--url and --service name two different targets — pass one')
  if (o.path !== undefined && !o.service) throw new Error('--path applies to --service (an external target carries its path in the --url)')
  if (!partial && !o.url && !o.service) throw new Error('name a target: --url <https://…> or --service <name> [--path /api/cron]')
  if (o.url !== undefined && !/^https?:\/\//i.test(o.url)) throw new Error(`--url must be an absolute http(s) URL, got: ${o.url}`)
  if (o.path !== undefined && !o.path.startsWith('/')) throw new Error(`--path must start with /, got: ${o.path}`)
}

export type CronRequest = { method: CronMethod; headers?: Record<string, string>; body?: string; secretRefs?: Record<string, string> }

/**
 * The stored request. `undefined` when no flag shaped one.
 *
 * `current` is the request of the job being edited (omit it on create). Its secret refs are carried
 * forward — unlike literal values they are readable, so dropping them would be a choice rather than
 * a limitation — except for a header the flags re-supply, via `--secret-ref` (a new secret) or
 * `--header` (a literal replacing the ref). `--secret-ref h=` removes one.
 */
export function buildRequest(o: RequestOpts, current?: CronJob['request']): CronRequest | undefined {
  const flags = parseRequestFlags(o)
  if (!flags) return undefined
  const { method, headers, refFlags } = flags
  const had = current ? refsOf(current) : {}
  const refs: Record<string, string> = {}
  for (const [h, s] of Object.entries(had)) {
    if (findHeader(headers ?? {}, h) === undefined && findHeader(refFlags, h) === undefined) refs[h] = s
  }
  for (const [h, s] of Object.entries(refFlags)) {
    if (s) { refs[h] = s; continue }
    // A removal that removes nothing is a typo'd header name, and the ref it meant is still live.
    if (!current) throw new Error(`--secret-ref ${h}= removes a secret ref, and a new job has none — name the secret: --secret-ref ${h}=SECRET_NAME`)
    if (findHeader(had, h) === undefined) {
      const names = Object.keys(had)
      throw new Error(`--secret-ref ${h}= removes a secret ref, and the job has none on ${h}${names.length ? ` (it has: ${names.join(', ')})` : ''}`)
    }
  }
  return {
    method,
    ...(headers ? { headers } : {}),
    ...(o.body !== undefined ? { body: o.body } : {}),
    ...(Object.keys(refs).length ? { secretRefs: refs } : {}),
  }
}

/** The request flags parsed and checked against each other — no job needed, so an edit runs this
 *  before any network access. `undefined` when no flag shaped a request. */
export function parseRequestFlags(o: RequestOpts): { method: CronMethod; headers?: Record<string, string>; refFlags: Record<string, string> } | undefined {
  if (!namesRequest(o)) return undefined
  const method = o.method ? parseMethod(o.method) : o.body !== undefined ? 'POST' : 'GET'
  // A body on a GET is a typo with a plausible-looking outcome: the platform would send it and most
  // targets would ignore it, so the job would run "fine" and do nothing. `--body` alone implies
  // POST; `--body` with an explicit `--method GET` is a contradiction and says so.
  if (o.body !== undefined && method !== 'POST') throw new Error('--body is sent on POST only — drop --method GET, or drop --body')
  const headers = o.header?.length ? parseHeaders(o.header) : undefined
  const refFlags = o.secretRef?.length ? parseSecretRefs(o.secretRef) : {}
  // The platform refuses a header in both maps; saying so here names the flags that did it.
  for (const h of Object.keys(refFlags)) {
    const both = findHeader(headers ?? {}, h)
    if (both !== undefined) throw new Error(`${h} is given as both --header and --secret-ref — a header is a literal value or a secret, not both`)
  }
  return { method, ...(headers ? { headers } : {}), refFlags }
}

/**
 * What an edit that reshapes the request is about to LOSE.
 *
 * The API replaces `request` wholesale — it cannot merge, because a deep merge cannot express
 * "remove this header", and the CLI could not merge either even if the API did: literal header
 * values are write-only, so the values currently stored are unreadable here. Anything the new flags
 * do not re-supply is therefore gone, and the one thing this command must not do is drop a
 * credential without saying which one. Secret refs are readable and buildRequest carries them into
 * `next`, so only a ref the flags removed or replaced leaves — on purpose, and not warned about.
 */
export function cronEditWarnings(current: CronJob['request'], next: CronRequest): string[] {
  const out: string[] = []

  const kept = new Set([...Object.keys(next.headers ?? {}), ...Object.keys(next.secretRefs ?? {})].map((h) => h.toLowerCase()))
  const dropped = current.headerNames.filter((n) => !kept.has(n.toLowerCase()) && findHeader(refsOf(current), n) === undefined)
  if (dropped.length) {
    out.push(`warning: the stored request is replaced, not merged (literal header values are write-only and cannot be read back) — these headers are dropped: ${dropped.join(', ')}`)
  }

  // The METHOD is part of the request being replaced, and changing it is the quietest way to break
  // a job: `--header` alone on a POST job re-shapes the whole request, and the default method for a
  // request with no --body is GET. The job then runs, answers 200, and does nothing.
  if (current.method !== next.method) {
    out.push(`warning: the request method changes ${current.method} → ${next.method} — pass --method ${current.method} to keep it`)
  }

  // The BODY cannot be read back either, so its loss cannot be detected by comparing; what CAN be
  // said is when the stored request was one that carries a body and the new flags supply none.
  // Silence here was the actual gap: the command promised to name what it drops and named only
  // headers, so a POST job edited with `--header` alone lost its payload without a word.
  if (current.method === 'POST' && next.body === undefined) {
    out.push('warning: the stored request body (write-only, and not readable here) is dropped — re-supply it with --body, or pass --method GET if the job should stop sending one')
  }

  return out
}

// ---- API plumbing ----

const jobsPath = (projectId: string): string => `/projects/${projectId}/cron-jobs`

/** The slice of ApiClient this module uses — structural, so a test stubs two methods rather than a
 *  session (the convention in CONTRIBUTING, as resolveDbUrl takes its api). */
export type CronApi = {
  request<T = any>(method: string, path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<T>
  rawRequest(method: string, path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<{ status: number; body: any }>
}

export type Resolved = { api: CronApi; projectId: string; branch: string | undefined }

/** Injected whole in tests; resolved from the config and the linked project otherwise. */
async function context(opts: CommonOpts, injected?: Resolved): Promise<Resolved> {
  if (injected) return injected
  const api = await ApiClient.load()
  const p = await requireProject()
  return { api, projectId: p.projectId, branch: opts.branch ?? p.branch }
}

async function listJobs(c: Resolved): Promise<CronJob[]> {
  const { jobs } = await c.api.request<{ jobs: CronJob[] }>('GET', `${jobsPath(c.projectId)}${q(c.branch)}`)
  return jobs
}

/** Name → the job itself: the listing is the resolution step, as it is for services. */
async function findJob(c: Resolved, name: string): Promise<CronJob> {
  return resolveJob(await listJobs(c), name)
}

/** The compute service a `--service <name>` target names, resolved on the same branch as the job. */
async function computeTarget(c: Resolved, name: string, path: string): Promise<CronTarget> {
  const { services } = await c.api.request<{ services: Array<{ id: string; type: string; name: string }> }>(
    'GET', `/projects/${c.projectId}/services${q(c.branch)}`)
  return { kind: 'service', serviceId: resolveSoleService(services, 'compute', name).id, path }
}

/** Service id → name, so a target reads as `compute/api/cron` instead of a uuid. Best effort: a
 *  target in another project of the org is legal and simply has no name on this branch. */
async function serviceNames(c: Resolved, jobs: CronJob[]): Promise<Map<string, string>> {
  if (!jobs.some((j) => j.target.kind === 'service')) return new Map()
  try {
    const { services } = await c.api.request<{ services: Array<{ id: string; name: string }> }>(
      'GET', `/projects/${c.projectId}/services${q(c.branch)}`)
    return new Map(services.map((s) => [s.id, s.name]))
  } catch {
    return new Map()
  }
}

function targetOf(c: Resolved, o: TargetOpts, fallbackPath = '/'): Promise<CronTarget> | CronTarget {
  return o.url ? { kind: 'external', url: o.url } : computeTarget(c, o.service!, o.path ?? fallbackPath)
}

/**
 * PATCH conditioned on the revision that was just read. A 409 is reported, never retried: the
 * schedule changed between the read and the write, and re-reading to apply the patch on top is
 * precisely how the other edit disappears.
 */
async function patchJob(c: Resolved, job: CronJob, patch: Record<string, unknown>, what: string, json?: boolean): Promise<CronJob | null> {
  try {
    const res = await c.api.rawRequest('PATCH', `${jobsPath(c.projectId)}/${job.id}`, patch, {
      headers: { 'If-Match': String(job.revision) },
    })
    if (handleApproval(res, json)) return null
    return res.body.job as CronJob
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) refuse(conflictLines(job.name, job.revision, what))
    throw e
  }
}

/** Run detail, one request per run — bounded, so a 100-run page cannot open 100 sockets at once. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      const item = items[i]
      if (item === undefined) return
      out[i] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const RUN_DETAIL_CONCURRENCY = 5

// ---- commands ----

export async function cronList(opts: CommonOpts = {}, injected?: Resolved): Promise<void> {
  const c = await context(opts, injected)
  const jobs = await listJobs(c)
  if (opts.json) return printJson(jobs)
  if (!jobs.length) return info(`(no cron jobs on ${c.branch ?? 'default'} — add one with \`insta cron create <name> "<expression>" --url <https://…>\`)`)
  const names = await serviceNames(c, jobs)
  for (const j of jobs) info(jobListLine(j, j.target.kind === 'service' ? names.get(j.target.serviceId) : undefined))
}

export async function cronCreate(name: string, expression: string, opts: CreateOpts = {}, injected?: Resolved): Promise<void> {
  // Flag validation first, before any config or network access: a contradictory command must not
  // reach the point where half of it has happened.
  assertTargetFlags(opts)
  const request = buildRequest(opts)
  const timeout = opts.timeout === undefined ? undefined : parseTimeout(opts.timeout)
  const c = await context(opts, injected)
  const target = await targetOf(c, opts)
  const res = await c.api.rawRequest('POST', jobsPath(c.projectId), {
    name,
    expression,
    ...(c.branch ? { branch: c.branch } : {}),
    target,
    ...(request ? { request } : {}),
    ...(timeout !== undefined ? { requestTimeoutMs: timeout } : {}),
  })
  if (handleApproval(res, opts.json)) return
  const job = res.body.job as CronJob
  if (opts.json) return printJson(job)
  info(`created cron job ${job.name} on ${job.branch} (${job.id})`)
  info(`  ${job.expression} (${job.timezone}) — next run ${fmtUtc(job.next_run_at)}`)
}

export async function cronShow(name: string, opts: CommonOpts = {}, injected?: Resolved): Promise<void> {
  const c = await context(opts, injected)
  const job = await findJob(c, name)
  if (opts.json) return printJson(job)
  const names = await serviceNames(c, [job])
  for (const line of jobShowLines(job, job.target.kind === 'service' ? names.get(job.target.serviceId) : undefined)) info(line)
}

export async function cronEdit(name: string, opts: EditOpts = {}, injected?: Resolved): Promise<void> {
  assertTargetFlags(opts, true)
  // Contradictory flags fail before any network access; only whether a `--secret-ref h=` removal
  // names a ref the job has waits for the job (buildRequest, below).
  parseRequestFlags(opts)
  const timeout = opts.timeout === undefined ? undefined : parseTimeout(opts.timeout)
  if (!namesTarget(opts) && !namesRequest(opts) && timeout === undefined && opts.expression === undefined && opts.name === undefined) {
    throw new Error('nothing to change — pass --expression, --url/--service/--path, --method/--header/--secret-ref/--body, --timeout or --name')
  }
  const c = await context(opts, injected)
  const job = await findJob(c, name)
  const request = buildRequest(opts, job.request)
  const target = namesTarget(opts)
    // An edit that moves a service target keeps the path it had unless --path says otherwise.
    ? await targetOf(c, opts, job.target.kind === 'service' ? job.target.path : '/')
    : undefined
  if (request) for (const w of cronEditWarnings(job.request, request)) process.stderr.write(`${w}\n`)
  const updated = await patchJob(c, job, {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.expression !== undefined ? { expression: opts.expression } : {}),
    ...(target ? { target } : {}),
    ...(request ? { request } : {}),
    ...(timeout !== undefined ? { requestTimeoutMs: timeout } : {}),
  }, 'edit', opts.json)
  if (!updated) return
  if (opts.json) return printJson(updated)
  info(`updated cron job ${updated.name} (revision ${updated.revision}) — next run ${fmtUtc(updated.next_run_at)}`)
}

export async function cronPause(name: string, opts: CommonOpts = {}, injected?: Resolved): Promise<void> {
  await setEnabled(name, false, opts, injected)
}

export async function cronResume(name: string, opts: CommonOpts = {}, injected?: Resolved): Promise<void> {
  await setEnabled(name, true, opts, injected)
}

async function setEnabled(name: string, enabled: boolean, opts: CommonOpts, injected?: Resolved): Promise<void> {
  const c = await context(opts, injected)
  const job = await findJob(c, name)
  const updated = await patchJob(c, job, { enabled }, enabled ? 'resume' : 'pause', opts.json)
  if (!updated) return
  if (opts.json) return printJson(updated)
  info(enabled
    ? `resumed cron job ${updated.name} — next run ${fmtUtc(updated.next_run_at)}`
    : `paused cron job ${updated.name} — it will not fire until \`insta cron resume ${updated.name}\``)
}

export async function cronDelete(name: string, opts: CommonOpts & { yes?: boolean } = {}, injected?: Resolved): Promise<void> {
  const c = await context(opts, injected)
  const job = await findJob(c, name)
  // No prompt, a refusal: there is no terminal in the caller an agent or CI runs from, and a
  // question asked into a pipe either hangs or is answered by whatever byte arrives next.
  if (!opts.yes) {
    refuse([
      `refusing to delete cron job ${job.name} on ${job.branch} (${job.expression} ${job.timezone}) without --yes.`,
      `its run history is retained, but the schedule stops firing immediately:  insta cron delete ${name} --yes`,
    ])
  }
  const res = await c.api.rawRequest('DELETE', `${jobsPath(c.projectId)}/${job.id}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true, deleted: { id: job.id, name: job.name, branch: job.branch } })
  info(`deleted cron job ${job.name} from ${job.branch} — its run history is retained`)
}

export async function cronRun(name: string, opts: CommonOpts = {}, injected?: Resolved): Promise<void> {
  const c = await context(opts, injected)
  const job = await findJob(c, name)
  // Minted ONCE per invocation, outside the request call. The API client replays a request after a
  // 401 refresh, and a key minted per HTTP attempt would make that replay a second execution of the
  // job — which is the exact duplicate the platform requires this header to prevent.
  const idempotencyKey = randomUUID()
  const res = await c.api.rawRequest('POST', `${jobsPath(c.projectId)}/${job.id}/runs`, undefined, {
    headers: { 'Idempotency-Key': idempotencyKey },
  })
  if (handleApproval(res, opts.json)) return
  const runId = res.body.runId as string
  if (opts.json) return printJson({ runId, job: { id: job.id, name: job.name }, idempotencyKey })
  info(`triggered cron job ${job.name} — run ${runId} accepted (read it with \`insta cron runs ${name}\`)`)
  // A manual run is an EXTRA execution: the platform does not move next_run_at for it, and an
  // operator firing a job by hand at 02:59 should not expect the 03:00 tick to have been consumed.
  //
  // Only when there IS a next run. A paused job accepts a manual run — pause governs the clock, not
  // the operator — and it has no next_run_at, so the sentence below would promise a scheduled
  // execution that is not coming and print the em dash `fmtUtc` uses for "none" in the middle of it.
  if (job.enabled) {
    info(`  the scheduled run at ${fmtUtc(job.next_run_at)} still happens — a manual run is an extra execution`)
  } else {
    info(`  ${job.name} is paused and stays paused — this run is the only one (\`insta cron resume ${name}\` starts the schedule again)`)
  }
}

export async function cronRuns(name: string, opts: CommonOpts & { limit?: string } = {}, injected?: Resolved): Promise<void> {
  const limit = opts.limit === undefined ? undefined : parseRunLimit(opts.limit)
  const c = await context(opts, injected)
  const job = await findJob(c, name)
  const { runs } = await c.api.request<{ runs: CronRun[] }>(
    'GET', `${jobsPath(c.projectId)}/${job.id}/runs${limit === undefined ? '' : `?limit=${limit}`}`)
  // The listing carries the run rows; the wake/request split and the HTTP status live on the
  // ATTEMPTS, which are only readable one run at a time. That is an extra request per row, which is
  // worth it: without them this command answers "it failed" and an operator still has to go and ask
  // what failed. A run whose detail cannot be read degrades to counters rather than failing the page.
  const rows: RunRow[] = await mapLimit(runs, RUN_DETAIL_CONCURRENCY, async (run) => {
    try {
      const d = await c.api.request<{ attempts: CronAttempt[] }>('GET', `${jobsPath(c.projectId)}/${job.id}/runs/${run.id}`)
      return { run, attempts: d.attempts }
    } catch {
      return { run, attempts: null }
    }
  })
  if (opts.json) return printJson(rows.map((r) => ({ ...r.run, attempts: r.attempts })))
  if (!rows.length) return info(`(no runs yet for ${job.name} — trigger one with \`insta cron run ${name}\`)`)
  info(`runs of cron/${job.name} on ${job.branch} — times are UTC`)
  for (const row of rows) info(runListLine(row))
}

export async function cronPreview(expression: string, opts: { json?: boolean } = {}, injected?: Resolved): Promise<void> {
  // The answer depends on nothing but the expression, but the route is project-scoped (membership is
  // what keeps an open parser endpoint off the internet) — so this resolves a project like every
  // other command, and asks the SAME parser that create() validates with rather than shipping a
  // second cron implementation in the CLI that could disagree with the materializer.
  const c = await context({}, injected)
  const res = await c.api.rawRequest('POST', `${jobsPath(c.projectId)}/preview`, { expression })
  if (handleApproval(res, opts.json)) return
  const preview = res.body as CronPreview
  if (opts.json) {
    printJson(preview)
    // An invalid expression is a legitimate answer from the API and a failed command here: a script
    // that pipes this into `insta cron create` must be able to branch on the exit code.
    if (!preview.valid) process.exitCode = 1
    return
  }
  if (!preview.valid) die(`invalid cron expression: ${preview.error ?? 'unparseable'}`)
  for (const line of previewLines(expression, preview)) info(line)
}
