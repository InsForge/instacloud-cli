import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ApiClient, ApiError, linkedProject } from '../api.js'
import { readGlobal, readPersistedGlobal } from '../config.js'
import { agentMode } from '../agent.js'
import { ENVS, ENV_NAMES, envForApiUrl, isEnvName, normalizeUrl } from '../env.js'
import { info, die, printJson, promptPassword, openUrl } from '../util.js'

/** --api-url and --env both set the target host; --api-url wins (more specific), matching the
 *  INSTA_API_URL > INSTA_ENV precedence in config.ts. Returns the URL to point at, or undefined
 *  to leave whatever is already resolved alone.
 *
 *  Every login entry point feeds this into `api.setApiUrl(targetApiUrl(opts) ?? api.apiUrl)`: a
 *  login is the one command that MAY move the machine's stored control-plane URL, and it must
 *  store the deployment it actually authenticated against — flag, env var or stored URL alike.
 *  Without the explicit set, ApiClient.persist() keeps the URL already on disk (see its comment),
 *  which would file a session minted on one deployment under another one's URL. */
function targetApiUrl(opts: { apiUrl?: string; env?: string }): string | undefined {
  if (opts.apiUrl) return opts.apiUrl
  if (!opts.env) return undefined
  const want = opts.env.trim().toLowerCase()
  if (!isEnvName(want)) die(`unknown --env "${opts.env}" — expected one of: ${ENV_NAMES.join(', ')}`)
  return ENVS[want].api
}

// `device`/`claim` are injectable so the dispatch itself is testable (repo pattern: DI fakes, no mocks).
export async function login(
  opts: { email?: string; password?: string; apiUrl?: string; env?: string; oauth?: string; device?: boolean; apiKey?: string; claim?: string },
  device: typeof loginDevice = loginDevice,
  claim: typeof loginClaim = loginClaim,
): Promise<void> {
  // Login modes are exclusive — pick one. Check presence (not truthiness) so an explicit
  // empty --api-key= is rejected by validation rather than silently falling through.
  if (opts.apiKey !== undefined) {
    if (opts.device || opts.oauth !== undefined || opts.email !== undefined || opts.claim !== undefined || opts.password !== undefined || process.env.INSTA_PASSWORD !== undefined) die('choose one login mode: --api-key, --claim, --device, --oauth, or --email')
    return loginApiKey(opts.apiKey, opts)
  }
  if (opts.claim !== undefined) {
    if (opts.device || opts.oauth !== undefined || opts.email !== undefined || opts.password !== undefined || process.env.INSTA_PASSWORD !== undefined) die('choose one login mode: --api-key, --claim, --device, --oauth, or --email (a password belongs to --email)')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opts.claim)) die('--claim needs an email address: the account that will authorize this agent')
    // The human types the code on the console; open it here only when a browser is on this machine.
    return claim(opts.claim, opts, agentMode() ? undefined : openUrl)
  }
  if (opts.device) return device(opts)
  if (opts.oauth) return loginOauth(opts.oauth, opts)
  // An explicitly empty --email is a mistake, not a request for the bare browser flow.
  if (opts.email === '') die('--email must not be empty')
  if (!opts.email) {
    // Bare `insta login` = sign in from the browser. The device grant is the one flow that covers
    // every account type (email, GitHub, Google): the console approval page owns the signin
    // round-trip, so the CLI just opens it here instead of only printing the link.
    if (opts.password !== undefined || process.env.INSTA_PASSWORD !== undefined) die('a password (--password / $INSTA_PASSWORD) is only used with --email <email>')
    return device(opts, openUrl)
  }
  const api = await ApiClient.load()
  api.setApiUrl(targetApiUrl(opts) ?? api.apiUrl)
  const password = opts.password ?? process.env.INSTA_PASSWORD ?? (await promptPassword())
  const res = await api.request('POST', '/auth/login', { email: opts.email, password }, { auth: false })
  api.setSession(res, res.user)
  await api.persist()
  info(`logged in as ${res.user.email ?? res.user.id} @ ${api.apiUrl}`)
}

// Browser OAuth (GitHub/Google) via a loopback listener. We open the platform's CLI-OAuth bridge,
// which runs Better Auth's social flow and bounces the resulting session token back to us.
export async function loginOauth(provider: string, opts: { apiUrl?: string; env?: string }): Promise<void> {
  if (provider !== 'github' && provider !== 'google') die('provider must be github or google')
  const api = await ApiClient.load()
  api.setApiUrl(targetApiUrl(opts) ?? api.apiUrl)
  const token = await browserOauth(api.apiUrl, provider)
  api.setSession({ accessToken: token, refreshToken: token })
  const me = await api.request<{ user: { id: string; email: string | null; name: string | null } }>('GET', '/me')
  api.setSession({ accessToken: token, refreshToken: token }, me.user)
  await api.persist()
  info(`logged in as ${me.user.email ?? me.user.id} @ ${api.apiUrl}`)
}

// RFC 8628 device authorization — the default login (bare `insta login` passes `open` to also
// launch the browser here), and as --device the flow for a machine with no usable browser (VM,
// SSH box, CI container), where the loopback --oauth flow can never work: its callback targets
// 127.0.0.1 on THIS machine. We mint a code, hand the human a link to the console approval page
// (which owns the signin round-trip), and poll the platform until they approve.
export async function loginDevice(opts: { apiUrl?: string; env?: string }, open?: (url: string) => boolean): Promise<void> {
  const api = await ApiClient.load()
  api.setApiUrl(targetApiUrl(opts) ?? api.apiUrl)
  const token = await deviceGrant((path, body) => api.request('POST', path, body, { auth: false }), sleepSeconds, open)
  api.setSession({ accessToken: token, refreshToken: token })
  const me = await api.request<{ user: { id: string; email: string | null; name: string | null } }>('GET', '/me')
  api.setSession({ accessToken: token, refreshToken: token }, me.user)
  await api.persist()
  info(`logged in as ${me.user.email ?? me.user.id} @ ${api.apiUrl}`)
}

// `insta login --claim <email>`: the auth.md user claimed flow. The named user confirms a code on
// the console, the platform mints an insta_ key, and it is stored exactly as --api-key stores one.
export async function loginClaim(email: string, opts: { apiUrl?: string; env?: string }, open?: (url: string) => boolean, grant: typeof claimGrant = claimGrant): Promise<void> {
  const api = await ApiClient.load()
  api.setApiUrl(targetApiUrl(opts) ?? api.apiUrl)
  const client = agentMode()?.client ?? 'unknown'
  const key = await grant(email, client, (path, body, signal) => api.request('POST', path, body, { auth: false, signal }), sleepSeconds, open)
  const user = await applyApiKeyLogin(api, key)
  await api.persist()
  info(`logged in as ${user.email ?? user.id} @ ${api.apiUrl}`)
}

// Non-interactive login with a durable insta_ key (minted via POST /tokens): store it and confirm against /me. No browser, no polling.
export async function loginApiKey(key: string, opts: { apiUrl?: string; env?: string }): Promise<void> {
  const api = await ApiClient.load()
  api.setApiUrl(targetApiUrl(opts) ?? api.apiUrl)
  const user = await applyApiKeyLogin(api, key)
  await api.persist()
  info(`logged in as ${user.email ?? user.id} @ ${api.apiUrl}`)
}

export type AuthedUser = { id: string; email: string | null; name: string | null }

// The client surface applyApiKeyLogin needs — ApiClient in prod, faked in tests.
export type ApiKeyClient = {
  request: (method: string, path: string, body?: unknown, opts?: { evidence?: boolean }) => Promise<any>
  setApiKey: (token: string, user?: AuthedUser, agentCredential?: boolean) => void
}

// Verify an insta_ key with a bare /me probe (an agent-minted key cannot enroll a session, and /me says which kind this is), then store it with the user and that kind.
export async function applyApiKeyLogin(client: ApiKeyClient, key: string): Promise<AuthedUser> {
  key = key.trim() // tolerate a trailing newline / stray whitespace from `--api-key "$(cat token)"`
  if (!key.startsWith('insta_')) throw new Error('--api-key expects an insta_ token (mint one with POST /tokens)')
  client.setApiKey(key)
  let me: { user?: AuthedUser; agentCredential?: boolean }
  try {
    me = await client.request('GET', '/me', undefined, { evidence: false })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw new Error('that insta_ API key was rejected (invalid or revoked) — check it or mint a new one')
    throw e
  }
  if (!me?.user) throw new Error('unexpected response while verifying the API key')
  client.setApiKey(key, me.user, me.agentCredential === true)
  return me.user
}

// RFC 8628 §3.2: verification_uri_complete and interval are OPTIONAL in the authorization
// response, so don't trust either arithmetically without a fallback.
type DeviceStart = {
  device_code: string; user_code: string; verification_uri: string
  verification_uri_complete?: string; expires_in: number; interval?: number
}

export type DevicePoster = (path: string, body: Record<string, unknown>) => Promise<any>

const sleepSeconds = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000))

// Drives the device grant against the platform's Better Auth mount (/api/auth/device*) and
// returns the approved session token. Injectable poster + wait keep this testable without a
// network or real timers. Poll errors arrive as ApiError with the OAuth error code as message
// (or a bare `HTTP 429` from the platform's rate limiter, treated as slow_down).
// `open` (the default browser-login path) launches the verification link locally on top of
// printing it; without it (--device) the link is print-only, for a browser on another machine.
export async function deviceGrant(post: DevicePoster, wait: (s: number) => Promise<void> = sleepSeconds, open?: (url: string) => boolean): Promise<string> {
  const start = (await post('/api/auth/device/code', { client_id: 'insta-cli' })) as DeviceStart
  // A missing/garbage expires_in must fail loudly here — carried into the deadline arithmetic it
  // becomes NaN, every `Date.now() < deadline` is false, and login dies as a bogus instant expiry.
  // Cap the lifetime too: a huge-but-finite value (Number.MAX_VALUE) overflows the ms conversion
  // to Infinity and would otherwise pin the CLI polling forever.
  const expiresIn = Number(start.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('malformed device authorization response (missing expires_in) — is the platform up to date?')
  }
  const lifetime = Math.min(expiresIn, 3600) // no device code sensibly outlives an hour
  const url = start.verification_uri_complete ?? start.verification_uri
  if (open) {
    info('opening your browser to sign in…')
    // Always print the link too: a launcher that fails to start reports it on spawn's ASYNC
    // error event, so open's return value cannot see it (same reasoning as browserOauth).
    info(`if nothing opens, use this link in a browser on any device:\n  ${url}`)
    open(url)
  } else {
    info('to log in, open this link in a browser on any device:')
    info(`  ${url}`)
  }
  info(`and check it shows this code: ${start.user_code}`)
  info(`waiting for approval… (expires in ${Math.round(lifetime / 60)}m, ctrl-c to abort)`)
  // Absent OR non-finite interval = the RFC 8628 §3.2 default 5s: NaN would fire the timer
  // instantly and Infinity gets truncated to ~1ms by Node — both hot-poll the token endpoint.
  const rawInterval = Number(start.interval)
  let interval = Number.isFinite(rawInterval) ? Math.max(rawInterval, 1) : 5
  const deadline = Date.now() + lifetime * 1000
  while (Date.now() < deadline) {
    await wait(interval)
    let grant: { access_token?: string } | null = null
    try {
      grant = (await post('/api/auth/device/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
        client_id: 'insta-cli',
      })) as { access_token?: string }
    } catch (e) {
      if (!(e instanceof ApiError)) continue // transport blip (dropped SSH/CI link) — keep polling until deadline
      const code = e.message
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') { interval += 5; continue } // RFC 8628 §3.5: back off by 5s
      // The platform's per-IP limiter answers a bare HTTP 429 (no OAuth error code) when a poll
      // trips it. That is the same
      // instruction as slow_down: the code is still pending, so back off and keep waiting rather
      // than abort a login the human may be one click away from approving.
      if (e.status === 429) { interval += 5; continue }
      if (code === 'expired_token') break
      if (code === 'access_denied') throw new Error('login request was denied in the console')
      throw e // a definite API-level error (invalid_grant, …) — not retryable
    }
    // Validated OUTSIDE the try: a 200 without a token is a malformed response that must fail
    // loudly, not be mistaken for a transport blip and retried into an empty stored session.
    if (!grant?.access_token) throw new Error('malformed token response (missing access_token)')
    return grant.access_token
  }
  throw new Error(`device login expired before it was approved — run \`insta login${open ? '' : ' --device'}\` again`)
}

// auth.md user claimed flow (service_auth). The agent knows the user's email; InstaCloud gives a
// 6-digit code and a console link; only a session for that email can type the code. We poll the
// standard token endpoint with the WorkOS claim grant and get an insta_ key back. Poster + wait
// are injected like deviceGrant's. JSON bodies: the platform's token route accepts them.
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim'
type ClaimBlock = { user_code: string; expires_in: number; verification_uri: string; interval?: number }
type ClaimStart = { registration_id: string; claim_token: string; claim_token_expires: string; claim: ClaimBlock }
export type ClaimPoster = (path: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<any>

// A poll interval is seconds, from the server: clamp it so a silly value cannot become a ~1 ms timer.
const pollInterval = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 3600) : fallback
}

export async function claimGrant(email: string, client: string, post: ClaimPoster, wait: (s: number) => Promise<void> = sleepSeconds, open?: (url: string) => boolean, now: () => number = Date.now): Promise<string> {
  const start = (await post('/agent/auth', { type: 'service_auth', login_hint: email, client })) as ClaimStart
  if (!start?.claim_token || !start.claim?.user_code || !start.claim.verification_uri) {
    throw new Error('malformed registration response (missing claim) — is the platform up to date?')
  }
  const expiresAt = Date.parse(start.claim_token_expires)
  const deadline = Math.min(Number.isFinite(expiresAt) ? expiresAt : Infinity, now() + 86_400_000)
  const show = (block: ClaimBlock, fresh: boolean) => {
    if (fresh) info('the code expired — here is a new one.')
    if (open) { info('opening your browser…'); open(block.verification_uri) }
    info(`to authorize this agent, open this link, sign in as ${email}, and enter this code: ${block.user_code}`)
    info(`  ${block.verification_uri}`)
  }
  show(start.claim, false)
  info(`waiting for ${email} to confirm… (ctrl-c to abort)`)
  let interval = pollInterval(start.claim.interval, 5)
  let reminted = false
  const expired = () => new Error(`the request expired before ${email} confirmed it — run \`insta login --claim ${email}\` again`)
  while (now() < deadline) {
    await wait(interval)
    const remaining = deadline - now()
    if (remaining <= 0) throw expired()
    const signal = AbortSignal.timeout(Math.ceil(Math.min(remaining, 30_000)))
    let grant: { access_token?: string } | null = null
    try {
      grant = (await post('/api/auth/oauth2/token', { grant_type: CLAIM_GRANT, claim_token: start.claim_token }, signal)) as { access_token?: string }
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) { if (now() >= deadline) throw expired(); continue }
      if (!(e instanceof ApiError)) continue // transport blip — keep polling until the deadline
      const code = e.message
      if (code === 'authorization_pending') continue
      if (code === 'slow_down' || e.status === 429) { interval = Math.min(interval + 5, 3600); continue }
      if (code === 'expired_token') {
        if (reminted) throw expired()
        let again: { claim_attempt?: ClaimBlock }
        try {
          again = (await post('/agent/auth/claim', { claim_token: start.claim_token, email }, signal)) as { claim_attempt?: ClaimBlock }
        } catch (re) {
          if (re instanceof ApiError && re.message === 'claim_expired') throw expired()
          if (!(re instanceof ApiError)) continue // re-mint timeout or transport blip: the next expired_token asks again
          throw re
        }
        reminted = true
        if (!again?.claim_attempt?.user_code || !again.claim_attempt.verification_uri) throw new Error('malformed claim response (missing claim_attempt)')
        interval = pollInterval(again.claim_attempt.interval, interval)
        show(again.claim_attempt, true)
        continue
      }
      throw e // invalid_grant and friends: not retryable
    }
    if (!grant?.access_token) throw new Error('malformed token response (missing access_token)')
    return grant.access_token
  }
  throw expired()
}

// Start a loopback server, open the browser at the platform bridge, and await the token.
function browserOauth(apiUrl: string, provider: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state = randomBytes(16).toString('hex')
    let timer: NodeJS.Timeout
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      const token = url.searchParams.get('token')
      const err = url.searchParams.get('error')
      const ok = !!token && !err && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' })
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;text-align:center;margin-top:4rem"><h2>InstaCloud</h2><p>${ok ? '✓ Login complete — you can close this tab.' : '✗ Login failed' + (err ? ` (${err})` : '')}</p></body>`)
      clearTimeout(timer)
      server.close()
      if (err) return reject(new Error(`oauth failed: ${err}`))
      if (!token) return reject(new Error('no token returned'))
      if (url.searchParams.get('state') !== state) return reject(new Error('state mismatch — aborting'))
      resolve(token)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const redirect = `http://127.0.0.1:${port}/callback`
      const authorizeUrl = `${apiUrl}/auth/cli/authorize?provider=${encodeURIComponent(provider)}&redirect=${encodeURIComponent(redirect)}&state=${state}`
      info(`opening browser to authorize with ${provider}…`)
      // Always print the URL: a launcher that fails to start reports it on spawn's ASYNC error
      // event, so openUrl's return value cannot see it (e.g. powershell.exe blocked by AppLocker
      // on hardened fleets) — and the silent variant of that failure looks exactly like a hang.
      info(`if nothing opens, use this URL:\n  ${authorizeUrl}`)
      openUrl(authorizeUrl)
      info('waiting for you to finish in the browser… (times out in 2m; ctrl-c to abort)')
      timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for browser login (2m)')) }, 120_000)
    })
  })
}

/** Log out: revoke the session on the server, then clear the local tokens.
 *
 *  Built from the PERSISTED config, not from `ApiClient.load()`'s override-resolved view. There is
 *  exactly one stored session, so a runtime `--api-url` (or INSTA_API_URL / INSTA_ENV) has no
 *  subject here — and pointing at a foreign deployment made this actively unsafe: readGlobal()
 *  scrubs a foreign deployment's tokens, so the revoke below was skipped for want of a refresh
 *  token while the local tokens were deleted anyway, leaving the session valid on the server with
 *  nothing left on this machine to revoke it with. The revoke now always goes to the deployment
 *  the session belongs to, with the real refresh token. `persist()` keeps the stored URL (see its
 *  comment): logout never sets one explicitly. */
export async function logout(): Promise<void> {
  const stored = await readPersistedGlobal()
  // Say so rather than ignoring it silently: exiting 0 with a bare "logged out" while the flag
  // named a different deployment reads as if that deployment was the one logged out of.
  const resolved = (await readGlobal()).apiUrl
  if (normalizeUrl(resolved) !== normalizeUrl(stored.apiUrl)) {
    info(`note: the control-plane override (${resolved}) does not apply to logout — there is one stored session; logging out of ${stored.apiUrl}`)
  }
  const api = new ApiClient(stored)
  if (api.config.refreshToken) {
    try { await api.request('POST', '/auth/logout', { refreshToken: api.config.refreshToken }, { auth: false }) } catch { /* ignore */ }
  }
  api.clearSession()
  await api.persist()
  info('logged out')
}

export async function status(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  let user: any = null
  try { user = (await api.request('GET', '/me')).user } catch { /* not logged in */ }
  const project = await linkedProject()
  // Surface the environment name alongside the URL: "api: https://api.staging.instacloud.com" is
  // easy to skim past, and mistaking staging for prod is the mistake worth making loud.
  const env = envForApiUrl(api.apiUrl)
  if (opts.json) return printJson({ env, apiUrl: api.apiUrl, user, project })
  info(`env:     ${env ?? '(custom)'}`)
  info(`api:     ${api.apiUrl}`)
  info(`user:    ${user ? (user.email ?? user.id) : '(not logged in)'}`)
  info(`project: ${project ? `${project.projectId} (branch ${project.branch})` : '(none linked)'}`)
}
