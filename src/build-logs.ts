import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { ApiError, type ApiClient } from './api.js'

type Api = Pick<ApiClient, 'rawRequest'>
export type BuildLogPage = {
  state: 'ready' | 'pending' | 'unsupported' | 'unavailable'
  buildState: string
  steps: Array<{ digest: string; name: string; error?: string; hasLogs: boolean }>
  entries: Array<{ timestamp: string; message: string }>
  nextCursor?: string
}
export type BuildLogSnapshot = BuildLogPage & { output: Array<{ step: string; name: string; entries: BuildLogPage['entries'] }> }
export type BuildSource = 'github' | 'archive'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const terminal = new Set(['succeeded', 'failed', 'canceled', 'unknown', 'live'])

export async function readBuildLogs(api: Api, projectId: string, source: BuildSource, buildId: string, signal = AbortSignal.timeout(30_000)): Promise<BuildLogSnapshot> {
  let bytes = 0
  let requests = 0
  async function pages(step?: string): Promise<BuildLogPage[]> {
    const result: BuildLogPage[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      if (++requests > 200) throw new Error('build logs exceed the per-read page limit')
      const params = new URLSearchParams({ ...(step ? { step } : {}), ...(cursor ? { cursor } : {}) })
      const { body } = await api.rawRequest('GET', `/projects/${projectId}/builds/${source}/${encodeURIComponent(buildId)}/logs?${params}`, undefined, { signal })
      if (!body || !['ready', 'pending', 'unsupported', 'unavailable'].includes(body.state) || !Array.isArray(body.steps) || !Array.isArray(body.entries)) throw new Error('invalid build log response')
      bytes += Buffer.byteLength(JSON.stringify(body))
      if (bytes > 16 * 1024 * 1024) throw new Error('build logs exceed the 16 MiB per-read limit')
      result.push(body)
      cursor = body.nextCursor || undefined
      if (cursor && seen.has(cursor)) throw new Error('build log pagination did not advance')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return result
  }
  const stepPages = await pages()
  const first = stepPages[0]!
  if (stepPages.some((page) => page.state !== first.state)) throw new Error('build steps are temporarily unavailable')
  const steps = stepPages.flatMap((page) => page.steps)
  const output: BuildLogSnapshot['output'] = []
  for (const step of steps) {
    if (!step.hasLogs) continue
    const logs = await pages(step.digest)
    if (logs.some((page) => page.state !== 'ready')) throw new Error('step output is temporarily unavailable')
    output.push({ step: step.digest, name: step.name, entries: logs.flatMap((page) => page.entries) })
  }
  return { ...first, steps, output }
}

const safeText = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

export class BuildLogPrinter {
  private seen = new Map<string, number>()
  private lastStep?: string
  print(snapshot: BuildLogSnapshot, write: (message: string) => void): void {
    for (const step of snapshot.output) {
      const counts = new Map<string, number>()
      for (const entry of step.entries) {
        const key = createHash('sha256').update(JSON.stringify([step.step, entry.timestamp, entry.message])).digest('hex')
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        if (count <= (this.seen.get(key) ?? 0)) continue
        if (this.seen.size >= 100_000) throw new Error('live build logs exceed the display limit')
        if (this.lastStep !== step.step) { write(safeText(step.name) + '\n'); this.lastStep = step.step }
        write(safeText(entry.message))
      }
      for (const [key, count] of counts) this.seen.set(key, Math.max(count, this.seen.get(key) ?? 0))
    }
  }
}

export function archiveLogWatcher(api: Api, projectId: string, write: (message: string) => void, wait = sleep) {
  const printer = new BuildLogPrinter()
  let warned = ''
  let unavailable = false
  return async (buildId: string, finished: boolean, remainingMs = 30_000): Promise<void> => {
    if (unavailable) return
    const deadline = Date.now() + Math.min(remainingMs, finished ? 18_000 : 3000)
    for (let attempt = 0; attempt < (finished ? 6 : 1); attempt++) {
      if (attempt > 0) await wait(Math.min(3000, Math.max(0, deadline - Date.now())))
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      try {
        const snapshot = await readBuildLogs(api, projectId, 'archive', buildId, AbortSignal.timeout(remaining))
        if (snapshot.state === 'unsupported') {
          write(`Build logs ${snapshot.state}. Read again with: insta build-logs ${buildId}\n`)
          unavailable = true
          return
        }
        if (snapshot.state === 'unavailable') throw new Error('build logs unavailable')
        printer.print(snapshot, write)
        warned = ''
      } catch {
        const message = `Could not read build logs. Retry with: insta build-logs ${buildId}\n`
        if (warned !== message) write(message)
        warned = message
      }
    }
  }
}

export async function followBuildLogs(api: Api, projectId: string, source: BuildSource, buildId: string, write: (message: string) => void, wait = sleep): Promise<void> {
  const printer = new BuildLogPrinter()
  let finalReads = 0
  let failures = 0
  for (;;) {
    let snapshot: BuildLogSnapshot
    try {
      snapshot = await readBuildLogs(api, projectId, source, buildId)
      failures = 0
    } catch (error) {
      const retryable = error instanceof ApiError ? error.status === 429 || error.status >= 500
        : error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      if (!retryable || ++failures >= 5) throw error
      write('Could not refresh build logs; retrying…\n')
      await wait(3000)
      continue
    }
    if (snapshot.state === 'unsupported' || snapshot.state === 'unavailable') throw new Error(`Build logs ${snapshot.state}`)
    printer.print(snapshot, write)
    if (terminal.has(snapshot.buildState) && ++finalReads >= 6) return
    await wait(3000)
  }
}
