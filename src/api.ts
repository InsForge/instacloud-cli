// Thin API client over the platform control-plane. Handles bearer auth + one-shot refresh on 401.
// 2xx (including 202 approval_required) returns the parsed body; >=400 throws ApiError.
import { readGlobal, writeGlobal, readProject, persistAutoLink, resolveProjectLink, foreignLinkMessage, type GlobalConfig, type ProjectConfig } from './config.js'
import { autoResolveProject, promptChoice, type ProjectItem } from './resolve-project.js'
import { die } from './util.js'
import { USER_AGENT } from './version.js'
import { agentHeaders, agentMode, type AgentScope } from './agent.js'

export class ApiError extends Error {
  // body carries the parsed error payload for callers that branch on machine-readable errors
  // (e.g. template deploy's missing_variables); the message stays the human line.
  constructor(public status: number, msg: string, public body?: any) { super(msg); this.name = 'ApiError' }
}
export class AgentApprovalRequired extends Error {
  constructor(public body: any) { super(body.message ?? `approval required: ${body.approvalId}`) }
}

// Store a durable insta_ key as the credential: set it as the bearer and drop any refresh token (an insta_ key never rotates; a stale one would leak to /auth/refresh on a 401).
export function storeApiKeyCredential(cfg: GlobalConfig, token: string, user?: GlobalConfig['user'], agentCredential = false): void {
  cfg.accessToken = token
  delete cfg.refreshToken
  if (user) cfg.user = user
  if (agentCredential) cfg.agentCredential = true
  else delete cfg.agentCredential
}

type RawResult = { status: number; body: any }
// projectId: the project this request acts on when the path does not carry /projects/:id, so agent
// mode signs with that project's session instead of a projectless bootstrap one (see agentHeaders).
// `signal` bounds one request: a poll loop hands in the time it has left, so a stalled endpoint
// cannot hold the CLI past the caller's own deadline.
// evidence: false sends the bearer alone; the /me probe at login uses it before the key's kind is known
type RequestOpts = { auth?: boolean; signal?: AbortSignal; evidence?: boolean } & AgentScope

export class ApiClient {
  constructor(private cfg: GlobalConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  static async load(): Promise<ApiClient> { return new ApiClient(await readGlobal()) }

  get apiUrl(): string { return this.cfg.apiUrl }
  get config(): GlobalConfig { return this.cfg }

  async persist(): Promise<void> { await writeGlobal(this.cfg) }

  setApiUrl(url: string): void { this.cfg.apiUrl = url }

  setSession(tokens: { accessToken: string; refreshToken: string }, user?: GlobalConfig['user']): void {
    this.cfg.accessToken = tokens.accessToken
    this.cfg.refreshToken = tokens.refreshToken
    if (user) this.cfg.user = user
    delete this.cfg.agentCredential
  }

  // Adopt a durable insta_ key as the credential (non-interactive `login --api-key`).
  setApiKey(token: string, user?: GlobalConfig['user'], agentCredential?: boolean): void {
    storeApiKeyCredential(this.cfg, token, user, agentCredential)
  }

  get agentCredential(): boolean { return this.cfg.agentCredential === true }

  clearSession(): void {
    delete this.cfg.accessToken
    delete this.cfg.refreshToken
    delete this.cfg.user
    delete this.cfg.agentCredential
  }

  // Returns parsed body for status < 400 (incl. 202); throws ApiError otherwise.
  async request<T = any>(method: string, path: string, body?: unknown, opts: RequestOpts = {}): Promise<T> {
    const res = await this.raw(method, path, body, opts.auth ?? true, opts)
    if (agentMode() && res.status === 202 && res.body?.status === 'approval_required') throw new AgentApprovalRequired(res.body)
    if (res.status >= 400) throw new ApiError(res.status, res.body?.error ?? `HTTP ${res.status}`, res.body)
    return res.body as T
  }

  // Like request but returns {status, body} so callers can branch on 202 (approval_required).
  async rawRequest(method: string, path: string, body?: unknown, opts: RequestOpts = {}): Promise<RawResult> {
    const res = await this.raw(method, path, body, opts.auth ?? true, opts)
    if (res.status >= 400) throw new ApiError(res.status, res.body?.error ?? `HTTP ${res.status}`, res.body)
    return res
  }

  private async raw(method: string, path: string, body: unknown, auth: boolean, scope: RequestOpts = {}): Promise<RawResult> {
    let r = await this.fetch(method, path, body, auth, scope)
    if (r.status === 401 && auth && this.cfg.refreshToken) {
      if (await this.refresh(scope.signal)) r = await this.fetch(method, path, body, auth, scope)
    }
    return r
  }

  private async fetch(method: string, path: string, body: unknown, auth: boolean, scope: RequestOpts = {}): Promise<RawResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Insta-Hints': '1', 'User-Agent': USER_AGENT }
    if (auth && this.cfg.accessToken) headers.Authorization = `Bearer ${this.cfg.accessToken}`
    if (auth && scope.evidence !== false) Object.assign(headers, await agentHeaders(this, method, path, body === undefined ? '' : JSON.stringify(body), scope))
    const res = await this.fetchImpl(this.apiUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: scope.signal,
    })
    const text = await res.text()
    let parsed: any = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed }
  }

  private async refresh(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.fetch('POST', '/auth/refresh', { refreshToken: this.cfg.refreshToken }, false, { signal })
      if (res.status >= 400) return false
      this.cfg.accessToken = res.body.accessToken
      this.cfg.refreshToken = res.body.refreshToken
      await this.persist()
      return true
    } catch (e) {
      // Refresh belongs to the original request's time budget. Do not turn its cancellation
      // into the earlier 401: the caller needs the abort to report a timeout or cancellation.
      signal?.throwIfAborted()
      if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e
      return false
    }
  }
}

// Resolve the linked project (./.insta/project.json), or null.
export async function linkedProject(): Promise<ProjectConfig | null> { return readProject() }

// Injected for tests (the convention in CONTRIBUTING): `cwd` to resolve from, and `autoResolve` to
// stand in for the interactive/API resolution below.
export type RequireProjectDeps = { cwd?: string; autoResolve?: () => Promise<ProjectConfig> }

// Resolve the linked project or exit with guidance.
export async function requireProject(deps: RequireProjectDeps = {}): Promise<ProjectConfig> {
  const r = await resolveProjectLink(deps.cwd)
  // Fail CLOSED on a link made against another control plane. Treating it as "unlinked" sent this
  // into auto-resolve, which with exactly one project on the new plane picks it without a prompt
  // and SAVES — so a read-only command replaced the committed team binding, and pointing back
  // flipped it again. Only an explicit `insta project link` may replace a link.
  if (r?.foreign) die(foreignLinkMessage(r.foreign))
  if (r) return r.link
  if (agentMode()) die('agent mode requires a linked project — run `insta setup agent --project <id>`')
  if (deps.autoResolve) return deps.autoResolve()
  // One command, just works: unlinked ≠ error. Resolve the project (auto when there's one,
  // one-keystroke picker when several) and persist the choice so this happens once per dir.
  const api = await ApiClient.load()
  try {
    const orgs = (await api.request<{ orgs: Array<{ id: string }> }>('GET', '/orgs')).orgs
    const orgId = orgs[0]?.id ?? 'local'
    return await autoResolveProject(orgId, {
      listProjects: async () =>
        (await api.request<{ projects: ProjectItem[] }>('GET', `/orgs/${orgId}/projects`)).projects,
      promptChoice,
      save: async (c) => {
        // stderr: this is a diagnostic that can precede ANY command's output — under --json,
        // stdout must stay one parseable document.
        if (await persistAutoLink(c, deps.cwd)) {
          process.stderr.write(`auto-linked project ${c.projectId} → ./.insta/project.json\n`)
        } else {
          // The home directory never holds a link (~/.insta is the global config): use the choice
          // for this command instead of failing it after the picker has already run.
          process.stderr.write(`using project ${c.projectId} for this command — not saving a link in the home directory; run inside a project directory to remember it\n`)
        }
      },
      tty: !!process.stdin.isTTY && !!process.stderr.isTTY,
    })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      die('not logged in — run `insta login` (cloud) or point INSTA_API_URL at your insta-oss daemon')
    }
    die(e instanceof Error ? e.message : String(e))
  }
}
