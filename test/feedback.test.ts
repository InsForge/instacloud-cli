import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPayload, feedback, feedbackStatus, submit } from '../src/commands/feedback.js'
import { ApiError } from '../src/api.js'
import { clean, redactSensitive, truncateMiddle } from '../src/redact.js'

const valid = {
  type: 'bug',
  component: 'cli',
  title: 'deploy drops --branch',
  detail: 'insta deploy --branch feat ignored the flag and deployed to main',
}

function fetchOk(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function controlPlane(opts: { apiUrl?: string; signedIn?: boolean; answer?: () => Promise<unknown> } = {}) {
  const asked: string[] = []
  const requestOpts: unknown[] = []
  const apiUrl = opts.apiUrl ?? 'https://api.instacloud.com'
  const api = {
    apiUrl,
    config: { apiUrl, ...(opts.signedIn === false ? {} : { accessToken: 'session' }) },
    request: (async (method: string, path: string, _body: unknown, o: unknown) => {
      asked.push(`${method} ${path}`)
      requestOpts.push(o)
      return (opts.answer ?? (async () => ({ token: 'platform.signed.token' })))()
    }) as any,
  }
  return { api, asked, requestOpts }
}

describe('buildPayload', () => {
  it('assembles context and defaults severity', async () => {
    const p = await buildPayload(valid, { cliVersion: '9.9.9' })
    expect(p.severity).toBe('minor')
    expect(p.source).toBe('cli')
    expect(p.client_version).toBe('9.9.9')
    expect(p.node_version).toBe(process.version)
    expect(typeof p.os).toBe('string')
  })

  it('rejects bad enums with a self-teaching message (non-interactive agents read this)', async () => {
    await expect(buildPayload({ ...valid, type: 'complaint' }, { cliVersion: 'x' })).rejects.toThrow(
      /--type must be one of: bug, feature-request, friction, other/,
    )
    await expect(buildPayload({ ...valid, component: 'sdk' }, { cliVersion: 'x' })).rejects.toThrow(
      /--component must be one of: cli, mcp, platform, skills, docs, other/,
    )
    await expect(buildPayload({ ...valid, severity: 'urgent' }, { cliVersion: 'x' })).rejects.toThrow(
      /--severity must be one of/,
    )
  })

  it('requires title and detail', async () => {
    await expect(buildPayload({ ...valid, title: '  ' }, { cliVersion: 'x' })).rejects.toThrow(/--title is required/)
    await expect(buildPayload({ ...valid, detail: undefined }, { cliVersion: 'x' })).rejects.toThrow(
      /--detail \(or --file <path>\) is required/,
    )
  })

  it('redacts PII in free-text fields before they leave the machine', async () => {
    const token = 'insta_' + 'a1b2c3d4'.repeat(4)
    const p = await buildPayload(
      { ...valid, error: `login failed for jane@example.com using ${token} at /Users/jane/repo` },
      { cliVersion: 'x' },
    )
    expect(p.error).not.toContain('jane@example.com')
    expect(p.error).not.toContain(token)
    expect(p.error).toContain('[REDACTED_EMAIL]')
    expect(p.error).toContain('[REDACTED_KEY]')
    expect(p.error).toContain('~/repo')
  })

  it('does NOT redact MCP tool names sharing the insta_ prefix', async () => {
    const p = await buildPayload(
      { ...valid, error: 'insta_feedback and insta_storage_download_url returned invalid_request' },
      { cliVersion: 'x' },
    )
    expect(p.error).toContain('insta_feedback')
    expect(p.error).toContain('insta_storage_download_url')
  })

  it('--file reads text, rejects oversized and binary files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-feedback-'))
    const textFile = join(dir, 'detail.txt')
    writeFileSync(textFile, 'deploy failed with exit 1')
    const p = await buildPayload({ ...valid, detail: undefined, file: textFile }, { cliVersion: 'x' })
    expect(p.detail).toBe('deploy failed with exit 1')

    const bigFile = join(dir, 'big.log')
    writeFileSync(bigFile, 'x'.repeat(300 * 1024))
    await expect(buildPayload({ ...valid, detail: undefined, file: bigFile }, { cliVersion: 'x' })).rejects.toThrow(
      /max 262144.*trim the file/,
    )

    const binFile = join(dir, 'blob.bin')
    writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    await expect(buildPayload({ ...valid, detail: undefined, file: binFile }, { cliVersion: 'x' })).rejects.toThrow(
      /looks binary/,
    )

    await expect(buildPayload({ ...valid, detail: undefined, file: dir }, { cliVersion: 'x' })).rejects.toThrow(
      /not a regular file/,
    )
  })

  it('caps over-long fields with middle truncation', async () => {
    const p = await buildPayload({ ...valid, detail: 'a'.repeat(3000) + 'z'.repeat(3000) }, { cliVersion: 'x' })
    const detail = p.detail as string
    expect(detail.length).toBeLessThan(4100)
    expect(detail).toContain('chars truncated')
    expect(detail.startsWith('aaa')).toBe(true)
    expect(detail.endsWith('zzz')).toBe(true)
  })
})

describe('submit', () => {
  it('POSTs the payload with the public ingest token', async () => {
    const { fetchImpl, calls } = fetchOk({ id: 'f-1', status: 'received' })
    const result = await submit({ a: 1 }, fetchImpl)
    expect(result).toEqual({ status: 'received', id: 'f-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ a: 1 })
  })

  it('carries the ticket a signed report opened', async () => {
    const ticket = { id: 'st-1', url: 'https://console.instacloud.com/support/st-1' }
    const { fetchImpl } = fetchOk({ id: 'f-1', status: 'received', ticket })
    expect(await submit({}, fetchImpl)).toEqual({ status: 'received', id: 'f-1', ticket })
  })

  it('maps duplicate folding', async () => {
    const { fetchImpl } = fetchOk({ id: 'f-1', status: 'duplicate' })
    expect(await submit({}, fetchImpl)).toEqual({ status: 'duplicate', id: 'f-1' })
  })

  it('returns server errors as a result, never throws (429, 500)', async () => {
    const { fetchImpl } = fetchOk({ error: 'rate limit exceeded: max 20 reports per hour' }, 429)
    expect(await submit({}, fetchImpl)).toEqual({
      status: 'error',
      error: 'rate limit exceeded: max 20 reports per hour',
    })
  })

  it('returns network failures as a result, never throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    const result = await submit({}, fetchImpl)
    expect(result.status).toBe('error')
    expect((result as { error: string }).error).toContain('ENOTFOUND')
  })

  it('a timeout is UNCONFIRMED, not an error — the server finishes in-flight requests', async () => {
    const fetchImpl = (async () => {
      const e = new Error('aborted')
      e.name = 'TimeoutError'
      throw e
    }) as unknown as typeof fetch
    const result = await submit({}, fetchImpl)
    expect(result.status).toBe('unconfirmed')
    expect((result as { error: string }).error).toContain('may have been recorded')
  })
})

describe('feedback command', () => {
  afterEach(() => {
    process.exitCode = 0
  })

  it('non-interactive + missing required flags throws instead of prompting (agents must never hang)', async () => {
    await expect(feedback({ title: 'x' }, { interactive: false, cliVersion: 'x', api: controlPlane().api })).rejects.toThrow(
      /--type must be one of/,
    )
  })

  it('--json validation errors stay machine-readable: JSON on stdout + exit code 1, no throw', async () => {
    await expect(feedback({ title: 'x', json: true }, { interactive: false, cliVersion: 'x', api: controlPlane().api })).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
  })

  it('a failed submission does not throw — feedback must never fail the main task', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(feedback({ ...valid, json: true }, { interactive: false, cliVersion: 'x', fetchImpl, api: controlPlane().api })).resolves.toBeUndefined()
  })

  it('an unconfirmed timeout does not throw either', async () => {
    const fetchImpl = (async () => {
      const e = new Error('aborted')
      e.name = 'TimeoutError'
      throw e
    }) as unknown as typeof fetch
    await expect(feedback({ ...valid, json: true }, { interactive: false, cliVersion: 'x', fetchImpl, api: controlPlane().api })).resolves.toBeUndefined()
    expect(process.exitCode ?? 0).toBe(0)
  })
})

describe('who is sending', () => {
  afterEach(() => {
    process.exitCode = 0
    vi.restoreAllMocks()
  })
  const run = (plane: ReturnType<typeof controlPlane>, fetchImpl: typeof fetch, opts = valid) =>
    feedback({ ...opts, json: true }, { interactive: false, cliVersion: 'x', fetchImpl, api: plane.api })
  const sent = (calls: Array<{ init: RequestInit }>) => calls[0]?.init.headers as Record<string, string> | undefined

  it('proves a signed-in cloud user with a token from the control plane', async () => {
    const plane = controlPlane()
    const { fetchImpl, calls } = fetchOk({ id: 'f-1', status: 'received' })
    await run(plane, fetchImpl)
    expect(plane.asked).toEqual(['GET /me/feedback-assertion'])
    expect(plane.requestOpts[0]).toMatchObject({ evidence: false, signal: expect.any(AbortSignal) })
    expect(sent(calls)?.['Insta-User-Assertion']).toBe('platform.signed.token')
  })

  it('refuses a signed-out cloud user, and staging, with exit 2, before sending anything', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    for (const plane of [
      controlPlane({ signedIn: false }),
      controlPlane({ answer: async () => { throw new ApiError(401, 'invalid token') } }),
      controlPlane({ apiUrl: 'https://api.staging.instacloud.com' }),
    ]) {
      out.mockClear()
      process.exitCode = 0
      const { fetchImpl, calls } = fetchOk({ id: 'f-1', status: 'received' })
      await expect(run(plane, fetchImpl)).rejects.toThrow('exit 1')
      expect(process.exitCode).toBe(2)
      expect(calls).toHaveLength(0)
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'refused', submitted: false })
    }
  })

  it('refuses a signed-out user before validating their input', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(run(controlPlane({ signedIn: false }), fetchOk({}).fetchImpl, { title: 'x' } as typeof valid)).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(2)
  })

  it('hands back the ticket the report opened, with its console link', async () => {
    const ticket = { id: 'st-1', url: 'https://console.instacloud.com/support/st-1' }
    const o = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run(controlPlane(), fetchOk({ id: 'f-1', status: 'received', ticket }).fetchImpl)
    expect(JSON.parse(String(o.mock.calls.at(-1)?.[0]))).toEqual({ status: 'received', id: 'f-1', ticket })
    o.mockClear()
    await feedback(valid, { interactive: false, cliVersion: 'x', fetchImpl: fetchOk({ id: 'f-1', status: 'received', ticket }).fetchImpl, api: controlPlane().api })
    const printed = o.mock.calls.map((c) => String(c[0])).join('')
    expect(printed).toContain(ticket.url)
    expect(printed).toContain('insta feedback status st-1')
  })

  it('still sends when the control plane cannot vouch, just without a token, and says so', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { fetchImpl, calls } = fetchOk({ id: 'f-1', status: 'received' })
    await run(controlPlane({ answer: async () => { throw new ApiError(503, 'unavailable') } }), fetchImpl)
    expect(calls).toHaveLength(1)
    expect(sent(calls)).not.toHaveProperty('Insta-User-Assertion')
    expect(String(err.mock.calls[0]?.[0])).toMatch(/could not confirm who you are/)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('never asks a self-hosted control plane, signed in or not', async () => {
    for (const signedIn of [true, false]) {
      const plane = controlPlane({ apiUrl: 'https://insta.example.internal', signedIn })
      const { fetchImpl, calls } = fetchOk({ id: 'f-1', status: 'received' })
      await run(plane, fetchImpl)
      expect(plane.asked).toEqual([])
      expect(calls).toHaveLength(1)
      expect(sent(calls)).not.toHaveProperty('Insta-User-Assertion')
    }
  })
})

describe('feedback status', () => {
  const TICKET = '3f2b6c1e-9a4d-4e8b-b1c2-7d5e6f8a9b0c'
  const URL_ = `https://console.instacloud.com/support/${TICKET}`
  afterEach(() => {
    process.exitCode = 0
    vi.restoreAllMocks()
  })
  const out = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

  it('asks the feedback service, as the signed-in user, and names the status', async () => {
    const plane = controlPlane()
    const { fetchImpl, calls } = fetchOk({ id: TICKET, status: 'in_progress', url: URL_ })
    const o = out()
    await feedbackStatus(TICKET, {}, { fetchImpl, api: plane.api })
    expect(plane.asked).toEqual(['GET /me/feedback-assertion'])
    expect(calls[0]!.url).toBe(`https://feedback.instacloud.com/v1/tickets/${TICKET}`)
    expect(calls[0]!.init.method ?? 'GET').toBe('GET')
    expect(calls[0]!.init).toMatchObject({
      headers: { Authorization: 'Bearer insta-feedback-public-v1', 'Insta-User-Assertion': 'platform.signed.token' },
      signal: expect.any(AbortSignal),
    })
    const printed = o.mock.calls.map((c) => String(c[0])).join('')
    expect(printed).toContain('In Progress')
    expect(printed).toContain(URL_)
  })

  it('--json prints the service answer as one object', async () => {
    const o = out()
    await feedbackStatus(TICKET, { json: true }, { fetchImpl: fetchOk({ id: TICKET, status: 'resolved', url: URL_ }).fetchImpl, api: controlPlane().api })
    expect(JSON.parse(String(o.mock.calls.at(-1)?.[0]))).toEqual({ id: TICKET, status: 'resolved', url: URL_ })
  })

  it('refuses staging, a self-hosted plane and a signed-out user with one refusal and exit 2', async () => {
    const o = out()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    for (const plane of [
      controlPlane({ apiUrl: 'https://api.staging.instacloud.com' }),
      controlPlane({ apiUrl: 'https://insta.example.internal' }),
      controlPlane({ signedIn: false }),
      controlPlane({ answer: async () => { throw new ApiError(401, 'invalid token') } }),
    ]) {
      o.mockClear()
      process.exitCode = 0
      const { fetchImpl, calls } = fetchOk({})
      await expect(feedbackStatus(TICKET, { json: true }, { fetchImpl, api: plane.api })).rejects.toThrow('exit 1')
      expect(process.exitCode).toBe(2)
      expect(calls).toHaveLength(0)
      expect(o.mock.calls).toHaveLength(1)
      expect(JSON.parse(String(o.mock.calls[0]?.[0]))).toMatchObject({ status: 'refused' })
    }
  })

  it('fails with exit 1 on a gateway error page, naming the answer', async () => {
    const o = out()
    const fetchImpl = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch
    await feedbackStatus(TICKET, { json: true }, { fetchImpl, api: controlPlane().api })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(o.mock.calls.at(-1)?.[0]))).toEqual({ status: 'error', error: 'the feedback service answered 502' })
  })

  it('does not tell a signed-in user to sign in when the service cannot verify them', async () => {
    const o = out()
    await feedbackStatus(TICKET, { json: true }, { fetchImpl: fetchOk({ error: 'sign in to see your tickets' }, 401).fetchImpl, api: controlPlane().api })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(o.mock.calls.at(-1)?.[0])).error).toMatch(/could not verify who you are/)
  })

  it('fails with exit 1 on a ticket that is not theirs, saying which id to use', async () => {
    const o = out()
    await feedbackStatus(TICKET, { json: true }, { fetchImpl: fetchOk({ error: 'not found' }, 404).fetchImpl, api: controlPlane().api })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(o.mock.calls.at(-1)?.[0])).error).toMatch(/no ticket .* of yours/)
  })
})

describe('redact', () => {
  it('scrubs JWTs, bearer tokens, URL credentials', () => {
    const out = redactSensitive(
      'postgres://admin:hunter2@db.example.com Bearer abc123def456 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef',
    )
    expect(out).toContain('postgres://[REDACTED]@')
    expect(out).toContain('Bearer [REDACTED]')
    expect(out).toContain('[REDACTED_JWT]')
    expect(out).not.toContain('hunter2')
  })

  it('redacts real insta_ tokens but keeps insta_* tool names', () => {
    const out = redactSensitive(`insta_deploy failed with token insta_${'x'.repeat(30)}`)
    expect(out).toContain('insta_deploy')
    expect(out).toContain('[REDACTED_KEY]')
    expect(out).not.toContain('x'.repeat(30))
  })

  it('keeps private IPs, redacts public ones', () => {
    const out = redactSensitive('from 127.0.0.1 and 192.168.0.10 to 34.120.9.1')
    expect(out).toContain('127.0.0.1')
    expect(out).toContain('192.168.0.10')
    expect(out).toContain('[REDACTED_IP]')
    expect(out).not.toContain('34.120.9.1')
  })

  it('clean trims, redacts, then truncates in that order', () => {
    expect(clean('   ', 100)).toBeUndefined()
    expect(clean(undefined, 100)).toBeUndefined()
    const long = 'jane@example.com ' + 'x'.repeat(300)
    expect(clean(long, 50)).toContain('[REDACTED_EMAIL]')
  })

  it('truncateMiddle marks the removed span', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc')
    expect(truncateMiddle('a'.repeat(200), 50)).toContain('chars truncated')
  })
})
