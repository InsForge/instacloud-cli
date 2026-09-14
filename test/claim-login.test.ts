// claimGrant drives the auth.md claim ceremony: register with service_auth, hand the human the link
// and the code, poll the token endpoint with the claim grant, re-mint once when the code lapses.
// Poster + wait are injected (repo pattern: DI fakes, no global mocks).
import { describe, expect, it } from 'vitest'
import { claimGrant, type ClaimPoster } from '../src/commands/auth.js'
import { ApiError } from '../src/api.js'

const GRANT = 'urn:workos:agent-auth:grant-type:claim'
const START = {
  registration_id: 'reg_1', claim_token: 'clm_1', claim_token_expires: new Date(Date.now() + 86_400_000).toISOString(),
  post_claim_scopes: [], claim_url: 'https://api.test/agent/auth/claim',
  claim: { user_code: '482913', expires_in: 600, verification_uri: 'https://console.test/claim?claim_attempt_token=cat_1', interval: 5 },
}
const REMINT = { registration_id: 'reg_1', claim_attempt_id: 'cla_2', status: 'initiated', expires_at: 'x', claim_attempt: { user_code: '101010', expires_in: 600, verification_uri: 'https://console.test/claim?claim_attempt_token=cat_2', interval: 5 } }

// polls: OAuth error codes (thrown as ApiError), 'http:<status>' for a bare limiter answer, or 'token:<key>'.
function fakeFlow(polls: string[], remint: Record<string, unknown> | ApiError = REMINT) {
  const waits: number[] = []
  const posts: Array<{ path: string; body: unknown }> = []
  const post: ClaimPoster = async (path, body) => {
    posts.push({ path, body })
    if (path === '/agent/auth') return START
    if (path === '/agent/auth/claim') { if (remint instanceof ApiError) throw remint; return remint }
    if (path === '/api/auth/oauth2/token') {
      const next = polls.shift()
      if (!next) throw new Error('poll after script ended')
      if (next.startsWith('token:')) return { access_token: next.slice('token:'.length), token_type: 'Bearer' }
      if (next.startsWith('http:')) { const s = Number(next.slice('http:'.length)); throw new ApiError(s, `HTTP ${s}`) }
      throw new ApiError(next === 'invalid_grant' ? 400 : 400, next)
    }
    throw new Error(`unexpected path ${path}`)
  }
  const wait = async (s: number) => { waits.push(s) }
  return { post, wait, waits, posts }
}

function stdoutLines(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((s: string) => { lines.push(String(s)); return true }) as typeof process.stdout.write
  return fn().finally(() => { process.stdout.write = write }).then(() => lines)
}

describe('claimGrant', () => {
  it('registers with service_auth, polls through pending, and returns the key', async () => {
    const { post, wait, waits, posts } = fakeFlow(['authorization_pending', 'authorization_pending', 'token:insta_abc'])
    await expect(claimGrant('me@example.com', 'claude-code', post, wait)).resolves.toBe('insta_abc')
    expect(posts[0]).toEqual({ path: '/agent/auth', body: { type: 'service_auth', login_hint: 'me@example.com', client: 'claude-code' } })
    expect(posts[1]).toEqual({ path: '/api/auth/oauth2/token', body: { grant_type: GRANT, claim_token: 'clm_1' } })
    expect(waits).toEqual([5, 5, 5])
  })

  it('backs off on slow_down and on a bare 429', async () => {
    const { post, wait, waits } = fakeFlow(['slow_down', 'http:429', 'authorization_pending', 'token:insta_x'])
    await expect(claimGrant('me@example.com', 'unknown', post, wait)).resolves.toBe('insta_x')
    expect(waits).toEqual([5, 10, 15, 15])
  })

  it('clamps a huge server-supplied interval instead of hot-polling', async () => {
    const hugeStart = { ...START, claim: { ...START.claim, interval: Number.MAX_VALUE } }
    const post: ClaimPoster = async (path) => {
      if (path === '/agent/auth') return hugeStart
      if (path === '/api/auth/oauth2/token') return { access_token: 'insta_x' }
      throw new Error(`unexpected path ${path}`)
    }
    const waits: number[] = []
    await expect(claimGrant('me@example.com', 'unknown', post, async (s) => { waits.push(s) })).resolves.toBe('insta_x')
    expect(waits).toEqual([3600])
  })

  it('clamps a zero interval up to 1s', async () => {
    const zeroStart = { ...START, claim: { ...START.claim, interval: 0 } }
    const post: ClaimPoster = async (path) => {
      if (path === '/agent/auth') return zeroStart
      if (path === '/api/auth/oauth2/token') return { access_token: 'insta_x' }
      throw new Error(`unexpected path ${path}`)
    }
    const waits: number[] = []
    await expect(claimGrant('me@example.com', 'unknown', post, async (s) => { waits.push(s) })).resolves.toBe('insta_x')
    expect(waits).toEqual([1])
  })

  it('falls back to 5s when the interval is missing or NaN', async () => {
    const { user_code, expires_in, verification_uri } = START.claim
    const noIntervalStart = { ...START, claim: { user_code, expires_in, verification_uri } }
    const post: ClaimPoster = async (path) => {
      if (path === '/agent/auth') return noIntervalStart
      if (path === '/api/auth/oauth2/token') return { access_token: 'insta_x' }
      throw new Error(`unexpected path ${path}`)
    }
    const waits: number[] = []
    await expect(claimGrant('me@example.com', 'unknown', post, async (s) => { waits.push(s) })).resolves.toBe('insta_x')
    expect(waits).toEqual([5])
  })

  it('clamps a negative re-mint interval up to 1s', async () => {
    const remint = { registration_id: 'reg_1', claim_attempt_id: 'cla_4', status: 'initiated', expires_at: 'x', claim_attempt: { user_code: '404040', expires_in: 600, verification_uri: 'https://console.test/claim?claim_attempt_token=cat_4', interval: -3 } }
    const { post, wait, waits } = fakeFlow(['expired_token', 'token:insta_new'], remint)
    await expect(claimGrant('me@example.com', 'unknown', post, wait)).resolves.toBe('insta_new')
    expect(waits[1]).toBe(1)
  })

  it('prints the link and code once, opens the browser only when asked', async () => {
    const opened: string[] = []
    const { post, wait } = fakeFlow(['token:insta_x'])
    const lines = await stdoutLines(() => claimGrant('me@example.com', 'codex', post, wait, (u) => { opened.push(u); return true }))
    const out = lines.join('')
    expect(out).toContain('sign in as me@example.com')
    expect(out).toContain('482913')
    expect(out).toContain('https://console.test/claim?claim_attempt_token=cat_1')
    expect(opened).toEqual(['https://console.test/claim?claim_attempt_token=cat_1'])
    const silent: string[] = []
    const second = fakeFlow(['token:insta_y'])
    await stdoutLines(() => claimGrant('me@example.com', 'codex', second.post, second.wait, (u) => { silent.push(u); return true }))
    expect(silent).toHaveLength(1)
    const noOpen = fakeFlow(['token:insta_z'])
    const openedNone: string[] = []
    await claimGrant('me@example.com', 'codex', noOpen.post, noOpen.wait)
    expect(openedNone).toEqual([])
  })

  it('re-mints once on expired_token, prints the new code, then gives up on the second expiry', async () => {
    const { post, wait, posts } = fakeFlow(['expired_token', 'authorization_pending', 'token:insta_new'])
    const lines = await stdoutLines(() => claimGrant('me@example.com', 'unknown', post, wait))
    expect(lines.join('')).toContain('101010')
    expect(posts.some((p) => p.path === '/agent/auth/claim' && JSON.stringify(p.body) === JSON.stringify({ claim_token: 'clm_1', email: 'me@example.com' }))).toBe(true)
    const twice = fakeFlow(['expired_token', 'expired_token'])
    await expect(claimGrant('me@example.com', 'unknown', twice.post, twice.wait)).rejects.toThrow(/expired before me@example.com confirmed/)
  })

  it('treats claim_expired from the re-mint as the request expiring', async () => {
    const { post, wait } = fakeFlow(['expired_token'], new ApiError(410, 'claim_expired'))
    await expect(claimGrant('me@example.com', 'unknown', post, wait)).rejects.toThrow(/expired before me@example.com confirmed/)
  })

  it('surfaces a definite grant error and a malformed start', async () => {
    const { post, wait } = fakeFlow(['invalid_grant'])
    await expect(claimGrant('me@example.com', 'unknown', post, wait)).rejects.toThrow('invalid_grant')
    const bad: ClaimPoster = async () => ({ registration_id: 'reg_1' })
    await expect(claimGrant('me@example.com', 'unknown', bad, async () => {})).rejects.toThrow(/malformed registration response/)
  })

  it('a re-mint honours the fresh interval and opens the browser again', async () => {
    const opened: string[] = []
    const remint = { registration_id: 'reg_1', claim_attempt_id: 'cla_3', status: 'initiated', expires_at: 'x', claim_attempt: { user_code: '202020', expires_in: 600, verification_uri: 'https://console.test/claim?claim_attempt_token=cat_3', interval: 7 } }
    const { post, wait, waits } = fakeFlow(['expired_token', 'authorization_pending', 'token:insta_new'], remint)
    await expect(claimGrant('me@example.com', 'unknown', post, wait, (u) => { opened.push(u); return true })).resolves.toBe('insta_new')
    expect(waits[1]).toBe(7) // the poll right after the re-mint paces to its fresh interval, not the stale slow_down backoff
    expect(opened).toEqual(['https://console.test/claim?claim_attempt_token=cat_1', 'https://console.test/claim?claim_attempt_token=cat_3'])
  })

  it('rejects a re-mint missing verification_uri', async () => {
    const badRemint = { registration_id: 'reg_1', claim_attempt: { user_code: '303030', expires_in: 600, interval: 5 } }
    const { post, wait } = fakeFlow(['expired_token'], badRemint)
    await expect(claimGrant('me@example.com', 'unknown', post, wait)).rejects.toThrow(/malformed claim response/)
  })

  it('gives every poll — the token poll and the re-mint — an AbortSignal', async () => {
    const seen: Array<{ path: string; signal: unknown }> = []
    let polled = 0
    const post: ClaimPoster = async (path, _body, signal) => {
      seen.push({ path, signal })
      if (path === '/agent/auth') return START
      if (path === '/agent/auth/claim') return REMINT
      if (path === '/api/auth/oauth2/token') {
        polled += 1
        if (polled === 1) throw new ApiError(400, 'expired_token')
        return { access_token: 'insta_done' }
      }
      throw new Error(`unexpected path ${path}`)
    }
    await claimGrant('me@example.com', 'unknown', post, async () => {})
    const polls = seen.filter((s) => s.path !== '/agent/auth')
    expect(polls.length).toBeGreaterThan(0)
    for (const p of polls) expect(p.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps polling through a poll timeout, and expires once the deadline passes', async () => {
    let t = 0
    const now = () => t
    const shortStart = { ...START, claim_token_expires: new Date(30).toISOString() }
    let polled = 0
    const post: ClaimPoster = async (path) => {
      if (path === '/agent/auth') return shortStart
      if (path === '/api/auth/oauth2/token') {
        polled += 1
        const e = new Error('the operation timed out'); e.name = 'TimeoutError'
        throw e
      }
      throw new Error(`unexpected path ${path}`)
    }
    const wait = async (s: number) => { t += s }
    await expect(claimGrant('me@example.com', 'unknown', post, wait, undefined, now)).rejects.toThrow(/expired before me@example.com confirmed/)
    expect(polled).toBeGreaterThan(1) // a timeout alone must not end the attempt before the deadline
  })

  it('a re-mint that times out is asked again on the next expired_token', async () => {
    const { post: scripted, wait, posts } = fakeFlow(['expired_token', 'expired_token', 'authorization_pending', 'token:insta_new'])
    let remints = 0
    const post: ClaimPoster = async (path, body, signal) => {
      if (path === '/agent/auth/claim' && remints++ === 0) { const e = new Error('the operation timed out'); e.name = 'TimeoutError'; throw e }
      return scripted(path, body, signal)
    }
    const lines = await stdoutLines(() => claimGrant('me@example.com', 'unknown', post, wait))
    expect(lines.join('')).toContain('101010')
    expect(remints).toBe(2) // the timed-out re-mint did not count as the one allowed re-mint
    expect(posts.filter((p) => p.path === '/agent/auth/claim')).toHaveLength(1) // only the successful one reached the scripted poster
  })
})
