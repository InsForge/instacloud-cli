// `insta feedback` — report an InstaCloud-side hurdle to the InstaCloud team.
//
// Scope rule (also stated in the skill): this is for problems in OUR toolkit — the CLI, the MCP
// server, the platform, the skills, the docs. Never for problems in the app the user is building.
//
// The backend is InstaCloud dogfooding itself: the "InstaCloud Agent Feedback" project runs the
// ingest service (InsForge/instacloud-feedback repo) on a postgres + compute pair. It is NOT the
// control-plane API on purpose — feedback must work unlinked, from insta-oss, and through a
// control-plane outage, which is exactly when we most want reports to still arrive.
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import * as clack from '@clack/prompts'
import { ApiClient, ApiError } from '../api.js'
import { readGlobal, readProject } from '../config.js'
import { envForApiUrl } from '../env.js'
import { info, printJson, refuse, CliCancel, CliExit } from '../util.js'
import { clean } from '../redact.js'
import { cliVersion } from '../version.js'

export const TYPES = ['bug', 'feature-request', 'friction', 'other'] as const
export const COMPONENTS = ['cli', 'mcp', 'platform', 'skills', 'docs', 'other'] as const
export const SEVERITIES = ['blocker', 'major', 'minor'] as const

// Field caps mirror the ingest service's LIMITS (insta-feedback src/app.ts) — the server
// truncates again, so a mismatch degrades gracefully instead of rejecting.
export const LIMITS = {
  title: 200,
  detail: 4000,
  area: 100,
  command: 500,
  error: 2000,
  expected: 1000,
  workaround: 1000,
  doc: 300,
} as const

// Hardcoded in source, not injected at build time: a build-time credential silently no-ops in
// local/tsx and fork builds, and feedback would appear to work while reports vanish. The token is
// public by design (it ships in this file); it only deflects drive-by scanners — real abuse
// control is server-side (per-IP rate limit + weekly dedup). Env overrides are for tests and
// emergency rotation.
const FEEDBACK_ENDPOINT =
  process.env.INSTA_FEEDBACK_URL ||
  'https://feedback.instacloud.com/v1/feedback'
const FEEDBACK_INGEST_TOKEN = process.env.INSTA_FEEDBACK_TOKEN || 'insta-feedback-public-v1'
// 15s gives the backend's scale-to-zero cold start room to answer (the ingest service waits out
// the DB wake and persists, so a report can land after a shorter deadline gave up on it).
// An expired deadline is reported as UNCONFIRMED, not failed — the report may well be stored.
const FEEDBACK_TIMEOUT_MS = 15_000
// A slow control plane may cost a report its ticket, never the report itself.
const ASSERTION_TIMEOUT_MS = 5_000
const MAX_FILE_BYTES = 256 * 1024

export type FeedbackOpts = {
  type?: string
  component?: string
  title?: string
  detail?: string
  file?: string
  area?: string
  command?: string
  error?: string
  expected?: string
  workaround?: string
  doc?: string
  severity?: string
  json?: boolean
}

export type FeedbackDeps = {
  fetchImpl?: typeof fetch
  /** Prompts run on a real terminal only — an agent's stdin is not one, and must never block. */
  interactive?: boolean
  cliVersion?: string
  api?: Pick<ApiClient, 'apiUrl' | 'config' | 'request'>
}

function requireEnum(value: string, allowed: readonly string[], flag: string): string {
  if (!allowed.includes(value)) {
    throw new Error(`${flag} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

async function promptMissing(opts: FeedbackOpts): Promise<void> {
  clack.intro('insta feedback — report an InstaCloud-side hurdle')
  if (!opts.type) {
    const answer = await clack.select({
      message: 'What kind of hurdle did you hit?',
      options: [
        { value: 'bug', label: 'bug — something InstaCloud should do, but does not' },
        { value: 'feature-request', label: 'feature-request — something InstaCloud does not support yet' },
        { value: 'friction', label: 'friction — works, but confusing or awkward' },
        { value: 'other', label: 'other' },
      ],
    })
    if (clack.isCancel(answer)) throw new CliCancel()
    opts.type = answer as string
  }
  if (!opts.component) {
    const answer = await clack.select({
      message: 'Where in the InstaCloud toolkit is the issue?',
      options: COMPONENTS.map((c) => ({ value: c, label: c })),
    })
    if (clack.isCancel(answer)) throw new CliCancel()
    opts.component = answer as string
  }
  if (!opts.title) {
    const answer = await clack.text({
      message: 'One-line summary:',
      validate: (v) => (v.trim() ? undefined : 'required'),
    })
    if (clack.isCancel(answer)) throw new CliCancel()
    opts.title = answer.trim()
  }
  if (!opts.detail && !opts.file) {
    const answer = await clack.text({
      message: 'What happened, and what did you expect?',
      validate: (v) => (v.trim() ? undefined : 'required'),
    })
    if (clack.isCancel(answer)) throw new CliCancel()
    opts.detail = answer.trim()
  }
}

/** Pure payload assembly (unit-tested): validation, redaction, caps, and ambient context. */
export async function buildPayload(
  opts: FeedbackOpts,
  ctx: { cliVersion: string },
): Promise<Record<string, unknown>> {
  const type = requireEnum(opts.type ?? '', TYPES, '--type')
  const component = requireEnum(opts.component ?? '', COMPONENTS, '--component')
  const severity = opts.severity ? requireEnum(opts.severity, SEVERITIES, '--severity') : 'minor'

  let detail = opts.detail
  if (!detail && opts.file) {
    try {
      // detail is capped at 4000 chars — a file far beyond that is a mistake (wrong path, a log
      // archive, a binary), so refuse before allocating it rather than truncating garbage.
      // Regular files only: a FIFO/device node (e.g. /dev/zero) stats as size 0, sails past the
      // byte ceiling, and then readFileSync reads unbounded.
      const stat = statSync(opts.file)
      if (!stat.isFile()) throw new Error(`--file ${opts.file} is not a regular file`)
      const size = stat.size
      if (size > MAX_FILE_BYTES) {
        throw new Error(`--file ${opts.file} is ${size} bytes — max ${MAX_FILE_BYTES} (detail is capped at ${LIMITS.detail} chars; trim the file first)`)
      }
      detail = readFileSync(opts.file, 'utf8')
      if (detail.includes('\0')) throw new Error(`--file ${opts.file} looks binary — feedback detail must be text`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(msg.startsWith('--file') ? msg : `--file ${opts.file}: ${msg}`)
    }
  }
  const title = clean(opts.title, LIMITS.title)
  if (!title) throw new Error('--title is required (one-line summary, ≤200 chars)')
  const cleanedDetail = clean(detail, LIMITS.detail)
  if (!cleanedDetail) throw new Error('--detail (or --file <path>) is required: what happened vs what you expected')

  const project = await readProject()
  const { apiUrl } = await readGlobal()
  // envForApiUrl → null means a custom host: insta-oss or a preview deployment (see env.ts).
  const target = envForApiUrl(apiUrl) ? 'cloud' : 'oss'

  return {
    type,
    component,
    severity,
    title,
    detail: cleanedDetail,
    area: clean(opts.area, LIMITS.area),
    command: clean(opts.command, LIMITS.command),
    error: clean(opts.error, LIMITS.error),
    expected: clean(opts.expected, LIMITS.expected),
    workaround: clean(opts.workaround, LIMITS.workaround),
    doc_ref: clean(opts.doc, LIMITS.doc),
    source: 'cli',
    target,
    client_version: ctx.cliVersion,
    node_version: process.version,
    os: `${os.platform()} ${os.release()}`,
    project_id: project?.projectId,
    org_id: project?.orgId,
    branch: project?.branch,
  }
}

export type SubmitResult =
  | { status: 'received' | 'duplicate'; id: string | null; ticket?: { id: string; url: string } }
  // unconfirmed = the deadline expired with the request in flight: the server does not abort
  // mid-request, so the report may have been stored — materially different from 'error'.
  | { status: 'unconfirmed'; error: string }
  | { status: 'error'; error: string }

/** One POST, one bounded attempt (FEEDBACK_TIMEOUT_MS), zero retries — feedback is a side quest and must never hang the CLI.
 *  Transport and server failures come back as a result, not an exception: the caller downgrades
 *  them to a warning so a broken feedback backend can't fail the user's actual task. */
export async function submit(payload: Record<string, unknown>, fetchImpl: typeof fetch, assertion?: string): Promise<SubmitResult> {
  let res: Response
  try {
    res = await fetchImpl(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FEEDBACK_INGEST_TOKEN}`,
        ...(assertion ? { 'Insta-User-Assertion': assertion } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return { status: 'unconfirmed', error: `no response after ${FEEDBACK_TIMEOUT_MS / 1000}s — the report may have been recorded anyway` }
    }
    return { status: 'error', error: `network error: ${e instanceof Error ? e.message : String(e)}` }
  }
  let body: any = {}
  try {
    body = await res.json()
  } catch { /* non-JSON body — fall through to status handling */ }
  if (!res.ok) return { status: 'error', error: body?.error ?? `HTTP ${res.status}` }
  return { status: body?.status === 'duplicate' ? 'duplicate' : 'received', id: body?.id ?? null, ticket: body?.ticket }
}

const SIGNED_OUT = 'not signed in to InstaCloud — run `insta login`, then send this again so the team can reply to you'
const STAGING = 'not accepted from staging — send InstaCloud feedback from production'

// Bearer only: agent evidence adds a session round trip the timeout cannot bound, and 401s signing in cannot fix.
async function userAssertion(api: NonNullable<FeedbackDeps['api']>): Promise<string> {
  return (await api.request<{ token: string }>('GET', '/me/feedback-assertion', undefined, { evidence: false, signal: AbortSignal.timeout(ASSERTION_TIMEOUT_MS) })).token
}

// Exit 2, not the submit path's 0: the caller can act on this one.
function refuseFeedback(message: string, json?: boolean): never {
  if (json) printJson({ status: 'refused', submitted: false, error: message })
  refuse([`insta feedback: ${message}`])
}

function inputError(e: unknown, json?: boolean, fields: object = { submitted: false }): void {
  if (!json) throw e
  printJson({ status: 'error', ...fields, error: e instanceof Error ? e.message : String(e) })
  process.exitCode = 1
}

export async function feedback(opts: FeedbackOpts, deps: FeedbackDeps = {}): Promise<void> {
  let api: NonNullable<FeedbackDeps['api']>
  try {
    api = deps.api ?? await ApiClient.load()
  } catch (e) {
    return inputError(e, opts.json)
  }
  const env = envForApiUrl(api.apiUrl)
  if (env === 'staging') refuseFeedback(STAGING, opts.json)
  // Before the prompts, so nobody types out a report only to be told to sign in.
  if (env === 'prod' && !api.config.accessToken) refuseFeedback(SIGNED_OUT, opts.json)

  const interactive = deps.interactive ?? (!opts.json && !!process.stdin.isTTY && !!process.stdout.isTTY)
  const missingRequired = !opts.type || !opts.component || !opts.title || (!opts.detail && !opts.file)
  if (missingRequired && interactive) await promptMissing(opts)

  // Bad/missing input exits 1 either way — an agent CAN fix its flags, so the error must be loud
  // and self-teaching (it lists the exact enum values). But it must arrive on the channel the
  // caller chose: --json gets a machine-readable object on stdout (uniform with the success and
  // transport-failure shapes) instead of guard()'s plaintext stderr line.
  let payload: Record<string, unknown>
  try {
    payload = await buildPayload(opts, { cliVersion: deps.cliVersion ?? cliVersion() })
  } catch (e) {
    return inputError(e, opts.json)
  }

  // Fetched after the prompts: it lives five minutes, and a person can take longer than that to type.
  let assertion: string | undefined
  if (env === 'prod') {
    try {
      assertion = await userAssertion(api)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) refuseFeedback(SIGNED_OUT, opts.json)
      process.stderr.write(`warning: could not confirm who you are (${e instanceof Error ? e.message : String(e)}) — sending anyway, but nobody can reply to this report\n`)
    }
  }

  const result = await submit(payload, deps.fetchImpl ?? fetch, assertion)

  if (result.status === 'unconfirmed') {
    // NOT a failure claim: the request was still in flight at the deadline and the server
    // finishes what it started, so saying "not submitted" here would be a false negative.
    if (opts.json) return printJson({ status: 'unconfirmed', error: result.error })
    process.stderr.write(`warning: feedback receipt unconfirmed (${result.error}) — continue with your task, do not retry\n`)
    return
  }
  if (result.status === 'error') {
    // Deliberate exit 0: an agent CANNOT fix a down/rate-limited backend, and feedback must never
    // fail or distract from the task the user actually asked for. Do not retry.
    if (opts.json) return printJson({ status: 'error', submitted: false, error: result.error })
    process.stderr.write(`warning: feedback not submitted (${result.error}) — continue with your task, do not retry\n`)
    return
  }

  if (opts.json) return printJson({ status: result.status, id: result.id, ticket: result.ticket })
  if (result.status === 'duplicate') {
    info(`already reported this week — bumped its count instead (id: ${result.id})`)
  } else {
    info(`feedback submitted (id: ${result.id}) — thank you!`)
  }
  if (result.ticket) {
    info(`ticket ${result.ticket.id} — the team's replies are in the console: ${result.ticket.url}`)
    info(`check its status with \`insta feedback status ${result.ticket.id}\``)
  }
  info('PII (emails, tokens, keys, home paths) was redacted before sending.')
}

const STATUS_LABEL: Record<string, string> = { open: 'New', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed' }
const SIGNED_OUT_STATUS = 'not signed in to InstaCloud — run `insta login` to check your ticket'

function refuseStatus(message: string, json?: boolean): never {
  if (json) printJson({ status: 'refused', error: message })
  refuse([`insta feedback status: ${message}`])
}

export async function feedbackStatus(id: string, opts: { json?: boolean }, deps: FeedbackDeps = {}): Promise<void> {
  try {
    const api = deps.api ?? await ApiClient.load()
    const env = envForApiUrl(api.apiUrl)
    if (env !== 'prod') refuseStatus('ticket status is only available on production InstaCloud', opts.json)
    if (!api.config.accessToken) refuseStatus(SIGNED_OUT_STATUS, opts.json)
    let assertion: string
    try {
      assertion = await userAssertion(api)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) refuseStatus(SIGNED_OUT_STATUS, opts.json)
      throw e
    }
    // Relative, so an endpoint served under a path prefix keeps it.
    const res = await (deps.fetchImpl ?? fetch)(new URL(`tickets/${encodeURIComponent(id)}`, FEEDBACK_ENDPOINT), {
      headers: { Authorization: `Bearer ${FEEDBACK_INGEST_TOKEN}`, 'Insta-User-Assertion': assertion },
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    })
    if (res.status === 404) throw new Error(`no ticket ${id} of yours — use the ticket id \`insta feedback\` printed`)
    // The platform vouched for this login a moment ago: a 401 here is the service's, not a signed-out user.
    if (res.status === 401) throw new Error('the feedback service could not verify who you are — signing in again will not fix it')
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; url?: string; error?: string }
    if (!res.ok || !body.status) throw new Error(`the feedback service answered ${res.status}${body.error ? `: ${body.error}` : ''}`)
    if (opts.json) return printJson({ id: body.id, status: body.status, url: body.url })
    info(`ticket ${body.id}: ${STATUS_LABEL[body.status] ?? body.status}`)
    info(`open it in the console: ${body.url}`)
  } catch (e) {
    // A refusal has already printed and set exit 2; handled again it would print twice and exit 1.
    if (e instanceof CliExit) throw e
    return inputError(e, opts.json, {})
  }
}
