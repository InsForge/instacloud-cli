import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { ApiError, type ApiClient } from './api.js'

type Api = Pick<ApiClient, 'rawRequest'>
export type BuildLogPage = {
  state: 'ready' | 'pending' | 'unsupported' | 'unavailable'
  buildState: string
  error?: string
  steps: Array<{ digest: string; name: string; error?: string; hasLogs: boolean; completedAt?: string }>
  entries: Array<{ timestamp: string; message: string; occurrence?: number }>
  nextCursor?: string
}
export type BuildLogSnapshot = BuildLogPage & { output: Array<{ step: string; name: string; entries: BuildLogPage['entries'] }> }
export type BuildSource = 'github' | 'archive'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const terminal = new Set(['succeeded', 'failed', 'canceled', 'unknown', 'live'])

type LogTail = { cursor?: string; counts: Map<string, number> }
type FollowState = { tails: Map<string, LogTail>; emit: (snapshot: BuildLogSnapshot) => void }
const entryKey = (step: string, entry: BuildLogPage['entries'][number]) => createHash('sha256').update(JSON.stringify([step, entry.timestamp, entry.message])).digest('hex')
class LogsNotReady extends Error {}

// Compute emits UTC RFC3339Nano; Date.parse discards submillisecond ordering.
function completionKey(value: string): string {
  const [seconds, fraction = ''] = value.slice(0, -1).split('.')
  return `${seconds}.${fraction.padEnd(9, '0')}`
}

export async function readBuildLogs(api: Api, projectId: string, source: BuildSource, buildId: string, signal = AbortSignal.timeout(30_000), follow?: FollowState): Promise<BuildLogSnapshot> {
  let bytes = 0
  let requests = 0
  let pending = false
  async function pages(step?: string): Promise<BuildLogPage[]> {
    const result: BuildLogPage[] = []
    const seen = new Set<string>()
    const tail = step ? follow?.tails.get(step) ?? { counts: new Map<string, number>() } : undefined
    let cursor = tail?.cursor
    do {
      if (++requests > 200) throw new Error('build logs exceed the per-read page limit')
      const params = new URLSearchParams({ ...(step ? { step } : {}), ...(cursor ? { cursor } : {}) })
      signal.throwIfAborted()
      const request = new AbortController()
      const abort = () => request.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => request.abort(new DOMException('build log request timed out', 'TimeoutError')), 20_000)
      let body
      try {
        const response = await api.rawRequest('GET', `/projects/${projectId}/builds/${source}/${encodeURIComponent(buildId)}/logs?${params}`, undefined, { signal: request.signal })
        body = response.body
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
      }
      if (!body || !['ready', 'pending', 'unsupported', 'unavailable'].includes(body.state) || !Array.isArray(body.steps) || !Array.isArray(body.entries)) throw new Error('invalid build log response')
      bytes += Buffer.byteLength(JSON.stringify(body))
      if (bytes > 16 * 1024 * 1024) throw new Error('build logs exceed the 16 MiB per-read limit')
      if (body.state === 'pending') pending = true
      if (step && follow && body.state === 'ready') {
        const counts = new Map(tail!.counts)
        const entries = (body.entries as BuildLogPage['entries']).map(entry => {
          const key = entryKey(step, entry)
          const occurrence = (counts.get(key) ?? 0) + 1
          if (counts.size >= 100_000 && !counts.has(key)) throw new Error('live build logs exceed the display limit')
          counts.set(key, occurrence)
          return { ...entry, occurrence }
        })
        const name = steps.find(item => item.digest === step)!.name
        follow.emit({ ...body, output: [{ step, name, entries }] })
        if (body.nextCursor) { tail!.counts = counts; tail!.cursor = body.nextCursor }
        follow.tails.set(step, tail!)
        result.push({ ...body, entries: [] })
      } else result.push(body)
      cursor = body.nextCursor || undefined
      if (cursor && seen.has(cursor)) throw new Error('build log pagination did not advance')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return result
  }
  const stepPages = await pages()
  const first = stepPages[0]!
  if (stepPages.some((page) => page.state !== first.state)) throw new LogsNotReady('build steps are temporarily unavailable')
  const byDigest = new Map<string, BuildLogPage['steps'][number]>()
  for (const step of stepPages.flatMap((page) => page.steps)) {
    const previous = byDigest.get(step.digest)
    if (!previous) { byDigest.set(step.digest, step); continue }
    const [older, newer] = previous.completedAt && (!step.completedAt || completionKey(previous.completedAt) > completionKey(step.completedAt))
      ? [step, previous] : [previous, step]
    byDigest.set(step.digest, { ...older, ...newer, hasLogs: older.hasLogs || newer.hasLogs, error: newer.error })
  }
  const steps = [...byDigest.values()]
  follow?.emit({ ...first, steps, output: [] })
  const output: BuildLogSnapshot['output'] = []
  for (const step of steps) {
    if (!step.hasLogs) continue
    const logs = await pages(step.digest)
    if (logs.some((page) => page.state !== 'ready' && page.state !== 'pending')) throw new LogsNotReady('step output is temporarily unavailable')
    output.push({ step: step.digest, name: step.name, entries: logs.flatMap((page) => page.entries) })
  }
  return { ...first, nextCursor: undefined, state: pending ? 'pending' : first.state, steps, output }
}

const safeText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

export class BuildLogPrinter {
  private seen = new Map<string, number>()
  private diagnostics = new Set<string>()
  private lastStep?: string
  private lineStart = true
  finishLine(write: (message: string) => void): void {
    if (!this.lineStart) write('\n')
    this.lineStart = true
  }
  print(snapshot: BuildLogSnapshot, write: (message: string) => void): void {
    const errors = [
      ...(snapshot.error ? [{ id: 'build', message: snapshot.error }] : []),
      ...snapshot.steps.filter(step => step.error).map(step => ({ id: step.digest, message: `${step.name}: ${step.error}` })),
    ]
    for (const error of errors) {
      const key = JSON.stringify([error.id, error.message])
      if (this.diagnostics.has(key)) continue
      this.finishLine(write)
      write(safeText(error.message) + '\n')
      this.diagnostics.add(key)
    }
    for (const step of snapshot.output) {
      const counts = new Map<string, number>()
      for (const entry of step.entries) {
        const key = entryKey(step.step, entry)
        const count = entry.occurrence ?? (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        if (count <= (this.seen.get(key) ?? 0)) continue
        if (this.seen.size >= 100_000) throw new Error('live build logs exceed the display limit')
        if (this.lastStep !== step.step) { this.finishLine(write); write(safeText(step.name) + '\n'); this.lastStep = step.step }
        const text = safeText(entry.message)
        write(text)
        if (text) this.lineStart = text.endsWith('\n')
      }
      for (const [key, count] of counts) this.seen.set(key, Math.max(count, this.seen.get(key) ?? 0))
    }
  }
}

export function archiveLogWatcher(api: Api, projectId: string, write: (message: string) => void, wait = sleep) {
  const printer = new BuildLogPrinter()
  const follow: FollowState = { tails: new Map(), emit: snapshot => printer.print(snapshot, write) }
  let warned = ''
  let unavailable = false
  return async (buildId: string, finished: boolean, remainingMs = 30_000, cancelSignal?: AbortSignal): Promise<void> => {
    if (unavailable) return
    const started = Date.now()
    const deadline = started + remainingMs
    const refreshDeadline = started + Math.min(remainingMs, finished ? 18_000 : remainingMs)
    for (let attempt = 0; attempt < (finished ? 6 : 1); attempt++) {
      if (attempt > 0) await wait(Math.min(3000, Math.max(0, refreshDeadline - Date.now())))
      const finalRead = finished && (attempt === 5 || Date.now() >= refreshDeadline)
      const remaining = Math.min(deadline - Date.now(), finalRead ? 30_000 : refreshDeadline - Date.now())
      if (remaining <= 0) return
      if (finished && (attempt === 0 || finalRead)) follow.tails.clear()
      const signal = cancelSignal ?? AbortSignal.timeout(remaining)
      try {
        const snapshot = await readBuildLogs(api, projectId, 'archive', buildId, signal, follow)
        if (snapshot.state === 'unsupported') {
          printer.finishLine(write)
          write('Build logs are not supported for this build provider.\n')
          unavailable = true
          return
        }
        if (snapshot.state === 'unavailable') throw new Error('build logs unavailable')
        warned = ''
      } catch (error) {
        if (cancelSignal?.aborted) return
        if (finished && signal.aborted && !finalRead && Date.now() < deadline) continue
        if (error instanceof ApiError && error.status === 400) follow.tails.clear()
        printer.finishLine(write)
        const reason = signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ? ' (timed out)' : error instanceof ApiError ? ` (HTTP ${error.status})` : ''
        const message = `Could not read build logs${reason}. Retry with: insta build logs ${buildId}\n`
        if (warned !== message) write(message)
        warned = message
      }
      if (finalRead) return
    }
  }
}

export async function followBuildLogs(api: Api, projectId: string, source: BuildSource, buildId: string, write: (message: string) => void, wait = sleep): Promise<void> {
  const printer = new BuildLogPrinter()
  const follow: FollowState = { tails: new Map(), emit: snapshot => printer.print(snapshot, write) }
  let finalReads = 0
  let failures = 0
  for (;;) {
    let snapshot: BuildLogSnapshot
    try {
      snapshot = await readBuildLogs(api, projectId, source, buildId, AbortSignal.timeout(30_000), follow)
      failures = 0
    } catch (error) {
      const retryable = error instanceof ApiError ? error.status === 400 || error.status === 429 || error.status >= 500
        : error instanceof LogsNotReady || error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      if (error instanceof ApiError && error.status === 400) follow.tails.clear()
      if (!retryable || ++failures >= 5) { printer.finishLine(write); throw error }
      printer.finishLine(write)
      write('Could not refresh build logs; retrying…\n')
      await wait(3000)
      continue
    }
    if (snapshot.state === 'unsupported' || snapshot.state === 'unavailable') { printer.finishLine(write); throw new Error(`Build logs ${snapshot.state}`) }
    if (snapshot.state === 'ready' && terminal.has(snapshot.buildState)) {
      if (++finalReads >= 6) { printer.finishLine(write); return }
      if (finalReads === 1 || finalReads === 5) follow.tails.clear()
    }
    await wait(3000)
  }
}
