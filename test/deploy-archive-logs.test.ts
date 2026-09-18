import { describe, expect, it, vi } from 'vitest'
import { archiveLogWatcher } from '../src/build-logs.js'
import { deployArchive } from '../src/deploy-archive.js'
import type { ApiClient } from '../src/api.js'

const ref = { archiveSha256: 'a'.repeat(64), build: { type: 'dockerfile' as const } }
const accepted = { status: 202, body: { operationId: 'build' } }
const live = { state: 'live', imageRef: 'ecr/app@sha256:aa', url: 'https://app.example' }
const step = { digest: 'step', name: 'RUN build', hasLogs: true }
const page = { state: 'ready', buildState: 'running', steps: [step], entries: [] }
const entry = (message: string) => ({ timestamp: '2026-09-18T00:00:00Z', message })

describe('archive deployment log polling', () => {
  it('polls status every 3 seconds during slow log reads, then cancels and drains before the final scan', async () => {
    vi.useFakeTimers()
    const started = Date.now()
    const polls: number[] = []
    let finished = false
    let active = 0
    let maxActive = 0
    let canceled = 0
    const api: Pick<ApiClient, 'rawRequest'> = { rawRequest: vi.fn(async (method, path, _body, opts) => {
      if (method === 'POST') return accepted
      if (path.includes('/archive-deploys/')) {
        polls.push(Date.now() - started)
        finished = polls.length === 4
        return { status: 200, body: finished ? live : { state: 'building' } }
      }
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (!finished) await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); canceled++; reject(opts!.signal!.reason) }
          const timer = setTimeout(() => { opts!.signal!.removeEventListener('abort', abort); resolve() }, 4000)
          opts!.signal!.addEventListener('abort', abort, { once: true })
        })
        const q = new URL('http://local' + path).searchParams
        return { status: 200, body: !q.has('step') ? page : {
          ...page, entries: [entry(q.has('cursor') ? 'FINAL\n' : 'FIRST\n')], ...(q.has('cursor') ? {} : { nextCursor: 'tail' }),
        } }
      } finally { active-- }
    }) }
    const write = vi.fn()
    const status = vi.fn()
    try {
      const deploying = deployArchive(api, 'p', ref, 'main', {}, Date.now, undefined, status, archiveLogWatcher(api, 'p', write))
      await vi.advanceTimersByTimeAsync(8000)
      expect(polls).toEqual([0, 3000, 6000])
      expect(write).toHaveBeenCalledWith('FIRST\n')
      await vi.advanceTimersByTimeAsync(16_000)
      expect(await deploying).toMatchObject({ url: live.url })
      expect(polls).toEqual([0, 3000, 6000, 9000])
      expect(maxActive).toBe(1)
      expect(active).toBe(0)
      expect(canceled).toBe(1)
      expect(write.mock.calls.filter(([s]) => s === 'FIRST\n')).toHaveLength(1)
      expect(write.mock.calls.filter(([s]) => s === 'FINAL\n')).toHaveLength(1)
      expect(write.mock.calls.some(([s]) => s.includes('Could not read'))).toBe(false)
      const requests = vi.mocked(api.rawRequest).mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(vi.mocked(api.rawRequest).mock.calls).toHaveLength(requests)
    } finally { vi.useRealTimers() }
  })

  it.each(['error', 'unknown', 'deadline'])('cancels pending logs when status polling exits through %s', async reason => {
    let now = 0
    let canceled = false
    const api: Pick<ApiClient, 'rawRequest'> = { rawRequest: vi.fn(async (method, path, _body, opts) => {
      if (method === 'POST') return accepted
      if (path.includes('/archive-deploys/')) {
        if (reason === 'error') throw new Error('status unavailable')
        return { status: 200, body: { state: reason === 'unknown' ? 'unexpected' : 'building' } }
      }
      await new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => { canceled = true; reject(opts!.signal!.reason) }, { once: true }))
      return { status: 200, body: page }
    }) }
    const write = vi.fn()
    const deploying = deployArchive(api, 'p', ref, 'main', {}, () => now, async () => { now = 30 * 60_000 }, () => {}, archiveLogWatcher(api, 'p', write))
    await expect(deploying).rejects.toThrow(reason === 'error' ? 'status unavailable' : reason === 'unknown' ? 'unknown deploy state' : 'did not finish within 30 minutes')
    expect(canceled).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('refreshes logs while a status request is waiting and cancels idle polling when the build fails', async () => {
    let finishStatus!: (value: { status: number; body: { state: string; error: string } }) => void
    const status = new Promise<{ status: number; body: { state: string; error: string } }>(resolve => { finishStatus = resolve })
    const api = { rawRequest: async (method: string) => method === 'POST' ? accepted : status }
    let finishReads!: () => void
    const refreshed = new Promise<void>(resolve => { finishReads = resolve })
    const watch = vi.fn(async (_id: string, finished: boolean) => {
      if (!finished && watch.mock.calls.length === 2) finishReads()
    })
    const deploying = deployArchive(api, 'p', ref, 'main', {}, Date.now, undefined, undefined, watch)
    await refreshed
    finishStatus({ status: 200, body: { state: 'failed', error: 'exit 17' } })
    expect(await deploying).toEqual({ failed: 'exit 17' })
    expect(watch.mock.calls.map(([, finished]) => finished)).toEqual([false, false, true])
  })
})
