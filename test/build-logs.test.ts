import { describe, expect, it, vi } from 'vitest'
import { archiveLogWatcher, BuildLogPrinter, followBuildLogs, readBuildLogs, type BuildLogSnapshot } from '../src/build-logs.js'
import { ApiError, type ApiClient } from '../src/api.js'

const steps = [{ digest: 'step1', name: 'RUN test', hasLogs: true }]
const base = { state: 'ready', buildState: 'running', entries: [], steps }
const entry = (message: string) => ({ timestamp: '2026-09-17T00:00:00Z', message })
const apiWith = (read: (path: string) => unknown): Pick<ApiClient, 'rawRequest'> => ({ rawRequest: vi.fn(async (_method, path) => ({ status: 200, body: read(path) })) })

describe('build logs', () => {
  it.each([[false, false, false, false], [true, false, false, false], [false, true, false, false], [true, true, false, false], [false, true, true, false], [true, true, true, false], [false, true, true, true], [true, true, true, true]])('merges duplicate steps across pages (terminal first: %s, older completion: %s, sub-ms: %s, success: %s)', async (terminalFirst, olderCompletion, subMillisecond, success) => {
    const finished = { digest: 'step1', name: 'RUN test', hasLogs: false, completedAt: subMillisecond ? '2026-09-17T00:00:00.000000002Z' : '2026-09-17T00:00:01Z', ...(success ? {} : { error: 'exit 17' }) }
    const running = { digest: 'step1', name: 'RUN test', hasLogs: true, ...(olderCompletion ? { completedAt: subMillisecond ? '2026-09-17T00:00:00.000000001Z' : '2026-09-17T00:00:00Z', error: 'older error' } : {}) }
    const records = terminalFirst ? [finished, running] : [running, finished]
    const api = apiWith(path => {
      const q = new URL('http://local' + path).searchParams
      if (!q.has('step')) return { ...base, steps: [records[q.has('cursor') ? 1 : 0]], ...(q.has('cursor') ? {} : { nextCursor: 'steps2' }) }
      return { ...base, steps: [], entries: [entry('same\n'), entry('same\n')] }
    })
    const snapshot = await readBuildLogs(api, 'p', 'archive', 'b')
    expect(snapshot.steps).toEqual([{ ...finished, hasLogs: true }])
    expect(snapshot.output).toHaveLength(1)
    expect(snapshot.output[0]!.entries).toEqual([entry('same\n'), entry('same\n')])
    expect(api.rawRequest).toHaveBeenCalledTimes(3)
  })

  it('follows step and output pagination, preserving repeated records and API order', async () => {
    const api = apiWith((path) => {
      const q = new URL('http://local' + path).searchParams
      if (!q.has('step')) return { ...base, steps: q.has('cursor') ? [] : steps, nextCursor: q.has('cursor') ? undefined : 'steps+next' }
      if (!q.has('cursor')) return { ...base, steps: [], entries: [entry('second\n'), entry('same\n')], nextCursor: 'logs/next' }
      return { ...base, steps: [], entries: [entry('same\n'), entry('first\n')] }
    })
    const snapshot = await readBuildLogs(api, 'project', 'archive', 'build')
    expect(snapshot.nextCursor).toBeUndefined()
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

it('retains the mutable tail cursor and preserves identical records across pages', async () => {
  let tailRecords = 1
  const cursors: string[] = []
  const api = apiWith(path => {
    const q = new URL('http://local' + path).searchParams
    if (!q.has('step')) return base
    const cursor = q.get('cursor') ?? ''
    cursors.push(cursor)
    return { ...base, entries: Array.from({ length: cursor === 'tail' ? tailRecords : 1 }, () => entry('same\n')), ...(cursor ? {} : { nextCursor: 'tail' }) }
  })
  const write = vi.fn()
  const watch = archiveLogWatcher(api, 'p', write, async () => {})
  await watch('b', false)
  tailRecords = 2
  await watch('b', false)
  expect(cursors).toEqual(['', 'tail', 'tail'])
  expect(write.mock.calls.filter(([text]) => text === 'same\n')).toHaveLength(3)
})

it('emits completed pages before a later page fails and resumes at that page', async () => {
  let fail = true
  const cursors: string[] = []
  const api = apiWith(path => {
    const q = new URL('http://local' + path).searchParams
    if (!q.has('step')) return base
    const cursor = q.get('cursor') ?? ''
    cursors.push(cursor)
    if (cursor && fail) { fail = false; throw new ApiError(502, 'down') }
    return { ...base, entries: [entry(cursor ? 'second' : 'first')], ...(cursor ? {} : { nextCursor: 'tail' }) }
  })
  const write = vi.fn()
  const watch = archiveLogWatcher(api, 'p', write, async () => {})
  await watch('b', false)
  expect(write).toHaveBeenCalledWith('first')
  await watch('b', false)
  expect(cursors).toEqual(['', 'tail', 'tail'])
  expect(write.mock.calls.filter(([text]) => text === 'first')).toHaveLength(1)
  expect(write).toHaveBeenCalledWith('second')
})

it('waits for a pending step and separates only output boundaries, not chunks', async () => {
  let pending = true
  const api = apiWith(path => path.includes('step=') ? { ...base, state: pending ? 'pending' : 'ready', entries: pending ? [] : [entry('hello')] } : base)
  expect((await readBuildLogs(api, 'p', 'archive', 'b')).state).toBe('pending')
  const write = vi.fn()
  const watch = archiveLogWatcher(api, 'p', write, async () => {})
  await watch('b', false)
  pending = false
  await watch('b', false)
  expect(write).toHaveBeenCalledWith('hello')
  const printer = new BuildLogPrinter()
  const chunks = vi.fn()
  const snapshot = (entries: BuildLogSnapshot['entries']): BuildLogSnapshot => ({ ...base, state: 'ready', output: [{ step: 's', name: 'RUN', entries }] })
  printer.print(snapshot([entry('hel')]), chunks)
  printer.print(snapshot([entry('hel'), entry('lo')]), chunks)
  printer.finishLine(chunks)
  expect(chunks.mock.calls.map(([text]) => text)).toEqual(['RUN\n', 'hel', 'lo', '\n'])
})


it('prints sanitized metadata-only failures once during follow and one-shot reads', async () => {
  const api = apiWith(() => ({ ...base, buildState: 'failed', error: 'failed to solve', steps: [{ ...steps[0], hasLogs: false, error: '\u001b[31mexit 17\u001b[0m' }] }))
  const write = vi.fn()
  await followBuildLogs(api, 'p', 'archive', 'b', write, async () => {})
  expect(write.mock.calls.map(([text]) => text)).toEqual(['failed to solve\n', 'RUN test: exit 17\n'])
  const snapshot = await readBuildLogs(api, 'p', 'archive', 'b')
  const once = vi.fn()
  new BuildLogPrinter().print(snapshot, once)
  expect(once.mock.calls).toEqual(write.mock.calls)
  expect(snapshot.error).toBe('failed to solve')
})

it('prints an unavailable build failure through the one-shot command', async () => {
  const apiModule = await import('../src/api.js')
  const api = apiWith(() => ({ ...base, state: 'unavailable', buildState: 'failed', error: 'source preparation failed', steps: [] }))
  const load = vi.spyOn(apiModule.ApiClient, 'load').mockResolvedValue(api as ApiClient)
  const project = vi.spyOn(apiModule, 'requireProject').mockResolvedValue({ projectId: 'p' } as Awaited<ReturnType<typeof apiModule.requireProject>>)
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    const { buildLogs } = await import('../src/commands/build-logs.js')
    await buildLogs('b', { source: 'archive' })
    expect(output).toHaveBeenCalledWith('source preparation failed\n')
  } finally {
    load.mockRestore(); project.mockRestore(); output.mockRestore()
  }
})

it.each([250, 350])('finishes the final full read after %s ms page reads consume the polling budget', async (latency) => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  let reads = 0
  const api: Pick<ApiClient, 'rawRequest'> = { rawRequest: vi.fn(async (_method, path, _body, opts) => {
    await new Promise(resolve => setTimeout(resolve, latency))
    opts?.signal?.throwIfAborted()
    const q = new URL('http://local' + path).searchParams
    if (!q.has('step')) { reads++; return { status: 200, body: { ...base, buildState: 'succeeded' } } }
    return { status: 200, body: { ...base, entries: [entry(q.has('cursor') ? 'tail\n' : reads >= 6 ? 'LATE\n' : 'first\n')], ...(q.has('cursor') ? {} : { nextCursor: 'tail' }) } }
  }) }
  const write = vi.fn()
  try {
    const watching = archiveLogWatcher(api, 'p', write)('b', true)
    await vi.runAllTimersAsync()
    await watching
    expect(write).toHaveBeenCalledWith('LATE\n')
    expect(write.mock.calls.some(([s]) => s.includes('Could not read'))).toBe(false)
    expect(write.mock.calls.filter(([s]) => s === 'tail\n')).toHaveLength(1)
  } finally { timeout.mockRestore(); vi.useRealTimers() }
})

it('yields an unfinished live refresh without warning and resumes its completed pages', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  let slow = true
  const api: Pick<ApiClient, 'rawRequest'> = { rawRequest: vi.fn(async (_method, path, _body, opts) => {
    await new Promise(resolve => setTimeout(resolve, slow ? 1100 : 10))
    opts?.signal?.throwIfAborted()
    const q = new URL('http://local' + path).searchParams
    if (!q.has('step')) return { status: 200, body: base }
    return { status: 200, body: { ...base, entries: [entry(q.has('cursor') ? 'tail\n' : 'first\n')], ...(q.has('cursor') ? {} : { nextCursor: 'tail' }) } }
  }) }
  const write = vi.fn()
  try {
    const watch = archiveLogWatcher(api, 'p', write)
    let watching = watch('b', false)
    await vi.runAllTimersAsync(); await watching
    expect(write).toHaveBeenCalledWith('first\n')
    slow = false
    watching = watch('b', false)
    await vi.runAllTimersAsync(); await watching
    expect(write.mock.calls.some(([s]) => s.includes('Could not read'))).toBe(false)
    expect(write.mock.calls.filter(([s]) => s === 'first\n')).toHaveLength(1)
    expect(write.mock.calls.filter(([s]) => s === 'tail\n')).toHaveLength(1)
  } finally { timeout.mockRestore(); vi.useRealTimers() }
})

it('reports a final read timeout while respecting the remaining deployment deadline', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  const api: Pick<ApiClient, 'rawRequest'> = { rawRequest: vi.fn(async (_method, _path, _body, opts) => {
    await new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => reject(opts!.signal!.reason), { once: true }))
    return { status: 200, body: base }
  }) }
  const write = vi.fn()
  try {
    const watching = archiveLogWatcher(api, 'p', write)('b', true, 500)
    await vi.runAllTimersAsync()
    await watching
    expect(api.rawRequest).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(500)
    expect(write).toHaveBeenCalledWith('Could not read build logs (timed out). Retry with: insta build-logs b\n')
  } finally { timeout.mockRestore(); vi.useRealTimers() }
})

it('keeps real HTTP failures visible in the archive watcher', async () => {
  const api = apiWith(() => { throw new ApiError(403, 'forbidden') })
  const write = vi.fn()
  await archiveLogWatcher(api, 'p', write)('b', false)
  expect(write).toHaveBeenCalledWith('Could not read build logs (HTTP 403). Retry with: insta build-logs b\n')
})


it('keeps polling delayed terminal output when less than 18 seconds remain', async () => {
  vi.useFakeTimers()
  let reads = 0
  const api = apiWith(path => {
    if (!path.includes('step=')) { reads++; return { ...base, buildState: 'succeeded' } }
    return { ...base, entries: reads >= 4 ? [entry('late\n')] : [] }
  })
  const write = vi.fn()
  try {
    await archiveLogWatcher(api, 'p', write, async ms => { vi.advanceTimersByTime(ms) })('b', true, 12_000)
    expect(write).toHaveBeenCalledWith('late\n')
  } finally { vi.useRealTimers() }
})


it('performs a bounded final scan after an early terminal refresh uses the whole polling window', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  let calls = 0
  const api: Pick<ApiClient, 'rawRequest'> = { rawRequest: vi.fn(async (_method, path, _body, opts) => {
    if (++calls === 1) await new Promise((_resolve, reject) => opts!.signal!.addEventListener('abort', () => reject(opts!.signal!.reason), { once: true }))
    return { status: 200, body: { ...base, buildState: 'succeeded', entries: path.includes('step=') ? [entry('recovered\n')] : [] } }
  }) }
  const write = vi.fn()
  try {
    const watching = archiveLogWatcher(api, 'p', write)('b', true, 60_000)
    await vi.runAllTimersAsync(); await watching
    expect(write).toHaveBeenCalledWith('recovered\n')
    expect(write.mock.calls.some(([s]) => s.includes('Could not read'))).toBe(false)
    expect(timeout.mock.calls).toEqual([[18_000], [30_000]])
  } finally { timeout.mockRestore(); vi.useRealTimers() }
})
