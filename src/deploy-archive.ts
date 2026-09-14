import type { ApiClient } from './api.js'
import { handleApproval } from './util.js'
import type { PackResult } from './pack.js'

// The gateway does NOT fall back to nixpacks when it finds no Dockerfile, it fails. The platform
// never sees the tree, so the side that packed it chooses.
export type ArchiveBuildSpec = { type: 'dockerfile' } | { type: 'nixpacks' }

export function archiveBuildSpec(hasDockerfile: boolean): ArchiveBuildSpec {
  return hasDockerfile ? { type: 'dockerfile' } : { type: 'nixpacks' }
}

// ONE digest, over the uploaded bytes: it is both the id the object is stored under and the value
// the build worker checks the bytes it fetched against. Splitting the two so the id could be
// canonical across runtimes is what let a Node-packed object be claimed by a Bun-packed digest;
// the compressor is deterministic instead, so one digest is canonical AND addresses the bytes.
export type ArchiveRef = { archiveSha256: string; build: ArchiveBuildSpec }

type Api = Pick<ApiClient, 'rawRequest'>
type Opts = { branch?: string; group?: string; json?: boolean; port?: string; websocket?: boolean; replaceSource?: boolean }

// Plain fetch, never the api client: the presigned URL carries its own signature and the platform
// bearer must not be sent to a bucket.
export type Uploader = (url: string, body: Buffer) => Promise<void>

const defaultUpload: Uploader = async (url, body) => {
  const res = await fetch(url, { method: 'PUT', body })
  if (!res.ok) throw new Error(`uploading the archive failed: HTTP ${res.status}`)
}

const statusPath = (projectId: string, sha256: string) => `/projects/${projectId}/build-uploads/${sha256}`

// Put an archive where the build gateway can fetch it, and answer what the deploy body needs.
// Returns null when an approval is pending — the caller stops, the user approves and re-runs.
//
// The status read comes FIRST and that ordering is the whole recovery story: it is ungated, the
// packer is deterministic and the upload id is derived from the content, so a re-run after an
// approval finds the object already there, skips the gated mint it no longer needs, and submits a
// byte-identical deploy body. That is why no resumable state is written to disk.
export async function uploadArchive(
  api: Api,
  projectId: string,
  packed: Pick<PackResult, 'archive' | 'sha256' | 'hasDockerfile'>,
  branch: string,
  opts: Opts,
  upload: Uploader = defaultUpload,
): Promise<ArchiveRef | null> {
  const ref: ArchiveRef = { archiveSha256: packed.sha256, build: archiveBuildSpec(packed.hasDockerfile) }

  // The id the platform derives storage from is this digest, so an object that is already there is
  // BYTE-IDENTICAL to the one in hand and the ref describes it truthfully. Keying on the tar digest
  // instead bought cross-runtime dedup and paid for it with a lie: a Bun re-run of a Node upload
  // matched the id, skipped the upload, and sent Bun's digest for Node's bytes, which the worker
  // then rejected on every attempt until the object expired.
  const first = await api.rawRequest('GET', statusPath(projectId, packed.sha256))
  if (first.body?.state === 'valid') return ref

  const minted = await api.rawRequest('POST', `/projects/${projectId}/build-uploads`, {
    branch,
    group: opts.group,
    sha256: packed.sha256,
    size: packed.archive.length,
  })
  if (handleApproval(minted, opts.json)) return null

  // The mint's whole product is this URL. An absent one would be PUT to as the string
  // "undefined" and the failure would surface two steps later as a missing object.
  const uploadUrl = minted.body?.uploadUrl
  if (typeof uploadUrl !== 'string' || !uploadUrl) throw new Error('the platform minted an upload with no URL — re-run the deploy')
  await upload(uploadUrl, packed.archive)

  // Never let the deploy call be the thing that discovers a failed upload: its grant is spent in
  // the governance preHandler, so a retry would need a NEW approval.
  const after = await api.rawRequest('GET', statusPath(projectId, packed.sha256))
  if (after.body?.state !== 'valid') {
    throw new Error('the archive upload did not land — re-run the deploy to try again')
  }
  return ref
}

// How often to ask, and how long to keep asking. The platform submits the build and returns; the
// WAIT is ours, one short request at a time, because a deploy is answered synchronously and the
// ALB in front of the platform cuts an idle request at 60s while an image build runs minutes.
const POLL_MS = 3000
const DEPLOY_DEADLINE_MS = 30 * 60 * 1000
// One status read is a small GET; anything longer than this is a stalled endpoint, not a slow one.
const POLL_REQUEST_TIMEOUT_MS = 20_000
const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

// What the archive lane hands back: the deploy already happened. Same fields `/deploy` answers
// with for an image body, so the command prints one shape whichever lane ran.
export type DeployOutcome = { image: string; url: string; branch: string; group: string; machineId?: string }
export type ArchiveDeployResult = DeployOutcome | { failed: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ONE gated call, then a poll. The platform enqueues the build+deploy as an operation and answers
// 202 at once, because a request has to finish inside the ALB's 60s and an image build runs
// minutes; the wait is ours, one short GET at a time. Two gates on the lane with the mint, the
// same as the flyctl lane. Returns null when an approval is pending.
//
// The operation is idempotent on (target, archive, build kind), so a re-run after approving finds
// the one it already started rather than building again: same image, same result, no second
// approval for a build that already happened.
export async function deployArchive(
  api: Api,
  projectId: string,
  ref: ArchiveRef,
  branch: string,
  opts: Opts,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<unknown> = sleep,
  log: (m: string) => void = () => {},
): Promise<ArchiveDeployResult | null> {
  const started = await api.rawRequest('POST', `/projects/${projectId}/archive-deploys`, {
    branch,
    group: opts.group,
    archive: ref,
    port: opts.port ? Number(opts.port) : undefined,
    websocket: typeof opts.websocket === 'boolean' ? opts.websocket : undefined,
    replaceSource: opts.replaceSource === true ? true : undefined,
  })
  // An approval is a 202 too, told apart by its status word; anything else here is our operation.
  if (handleApproval(started, opts.json)) return null
  const operationId = started.body?.operationId
  if (typeof operationId !== 'string' || !operationId) throw new Error('the platform accepted the deploy but returned no operation id — re-run the deploy')
  if (started.body?.resumed === true) log('resuming the deploy this archive already started')

  const deadline = now() + DEPLOY_DEADLINE_MS
  const overdue = () => new Error(`the deploy did not finish within ${Math.round(DEPLOY_DEADLINE_MS / 60000)} minutes — check \`insta status\` or re-run`)
  let last = ''
  for (;;) {
    // The deadline bounds the wall clock, not the number of answers: it is checked before each poll,
    // and each poll is itself bounded by what remains, so a stalled endpoint cannot hold the CLI
    // past it, and an answer that would arrive after it is not waited for.
    const remaining = deadline - now()
    if (remaining <= 0) throw overdue()
    const res = await api.rawRequest('GET', `/projects/${projectId}/archive-deploys/${encodeURIComponent(operationId)}`, undefined, {
      signal: AbortSignal.timeout(Math.min(remaining, POLL_REQUEST_TIMEOUT_MS)),
    }).catch((e) => {
      if (!isAbort(e)) throw e
      throw remaining <= POLL_REQUEST_TIMEOUT_MS ? overdue() : new Error(`the platform did not answer a status poll within ${POLL_REQUEST_TIMEOUT_MS / 1000}s — check \`insta status\` or re-run`)
    })
    const state = res.body?.state
    // A failed operation is an ANSWER, not a transport error: the poll worked, and the sentence
    // it carries (usually the gateway's own, e.g. "no Dockerfile at ./api") is the one to show.
    if (state === 'failed') {
      // `||` would let a non-string through and the CLI would print "[object Object]" for the one
      // sentence that explains the failure. Only a non-empty string is a message.
      const error = res.body?.error
      return { failed: typeof error === 'string' && error ? error : 'the deploy failed' }
    }
    if (state === 'live') {
      const image = res.body?.imageRef
      const url = res.body?.url
      if (typeof image !== 'string' || !image || typeof url !== 'string' || !url) {
        throw new Error('the deploy finished but the platform returned no image or URL for it — check `insta status`')
      }
      // Optional strings, validated as such. String() would have coerced a protocol error into a
      // plausible-looking branch or group and reported a target the deploy never named. An omitted
      // field falls back to what was requested; a field of the wrong type is a broken contract.
      const optionalString = (field: string, v: unknown): string | undefined => {
        if (v === undefined || v === null) return undefined
        if (typeof v !== 'string') throw new Error(`the platform returned a non-string ${field} for the deploy — upgrade with \`insta upgrade\``)
        return v
      }
      return {
        image, url,
        branch: optionalString('branch', res.body.branch) ?? branch,
        group: optionalString('group', res.body.group) ?? opts.group ?? '',
        machineId: optionalString('machineId', res.body.machineId),
      }
    }
    // Only the platform's own in-flight states keep the loop going. An absent or unknown state
    // would otherwise spend the whole deadline looking like a slow build.
    if (state !== 'queued' && state !== 'building' && state !== 'deploying') {
      throw new Error(`the platform reported an unknown deploy state (${JSON.stringify(state)}) — upgrade with \`insta upgrade\``)
    }
    if (state !== last) { log(state === 'deploying' ? 'image built, deploying it' : `${state}…`); last = state }
    await wait(POLL_MS)
  }
}
