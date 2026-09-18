import { describe, expect, it, vi } from 'vitest'

import {
  assertTargetFlags, buildRequest, conflictLines, cronDelete, cronEdit, cronEditWarnings, cronRun,
  fmtUtc, jobListLine, jobShowLines, parseHeader, parseHeaders, parseMethod, parseRunLimit,
  parseTimeout, previewLines, resolveJob, runListLine, targetLine,
  type CronAttempt, type CronJob, type CronRun, type Resolved,
} from '../src/commands/cron.js'

const JOB: CronJob = {
  id: 'job1', name: 'nightly', branch: 'main', expression: '0 3 * * *', timezone: 'UTC',
  enabled: true, revision: 4, next_run_at: '2026-09-18T03:00:00.000Z',
  target: { kind: 'external', url: 'https://example.test/hook' },
  request: { method: 'POST', headerNames: ['x-api-key'] },
  request_timeout_ms: 5000, retry_policy: {},
  created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-17T09:30:00.000Z',
}

const RUN: CronRun = {
  id: 'run1', scheduled_at: '2026-09-17T03:00:00.000Z', trigger_type: 'scheduled', status: 'succeeded',
  skip_reason: null, platform_retry_count: 0, application_retry_count: 0,
  started_at: '2026-09-17T03:00:01.000Z', finished_at: '2026-09-17T03:00:02.000Z',
  config: { target: JOB.target, method: 'POST', headerNames: [], requestTimeoutMs: 5000 },
}

const ATTEMPT: CronAttempt = { attempt_no: 1, wake_ms: 120, request_ms: 83, failure_kind: null, error_code: null, http_status: 200 }

describe('parseMethod', () => {
  it('accepts the two methods a cron request may use, in any case', () => {
    expect(parseMethod('get')).toBe('GET')
    expect(parseMethod(' Post ')).toBe('POST')
  })
  it('rejects anything else', () => {
    expect(() => parseMethod('DELETE')).toThrow(/must be GET\|POST/)
    expect(() => parseMethod('')).toThrow(/must be GET\|POST/)
  })
})

describe('parseTimeout', () => {
  it('parses a timeout inside the API bounds', () => {
    expect(parseTimeout('5000')).toBe(5000)
    expect(parseTimeout(' 300000 ')).toBe(300000)
  })
  it('rejects values outside 1000..300000 and non-integers', () => {
    expect(() => parseTimeout('999')).toThrow(/between 1000 and 300000/)
    expect(() => parseTimeout('300001')).toThrow(/between 1000 and 300000/)
    expect(() => parseTimeout('5s')).toThrow(/between 1000 and 300000/)
  })
  // Number() reads these as 5000 and 5000 — a timeout written in hex is a typo (the parsePort lesson).
  it('rejects non-decimal spellings Number() would have accepted', () => {
    expect(() => parseTimeout('0x1388')).toThrow(/between 1000 and 300000/)
    expect(() => parseTimeout('5e3')).toThrow(/between 1000 and 300000/)
  })
})

describe('parseRunLimit', () => {
  it('accepts a page the API will serve', () => {
    expect(parseRunLimit('1')).toBe(1)
    expect(parseRunLimit('100')).toBe(100)
  })
  it('rejects 0, oversized pages and junk', () => {
    expect(() => parseRunLimit('0')).toThrow(/1\.\.100/)
    expect(() => parseRunLimit('101')).toThrow(/1\.\.100/)
    expect(() => parseRunLimit('ten')).toThrow(/1\.\.100/)
  })
})

describe('parseHeader / parseHeaders', () => {
  it('splits on the FIRST = so a value may contain one', () => {
    expect(parseHeader('authorization=Bearer a=b==')).toEqual(['authorization', 'Bearer a=b=='])
  })
  it('allows an empty value but never an empty name', () => {
    expect(parseHeader('x-trace=')).toEqual(['x-trace', ''])
    expect(() => parseHeader('=value')).toThrow(/name=value/)
    expect(() => parseHeader('nope')).toThrow(/name=value/)
  })
  it('collects repeated flags', () => {
    expect(parseHeaders(['a=1', 'b=2'])).toEqual({ a: '1', b: '2' })
  })
  // Last-wins would silently drop one of two credentials an agent passed; the 401 would surface far
  // from the mistake. Header names are case-insensitive on the wire, so a case-varied repeat counts.
  it('refuses the same header twice, including in another case', () => {
    expect(() => parseHeaders(['a=1', 'a=2'])).toThrow(/given twice/)
    expect(() => parseHeaders(['X-Key=1', 'x-key=2'])).toThrow(/given twice/)
  })
})

describe('fmtUtc', () => {
  // A cron pinned to UTC does not keep a fixed local time: a localised column would read correctly
  // today and be an hour wrong after a DST change, for a schedule nobody touched.
  it('renders an instant as UTC with the marker visible, whatever the machine TZ is', () => {
    expect(fmtUtc('2026-09-18T03:00:00.000Z')).toBe('2026-09-18 03:00:00Z')
  })
  it('renders an absent time as a dash rather than a fake one', () => {
    expect(fmtUtc(null)).toBe('—')
    expect(fmtUtc(undefined)).toBe('—')
  })
  it('passes through anything it cannot parse rather than inventing a time', () => {
    expect(fmtUtc('soon')).toBe('soon')
  })
})

describe('targetLine', () => {
  it('prints an external target as its URL', () => {
    expect(targetLine({ kind: 'external', url: 'https://x.test/h' })).toBe('https://x.test/h')
  })
  it('names the service when the name is known, and falls back to the id when it is not', () => {
    const t = { kind: 'service', serviceId: 'svc1', path: '/cron' } as const
    expect(targetLine(t, 'api')).toBe('compute/api → /cron')
    expect(targetLine(t)).toBe('service svc1 → /cron')
  })
})

describe('jobListLine', () => {
  it('carries state, expression, the next UTC run, the target and the id', () => {
    expect(jobListLine(JOB)).toBe('nightly  [enabled]  0 3 * * *  next 2026-09-18 03:00:00Z  https://example.test/hook  job1')
  })
  it('shows a paused job as paused', () => {
    expect(jobListLine({ ...JOB, enabled: false })).toContain('[paused]')
  })
})

describe('jobShowLines', () => {
  it('lists header NAMES and says why there are no values', () => {
    const out = jobShowLines(JOB).join('\n')
    expect(out).toContain('x-api-key')
    expect(out).toMatch(/names only — values are encrypted at rest and never returned/)
  })
  it('says "(none)" rather than printing an empty header column', () => {
    expect(jobShowLines({ ...JOB, request: { method: 'GET', headerNames: [] } }).join('\n')).toContain('headers      (none)')
  })
  it('shows the revision an edit is conditioned on', () => {
    expect(jobShowLines(JOB).join('\n')).toContain('revision     4')
  })
  it('names the platform retry defaults when the job sets none', () => {
    expect(jobShowLines(JOB).join('\n')).toContain('platform 2, application 0')
  })
})

describe('runListLine', () => {
  it('shows the wake/request split and the HTTP status of the last attempt', () => {
    const line = runListLine({ run: RUN, attempts: [ATTEMPT] })
    expect(line).toContain('2026-09-17 03:00:00Z')
    expect(line).toContain('succeeded')
    expect(line).toContain('scheduled')
    expect(line).toContain('1 attempt')
    expect(line).toContain('wake 120ms  req 83ms')
    expect(line).toContain('http 200')
  })
  // A failure with no status never reached the target: naming the failure kind is what separates
  // "your endpoint said no" from "nothing was sent".
  it('names the failure kind when no response ever arrived', () => {
    const failed = { ...RUN, status: 'failed', platform_retry_count: 2 }
    const attempts: CronAttempt[] = [
      { attempt_no: 1, wake_ms: 30, request_ms: null, failure_kind: 'wake_failed', error_code: 'machine_unreachable', http_status: null },
      { attempt_no: 2, wake_ms: 40, request_ms: null, failure_kind: 'wake_failed', error_code: 'machine_unreachable', http_status: null },
    ]
    const line = runListLine({ run: failed, attempts })
    expect(line).toContain('2 attempts')
    expect(line).toContain('wake_failed (machine_unreachable)')
    expect(line).not.toContain('http ')
  })
  it('falls back to the retry counters when the attempts could not be read', () => {
    const line = runListLine({ run: { ...RUN, platform_retry_count: 1, application_retry_count: 1 }, attempts: null })
    expect(line).toContain('3 attempts')
    expect(line).toContain('wake ?  req ?')
  })
  it('reports a skipped run by its reason', () => {
    const line = runListLine({ run: { ...RUN, status: 'skipped', skip_reason: 'overlap' }, attempts: [] })
    expect(line).toContain('skipped: overlap')
  })
})

describe('previewLines', () => {
  it('prints the description and the next times as UTC', () => {
    const lines = previewLines('*/5 * * * *', { valid: true, description: 'every 5 minutes', next: ['2026-09-17T12:05:00.000Z'] })
    expect(lines[0]).toBe('*/5 * * * *  every 5 minutes  (UTC)')
    expect(lines[1]).toBe('  2026-09-17 12:05:00Z')
  })
  it('reports an invalid expression as the answer it is', () => {
    expect(previewLines('nope', { valid: false, error: 'expected 5 fields', description: '', next: [] })[0])
      .toBe('invalid cron expression: expected 5 fields')
  })
})

describe('assertTargetFlags', () => {
  it('requires a target on create and accepts either kind', () => {
    expect(() => assertTargetFlags({})).toThrow(/name a target/)
    expect(() => assertTargetFlags({ url: 'https://x.test/h' })).not.toThrow()
    expect(() => assertTargetFlags({ service: 'api', path: '/cron' })).not.toThrow()
  })
  it('allows an edit to name no target at all', () => {
    expect(() => assertTargetFlags({}, true)).not.toThrow()
  })
  it('refuses two targets, a path without a service, a relative URL and a path without a slash', () => {
    expect(() => assertTargetFlags({ url: 'https://x.test', service: 'api' })).toThrow(/pass one/)
    expect(() => assertTargetFlags({ url: 'https://x.test', path: '/cron' })).toThrow(/--path applies to --service/)
    expect(() => assertTargetFlags({ url: 'example.test/hook' })).toThrow(/absolute http\(s\) URL/)
    expect(() => assertTargetFlags({ service: 'api', path: 'cron' })).toThrow(/must start with \//)
  })
})

describe('buildRequest', () => {
  it('is undefined when no flag shaped a request, so the platform default stands', () => {
    expect(buildRequest({})).toBeUndefined()
  })
  it('defaults to GET, and to POST when a body is given', () => {
    expect(buildRequest({ header: ['a=1'] })).toEqual({ method: 'GET', headers: { a: '1' } })
    expect(buildRequest({ body: '{}' })).toEqual({ method: 'POST', body: '{}' })
  })
  // A body on a GET would be sent and ignored: the job would look healthy and do nothing.
  it('refuses a body on an explicit GET instead of sending one nothing will read', () => {
    expect(() => buildRequest({ body: '{}', method: 'GET' })).toThrow(/POST only/)
  })
})

describe('cronEditWarnings', () => {
  // The API replaces `request` wholesale and header values are write-only, so the CLI cannot merge
  // either — the one thing it must not do is drop a credential silently.
  it('names the headers an edit is about to drop', () => {
    const w = cronEditWarnings({ method: 'POST', headerNames: ['x-api-key', 'x-tenant'] }, { method: 'POST', headers: { 'x-tenant': 't' } })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('x-api-key')
    expect(w[0]).not.toContain('x-tenant')
  })
  it('says nothing when every stored header is re-supplied (case-insensitively)', () => {
    expect(cronEditWarnings({ method: 'GET', headerNames: ['X-Api-Key'] }, { method: 'GET', headers: { 'x-api-key': 'k' } })).toEqual([])
    expect(cronEditWarnings({ method: 'GET', headerNames: [] }, { method: 'POST' })).toEqual([])
  })
})

describe('conflictLines', () => {
  it('says the job moved, that nothing was written, and how to look', () => {
    const lines = conflictLines('nightly', 4, 'edit')
    expect(lines[0]).toContain('changed since revision 4')
    expect(lines[1]).toContain('nothing was written')
    expect(lines[1]).toContain('insta cron show nightly')
  })
})

// ---- command behaviour against a stubbed API (the two facts that carry real meaning) ----

type Call = { method: string; path: string; body?: unknown; headers?: Record<string, string> }

function stub(handlers: (c: Call) => { status: number; body: any }): { ctx: Resolved; calls: Call[] } {
  const calls: Call[] = []
  const record = async (method: string, path: string, body?: unknown, opts?: { headers?: Record<string, string> }) => {
    const call: Call = { method, path, body, headers: opts?.headers }
    calls.push(call)
    return handlers(call)
  }
  const api = {
    request: async (m: string, p: string, b?: unknown, o?: { headers?: Record<string, string> }) => (await record(m, p, b, o)).body,
    rawRequest: record,
  }
  return { ctx: { api, projectId: 'p1', branch: 'main' }, calls }
}

const listResponse = { status: 200, body: { jobs: [JOB] } }

describe('cron run (manual trigger)', () => {
  it('mints ONE Idempotency-Key for the invocation, so a replayed request cannot fire the job twice', async () => {
    const { ctx, calls } = stub((c) => (c.path.endsWith('/runs') ? { status: 202, body: { runId: 'run9' } } : listResponse))
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await cronRun('nightly', {}, ctx)
    } finally {
      log.mockRestore()
    }
    const trigger = calls.find((c) => c.method === 'POST')!
    expect(trigger.path).toBe('/projects/p1/cron-jobs/job1/runs')
    // The key travels as a header on the ONE call: the api client replays that same call (headers
    // included) after a 401 refresh, which is what makes the replay land on the same run.
    expect(trigger.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('gives a different key to a different invocation — a key is per trigger, not per job', async () => {
    const keys: string[] = []
    for (let i = 0; i < 2; i++) {
      const { ctx, calls } = stub((c) => (c.path.endsWith('/runs') ? { status: 202, body: { runId: 'run9' } } : listResponse))
      const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        await cronRun('nightly', {}, ctx)
      } finally {
        log.mockRestore()
      }
      keys.push(calls.find((c) => c.method === 'POST')!.headers!['Idempotency-Key']!)
    }
    expect(keys[0]).not.toBe(keys[1])
  })
})

describe('cron edit (If-Match)', () => {
  it('conditions the PATCH on the revision it just read', async () => {
    const { ctx, calls } = stub((c) => (c.method === 'PATCH' ? { status: 200, body: { job: { ...JOB, revision: 5 } } } : listResponse))
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await cronEdit('nightly', { expression: '*/5 * * * *' }, ctx)
    } finally {
      log.mockRestore()
    }
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.headers).toEqual({ 'If-Match': '4' })
    expect(patch.body).toEqual({ expression: '*/5 * * * *' })
  })

  // Re-reading and retrying is precisely how the other editor's change disappears.
  it('reports a 409 and writes nothing, instead of re-reading and clobbering', async () => {
    const { ApiError } = await import('../src/api.js')
    const calls: Call[] = []
    const api = {
      request: async (m: string, p: string) => { calls.push({ method: m, path: p }); return { jobs: [JOB] } },
      rawRequest: async (m: string, p: string) => {
        calls.push({ method: m, path: p })
        throw new ApiError(409, 'the job changed since that revision')
      },
    }
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const previousExit = process.exitCode
    try {
      await expect(cronEdit('nightly', { expression: '*/5 * * * *' }, { api, projectId: 'p1', branch: 'main' }))
        .rejects.toThrow(/CliExit|exit/i)
      const said = err.mock.calls.map((c) => String(c[0])).join('')
      expect(said).toContain('changed since revision 4')
      expect(said).toContain('nothing was written')
      // One PATCH, and no second read to "resolve" the conflict.
      expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
    } finally {
      err.mockRestore()
      process.exitCode = previousExit
    }
  })
})

describe('cron delete', () => {
  it('refuses without --yes and sends nothing', async () => {
    const { ctx, calls } = stub(() => listResponse)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const previousExit = process.exitCode
    try {
      await expect(cronDelete('nightly', {}, ctx)).rejects.toThrow()
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('--yes')
    } finally {
      err.mockRestore()
      process.exitCode = previousExit
    }
  })
  it('deletes by id once confirmed', async () => {
    const { ctx, calls } = stub((c) => (c.method === 'DELETE' ? { status: 200, body: { ok: true } } : listResponse))
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await cronDelete('nightly', { yes: true }, ctx)
    } finally {
      log.mockRestore()
    }
    expect(calls.find((c) => c.method === 'DELETE')!.path).toBe('/projects/p1/cron-jobs/job1')
  })
})

describe('resolveJob', () => {
  it('resolves the name the CLI addresses a job by', () => {
    expect(resolveJob([JOB], 'nightly').id).toBe('job1')
  })
  it('throws with the name that was asked for', () => {
    expect(() => resolveJob([JOB], 'hourly')).toThrow(/cron job not found: hourly/)
  })
})
