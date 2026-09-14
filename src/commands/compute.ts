import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, printJson, handleApproval, relayExitCode, writeFileAtomicSync, resolveThroughSymlink } from '../util.js'
import { resolveComputeServiceId, resolveSoleService, q, parseVolumeGib } from './services.js'

type Opts = { branch?: string; group?: string; json?: boolean }

// ---- custom domains (bring your own hostname) ----
//
// A compute service's region is fixed at creation (`insta services add compute --region`), and a
// custom hostname routes in the router of the region that OWNS the service. So the region is
// DETECTED from the service, never chosen for the domain — the customer's DNS is one region-agnostic
// CNAME target either way — and every line below names it so the user knows where traffic lands.

// The `services list` row fields these commands read. `port === 0` is a worker: no HTTP endpoint,
// so no hostname can ever serve from it.
export type ComputeRow = { id: string; type: string; name: string; status?: string; region?: string | null; domain?: string | null; port?: number | null }

export const isWorker = (s: ComputeRow): boolean => s.port === 0

// One line per compute service for the disambiguation error: name, region, default URL, status —
// enough to pick one without a second command. Pure, exported for tests.
export function computeChoiceLine(s: ComputeRow, w = { name: 8, region: 12 }): string {
  const target = isWorker(s)
    ? '(no HTTP endpoint — worker, cannot serve a domain)'
    : `${s.domain ? `https://${s.domain}` : '(no default URL yet)'}${s.status ? `  (${s.status})` : ''}`
  return `  ${s.name.padEnd(w.name)} ${(s.region ?? '-').padEnd(w.region)} ${target}`
}

// Which compute service a hostname binds to. Exactly one compute service → it, no flag needed.
// Several → never guess (a wrong pick routes the customer's hostname to the wrong app in the wrong
// region): refuse with the list and require --group. With --group: must exist and must not be a
// worker. Pure, exported for tests.
export function resolveDomainTarget(services: ComputeRow[], host: string, group?: string): ComputeRow {
  const compute = services.filter((s) => s.type === 'compute')
  if (group) {
    const svc = compute.find((s) => s.name === group)
    if (!svc) throw new Error(`compute service not found: ${group}${compute.length ? ` (have: ${compute.map((s) => s.name).join(', ')})` : ''}`)
    if (isWorker(svc)) throw new Error(`${svc.name} is a worker (port 0) — it has no HTTP endpoint, so ${host} cannot serve from it`)
    return svc
  }
  if (compute.length === 0) throw new Error('no compute service in this project (add one with `insta services add compute <name>`)')
  if (compute.length === 1) {
    const only = compute[0]!
    if (isWorker(only)) throw new Error(`${only.name} is a worker (port 0) — it has no HTTP endpoint, so ${host} cannot serve from it`)
    return only
  }
  const w = { name: Math.max(4, ...compute.map((s) => s.name.length)), region: Math.max(6, ...compute.map((s) => (s.region ?? '-').length)) }
  throw new Error([
    `this project has ${compute.length} compute services; pass --group to choose which one serves ${host}:`,
    ...compute.map((s) => computeChoiceLine(s, w)),
  ].join('\n'))
}

// The platform's /compute/domain answer. `service`/`region` are the platform's own row; `ssl`,
// `dns[].status` and the origin trio are the compute plane's report and are ABSENT when its daemon
// does not report them (older builds) — the renderers say so rather than inventing a value.
export type DomainView = {
  hostname: string; flyApp: string; configured: boolean; status: string
  dns: Array<{ type: string; name: string; value: string; note?: string; status?: string }>
  service?: string | null; region?: string | null
  ssl?: string; errorReason?: string
  origin?: string; edgeOrigin?: string; originOk?: boolean
}

const targetOf = (r: DomainView) => `${r.service ?? r.flyApp}${r.region ? ` (${r.region})` : ''}`
const pad = (s: string, n: number) => s.padEnd(n)
// An older platform may omit `dns` entirely; every reader treats that as "no records", not a crash.
const recordsOf = (r: DomainView) => r.dns ?? []

// How a printed follow-up command must be spelled so it reaches the SAME service on the SAME
// branch the user just acted on. Without these, a suggested command run in a multi-service project
// dies on the very ambiguity error this feature exists to raise, and a --branch invocation would
// silently check the linked branch instead (cubic P2 ×2).
export type DomainCmdCtx = { group?: string; branch?: string }
const flags = (c: DomainCmdCtx = {}) =>
  `${c.group ? ` --group ${c.group}` : ''}${c.branch ? ` --branch ${c.branch}` : ''}`

// After set-domain: exactly what to do next, from the records the platform returned — never a
// hand-built template. No records = say so; a template here would send the customer publishing
// values the plane never issued. Pure, exported for tests.
export function domainGuidanceLines(r: DomainView, ctx: DomainCmdCtx = {}): string[] {
  const records = recordsOf(r)
  const out = [`${r.hostname} -> ${targetOf(r)}`]
  if (!records.length) {
    out.push('  the platform returned NO DNS records for this domain — the compute plane has no custom-domain CNAME target configured (or is misconfigured)')
    out.push('  nothing to publish yet: ask an operator before adding any DNS record')
    return out
  }
  const nameW = Math.max(...records.map((d) => d.name.length))
  out.push('add these DNS records at your DNS provider:')
  for (const d of records) out.push(`  ${pad(d.type, 6)} ${pad(d.name, nameW)} -> ${d.value}`)
  out.push(`then: insta compute check-domain ${r.hostname}${flags(ctx)}`)
  return out
}

// Whether this provider reports an edge routing target AT ALL. The compute plane's domain view
// always carries an `ssl` status, so a plane answer without `origin` is a daemon too old to report
// where the hostname resolves — we cannot confirm routing, and must not call it serving. A Fly
// answer carries no `ssl` and has no per-hostname origin concept, so its own verdict stands
// (r2d2 round 1 Critical: "no target reported" was previously treated as ready for both).
const reportsOrigin = (r: DomainView) => r.ssl !== undefined

// Where the hostname actually resolves — the region-specific origin the plane requested vs what
// Cloudflare holds. Each shape carries its action; absent fields are reported as absent.
export function domainResolveLine(r: DomainView): { line: string; ready: boolean } {
  const region = r.region ?? 'this region'
  if (r.origin === undefined) {
    if (reportsOrigin(r)) {
      return {
        line: `  ${pad('resolves to', 12)}UNCONFIRMED — ${region}'s daemon does not report the edge routing target, so where ${r.hostname} lands cannot be verified from here (update the region's daemon)`,
        ready: false,
      }
    }
    return { line: `  ${pad('resolves to', 12)}(this provider does not report an edge routing target)`, ready: true }
  }
  if (r.origin === '') {
    return {
      line: `  ${pad('resolves to', 12)}NOT READY — ${region} has no edge origin configured; ${r.hostname} would fall to the zone default. Ask an operator to set cf-custom-origin for ${region}`,
      ready: false,
    }
  }
  if (r.edgeOrigin && r.edgeOrigin !== r.origin) {
    return {
      line: `  ${pad('resolves to', 12)}${r.edgeOrigin} — Cloudflare routes ${r.hostname} to ${r.edgeOrigin}, but this service is in ${region} (${r.origin}); it is attached elsewhere — remove it there first`,
      ready: false,
    }
  }
  if (r.originOk === false) {
    return { line: `  ${pad('resolves to', 12)}${r.origin}   (${region} router)   pending — Cloudflare does not hold this hostname yet`, ready: false }
  }
  return { line: `  ${pad('resolves to', 12)}${r.origin}   (${region} router)   ok`, ready: true }
}

// check-domain: every stage, what each still needs, and where it routes. Pure, exported for tests.
export function domainStatusLines(r: DomainView, ctx: DomainCmdCtx = {}): string[] {
  if (r.status === 'not added') {
    return [`${r.hostname} is not attached to ${targetOf(r)} — attach it with: insta compute set-domain ${r.hostname}${flags(ctx)}`]
  }
  const records = recordsOf(r)
  const out = [`${r.hostname} -> ${targetOf(r)}`]
  const txt = records.find((d) => d.type === 'TXT')
  // The ROUTING records for the hostname, whatever type they take: a CNAME for a subdomain, or the
  // A/AAAA PAIR an apex needs (Fly's apex path emits both). All of them, not the first one —
  // a correct A beside a missing AAAA is not "routing is fine".
  const isRouting = (d: DomainView['dns'][number]) => d.type !== 'TXT' && d.name === r.hostname
  const routing = records.filter(isRouting)
  const blockers: string[] = []
  const stage = (label: string, state: string, detail: string) => out.push(`  ${pad(label, 12)}${pad(state, 10)}${detail ? `  ${detail}` : ''}`)

  // The ONE verdict rule, applied to EVERY record the platform returned regardless of its role.
  // A record is settled only when the platform says `ok` — or, for a provider that reports no
  // per-record status at all (Fly), when it vouched for the whole set with `configured`. missing,
  // mismatch and never-checked are each outstanding and each add a blocker. Applying this to only
  // the ownership TXT and the FIRST routing record was the bug (r2d2 round 3): every other record
  // rendered from `configured` alone and blocked nothing, so an apex whose AAAA was missing, or a
  // still-pending validation record, could ride under a `serving https://…` line.
  const verdictOf = (d: DomainView['dns'][number]) => d.status ?? (r.configured ? 'ok' : 'unchecked')

  if (txt) {
    const st = verdictOf(txt)
    if (st === 'ok') stage('ownership', 'verified', '(TXT found)')
    else if (st === 'mismatch') { stage('ownership', 'mismatch', `TXT ${txt.name} has a different value — set it to ${txt.value}`); blockers.push('fix the ownership TXT') }
    else if (st === 'missing') { stage('ownership', 'pending', `add TXT ${txt.name} -> ${txt.value}`); blockers.push('add the ownership TXT') }
    else { stage('ownership', 'unchecked', `TXT ${txt.name} -> ${txt.value} (the plane has not checked it yet — re-run check-domain)`); blockers.push('ownership unchecked') }
  } else if (reportsOrigin(r)) {
    // The stage is drawn even with no record to draw it from: an omitted stage reads as "not
    // required", when in fact the platform told us nothing to publish (cubic P2). Only the plane
    // proves ownership by TXT, so only a plane answer missing one is a problem.
    stage('ownership', 'unknown', 'the platform returned no ownership TXT for this domain — nothing to publish yet; ask an operator')
    blockers.push('no ownership TXT from the platform')
  } else {
    stage('ownership', 'n/a', '(this provider does not use an ownership TXT)')
  }

  if (routing.length === 0) {
    // No routing record for the hostname — whatever ELSE came back. Keying this on an entirely
    // empty record set was the bug (r2d2 round 2): a payload carrying only the ownership TXT
    // skipped the stage and added no blocker, so a `configured: true` answer with a live cert and
    // a confirmed origin printed `serving` for a hostname with nothing pointing at us.
    stage('cname', 'unknown', 'the platform returned no routing record for this domain — nothing to publish yet; ask an operator')
    blockers.push('no routing record from the platform')
  }
  for (const d of routing) {
    const st = verdictOf(d)
    // The stage is named for the record the platform actually issued, so an apex's A record is not
    // described to the user as a CNAME they cannot create.
    const lbl = d.type.toLowerCase()
    if (st === 'ok') stage(lbl, 'ok', `(points at ${d.value})`)
    else if (st === 'mismatch') { stage(lbl, 'mismatch', `${d.type} ${d.name} must point at ${d.value}`); blockers.push(`fix the ${d.type}`) }
    else if (st === 'missing') { stage(lbl, 'pending', `add ${d.type} ${d.name} -> ${d.value}`); blockers.push(`add the ${d.type}`) }
    else { stage(lbl, 'unchecked', `${d.type} ${d.name} -> ${d.value} (not checked yet — re-run check-domain)`); blockers.push(`${d.type} unchecked`) }
  }

  // Everything else the platform returned — a Let's Encrypt validation CNAME, any extra record.
  // Same rule, no exemption: an outstanding record is outstanding whatever its role.
  for (const d of records) {
    if (d === txt || isRouting(d)) continue
    const st = verdictOf(d)
    const lbl = d.type.toLowerCase()
    const where = `${d.name} -> ${d.value}${d.note ? `  (${d.note})` : ''}`
    if (st === 'ok') stage(lbl, 'ok', where)
    else if (st === 'mismatch') { stage(lbl, 'mismatch', `${d.type} ${d.name} must point at ${d.value}`); blockers.push(`fix the ${d.type} ${d.name}`) }
    else if (st === 'missing') { stage(lbl, 'pending', `add ${where}`); blockers.push(`add the ${d.type} ${d.name}`) }
    else { stage(lbl, 'unchecked', `${where} (not checked yet — re-run check-domain)`); blockers.push(`${d.type} ${d.name} unchecked`) }
  }

  const ssl = r.ssl ?? (r.configured ? 'active' : undefined)
  if (ssl === 'active') stage('certificate', 'active', '(edge TLS issued)')
  else if (ssl === 'external') stage('certificate', 'external', '(this plane manages no edge certificate for custom domains)')
  else if (ssl === undefined) { stage('certificate', 'pending', `(provider status: ${r.status})`); blockers.push('certificate') }
  else { stage('certificate', 'pending', `(${ssl} — issues once ownership is verified)`); blockers.push('certificate') }

  const resolve = domainResolveLine(r)
  out.push(resolve.line)
  // An error STATE is a blocker whether or not the plane sent a reason with it (cubic P2): a row
  // that says `error` has not been observed serving, and saying otherwise is the blackhole lie.
  if (r.status === 'error') {
    stage('error', r.status, r.errorReason || '(the plane reported an error state with no reason)')
    blockers.push('the plane reports an error state')
  } else if (r.errorReason) {
    stage('error', r.status, r.errorReason)
    blockers.push(r.errorReason)
  }

  // An unconfirmed routing target is one blocker among the others, not a headline that hides them:
  // a user fixing their DNS needs the whole outstanding list, not whichever item sorted first.
  if (!resolve.ready) blockers.push('confirm the routing target above')

  // `serving` is claimed only when every stage above agreed: the provider says configured, the
  // routing target is confirmed, and NOTHING is outstanding. A blocker beside a `configured: true`
  // answer means the record set and the verdict disagree — report the disagreement, never paper
  // over it with a URL the user would then trust (cubic P1).
  if (r.configured && blockers.length === 0) stage('serving', `https://${r.hostname}`, '')
  else stage('serving', 'not yet', blockers.length ? `(${blockers.join(', ')})` : `(${r.status})`)
  return out
}

// The platform's 409: the hostname is already bound elsewhere. Domains are never MOVED — the only
// path is unbind there, then bind here — so the hint names the release step. Three shapes:
//   owner named and present in this project → the exact remove-domain command;
//   owner named but NOT in this project's services → it is held by a deleted (or other-project)
//     service: an operator must release it (the plane has no self-serve orphan release yet);
//   owner not named (today's plane) → the generic release instruction.
// Pure, exported for tests.
export function domainConflictMessage(host: string, e: ApiError, services: ComputeRow[], ctx: DomainCmdCtx = {}): string {
  const m = /already attached to (\S+)(?: in (\S+))?;/.exec(e.message)
  const owner = m?.[1] && m[1] !== 'another' ? m[1] : undefined
  const region = m?.[2]
  // The release command must name the OWNER's group, and the branch the user is working on — a
  // command that defaults back to the linked branch would release nothing (cubic P2).
  const release = (group: string) => `insta compute remove-domain ${host}${flags({ group, branch: ctx.branch })}`
  if (owner) {
    const here = services.find((s) => s.type === 'compute' && s.name === owner)
    if (here) return `${host} is already attached to ${owner}${region ? ` (${region})` : here.region ? ` (${here.region})` : ''} — domains are not moved; release it first: ${release(owner)}, then re-run set-domain`
    return `${host} is already attached to ${owner}${region ? ` in ${region}` : ''}, which is not a service in this project — it is held by a deleted service (or one in another project); ask an operator to release the hostname before re-binding it`
  }
  return `${host} is already attached to another compute service — domains are not moved; release it there first (${release('<that service>')}) or, if that service was deleted, ask an operator to release the hostname`
}

// Resolve branch + target service, so every domain verb names the service AND its region, and an
// ambiguous project is refused with the list instead of the platform's `default` fallback picking
// one silently.
export async function domainTarget(api: DomainApi, projectId: string, branch: string | undefined, host: string, group?: string): Promise<{ target: ComputeRow; services: ComputeRow[] }> {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  return { target: resolveDomainTarget(services, host, group), services }
}

// The API surface these three verbs use, so the command-level flow — preflight service lookup,
// explicit `group` on every call, --json passthrough, 409 mapping — is testable without a network
// mock (r2d2 round 1 Suggestion). Production passes a real ApiClient.
export type DomainApi = Pick<ApiClient, 'request' | 'rawRequest'>
export type DomainDeps = { api: DomainApi; project: { projectId: string; orgId?: string; branch?: string } }
export async function domainDeps(deps?: DomainDeps): Promise<DomainDeps> {
  if (deps) return deps
  const [api, project] = [await ApiClient.load(), await requireProject()]
  return { api, project }
}

// Attach a developer-owned custom domain to a branch's compute service. The plane issues the edge
// cert + routes the hostname in the service's region; the platform returns the DNS records to set
// in your OWN zone, which are printed verbatim as the next step.
export async function setDomain(host: string, opts: Opts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target, services } = await domainTarget(api, p.projectId, branch, host, opts.group)
  const ctx: DomainCmdCtx = { group: target.name, branch: opts.branch }
  let res
  try { res = await api.rawRequest('POST', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch, group: target.name }) }
  catch (e) { throw e instanceof ApiError && e.status === 409 ? new Error(domainConflictMessage(host, e, services, ctx)) : e }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  for (const line of domainGuidanceLines(withRow(res.body, target), ctx)) info(line)
}

// Re-check a custom domain: every stage (ownership TXT, routing CNAME, edge certificate, where it
// resolves) and what each still needs.
export async function checkDomain(host: string, opts: Opts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target, services } = await domainTarget(api, p.projectId, branch, host, opts.group)
  const ctx: DomainCmdCtx = { group: target.name, branch: opts.branch }
  const qs = new URLSearchParams({ hostname: host, group: target.name })
  if (branch) qs.set('branch', branch)
  let r
  try { r = await api.request('GET', `/projects/${p.projectId}/compute/domain?${qs}`) }
  catch (e) { throw e instanceof ApiError && e.status === 409 ? new Error(domainConflictMessage(host, e, services, ctx)) : e }
  if (opts.json) return printJson(r)
  for (const line of domainStatusLines(withRow(r, target), ctx)) info(line)
}

export async function removeDomain(host: string, opts: Opts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target } = await domainTarget(api, p.projectId, branch, host, opts.group)
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch, group: target.name })
  if (handleApproval(res, opts.json)) return
  renderRemoveDomain(res.body, opts.json, target)
}

// An older platform answers without service/region; the CLI already holds the row it resolved the
// target from, so the human lines never lose the region. --json stays the platform body verbatim.
export function withRow(r: DomainView, row: ComputeRow): DomainView {
  return { ...r, service: r.service ?? row.name, region: r.region ?? row.region ?? null }
}

// Split out (same pattern as applyExecResult) so the --json contract — stdout carries the platform
// response, never prose — is unit-testable without a network mock.
export function renderRemoveDomain(body: any, json?: boolean, row?: ComputeRow): void {
  if (json) return printJson(body)
  const region = body.region ?? row?.region
  info(`removed custom domain ${body.hostname} from ${body.service ?? row?.name ?? body.flyApp}${region ? ` (${region})` : ''}`)
}

// ---- lifecycle (start/stop/suspend/restart/status) ----

type LifeOpts = { json?: boolean; branch?: string }
type LifeVerb = 'start' | 'stop' | 'suspend' | 'restart'
export type LifeBody = { service?: { name?: string; desired_state?: string; image?: string }; state?: string }

// The line a lifecycle verb prints. restart gets its own wording: `running` is a PRECONDITION of a
// restart (the platform refuses it in any other desired state), so echoing desired_state back says
// nothing — what the operator needs is which image came back up and whether it is live. Pure,
// exported for tests.
export function lifecycleLine(verb: LifeVerb, fallbackName: string, body: LifeBody): string {
  const name = body.service?.name ?? fallbackName
  if (verb === 'restart') {
    const image = body.service?.image ? ` on ${body.service.image}` : ''
    return `restarted compute ${name}${image} — env re-resolved from the current secrets (live: ${body.state})`
  }
  return `compute ${name}: ${verb} → desired=${body.service?.desired_state} (live: ${body.state})`
}

async function lifecycle(verb: LifeVerb, serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/${verb}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(lifecycleLine(verb, id, res.body))
}

export const computeStart = (service: string | undefined, opts: LifeOpts) => lifecycle('start', service, opts)
export const computeStop = (service: string | undefined, opts: LifeOpts) => lifecycle('stop', service, opts)
export const computeSuspend = (service: string | undefined, opts: LifeOpts) => lifecycle('suspend', service, opts)
export const computeRestart = (service: string | undefined, opts: LifeOpts) => lifecycle('restart', service, opts)

export async function computeStatus(serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/state`)
  if (opts.json) return printJson(r)
  info(`compute ${serviceName ?? id}: desired=${r.desiredState}  live=${r.state}`)
}

// ---- exec (one-shot command; no interactive shell/PTY) ----

// `insta compute exec [service] -- <command> [args…]`: the command must reach the platform
// byte-for-byte and can itself contain dashes or another `--`, so it can't be a normal commander
// positional — with `service` optional, commander flattens everything past the literal `--` into
// one operand list and has no way to tell "no service, command starts here" apart from "service IS
// the first command token". Splitting argv on the first literal `--` after `compute exec`
// ourselves, before commander ever parses it, removes the ambiguity; this is the only place in the
// whole CLI a bare `--` has this meaning, so nothing else is affected. Exported for a direct,
// network-free unit test — this split is the seam most likely to regress.
/** The options `insta compute exec` declares — the one source of truth. index.ts builds the
 *  commander command from this list, and the payload scan below uses it to know where the CLI's
 *  own arguments stop. Adding an option here reaches both. */
export const EXEC_OPTIONS: ReadonlyArray<readonly [flags: string, description?: string]> = [
  ['--branch <b>'],
  ['--timeout <sec>', 'command timeout in seconds, 1-180 (platform default: 30)'],
  ['--json'],
]

const names = (flags: string) => flags.split(/[ ,|]+/).filter((t) => t.startsWith('-'))
const TAKES_VALUE = new Set(EXEC_OPTIONS.filter(([f]) => /[<[]/.test(f)).flatMap(([f]) => names(f)))
const BARE = new Set(EXEC_OPTIONS.filter(([f]) => !/[<[]/.test(f)).flatMap(([f]) => names(f)))

const isExecOption = (t: string) =>
  TAKES_VALUE.has(t) || BARE.has(t) || (t.includes('=') && TAKES_VALUE.has(t.slice(0, t.indexOf('='))))
const isHelp = (t: string | undefined) => t === '--help' || t === '-h'

// Indices of the tokens after `compute exec` that are NOT this command's own options. Used twice,
// for two different questions, which is why it returns positions rather than a partition:
//   - how many operands sit ahead of a `--` (is that `--` where a real separator could be?)
//   - where the payload starts once the separator is gone
// Note what it is never used for: reaching INSIDE the payload. Past its first token the remote
// command may have begun, and `--json` there is the command's own argument, not ours.
function operandIndices(argv: string[], from: number, to: number = argv.length): number[] {
  const out: number[] = []
  for (let cursor = from; cursor < to; cursor++) {
    const token = argv[cursor]!
    if (TAKES_VALUE.has(token)) { cursor++; continue }
    if (isExecOption(token)) continue
    out.push(cursor)
  }
  return out
}

// Where does THIS process's `compute exec` command start? Only the command path counts: `compute`
// and `exec` appearing later are payload for something else — `insta run -- compute exec app echo`
// hands those words to a LOCAL child, and rewriting argv there would eat the child's last
// argument. argv[0] and argv[1] are the runtime and this script, verified to hold for the released
// Bun standalone binary too (its `process.argv` is `["bun", "/$bunfs/root/insta", …]`), which is
// the offset commander's own parse assumes. Returns -1 for "not ours".
function execCommandIndex(argv: string[]): number {
  for (let cursor = 2; cursor < argv.length; cursor++) {
    const token = argv[cursor]!
    if (token === '--agent') continue
    if (token.startsWith('-')) return -1 // a global flag, or `--`: either way not our command path
    return token === 'compute' && argv[cursor + 1] === 'exec' ? cursor : -1
  }
  return -1
}

// `insta compute exec [service] -- <command> [args…]`: the command must reach the platform
// byte-for-byte and can itself contain dashes or another `--`, so it cannot be a normal commander
// positional — with `service` optional, commander cannot tell "no service, command starts here"
// from "service IS the first command token". Splitting argv ourselves, before commander parses,
// removes the ambiguity. Exported for a direct, network-free unit test.
export function splitExecArgs(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; command?: string[]; windowsFallback?: boolean } {
  const i = execCommandIndex(argv)
  if (i === -1) return { argv }
  const dash = argv.indexOf('--', i + 2)
  if (dash !== -1) {
    // A separator that survived has at most ONE operand ahead of it — the optional service. Two or
    // more mean this `--` is the remote command's own: npm's PowerShell shim strips only the first,
    // so the real separator is already gone. Options are skipped wherever they sit, because with an
    // intact `--` everything ahead of it belongs to the CLI.
    if (platform !== 'win32' || operandIndices(argv, i + 2, dash).length <= 1) {
      return { argv: argv.slice(0, dash), command: argv.slice(dash + 1) }
    }
  }
  if (platform !== 'win32') return { argv }
  // The separator is gone. Everything from the first operand is PAYLOAD — the optional service plus
  // the remote command — and nothing inside it is touched, so the command keeps its own flags AND
  // its own `--json`/`--branch`. Options can only be recognised AHEAD of it; one stranded behind
  // the service is reported by resolveExecFallback rather than silently applied or dropped.
  const start = operandIndices(argv, i + 2)[0]
  if (start === undefined) return { argv } // nothing to recover; no service-list round-trip needed
  const payload = argv.slice(start)
  if (isHelp(payload[0])) return { argv } // `insta compute exec --help` — local, and never remote
  return { argv: argv.slice(0, start), command: payload, windowsFallback: true }
}

// The separator is gone, so the payload arrives undivided and only the service list can split it:
// `insta compute exec -- printenv PORT` and `insta compute exec printenv PORT` are byte-identical
// by the time they reach us. The reading taken is STATED on stderr — stdout stays clean for
// --json — because it is a guess in both directions: a service named `echo` would swallow the
// executable, and a mistyped service name is demoted to argv[0] and run remotely.
export function resolveExecFallback(
  services: Array<{ id: string; type: string; name: string }>,
  payload: string[],
  note: (msg: string) => void = (msg) => process.stderr.write(`${msg}\n`),
): { serviceName: string | undefined; command: string[] } {
  const [head, ...rest] = payload
  if (head === undefined) return { serviceName: undefined, command: [] }
  if (!services.some((service) => service.type === 'compute' && service.name === head)) {
    note(`note: no \`--\` separator was found and \`${head}\` is not a compute service, so it was read as the command. If \`${head}\` was the service, check the name with \`insta services list\`.`)
    return { serviceName: undefined, command: payload }
  }
  // `head` really is a service, so whatever follows it cannot be the command's first token.
  // A help flag there is a request for THIS command's help, which commander already answered for
  // every other shape; say where to get it rather than exec `-h` on the machine.
  if (isHelp(rest[0])) throw new Error(`\`${rest[0]}\` after a service name is not a command — run \`insta compute exec --help\` for this command's help, or \`--\` before a remote command`)
  // A CLI option there landed on the wrong side of a separator that is not present. It cannot be
  // honoured this late — --branch and --timeout are already spent by the time the service list
  // arrives — so it is reported instead of being silently dropped or exec'd as a program.
  if (rest[0]?.startsWith('-')) {
    throw new Error(`no \`--\` separator was found before \`${rest[0]}\` — put CLI options ahead of [service], or add \`--\` before the command: insta compute exec ${head} -- <command> [args…]`)
  }
  // The reading is a guess in both directions — a service named `echo` would swallow the
  // executable — so state it. The escape hatch names insta.cmd: pasting a plain `--` back into the
  // same PowerShell session would be eaten exactly as the first one was. The command itself is NOT
  // echoed; remote argv can carry tokens and passwords, and the user already has it on screen.
  if (rest.length > 0) {
    note(`note: no \`--\` separator was found; read \`${head}\` as the compute service. If \`${head}\` was part of the command, re-run it through insta.cmd, which keeps \`--\`: insta.cmd compute exec -- <command>`)
  }
  return { serviceName: head, command: rest }
}

// The --timeout override, through a throwing parser like every other user-typed number in this
// repo (parseCpu, parseCount, parsePort): junk must fail locally instead of reaching the server as
// NaN, and the bounds mirror what the platform enforces (1-180s; server default 30 when omitted).
export function parseTimeoutSec(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 180) throw new Error(`invalid timeout: ${raw} (1-180 seconds)`)
  return n
}

// Map exec inputs to the platform POST body. Pure, unit-tested without a network mock (mirrors
// deployRequestBody / servicesAddRequestBody). timeoutSec is omitted when not given so the server
// applies its own default (30s) rather than the client picking one on the wire.
export function execRequestBody(command: string[], timeoutSec?: number): Record<string, unknown> {
  return { command, ...(timeoutSec !== undefined ? { timeoutSec } : {}) }
}

type ExecOpts = LifeOpts & { timeout?: string }
type ExecRecovery = { windowsFallback?: boolean }

// Renders the exec response and sets process.exitCode — split out of computeExec as a pure function
// of (res, json) so it's unit-testable without a network mock, same as handleApproval's own
// {status, body} shape.
//
// A 202 means the command has NOT run: handleApproval owns the whole contract (hint on stderr,
// raw envelope on stdout with --json, exit 2), so a caller chaining `insta compute exec … && next`
// can never mistake a pending gate for the command having succeeded — and exit 2 stays
// distinguishable from the remote command's own exit 1.
export function applyExecResult(res: { status: number; body: any }, json?: boolean): void {
  if (handleApproval(res, json)) return
  const { exitCode, stdout, stderr, truncated } = res.body
  if (json) {
    printJson(res.body)
  } else {
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    if (truncated) process.stderr.write('note: output truncated — the platform caps stdout/stderr at 1 MiB each\n')
  }
  // The platform sends -1 as an "unknown exit" sentinel, and nothing outside 0-255 is a valid POSIX
  // exit code. Assigning it straight to process.exitCode risks Node's own DEP0164 (a negative code
  // silently exits 255) — clamp out-of-range codes to 1 instead, with a one-line note so the cause is
  // visible. Normal codes pass through untouched.
  if (exitCode < 0 || exitCode > 255) {
    process.stderr.write(`note: remote exit code ${exitCode} out of range — exiting 1\n`)
    relayExitCode(1)
  } else {
    relayExitCode(exitCode)
  }
}

// One HTTP round trip, not a shell session: no PTY, no interactivity, stdout/stderr come back as
// two whole strings (each capped at 1 MiB server-side) rather than a stream. They're written to
// this process's own stdout/stderr verbatim — no prefixes, no added newline — and the remote exit
// code becomes this process's own exit code (--json still passes it through, it just skips the
// split-stream output), since agents scripting this rely on it. Waking a scaled-to-zero machine is
// expected — it adds latency and bills as uptime, it is not an error.
export async function computeExec(
  serviceName: string | undefined,
  command: string[] | undefined,
  opts: ExecOpts,
  recovery: ExecRecovery = {},
): Promise<void> {
  if (!recovery.windowsFallback && (!command || command.length === 0)) {
    throw new Error('usage: insta compute exec [service] -- <command> [args…] (see --help)')
  }
  const timeoutSec = opts.timeout !== undefined ? parseTimeoutSec(opts.timeout) : undefined
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const target = recovery.windowsFallback
    ? resolveExecFallback(services, command ?? [])
    : { serviceName, command }
  if (!target.command || target.command.length === 0) {
    throw new Error('usage: insta compute exec [service] -- <command> [args…] (see --help)')
  }
  const id = resolveComputeServiceId(services, target.serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/exec`, execRequestBody(target.command, timeoutSec))
  applyExecResult(res, opts.json)
}

// ---- always-on (opt out of scale-to-zero; all plans; billing is actual usage either way) ----

export async function computeAlwaysOn(mode: string, serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  if (mode !== 'on' && mode !== 'off') throw new Error('mode must be on|off')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/always-on`, { enabled: mode === 'on' })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const on = res.body.service?.always_on
  info(`compute ${res.body.service?.name ?? id}: always-on ${on ? 'ENABLED — machines stay warm (no cold starts; idle RAM bills at actual usage)' : 'disabled — scales to zero when idle'}`)
}

// ---- limits (the resource ceiling; paid plans) ----

// Parse a human memory value into MB: "512", "512mb", "1gb", "2g", "1.5gb".
// Exported for unit tests — this is the only place a user-typed size becomes a number.
export function parseMemoryMb(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gi|gib|m|mb|mi|mib)?\s*$/i.exec(raw)
  if (!m) throw new Error(`invalid memory: ${raw} (try 512mb, 1gb, 2gb)`)
  const n = Number(m[1])
  const unit = (m[2] ?? 'mb').toLowerCase()
  const mb = unit.startsWith('g') ? n * 1024 : n
  if (!(mb > 0)) throw new Error(`invalid memory: ${raw}`)
  return Math.round(mb)
}

// Whole and half GB collapse (1536 → "1.5 GB"); anything else stays exact in MB — a display that
// rounds 1536 to "2 GB" claims a ceiling the API did not set.
export const fmtMb = (mb: number) => (mb >= 1024 && mb % 512 === 0 ? `${mb / 1024} GB` : `${mb} MB`)

// The --cpu override, through a throwing parser like every other user-typed number in this repo
// (parseCount, parseMemoryMb). A bare Number() turns a typo into NaN, which JSON.stringify
// serializes as null — the server then sees {cpu: null} instead of the user seeing an error.
// Enforces the provider grid the help text advertises: the server would reject 100 anyway, but a
// value the client KNOWS is invalid should fail locally, matching what --help promises.
const CPU_SIZES = [1, 2, 4, 6, 8]
export function parseCpu(raw: string): number {
  const n = Number(raw)
  if (!CPU_SIZES.includes(n)) throw new Error(`invalid cpu: ${raw} (provider sizes: ${CPU_SIZES.join(', ')})`)
  return n
}

// ---- volume (the persistent /data disk; attach any time, grow-only, deletable; never detach) ----

// Render the volume read. Pure, exported for tests (mirrors serviceListLine). Every plan may view;
// only growth is paid — that gate is the backend's to enforce, so nothing here pre-blocks.
export function volumeLines(name: string, volume: { sizeGib: number; mountPath: string } | null, cap: { volumeGib: number }): string[] {
  if (!volume) return [
    `compute ${name}: no volume attached (attach one: \`insta compute volume ${name} --size <gi>\` — it mounts at /data on the next deploy)`,
  ]
  return [
    `compute ${name}: volume ${volume.sizeGib}Gi at ${volume.mountPath}  (plan max ${cap.volumeGib}Gi)`,
    '  billing is actual data stored — the size is a cap, not a price; grow with --size (grow-only), delete with --delete (destroys the data)',
  ]
}

// Render the PUT result. Pure, exported for tests. `attached` comes from the backend and is what
// tells a FIRST attach (no disk yet — it mounts on the next deploy) apart from a grow (the live
// disk was already extended); the wire size is authoritative in both cases.
export function volumeWriteLine(name: string, body: { volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean }): string {
  if (body.attached) {
    return `compute ${name}: volume ${body.volume.sizeGib}Gi attached — mounts at ${body.volume.mountPath} on the next deploy  (plan max ${body.cap.volumeGib}Gi)`
  }
  return `compute ${name}: volume grown to ${body.volume.sizeGib}Gi at ${body.volume.mountPath}  (plan max ${body.cap.volumeGib}Gi)`
}

// Render the DELETE result. Pure, exported for tests. Deleting is the only way off the volume
// path (there is no detach), so the line says what came back with it: the two constraints the
// volume imposed.
export function volumeDeleteLine(name: string): string {
  return `compute ${name}: volume deleted — the disk and its data are gone; suspend fast-wake and scale-out are back`
}

// Map a DELETE .../volume failure. Pure, exported for tests (r2d2 review rounds 1+2: this is the
// close-call branch worth pinning). An older backend has no DELETE route, and what its 404 looks
// like depends on who answered: the real platform (Fastify, no custom notFound handler) sends its
// default body {"message":"Route DELETE:/… not found","error":"Not Found"} → ApiError message
// "Not Found"; a proxy or bodyless 404 leaves ApiError's own "HTTP 404" fallback. BOTH are the
// generic route-miss shape and mean version skew, not a bug — parroting them would send the user
// hunting the wrong thing. A backend that HAS the route names the real problem in a DOMAIN
// message ("this service has no volume", …), which must flow verbatim, 404 or not.
const GENERIC_404 = /^(HTTP 404|Not Found)$/i
export function volumeDeleteError(e: unknown): unknown {
  if (e instanceof ApiError && e.status === 404 && GENERIC_404.test(e.message.trim())) {
    return new Error('this backend does not support volume delete yet — update the platform, or delete the service to remove its volume')
  }
  return e
}

type VolumeOpts = LifeOpts & { size?: string; delete?: boolean }

// Show, attach, grow, or delete a compute service's /data volume. No flag: a safe read (size +
// mount path + the plan cap). --size: PUT .../volume — attaches when no volume exists, grows
// otherwise. --delete: DELETE .../volume — destroys the disk and its data immediately (no detach,
// no undo; billing stops now). The paid/cap/machine-count gates all belong to the backend, whose
// 403/400 messages carry the upgrade hints and must reach the user verbatim (the guard prints
// ApiError messages as-is).
export async function computeVolume(serviceName: string | undefined, opts: VolumeOpts): Promise<void> {
  if (opts.delete && opts.size) throw new Error('--delete cannot be combined with --size (one changes the volume, the other destroys it)')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)

  if (opts.delete) {
    let res
    try { res = await api.rawRequest('DELETE', `/projects/${p.projectId}/services/${id}/volume`) }
    catch (e) { throw volumeDeleteError(e) }
    if (handleApproval(res, opts.json)) return
    if (opts.json) return printJson(res.body)
    info(volumeDeleteLine(res.body.service?.name ?? serviceName ?? id))
    return
  }

  if (!opts.size) {
    const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/volume`)
    if (opts.json) return printJson(r)
    for (const line of volumeLines(serviceName ?? id, r.volume, r.cap)) info(line)
    return
  }

  const sizeGib = parseVolumeGib(opts.size)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/volume`, { sizeGib })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(volumeWriteLine(res.body.service?.name ?? serviceName ?? id, res.body))
}

type LimitsOpts = LifeOpts & { cpu?: string; memory?: string }

// Show or set a compute service's ceiling. With no --memory it PRINTS the current limits and the
// plan cap (so `insta compute limits` is a safe read), which is also what a UI renders as a slider
// with its plan-limit marker.
export async function computeLimits(serviceName: string | undefined, opts: LimitsOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)

  if (!opts.memory && !opts.cpu) {
    const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/limits`)
    if (opts.json) return printJson(r)
    info(`compute ${serviceName ?? id}: ceiling ${r.limits.cpu} vCPU / ${fmtMb(r.limits.memoryMb)}  (plan max ${r.cap.cpu} vCPU / ${fmtMb(r.cap.memoryMb)})`)
    info('  billing is actual usage — the ceiling caps what the app may burn, it is not a price')
    return
  }
  if (!opts.memory) throw new Error('--memory is required when setting limits (cpu is derived from it; pass --cpu only to override)')

  const body: Record<string, unknown> = { memoryMb: parseMemoryMb(opts.memory) }
  if (opts.cpu) body.cpu = parseCpu(opts.cpu)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/limits`, body)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const l = res.body.limits
  info(`compute ${res.body.service?.name ?? id}: ceiling set to ${l.cpu} vCPU / ${fmtMb(l.memoryMb)}`)
}

// ---- ssh (interactive sessions) --------------------------------------------

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  aliasFor, isSafeAlias, isSafeConfigValue, isSafeSSHHost, isSafeSSHUsername, isSafeTimestamp, isSSHCertificateRecord, mayWidenCAHost, parseCAPublicKey, renderConfigBlock, upsertCertAuthority, upsertConfigBlock, type HostEntry,
} from './ssh-config.js'

/** Where this CLI keeps its own SSH material. Deliberately NOT ~/.ssh: we never
 *  touch a key the user already had, and a dedicated key pairs with
 *  IdentitiesOnly to avoid being identified by the wrong one. */
export const instaSSHDir = () => join(homedir(), '.insta', 'ssh')
export const instaKeyPath = () => join(instaSSHDir(), 'id_ed25519')
/** One certificate file per alias. A certificate is issued for ONE service, so
 *  a single shared file cannot serve a project with two compute services. */
export const instaCertPath = (alias: string) => join(instaSSHDir(), `${alias}-cert.pub`)
export const instaAliasStorePath = () => join(instaSSHDir(), 'aliases.json')

/** The renewal-hook command prefix. ssh-config.ts appends the validated alias. */
export const ENSURE_CERT_COMMAND = 'insta __ssh-ensure-cert'

type SSHOpts = LifeOpts & { setup?: boolean; ensureCert?: string; json?: boolean }

/** What an alias stands for. The renewal hook is handed nothing but the alias —
 *  no positional argument, no guarantee the cwd is even a linked project — so
 *  everything needed to re-issue THE SAME certificate has to be recorded here. */
export type AliasRecord = {
  projectId: string
  /** The branch the alias was set up on, when the project had one.
   *
   *  Collision identity, NOT addressing: renewal reaches the service through
   *  projectId + serviceId, which names it outright, so the branch is never
   *  part of the mint request. It exists for assertAliasFree, where it is the
   *  only thing telling two same-named services on two branches of one project
   *  apart -- without it the second `--setup` silently repoints the alias. */
  branch?: string
  serviceId: string
  host: string
  username: string
}

export type AliasStore = Record<string, AliasRecord>

/** Never throws: a missing or hand-mangled store must degrade to "nothing is
 *  set up", not break `ssh` for every alias. */
export function readAliasStore(path = instaAliasStorePath()): AliasStore {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Each RECORD is validated, not just the outer object. A cast here let a
    // single hand-edited entry through to hostEntries, where a missing host
    // rendered `HostName undefined` -- and one bad stanza is enough for
    // OpenSSH to reject the whole file, so every OTHER alias stopped working
    // too. Dropping the bad entry keeps the blast radius at the entry.
    const out: AliasStore = {}
    for (const [alias, r] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidAliasRecord(r)) out[alias] = r
    }
    return out
  } catch {
    return {}
  }
}

/** Whether a stored record can still describe a working alias. */
export function isValidAliasRecord(r: unknown): r is AliasRecord {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  const v = r as Record<string, unknown>
  return typeof v.projectId === 'string' && v.projectId !== ''
    && typeof v.serviceId === 'string' && v.serviceId !== ''
    && (v.branch === undefined || typeof v.branch === 'string')
    && isSafeConfigValue(v.host) && isSafeConfigValue(v.username)
}

/** Refuse to point an existing alias at a different service.
 *
 *  An alias is derived from the SERVICE NAME alone, which is unique only within
 *  a branch. Two projects that each call a service `api` -- the ordinary case,
 *  not a contrived one -- would otherwise have the second setup silently
 *  repoint `api.insta` at the first one's host, and the developer would land a
 *  shell in the WRONG PROJECT while every visible signal said the command
 *  worked. Refused by name rather than auto-renamed: picking which `api` they
 *  meant is the same guess one level up.
 */
export function assertAliasFree(
  store: AliasStore,
  alias: string,
  want: { projectId: string; serviceId: string; branch?: string },
): void {
  const held = store[alias]
  if (!held) return
  const same = held.projectId === want.projectId
    && held.serviceId === want.serviceId
    && (held.branch ?? '') === (want.branch ?? '')
  if (same) return
  throw new Error(
    `the alias ${alias} is already set up for a different service ` +
    `(project ${held.projectId}, service ${held.serviceId}${held.branch ? `, branch ${held.branch}` : ''}).\n` +
    `Rename one of the services, or remove "${alias}" from ${instaAliasStorePath()} and run --setup again.`,
  )
}

export function writeAliasStore(store: AliasStore, path = instaAliasStorePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileAtomicSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

/** The ssh_config entries for everything set up so far. Rendered from the whole
 *  store, not just the service being set up: our block is replaced wholesale,
 *  so rendering one entry would delete the stanzas of every other service. */
export function hostEntries(store: AliasStore): HostEntry[] {
  return Object.entries(store)
    // Both halves, and the second is not redundant with readAliasStore: this
    // function is also called with a store held in memory, so the check has to
    // sit where the rendering does.
    .filter(([alias, r]) => isSafeAlias(alias) && isValidAliasRecord(r))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, r]) => ({ alias, hostName: r.host, user: r.username, certificateFile: instaCertPath(alias) }))
}

/**
 * When `ssh-keygen -L` output says the certificate stops being valid, or
 * `undefined` when that cannot be established.
 *
 * `undefined` is not "valid forever". Both the no-match case and a date the
 * platform formats differently have to read as "cannot confirm", because a
 * NaN comparison is false and would otherwise pass for healthy.
 */
export function parseCertValidUntil(keygenOutput: string): number | undefined {
  const m = /Valid:.*to (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(keygenOutput)
  if (!m || !m[1]) return undefined
  const until = new Date(m[1]).getTime()
  return Number.isNaN(until) ? undefined : until
}

/** Reads a certificate's validity. Injected in tests; ssh-keygen in production. */
export type CertReader = (certPath: string) => string

const sshKeygenReadCert: CertReader = (certPath) =>
  execFileSync('ssh-keygen', ['-L', '-f', certPath], { encoding: 'utf8' })

/**
 * Whether the certificate at `certPath` should be re-issued.
 *
 * Every uncertain case renews. "Cannot confirm it is valid" and "it is valid"
 * must not collapse into the same answer: an unnecessary renewal costs one
 * HTTPS call, and the opposite costs a login that fails with no explanation.
 */
export function certNeedsRenewal(
  certPath: string,
  { now = Date.now(), marginMs = 5 * 60_000, read = sshKeygenReadCert }: { now?: number; marginMs?: number; read?: CertReader } = {},
): boolean {
  if (!existsSync(certPath)) return true
  try {
    const until = parseCertValidUntil(read(certPath))
    if (until === undefined) return true
    return until - marginMs <= now
  } catch {
    return true
  }
}

function ensureKeyPair(): string {
  const dir = instaSSHDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = instaKeyPath()
  if (!existsSync(key)) {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'insta compute ssh', '-f', key], { stdio: 'pipe' })
  }
  chmodSync(key, 0o600)
  return readFileSync(key + '.pub', 'utf8').trim()
}

type CertResponse = { certificate: string; host: string; username: string; expiresAt: string; caPublicKey?: string }

async function mintCert(api: ApiClient, projectId: string, serviceId: string, publicKey: string, alias: string, signal?: AbortSignal): Promise<CertResponse> {
  const res = await api.rawRequest('POST', `/projects/${projectId}/services/${serviceId}/ssh-cert`, { publicKey }, { signal })
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, res.body?.error ?? 'could not issue an ssh certificate')
  }
  // Validated BEFORE the write, not after. The certificate file is the live
  // credential for an alias that may already be working, so a response we go
  // on to reject must not have replaced it on the way -- the caller would be
  // left with an error message and a broken alias. Same ordering rule as the
  // collision check: nothing is written until the whole response is known-good.
  const out = validateCertResponse(res.body)
  installCertificate(instaCertPath(alias), out.certificate.trim() + '\n')
  return out
}

/** Everything the plane returns that we will write into ~/.ssh or ~/.insta. */
export function validateCertResponse(body: unknown): CertResponse {
  const b = (body ?? {}) as Record<string, unknown>
  // The CONTENT, not merely the presence. A non-empty string was enough to
  // replace a working alias's live credential with something OpenSSH cannot
  // parse -- failing later, inside ssh, with a message pointing at the file
  // rather than at the plane that sent it.
  if (!isSSHCertificateRecord(b.certificate)) {
    throw new Error('the platform did not return a usable ssh certificate')
  }
  if (!isSafeConfigValue(b.host) || !isSafeSSHHost(b.host)) {
    throw new Error(`the platform returned an unusable ssh host: ${JSON.stringify(String(b.host).slice(0, 64))}`)
  }
  // Principal syntax, which above all excludes a leading `-`: the printed
  // command is argv for `ssh`, and `ssh` parses its own options no matter how
  // the shell quoted them.
  if (!isSafeSSHUsername(b.username)) {
    throw new Error(`the platform returned an unusable ssh username: ${JSON.stringify(String(b.username).slice(0, 64))}`)
  }
  // Printed straight to a terminal, so control characters and escape sequences
  // are refused rather than rendered.
  if (!isSafeTimestamp(b.expiresAt)) throw new Error('the platform returned an unusable certificate expiry')
  // Parsed here rather than at install time so a malformed key fails before
  // anything is written, instead of after the alias is already recorded.
  if (b.caPublicKey !== undefined) parseCAPublicKey(b.caPublicKey)
  return b as CertResponse
}

/** Verifies a certificate FILE. Injected in tests; ssh-keygen in production.
 *  Throws when the file is not a certificate OpenSSH can parse. */
export type CertVerifier = (certPath: string) => void

const sshKeygenVerifyCert: CertVerifier = (certPath) => {
  execFileSync('ssh-keygen', ['-L', '-f', certPath], { stdio: 'ignore' })
}

/**
 * Write a certificate into place only once OpenSSH agrees it is one.
 *
 * The structural decode in isSSHCertificateRecord reads the blob's first field
 * and stops. That rejects arbitrary base64, and it still accepts a blob whose
 * type name is right and whose remaining bytes are noise -- there is no nonce,
 * public key, serial, principal list, validity window or signature behind it.
 * Such a response would replace a WORKING alias's live credential and fail
 * later inside ssh, which is exactly the preservation guarantee this command
 * makes.
 *
 * So the authority is `ssh-keygen -L`, run against a temporary file, and the
 * real file is only replaced once it passes. Spawning it here costs nothing
 * new: certNeedsRenewal already runs the same binary on this same path, every
 * time a certificate exists. (An earlier round declined this on the grounds
 * that a subprocess did not belong on the renewal path -- that reasoning was
 * simply wrong about what the path already does.)
 *
 * A missing ssh-keygen is a REFUSAL, not a pass: it means we cannot confirm,
 * and an unconfirmable certificate must not displace one that works. Nothing
 * is lost by it either -- without OpenSSH installed the certificate has no
 * consumer.
 */
export function installCertificate(certPath: string, contents: string, verify: CertVerifier = sshKeygenVerifyCert): void {
  mkdirSync(dirname(certPath), { recursive: true, mode: 0o700 })
  // Followed to its target, for the same reason writeFileAtomicSync does it:
  // rename(2) replaces the LINK, so a certificate someone symlinked into a
  // dotfiles repo would be severed on the first renewal -- quietly, and only
  // on the path that runs unattended.
  const target = resolveThroughSymlink(certPath)
  const staging = `${target}.staging-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(staging, contents, { mode: 0o644 })
    try {
      verify(staging)
    } catch (e) {
      const why = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? 'ssh-keygen is not installed, so the certificate cannot be checked'
        : 'the platform returned a certificate OpenSSH cannot parse'
      throw new Error(`${why} — the existing certificate was left untouched`)
    }
    renameSync(staging, target)
  } finally {
    try { unlinkSync(staging) } catch { /* moved into place, or never created */ }
  }
}

/** One line covers every node in every region, which is the whole reason for a
 *  host CA: the TOFU alternative is a fingerprint per node and a REMOTE HOST
 *  IDENTIFICATION HAS CHANGED for a random fraction of reconnects behind a load
 *  balancer. Re-run on every renewal too, so a rotated CA is trusted before the
 *  retired one stops signing rather than at the user's next `--setup`. */
function installCertAuthority(hostPattern: string, caPublicKey: string): void {
  const knownHosts = join(homedir(), '.ssh', 'known_hosts')
  mkdirSync(dirname(knownHosts), { recursive: true, mode: 0o700 })
  const existing = existsSync(knownHosts) ? readFileSync(knownHosts, 'utf8') : ''
  writeFileAtomicSync(knownHosts, upsertCertAuthority(existing, hostPattern, caPublicKey), { mode: 0o600 })
}

function installConfigBlock(store: AliasStore): void {
  const cfg = join(homedir(), '.ssh', 'config')
  mkdirSync(dirname(cfg), { recursive: true, mode: 0o700 })
  const existing = existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''
  const block = renderConfigBlock({
    entries: hostEntries(store),
    identityFile: instaKeyPath(),
    ensureCertCommand: ENSURE_CERT_COMMAND,
  })
  // Backed up: this is the file that decides whether the user can ssh anywhere
  // at all, and our block goes at the TOP of it.
  writeFileAtomicSync(cfg, upsertConfigBlock(existing, block), { mode: 0o600, backup: true })
}

/**
 * The renewal hook OpenSSH runs while PARSING the config, before it connects.
 *
 * Two properties, both load-bearing, and both about the fact that this runs on
 * EVERY ssh invocation — including `scp`, `ssh -G` and an IDE's connections:
 *
 *  - Cheap when there is nothing to do. The local certificate is checked FIRST;
 *    a valid one returns before any config, project or API work happens. This
 *    is also why the config block invokes the HIDDEN `__ssh-ensure-cert`
 *    command rather than `compute ssh --ensure-cert`: `guard` awaits
 *    trackCommand() after every action, which reads global and project config,
 *    can create ~/.insta/telemetry.json and issues a PostHog request with a
 *    timeout of up to 1.5s. Returning early from the action does not skip any
 *    of that. Telemetry already skips command paths beginning `__` (the same
 *    rule __update-check relies on), so the fast path is genuinely local only
 *    when the hook enters through that name.
 *  - Silent and fail-safe. An unlinked directory, an expired login or a network
 *    outage must not print anything or fail the parse: the existing certificate
 *    stays in place and the login then fails with SSH's own message, not a CLI
 *    error spliced into the middle of an ssh session.
 */
export async function ensureCertForAlias(alias: string, timeoutMs = RENEWAL_REQUEST_TIMEOUT_MS): Promise<void> {
  let release: (() => void) | undefined
  try {
    if (!isSafeAlias(alias)) return
    if (!certNeedsRenewal(instaCertPath(alias))) return

    // An IDE opens several connections at once and `scp` adds more, so the
    // near-expiry certificate is observed by every one of them simultaneously
    // and each would mint its own replacement -- redundant requests against a
    // rate-limited endpoint, racing each other's known_hosts writes.
    //
    // NON-BLOCKING on purpose: losing the race returns immediately rather than
    // waiting. This runs inside OpenSSH's config parse, so a lock that waits is
    // a lock that can hang `ssh` itself -- strictly worse than the duplicate
    // request it would prevent. The loser simply lets the winner renew.
    release = acquireRenewalLock(alias)
    if (!release) return
    // Re-checked after the lock. Without this the second process through the
    // door renews again over the certificate the first just wrote -- the lock
    // would serialise the stampede instead of collapsing it.
    if (!certNeedsRenewal(instaCertPath(alias))) return

    // The alias is the ONLY input: it carries the project, branch and service
    // the certificate was issued for, so renewal cannot drift to another one.
    const rec = readAliasStore()[alias]
    if (!rec) return
    const api = await ApiClient.load()
    // A DEADLINE, because this runs inside OpenSSH's config parse. A server
    // that accepts the connection and then says nothing would otherwise block
    // ssh, scp, `ssh -G` and every IDE connection for as long as it liked --
    // the catch below only helps once the request has actually rejected.
    // AbortSignal rather than a Promise.race: a race returns while leaving the
    // socket open, so the process lingers anyway.
    const out = await mintCert(api, rec.projectId, rec.serviceId, ensureKeyPair(), alias, AbortSignal.timeout(timeoutMs))
    if (out.caPublicKey) installCertAuthority(hostPatternFor(out.host), out.caPublicKey)
  } catch {
    // Deliberately swallowed. See above.
  } finally {
    release?.()
  }
}

/** Renewal timeout. A lock older than this belonged to a process that died
 *  holding it; without a staleness rule one crash would disable renewal for
 *  that alias permanently, which is a worse failure than a duplicate mint. */
const RENEWAL_LOCK_STALE_MS = 60_000

/** How long the renewal request may take before it is abandoned. Sized for the
 *  path it sits on: OpenSSH is parsing its config and the user is waiting, so a
 *  renewal that cannot finish quickly is better skipped -- the existing
 *  certificate is still in place and the login proceeds on it. */
const RENEWAL_REQUEST_TIMEOUT_MS = 5_000

/** Take the per-alias renewal lock, or return undefined if someone else holds
 *  a fresh one. Never waits — see the call site. */
export function acquireRenewalLock(alias: string, now = Date.now()): (() => void) | undefined {
  const path = join(instaSSHDir(), `${alias}.renew.lock`)
  const take = (): (() => void) | undefined => {
    // A token, not just the pid. A renewal slower than the staleness window
    // has its lock broken by the next caller; without an ownership check the
    // original holder's release would then delete the NEW holder's lock,
    // leaving the file unlocked while two renewals ran -- the lock defeating
    // itself precisely when it is under load.
    const token = `${process.pid}:${randomUUID()}`
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      // wx is the atomic part: exclusive create fails if the file exists, so
      // exactly one process can win regardless of how many arrive together.
      writeFileSync(path, token, { flag: 'wx', mode: 0o600 })
      return () => {
        try {
          if (readFileSync(path, 'utf8') === token) unlinkSync(path)
        } catch { /* already gone, or taken over by someone else */ }
      }
    } catch {
      return undefined
    }
  }
  const held = take()
  if (held) return held
  try {
    if (now - statSync(path).mtimeMs < RENEWAL_LOCK_STALE_MS) return undefined
    unlinkSync(path)
  } catch {
    return undefined
  }
  return take()
}

/** Side-effect seams, following the `TrackDeps` convention used by telemetry.
 *  Present so the ORDER of operations is testable: the two defects this seam
 *  exists for -- minting before the collision check, and advertising a command
 *  that cannot use the credential -- are both invisible to a test of any single
 *  step, and both shipped past unit tests of every piece. */
export type SSHDeps = {
  mint?: typeof mintCert
  loadApi?: () => Promise<ApiClient>
  loadProject?: typeof requireProject
  installCA?: typeof installCertAuthority
  installConfig?: typeof installConfigBlock
  emit?: (line: string) => void
}

export async function computeSSH(serviceName: string | undefined, opts: SSHOpts, deps: SSHDeps = {}): Promise<void> {
  if (opts.ensureCert !== undefined) return ensureCertForAlias(opts.ensureCert)

  const mint = deps.mint ?? mintCert
  const emit = deps.emit ?? info
  const api = await (deps.loadApi ?? ApiClient.load)()
  const p = await (deps.loadProject ?? requireProject)()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const svc = resolveSoleService(services as ComputeRow[], 'compute', serviceName)
  const alias = aliasFor(svc.name)

  // BEFORE the mint, and the order is the fix. mintCert writes
  // `<alias>-cert.pub` as part of succeeding, so checking afterwards meant a
  // collision had already overwritten the certificate of the alias it was
  // about to refuse -- the previously working `api.insta` could no longer
  // authenticate, and the command that broke it exited with an error saying it
  // had done nothing. Nothing is written until the alias is known to be ours.
  const store = readAliasStore()
  assertAliasFree(store, alias, { projectId: p.projectId, serviceId: svc.id, branch })

  const out = await mint(api, p.projectId, svc.id, ensureKeyPair(), alias)
  // --setup PROMISES a trust anchor, so a response without one cannot be
  // reported as configured. Skipping installCA and carrying on left plain
  // `ssh`/`scp` facing a host-key prompt on every new node behind the load
  // balancer -- the exact failure the anchor exists to prevent -- while the
  // command printed the short alias and claimed success. Checked before
  // anything is installed, so the refusal is clean.
  if (opts.setup && !out.caPublicKey) {
    throw new Error(
      'the platform did not return an ssh certificate authority key, so `--setup` cannot install the trust anchor it promises.\n' +
      'Retry, and contact support if it persists; the certificate itself was issued and `insta compute ssh ' + svc.name + '` still prints a usable command.',
    )
  }

  store[alias] = { projectId: p.projectId, ...(branch ? { branch } : {}), serviceId: svc.id, host: out.host, username: out.username }
  writeAliasStore(store)

  if (opts.setup) {
    // upsertCertAuthority parses the key and refuses a bad one, so a hostile or
    // malformed response fails HERE instead of appending lines to known_hosts.
    if (out.caPublicKey) (deps.installCA ?? installCertAuthority)(hostPatternFor(out.host), out.caPublicKey)
    ;(deps.installConfig ?? installConfigBlock)(store)
  }

  if (opts.json) return printJson({ alias, host: out.host, username: out.username, expiresAt: out.expiresAt, configured: !!opts.setup })
  for (const line of sshAdvice({
    alias, host: out.host, username: out.username, expiresAt: out.expiresAt, serviceName: svc.name,
    configured: !!opts.setup, identityFile: instaKeyPath(), certificateFile: instaCertPath(alias),
  })) emit(line)
}

/** What to tell the user once the certificate is in hand.
 *
 *  Split out from computeSSH because the choice is the whole point and the
 *  orchestration around it is network glue (untested here, as in
 *  computeStart/computeExec/computeVolume). The rule: only advertise the alias
 *  when the alias was actually INSTALLED. Without --setup nothing was written
 *  to ssh_config, so `ssh api.insta` does not resolve -- printing it anyway is
 *  advice that fails on first use and reads as a broken feature rather than a
 *  skipped step.
 */
export function sshAdvice(r: {
  alias: string; host: string; username: string; expiresAt: string; serviceName: string; configured: boolean
  identityFile: string; certificateFile: string
}): string[] {
  const head = r.configured
    ? [`ssh ${r.alias}  →  ${r.username}@${r.host}`]
    : [
        // Every option here is load-bearing. The key lives at
        // ~/.insta/ssh/id_ed25519 and the certificate at <alias>-cert.pub;
        // NEITHER is a path OpenSSH looks in by default, so a bare
        // `ssh user@host` offers the user's own keys and not the credential
        // this command just issued -- it fails, having printed success.
        // IdentitiesOnly stops a loaded agent from spending the server's
        // MaxAuthTries on unrelated keys before ours is ever tried.
        `ssh -i ${shQuote(r.identityFile)} -o CertificateFile=${shQuote(r.certificateFile)} -o IdentitiesOnly=yes ${shQuote(`${r.username}@${r.host}`)}`,
        `  run \`insta compute ssh ${r.serviceName} --setup\` once for the shorter \`ssh ${r.alias}\`, automatic renewal, and scp/-L support`,
      ]
  return [...head, `  certificate valid until ${r.expiresAt}`]
}

/** POSIX single-quoting, for a command line we PRINT for a human to paste.
 *  A home directory with a space in it is the ordinary case this exists for. */
function shQuote(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`
}

/** `ssh.us-west-1.compute.example` -> `ssh.*.compute.example`.
 *
 *  Widening the REGION label is the whole point: one anchor then covers every
 *  region without a line per gateway. But widening is only safe while the
 *  wildcard stays deep inside a domain the gateway occupies, and blindly
 *  replacing the second label does not guarantee that. `ssh.example.com` --
 *  a hostname isSafeSSHHost accepts -- became `ssh.*.com`, which makes the
 *  platform's CA authoritative for ssh.vendor.com and every other
 *  `ssh.<anything>.com`.
 *
 *  So the wildcard is introduced ONLY when at least two fixed labels remain
 *  after it. Anything else anchors the EXACT host: strictly narrower, always
 *  correct, and it costs nothing but one extra known_hosts line per region for
 *  a deployment whose names are shaped that way. Narrower-and-works beats
 *  wider-and-guesses. */
export function hostPatternFor(host: string, suffixes?: readonly string[]): string {
  // Counting labels is not enough to know where the registrable domain ends:
  // `ssh.*.co.uk` keeps two labels after the wildcard and still ranges over
  // every co.uk registrant. Only a suffix we KNOW we own may be widened;
  // everything else is anchored exactly.
  if (!mayWidenCAHost(host, suffixes)) return host
  const parts = host.split('.')
  return [parts[0], '*', ...parts.slice(2)].join('.')
}
