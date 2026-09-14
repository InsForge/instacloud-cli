// `insta feedback` — report an InstaCloud-side hurdle to the InstaCloud team.
//
// Scope rule (also stated in the skill): this is for problems in OUR toolkit — the CLI, the MCP
// server, the platform, the skills, the docs. Never for problems in the app the user is building.
//
// The backend is InstaCloud dogfooding itself: the "InstaCloud Agent Feedback" project runs the
// ingest service (InsForge/instacloud-feedback repo) on a postgres + compute pair. It is NOT the
// control-plane API on purpose — feedback must work logged-out, unlinked, and from insta-oss,
// and a control-plane outage is exactly when we most want reports to still arrive.
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import * as clack from '@clack/prompts'
import { readGlobal, readProject } from '../config.js'
import { envForApiUrl } from '../env.js'
import { info, printJson, CliCancel } from '../util.js'
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
// the DB wake and persists, so a report can land after the old 10s deadline gave up on it).
// An expired deadline is reported as UNCONFIRMED, not failed — the report may well be stored.
const FEEDBACK_TIMEOUT_MS = 15_000
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
  | { status: 'received' | 'duplicate'; id: string | null }
  // unconfirmed = the deadline expired with the request in flight: the server does not abort
  // mid-request, so the report may have been stored — materially different from 'error'.
  | { status: 'unconfirmed'; error: string }
  | { status: 'error'; error: string }

/** One POST, 10s timeout, zero retries — feedback is a side quest and must never hang the CLI.
 *  Transport and server failures come back as a result, not an exception: the caller downgrades
 *  them to a warning so a broken feedback backend can't fail the user's actual task. */
export async function submit(payload: Record<string, unknown>, fetchImpl: typeof fetch): Promise<SubmitResult> {
  let res: Response
  try {
    res = await fetchImpl(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FEEDBACK_INGEST_TOKEN}`,
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
  return { status: body?.status === 'duplicate' ? 'duplicate' : 'received', id: body?.id ?? null }
}

export async function feedback(opts: FeedbackOpts, deps: FeedbackDeps = {}): Promise<void> {
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
    if (!opts.json) throw e
    printJson({ status: 'error', submitted: false, error: e instanceof Error ? e.message : String(e) })
    process.exitCode = 1
    return
  }

  const result = await submit(payload, deps.fetchImpl ?? fetch)

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

  if (opts.json) return printJson({ status: result.status, id: result.id })
  if (result.status === 'duplicate') {
    info(`already reported this week — bumped its count instead (id: ${result.id})`)
  } else {
    info(`feedback submitted (id: ${result.id}) — thank you!`)
  }
  info('PII (emails, tokens, keys, home paths) was redacted before sending.')
}
