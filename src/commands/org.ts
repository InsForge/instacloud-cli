import { ApiClient, linkedProject } from '../api.js'
import type { ProjectConfig, TokenScopeInfo } from '../config.js'
import { die, handleApproval, info, printJson } from '../util.js'

export async function orgList(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const { orgs } = await api.request('GET', '/orgs')
  if (opts.json) return printJson(orgs)
  for (const o of orgs) info(`${o.id}  ${o.name}${o.is_personal ? ' (personal)' : ''}  [${o.role}]`)
}

export async function orgCreate(name: string, opts: { json?: boolean } = {}): Promise<void> {
  const api = await ApiClient.load()
  const { org } = await api.request('POST', '/orgs', { name })
  if (opts.json) return printJson(org)
  info(`created org ${org.id} (${org.name})`)
}

// ---- members & invitations (`insta org member …`, `insta org invitation …`) ----
// Thin wrappers over the platform's /orgs/:orgId/members and /orgs/:orgId/invitations routes — the
// same ones the console's Members page calls. Role rules are the platform's: invite as admin|member
// (admin+), change roles admin+ (only an owner may set/clear owner), the last owner cannot leave.

// Platform Member / Invitation schemas.
export type MemberRecord = { user_id: string; role: 'owner' | 'admin' | 'member'; email?: string | null; name?: string | null; created_at?: string }
export type InvitationRecord = { id: string; email: string; role: 'admin' | 'member'; status?: string; expires_at?: string; created_at?: string }

// The client surface these commands need — ApiClient in prod, a fake in tests.
export type OrgApi = {
  request: (method: string, path: string, body?: unknown) => Promise<any>
  rawRequest: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
  config: { tokenScope?: TokenScopeInfo }
}
export type OrgDeps = { api?: OrgApi; linked?: () => Promise<ProjectConfig | null> }
export type OrgOpts = { org?: string; json?: boolean }

const loadApi = async (deps: OrgDeps): Promise<OrgApi> => deps.api ?? ApiClient.load()
const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '')

const INVITE_ROLES = ['admin', 'member'] as const
const MEMBER_ROLES = ['owner', 'admin', 'member'] as const

/** The org a member/invitation command acts on, most explicit first: --org; the org an org- or
 *  project-scoped login is bound to; the linked project's org; the caller's only org. Several orgs
 *  stop here rather than guess — inviting someone into the wrong org is not a mistake to make quietly. */
export async function resolveOrg(api: OrgApi, opts: OrgOpts, linked: () => Promise<ProjectConfig | null> = linkedProject): Promise<string> {
  if (opts.org) return opts.org
  const bound = api.config.tokenScope?.orgId
  if (bound) return bound
  const link = await linked()
  if (link?.orgId) return link.orgId
  const { orgs } = (await api.request('GET', '/orgs')) as { orgs: Array<{ id: string; name: string }> }
  if (orgs.length === 1) return orgs[0]!.id
  if (orgs.length === 0) die('no org found — create one first: insta org create <name>')
  const list = orgs.map((o) => `  ${o.id}  ${o.name}`).join('\n')
  die(`several orgs — pass --org <id>:\n${list}`)
}

// The writes go through the governance gate like any other mutation: a 202 approval_required means
// nothing ran yet, so handleApproval prints the approval hint and exits 2 instead of claiming success.
async function write(api: OrgApi, method: string, path: string, body?: unknown, json?: boolean): Promise<any | null> {
  const res = await api.rawRequest(method, path, body)
  return handleApproval(res, json) ? null : res.body
}

const orgPath = (orgId: string, rest: string): string => `/orgs/${encodeURIComponent(orgId)}/${rest}`

async function listMembers(api: OrgApi, orgId: string): Promise<MemberRecord[]> {
  return ((await api.request('GET', orgPath(orgId, 'members'))) as { members: MemberRecord[] }).members
}

/** `<user>` is a user id or an email (case-insensitive) — the console shows emails, the API takes ids. */
async function resolveMember(api: OrgApi, orgId: string, user: string): Promise<MemberRecord> {
  if (!user.trim()) die('<user> is required: a user id or an email (see: insta org member list)')
  const members = await listMembers(api, orgId)
  const want = user.toLowerCase()
  const m = members.find((x) => x.user_id === user || (x.email ?? '').toLowerCase() === want)
  if (!m) die(`no member "${user}" in org ${orgId} — see: insta org member list`)
  return m
}

const who = (m: MemberRecord): string => m.email ?? m.user_id

export async function memberList(opts: OrgOpts, deps: OrgDeps = {}): Promise<void> {
  const api = await loadApi(deps)
  const members = await listMembers(api, await resolveOrg(api, opts, deps.linked))
  if (opts.json) return printJson(members)
  if (!members.length) return info('(no members)')
  for (const m of members) info(`${m.user_id}  ${m.email ?? ''}  [${m.role}]${m.name ? `  ${m.name}` : ''}`)
}

export async function memberInvite(email: string, opts: OrgOpts & { role?: string }, deps: OrgDeps = {}): Promise<void> {
  const role = opts.role ?? 'member'
  if (!(INVITE_ROLES as readonly string[]).includes(role)) die(`--role must be ${INVITE_ROLES.join('|')} (owners are made with: insta org member role <user> owner)`)
  const api = await loadApi(deps)
  const orgId = await resolveOrg(api, opts, deps.linked)
  const res = (await write(api, 'POST', orgPath(orgId, 'invitations'), { email, role }, opts.json)) as { id?: string } | null
  if (!res) return
  if (opts.json) return printJson({ ...res, orgId, email, role })
  info(`invited ${email} to org ${orgId} as ${role} — they accept from the emailed link`)
}

export async function memberRemove(user: string, opts: OrgOpts, deps: OrgDeps = {}): Promise<void> {
  const api = await loadApi(deps)
  const orgId = await resolveOrg(api, opts, deps.linked)
  const m = await resolveMember(api, orgId, user)
  if (!(await write(api, 'DELETE', orgPath(orgId, `members/${encodeURIComponent(m.user_id)}`), undefined, opts.json))) return
  if (opts.json) return printJson({ ok: true, orgId, userId: m.user_id })
  info(`removed ${who(m)} from org ${orgId}`)
}

export async function memberRole(user: string, role: string, opts: OrgOpts, deps: OrgDeps = {}): Promise<void> {
  if (!(MEMBER_ROLES as readonly string[]).includes(role)) die(`role must be ${MEMBER_ROLES.join('|')}`)
  const api = await loadApi(deps)
  const orgId = await resolveOrg(api, opts, deps.linked)
  const m = await resolveMember(api, orgId, user)
  if (!(await write(api, 'PUT', orgPath(orgId, `members/${encodeURIComponent(m.user_id)}`), { role }, opts.json))) return
  if (opts.json) return printJson({ ok: true, orgId, userId: m.user_id, role })
  info(`${who(m)} is now ${role} in org ${orgId}`)
}

export async function invitationList(opts: OrgOpts, deps: OrgDeps = {}): Promise<void> {
  const api = await loadApi(deps)
  const orgId = await resolveOrg(api, opts, deps.linked)
  const { invitations } = (await api.request('GET', orgPath(orgId, 'invitations'))) as { invitations: InvitationRecord[] }
  if (opts.json) return printJson(invitations)
  if (!invitations.length) return info('(no pending invitations)')
  for (const i of invitations) info(`${i.id}  ${i.email}  [${i.role}]${i.expires_at ? `  expires ${day(i.expires_at)}` : ''}`)
}

export async function invitationRevoke(id: string, opts: OrgOpts, deps: OrgDeps = {}): Promise<void> {
  const api = await loadApi(deps)
  const orgId = await resolveOrg(api, opts, deps.linked)
  if (!(await write(api, 'DELETE', orgPath(orgId, `invitations/${encodeURIComponent(id)}`), undefined, opts.json))) return
  if (opts.json) return printJson({ ok: true, orgId, id })
  info(`revoked invitation ${id}`)
}
