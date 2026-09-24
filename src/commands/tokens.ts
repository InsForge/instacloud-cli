// `insta tokens` — mint, list and revoke insta_ API tokens (spec 2026-09-23-scoped-api-tokens §9).
// A new token binds to an org (or a project) by default; account-wide is an EXPLICIT --account,
// mirroring the platform rule that "no org" has to be said out loud. The plaintext is printed once.
import { ApiClient, linkedProject } from '../api.js'
import type { ProjectConfig, TokenScopeInfo } from '../config.js'
import { die, info, printJson } from '../util.js'

export type { TokenScopeInfo }

// `record` of POST /tokens and the items of GET /tokens (platform ApiToken schema).
export type TokenRecord = {
  id: string
  name: string
  scope: 'account' | 'org' | 'project'
  orgId: string | null
  projectId: string | null
  access: 'full' | 'read_only'
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

// The client surface these commands need — ApiClient in prod, a fake in tests. `config.tokenScope`
// is the binding of the key this CLI is logged in with (an org token can only mint inside its org).
export type TokensApi = {
  request: (method: string, path: string, body?: unknown) => Promise<any>
  config: { tokenScope?: TokenScopeInfo }
}
export type TokensDeps = { api?: TokensApi; linked?: () => Promise<ProjectConfig | null> }

const loadApi = async (deps: TokensDeps): Promise<TokensApi> => deps.api ?? ApiClient.load()

/** `--expires` → `expiresInDays`: '30d' → 30, '1y' → 365, 'never' (or absent) → undefined, i.e.
 *  the field is not sent. Anything else is a usage error, raised before any request is made. */
export function parseExpires(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const s = v.trim().toLowerCase()
  if (s === 'never') return undefined
  const m = /^(\d+)([dy])$/.exec(s)
  const n = m ? Number(m[1]) : 0
  if (!m || !Number.isSafeInteger(n) || n <= 0) throw new Error(`--expires expects 30d | 90d | 1y | never, got "${v}"`)
  return m[2] === 'y' ? n * 365 : n
}

/** One phrase for a credential's reach — the login line, `insta status`, and the token_scope hint. */
export function describeTokenScope(s: TokenScopeInfo | undefined): string {
  const ro = s?.access === 'read_only' ? ', read-only' : ''
  if (!s || s.scope === 'account') return `account-wide${ro}`
  if (s.scope === 'project') return `project ${s.projectId} (org ${s.orgId})${ro}`
  return `org ${s.orgId}${ro}`
}

/** What the command guard prints for a 403 token_scope: the platform's message verbatim, then ONE
 *  hint naming the credential this login holds. Deliberately not a permissions message — the user
 *  IS a member; only the credential is narrow (spec §5.2), and "no permission" sends people off to
 *  check roles. */
export function tokenScopeErrorLines(body: { message?: unknown }, scope: TokenScopeInfo | undefined): string {
  const message = typeof body.message === 'string' && body.message ? body.message : 'refused by the scope of this token'
  const held = scope ? `this login's token: ${describeTokenScope(scope)}` : 'this login uses a scoped token'
  return `${message}\n  ${held} — mint a wider one with \`insta tokens create <name> --account\` (from an account login) or run \`insta login\``
}

const id8 = (s: string | null | undefined): string => (s ?? '').slice(0, 8)
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : 'never')

/** The scope column of `tokens list`: `account`, `org:<id8>`, or `<org id8>/<project id8>`. */
export function scopeColumn(t: TokenRecord): string {
  if (t.scope === 'project') return `${id8(t.orgId)}/${id8(t.projectId)}`
  if (t.scope === 'org') return `org:${id8(t.orgId)}`
  return 'account'
}

const scopeOf = (r: TokenRecord): TokenScopeInfo => ({
  scope: r.scope, access: r.access,
  ...(r.orgId ? { orgId: r.orgId } : {}),
  ...(r.projectId ? { projectId: r.projectId } : {}),
})

// Column-aligned rows; trailing spaces trimmed so an empty last cell leaves no ragged edge.
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)))
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd())
}

export async function tokensList(opts: { json?: boolean }, deps: TokensDeps = {}): Promise<void> {
  const api = await loadApi(deps)
  const { tokens } = (await api.request('GET', '/tokens')) as { tokens: TokenRecord[] }
  if (opts.json) return printJson(tokens)
  if (!tokens.length) return info('(no tokens)')
  const rows = tokens.map((t) => [t.id, t.name, scopeColumn(t), t.access, day(t.expiresAt), day(t.lastUsedAt), t.revokedAt ? 'revoked' : ''])
  for (const line of table([['id', 'name', 'scope', 'access', 'expires', 'last-used', ''], ...rows])) info(line)
}

export type TokensCreateOpts = { org?: string; project?: string; account?: boolean; readOnly?: boolean; expires?: string; json?: boolean }

export async function tokensCreate(name: string, opts: TokensCreateOpts, deps: TokensDeps = {}): Promise<void> {
  if (opts.account && (opts.org || opts.project)) die('--account is mutually exclusive with --org / --project: an account-wide token has no org')
  const expiresInDays = parseExpires(opts.expires ?? '90d') // validated before any request
  const api = await loadApi(deps)
  const binding = opts.account ? {} : await resolveBinding(api, opts, deps.linked ?? linkedProject)
  const body = {
    name,
    ...binding,
    access: opts.readOnly ? 'read_only' : 'full',
    ...(expiresInDays === undefined ? {} : { expiresInDays }),
  }
  const { token, record } = (await api.request('POST', '/tokens', body)) as { token: string; record: TokenRecord }
  if (opts.json) return printJson({ token, record })
  // The plaintext ALONE on stdout, so `$(insta tokens create ci)` captures exactly the token; the
  // note goes to stderr and never repeats the secret.
  process.stdout.write(token + '\n')
  const expiry = record.expiresAt ? `expires ${day(record.expiresAt)}` : 'never expires'
  process.stderr.write(`created token ${record.id} (${record.name}: ${describeTokenScope(scopeOf(record))}; ${expiry}) — the plaintext above is shown once; store it now\n`)
}

// Default-org rule (spec §9.1 / §9.2), most explicit first: --project → its org; --org; the org an
// org-scoped login is bound to (the only one it can mint in); the linked project's org; the caller's
// only org. Several orgs — or none — stop here rather than guess: binding a CI token to the wrong
// org is exactly the mistake the scope exists to prevent.
async function resolveBinding(api: TokensApi, opts: TokensCreateOpts, linked: () => Promise<ProjectConfig | null>): Promise<{ orgId: string; projectId?: string }> {
  if (opts.project) {
    const { project } = (await api.request('GET', `/projects/${encodeURIComponent(opts.project)}`)) as { project: { id: string; org_id: string } }
    // A pair the platform would 404 (project outside the org, spec §4.4) is caught here with the real reason.
    if (opts.org && opts.org !== project.org_id) die(`project ${opts.project} belongs to org ${project.org_id}, not --org ${opts.org}`)
    return { orgId: project.org_id, projectId: project.id }
  }
  if (opts.org) return { orgId: opts.org }
  const bound = api.config.tokenScope?.orgId
  if (bound) return { orgId: bound }
  const link = await linked()
  if (link?.orgId) return { orgId: link.orgId }
  const { orgs } = (await api.request('GET', '/orgs')) as { orgs: Array<{ id: string; name: string }> }
  if (orgs.length === 1) return { orgId: orgs[0]!.id }
  if (orgs.length === 0) die('no org found — pass --account for an account-wide token, or create an org first: insta org create <name>')
  const list = orgs.map((o) => `  ${o.id}  ${o.name}`).join('\n')
  die(`several orgs — pass --org <id> to bind the token to one, or --account for an account-wide token:\n${list}`)
}

export async function tokensRevoke(id: string, opts: { json?: boolean }, deps: TokensDeps = {}): Promise<void> {
  const api = await loadApi(deps)
  await api.request('DELETE', `/tokens/${encodeURIComponent(id)}`)
  if (opts.json) return printJson({ ok: true, id })
  info(`revoked token ${id}`)
}
