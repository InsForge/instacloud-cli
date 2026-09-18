import { describe, expect, it, vi } from 'vitest'
import { archiveLogWatcher, BuildLogPrinter, followBuildLogs, readBuildLogs, type BuildLogSnapshot } from '../src/build-logs.js'
import { ApiError, type ApiClient } from '../src/api.js'

const steps = [{ digest: 'step1', name: 'RUN test', hasLogs: true }]
const base = { state: 'ready', buildState: 'running', entries: [], steps }
const entry = (message: string) => ({ timestamp: '2026-09-17T00:00:00Z', message })
const apiWith = (read: (path: string) => unknown): Pick<ApiClient, 'rawRequest'> => ({ rawRequest: vi.fn(async (_method, path) => ({ status: 200, body: read(path) })) })

describe('build logs', () => {
  it('follows step and output pagination, preserving repeated records and API order', async () => {
    const api = apiWith((path) => {
      const q = new URL('http://local' + path).searchParams
      if (!q.has('step')) return { ...base, steps: q.has('cursor') ? [] : steps, nextCursor: q.has('cursor') ? undefined : 'steps+next' }
      if (!q.has('cursor')) return { ...base, steps: [], entries: [entry('second\n'), entry('same\n')], nextCursor: 'logs/next' }
      return { ...base, steps: [], entries: [entry('same\n'), entry('first\n')] }
    })
    const snapshot = await readBuildLogs(api, 'project', 'archive', 'build')
    expect(snapshot.output[0]!.entries.map((e) => e.message)).toEqual(['second\n', 'same\n', 'same\n', 'first\n'])
    expect(api.rawRequest).toHaveBeenCalledTimes(4)
    expect(api.rawRequest).toHaveBeenCalledWith('GET', expect.stringContaining('cursor=logs%2Fnext'), undefined, { signal: expect.any(AbortSignal) })
  })

  it('prints late records without reprinting history and strips terminal escape sequences', () => {
    const snapshot = (entries: BuildLogSnapshot['entries']): BuildLogSnapshot => ({ ...base, state: 'ready', output: [{ step: 'step1', name: 'RUN test', entries }] })
    const printer = new BuildLogPrinter()
    const write = vi.fn()
    printer.print(snapshot([entry('same\n'), entry('same\n')]), write)
    printer.print(snapshot([entry('\u001b[31mlate\u001b[0m\n'), entry('same\n'), entry('same\n'), entry('same\n')]), write)
    expect(write.mock.calls.map(([text]) => text)).toEqual(['RUN test\n', 'same\n', 'same\n', 'late\n', 'same\n'])
  })

  it('resumes after transient errors and reads delayed terminal output', async () => {
    let reads = 0
    const api = apiWith((path) => {
      if (!path.includes('step=')) { if (++reads === 1) throw new Error('down'); return { ...base, buildState: 'failed' } }
      return { ...base, entries: reads >= 4 ? [entry('FINAL')] : [] }
    })
    const write = vi.fn()
    const wait = vi.fn(async () => {})
    await archiveLogWatcher(api, 'project', write, wait)('build', true)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('Could not read'))
    expect(write.mock.calls.filter(([text]) => text === 'FINAL')).toHaveLength(1)
    expect(wait).toHaveBeenCalledTimes(5)
  })

  it('continues polling a mutable tail even when nextCursor is absent', async () => {
    let reads = 0
    const api = apiWith((path) => {
      if (!path.includes('step=')) { reads++; return { ...base, buildState: reads < 2 ? 'running' : 'succeeded' } }
      return { ...base, entries: reads >= 3 ? [entry('late tail')] : [] }
    })
    const write = vi.fn()
    await followBuildLogs(api, 'project', 'github', 'build', write, async () => {})
    expect(write.mock.calls.filter(([text]) => text === 'late tail')).toHaveLength(1)
    expect(reads).toBe(7)
  })

  it('does not turn unavailable logs or a broken pagination cursor into empty success', async () => {
    const repeated = apiWith(() => ({ ...base, nextCursor: 'same' }))
    await expect(readBuildLogs(repeated, 'p', 'archive', 'b')).rejects.toThrow('pagination did not advance')
    const unavailable = apiWith((path) => path.includes('step=') ? { ...base, state: 'unavailable' } : base)
    await expect(readBuildLogs(unavailable, 'p', 'archive', 'b')).rejects.toThrow('temporarily unavailable')
  })
})


it('rejects partially unavailable step pagination', async () => {
  const api = apiWith(path => path.includes('cursor=') ? { ...base, state: 'unavailable', steps: [] } : { ...base, nextCursor: 'page2' })
  await expect(readBuildLogs(api, 'p', 'archive', 'b')).rejects.toThrow('steps are temporarily unavailable')
})

it('labels interleaved live output with the step that produced it', () => {
  const printer = new BuildLogPrinter()
  const write = vi.fn()
  const snapshot = (n: number): BuildLogSnapshot => ({ ...base, state: 'ready', output: ['A', 'B'].map(step => ({ step, name: 'RUN ' + step, entries: Array.from({ length: n }, (_, i) => entry(step + (i + 1) + '\n')) })) })
  printer.print(snapshot(1), write)
  printer.print(snapshot(2), write)
  expect(write.mock.calls.map(([text]) => text)).toEqual(['RUN A\n', 'A1\n', 'RUN B\n', 'B1\n', 'RUN A\n', 'A2\n', 'RUN B\n', 'B2\n'])
})

it('retries a transient follow error without duplicating output and stops on permanent errors', async () => {
  let reads = 0
  const api = apiWith(path => {
    if (!path.includes('step=')) { if (++reads === 2) throw new ApiError(502, 'down'); return { ...base, buildState: 'succeeded' } }
    return { ...base, entries: [entry('once')] }
  })
  const write = vi.fn()
  await followBuildLogs(api, 'p', 'archive', 'b', write, async () => {})
  expect(write.mock.calls.filter(([text]) => text === 'once')).toHaveLength(1)
  expect(reads).toBe(7)
  const forbidden = apiWith(() => { throw new ApiError(403, 'forbidden') })
  await expect(followBuildLogs(forbidden, 'p', 'archive', 'b', write, async () => {})).rejects.toThrow('forbidden')
  expect(forbidden.rawRequest).toHaveBeenCalledTimes(1)
  const down = apiWith(() => { throw new ApiError(502, 'down') })
  await expect(followBuildLogs(down, 'p', 'archive', 'b', write, async () => {})).rejects.toThrow('down')
  expect(down.rawRequest).toHaveBeenCalledTimes(5)
})
