import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ApiClient, ApiError, linkedProject } from '../api.js'
import { ENVS, ENV_NAMES, envForApiUrl, isEnvName } from '../env.js'
import { info, die, printJson, promptPassword, openUrl } from '../util.js'

/** --api-url and --env both set the target host; --api-url wins (more specific), matching the
 *  INSTA_API_URL > INSTA_ENV precedence in config.ts. Returns the URL to point at, or undefined
 *  to leave whatever is already resolved alone. */
function targetApiUrl(opts: { apiUrl?: string; env?: string }): string | undefined {
  if (opts.apiUrl) return opts.apiUrl
  if (!opts.env) return undefined
  const want = opts.env.trim().toLowerCase()
  if (!isEnvName(want)) die(`unknown --env "${opts.env}" — expected one of: ${ENV_NAMES.join(', ')}`)
  return ENVS[want].api
}

// `device` is injectable so the dispatch itself is testable (repo pattern: DI fakes, no mocks).
export async function login(opts: { email?: string; password?: string; apiUrl?: string; env?: string; oauth?: string; device?: boolean; apiKey?: string }, device: typeof loginDevice = loginDevice): Promise<void> {
  // Login modes are exclusive — pick one. Check presence (not truthiness) so an explicit
  // empty --api-key= is rejected by validation rather than silently falling through.
  if (opts.apiKey !== undefined) {
    if (opts.device || opts.oauth || opts.email) die('choose one login mode: --api-key, --device, --oauth, or --email')
    return loginApiKey(opts.apiKey, opts)
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
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
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
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
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
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  const token = await deviceGrant((path, body) => api.request('POST', path, body, { auth: false }), sleepSeconds, open)
  api.setSession({ accessToken: token, refreshToken: token })
  const me = await api.request<{ user: { id: string; email: string | null; name: string | null } }>('GET', '/me')
  api.setSession({ accessToken: token, refreshToken: token }, me.user)
  await api.persist()
  info(`logged in as ${me.user.email ?? me.user.id} @ ${api.apiUrl}`)
}

// Non-interactive login with a durable insta_ key (minted via POST /tokens): store it and confirm against /me. No browser, no polling.
export async function loginApiKey(key: string, opts: { apiUrl?: string; env?: string }): Promise<void> {
  const api = await ApiClient.load()
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  const user = await applyApiKeyLogin(api, key)
  await api.persist()
  info(`logged in as ${user.email ?? user.id} @ ${api.apiUrl}`)
}

export type AuthedUser = { id: string; email: string | null; name: string | null }

// The client surface applyApiKeyLogin needs — ApiClient in prod, faked in tests.
export type ApiKeyClient = {
  request: (method: string, path: string) => Promise<any>
  setApiKey: (token: string, user?: AuthedUser) => void
}

// Verify an insta_ key and store it: set it first so the /me probe is authed with the key itself, then re-store with the resolved user (401 → bad/revoked).
export async function applyApiKeyLogin(client: ApiKeyClient, key: string): Promise<AuthedUser> {
  key = key.trim() // tolerate a trailing newline / stray whitespace from `--api-key "$(cat token)"`
  if (!key.startsWith('insta_')) throw new Error('--api-key expects an insta_ token (mint one with POST /tokens)')
  client.setApiKey(key)
  let me: { user?: AuthedUser }
  try {
    me = await client.request('GET', '/me')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw new Error('that insta_ API key was rejected (invalid or revoked) — check it or mint a new one')
    throw e
  }
  if (!me?.user) throw new Error('unexpected response while verifying the API key')
  client.setApiKey(key, me.user)
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
      // trips it — seen on prod 2026-09-10 after ~8 min of steady 5s polling. That is the same
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

export async function logout(): Promise<void> {
  const api = await ApiClient.load()
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
