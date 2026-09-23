import { ApiClient } from '../api.js'
import { readProject } from '../config.js'
import { info, printJson, handleApproval, die } from '../util.js'
import { presentUrl, resolveOrgId } from './billing.js'
import { domainDeps, domainTarget, setDomain, checkDomain, removeDomain, type DomainDeps } from './compute.js'

type Quote = { domainName: string; purchasable: boolean; priceCents?: number; renewalPriceCents?: number; reason?: string }
type Order = { id: string; domainName: string; years: number; status: string; priceCents: number; renewalPriceCents: number | null; checkoutUrl?: string; failedReason: string | null }
type HostnameState = { hostname: string; state: string; reason?: string; service: string | null }
type Purchased = { domainName: string; status: string; hostnames: HostnameState[]; expiresAt: string | null; autorenew: boolean; locked: boolean; nameservers: string[]; delegated: boolean; custody?: 'registrar' | 'managed' | 'foreign'; transferLockExpiresAt: string | null }
type DnsRecord = { id: number; type: string; fqdn: string; answer: string; ttl: number; priority?: number; managed: boolean; hostname?: string }

type RecordsOpts = { org?: string; json?: boolean }

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`

// --org wins; otherwise the linked project's org — the org verbs must not force a project link.
async function orgDeps(opts: { org?: string }, deps?: DomainDeps): Promise<{ api: DomainDeps['api']; orgId: string }> {
  if (deps) return { api: deps.api, orgId: opts.org ?? deps.project.orgId! }
  return { api: await ApiClient.load(), orgId: await resolveOrgId(opts) }
}

export function searchLines(results: Quote[]): string[] {
  if (!results.length) return ['no results']
  const w = Math.max(...results.map((r) => r.domainName.length))
  return results.map((r) => r.purchasable
    ? `  ${r.domainName.padEnd(w)}  ${usd(r.priceCents!)}${r.renewalPriceCents !== undefined ? `  (renews ${usd(r.renewalPriceCents)}/yr)` : ''}`
    // The platform's default reason for every unpurchasable row IS `unavailable`, so passing it
    // through prints the word twice.
    : `  ${r.domainName.padEnd(w)}  unavailable${r.reason && r.reason !== 'unavailable' ? ` — ${r.reason}` : ''}`)
}

export async function domainSearch(keyword: string, opts: { tlds?: string; org?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const qs = new URLSearchParams({ q: keyword })
  if (opts.tlds) qs.set('tlds', opts.tlds)
  const r = await api.request<{ results: Quote[] }>('GET', `/orgs/${orgId}/domains/search?${qs}`)
  if (opts.json) return printJson(r)
  for (const line of searchLines(r.results)) info(line)
  const buyable = r.results.find((x) => x.purchasable)
  if (buyable) info(`buy one: insta domain buy ${buyable.domainName}`)
}

// ---- buy / attach ----

export type BuyOpts = { years?: string; open?: boolean; json?: boolean }

export async function domainBuy(name: string, opts: BuyOpts, deps?: DomainDeps): Promise<void> {
  const years = whole('--years', opts.years)
  const { api, project: p } = await domainDeps(deps)
  const orgId = p.orgId || die('this project link names no organization — set INSTA_ORG_ID')
  // The org route still signs for a PROJECT in agent mode: `domain.purchase` is read there, and a
  // bootstrap session names none, so the platform refuses it.
  const res = await api.rawRequest('POST', `/orgs/${orgId}/domains/orders`, { domainName: name, years }, { projectId: p.projectId })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const { order } = res.body as { order: Order }
  info(`${order.domainName} — ${usd(order.priceCents)} for ${order.years} year${order.years === 1 ? '' : 's'}${order.renewalPriceCents !== null ? `, then ${usd(order.renewalPriceCents)}/yr` : ''}`)
  presentUrl(order.checkoutUrl!, 'Complete the payment in your browser:', opts.open)
  info(`then attach it: insta domain attach ${order.domainName}`)
}

// The bought name `host` sits under. At most one name can match: only apex names are sold, so no bought
// domain is ever a subdomain of another.
export function ownerOf<T extends { domainName: string }>(host: string, owned: T[]): T | null {
  return owned.find((d) => host === d.domainName || host.endsWith(`.${d.domainName}`)) ?? null
}

/**
 * Point one hostname at a compute service. `host` is a bought name — which binds it and its www —
 * or any subdomain of one, which binds only that; the rest of the domain is left as it is.
 */
export async function domainAttach(host: string, opts: { branch?: string; group?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const orgId = p.orgId || die('this project link names no organization — set INSTA_ORG_ID')
  const name = host.trim().toLowerCase()
  const { items } = await api.request<{ items: Purchased[] }>('GET', `/orgs/${orgId}/domains`)
  const owner = ownerOf(name, items)
  if (!owner) {
    // The domains list holds registered names only; a bought name still registering is an order.
    const { items: orders } = await api.request<{ items: Order[] }>('GET', `/orgs/${orgId}/domains/orders`)
    const o = ownerOf(name, orders)
    if (o) die(`${o.domainName} is not registered yet — its order is ${o.status}: insta domain status ${o.domainName}`)
    // Not a name this org bought: a domain owned elsewhere. Same verb, the bring-your-own path —
    // the plane issues the edge cert and the DNS records to publish in your own zone are printed.
    return setDomain(name, opts, { api, project: p })
  }
  const branch = opts.branch ?? p.branch
  const { target } = await domainTarget(api, p.projectId, branch, name, opts.group)
  const hostname = name === owner.domainName ? undefined : name
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/domains/${encodeURIComponent(owner.domainName)}/attach`, { hostname, branch, group: target.name })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  // What THIS call asked for. Reading it back off the answer would also name a hostname some
  // earlier attach left pending, which this command did not touch.
  const asked = hostname ? [hostname] : [owner.domainName, `www.${owner.domainName}`]
  info(`${asked.join(' and ')} will attach to ${target.name}`)
  info(`then: insta domain status ${owner.domainName}`)
}

// ---- list / status ----

function domainLines(d: Purchased, linked = true): string[] {
  const out = [`${d.domainName}  ${d.status}${d.expiresAt ? `  (expires ${d.expiresAt.slice(0, 10)}${d.autorenew ? ', auto-renews' : ''})` : ''}`]
  // Vacuously true for a domain with no hostnames, which is every domain until something attaches.
  // Not while delegated: the platform fails every hostname on the way out, and refuses the attach.
  if (linked && !d.delegated && d.hostnames.every((h) => h.state === 'failed')) {
    const names = d.hostnames.map((h) => h.hostname)
    // Attaching the bought name itself re-attaches its www.
    const retry = names.includes(d.domainName) ? names.filter((h) => h !== `www.${d.domainName}`) : names
    out.push(`  nothing serving — ${(retry.length ? retry : [d.domainName]).map((h) => `insta domain attach ${h}`).join('; ')}`)
  }
  // The zone answers elsewhere, so nothing published here resolves and an attach is refused. The
  // repair is a next action, so it follows `linked` like the others: under --org it would name this org.
  // Managed custody is the opposite case — the zone answers from InstaCloud's own nameservers, and
  // attach works exactly as under the registrar — so `delegated` stays false there and only the
  // custody line says where the zone lives.
  if (d.delegated) {
    out.push(`  delegated to ${d.nameservers.join(', ')}${linked ? '' : ' — attach is refused'}`)
    if (linked) out.push(`  attach is refused until: insta domain nameservers reset ${d.domainName}`)
  }
  if (d.custody === 'managed') out.push(`  zone managed by InstaCloud (${d.nameservers.join(', ')}) — attach works as usual`)
  const w = Math.max(0, ...d.hostnames.map((x) => x.hostname.length))
  for (const h of d.hostnames) out.push(`  ${h.hostname.padEnd(w)}  ${h.state}${h.service ? ` → ${h.service}` : ''}${h.reason ? ` — ${h.reason}` : ''}`)
  return out
}

function orderStatusLines(o: Order, linked = true): string[] {
  const out = [`order ${o.id}: ${o.domainName} — ${o.status}${o.failedReason ? ` — ${o.failedReason}` : ''}`]
  if (linked && o.status === 'canceled') out.push(`  the checkout closed without payment — order again: insta domain buy ${o.domainName}`)
  return out
}

export async function domainList(opts: { org?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<{ items: Purchased[] }>('GET', `/orgs/${orgId}/domains`)
  if (opts.json) return printJson(r)
  if (!r.items.length) return info('no domains bought through InstaCloud in this org (search: insta domain search <keyword>)')
  for (const d of r.items) for (const line of domainLines(d, !opts.org)) info(line)
}

export async function domainStatus(name: string, opts: { org?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const host = name.trim().toLowerCase()
  const [{ items: domains }, { items: orders }] = await Promise.all([
    api.request<{ items: Purchased[] }>('GET', `/orgs/${orgId}/domains`),
    api.request<{ items: Order[] }>('GET', `/orgs/${orgId}/domains/orders`),
  ])
  const domain = domains.find((d) => d.domainName === host) ?? null
  const order = orders.find((o) => o.domainName === host) ?? null
  if (!domain && !order) die(`${host} was not bought through this org`)
  if (opts.json) return printJson({ domain, order })
  for (const line of domain ? domainLines(domain, !opts.org) : orderStatusLines(order!, !opts.org)) info(line)
}

// ---- nameservers and transferring out ----

const domainPath = (orgId: string, domainName: string): string =>
  `/orgs/${orgId}/domains/${encodeURIComponent(domainName)}`

/**
 * Move a bought domain's DNS onto an InstaCloud-managed zone. This is what makes an APEX serve:
 * under the registrar's nameservers the apex flattens to shared proxy addresses no certificate
 * authority will vouch for, and the hostname can never verify. Delegation copies every record —
 * the platform's and yours — into the managed zone first, then switches the nameservers, so a
 * hostname that was serving keeps serving; a hostname that failed BECAUSE the zone had been
 * delegated away is revived to pending on its own. 202 approval_required in agent mode
 * (domain.delegate); the platform requires org admin either way.
 */
export async function domainDelegate(domainName: string, opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  // The org route still signs for a PROJECT in agent mode — `domain.delegate` is read there, the
  // same precedent `buy` documents above — but a user token needs none, so the link stays optional
  // and the verb keeps working from an unlinked directory.
  const projectId = deps?.project?.projectId ?? (await readProject())?.projectId ?? undefined
  const res = await api.rawRequest('POST', `${domainPath(orgId, domainName)}/delegate`, undefined, projectId ? { projectId } : undefined)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const d = res.body as Purchased
  for (const line of domainLines(d, !opts.org)) info(line)
  // Hostname re-verification is the platform's own loop; the reader's next move is to watch it —
  // in the org the delegate just acted on, so an explicit --org rides along. But the platform
  // revives only delegation-caused failures: when every hostname is still failed in this very
  // answer, nothing is converging and the watch hint would contradict the `nothing serving —
  // attach` line domainLines just printed, which IS the remedy there (attach works as usual
  // under managed custody).
  if (!d.hostnames.length || d.hostnames.some((h) => h.state !== 'failed')) {
    info(`hostnames re-verify on the managed zone by themselves — watch: insta domain status ${d.domainName}${opts.org ? ` --org ${opts.org}` : ''}`)
  }
}

export async function domainNameserversSet(domainName: string, hosts: string[], opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  const nameservers = hosts.flatMap((h) => h.split(/[\s,]+/)).map((h) => h.replace(/\.$/, '')).filter(Boolean)
  if (!nameservers.length) die("name at least one nameserver, or `insta domain nameservers reset <domain>` to restore the registrar's own")
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<Purchased>('PUT', `${domainPath(orgId, domainName)}/nameservers`, { nameservers })
  if (opts.json) return printJson(r)
  for (const line of domainLines(r, !opts.org)) info(line)
}

export async function domainNameserversReset(domainName: string, opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<Purchased>('DELETE', `${domainPath(orgId, domainName)}/nameservers`)
  if (opts.json) return printJson(r)
  for (const line of domainLines(r, !opts.org)) info(line)
}

export async function domainTransferLock(domainName: string, mode: string, opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  if (mode !== 'on' && mode !== 'off') die('mode must be on or off')
  const locked = mode === 'on'
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<Purchased>('PATCH', domainPath(orgId, domainName), { locked })
  if (opts.json) return printJson(r)
  info(`${r.domainName}  transfer lock ${r.locked ? 'on' : 'off'}`)
  if (!r.locked) {
    // ICANN's post-registration lock outranks this one and nothing here can waive it.
    if (r.transferLockExpiresAt && new Date(r.transferLockExpiresAt).getTime() > Date.now()) {
      info(`  ICANN holds the registration until ${r.transferLockExpiresAt.slice(0, 10)} whatever this says`)
    }
    if (!opts.org) info(`  authorization code: insta domain transfer code ${r.domainName}`)
  }
}

export async function domainTransferCode(domainName: string, opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<{ authCode: string }>('POST', `${domainPath(orgId, domainName)}/auth-code`)
  if (opts.json) return printJson(r)
  info(r.authCode)
}

// ---- records ----

export function recordLines(records: DnsRecord[]): string[] {
  const w = (pick: (r: DnsRecord) => string) => Math.max(...records.map((r) => pick(r).length))
  const idW = w((r) => String(r.id)), typeW = w((r) => r.type), nameW = w((r) => r.fqdn), answerW = w((r) => r.answer), ttlW = w((r) => String(r.ttl))
  return records.map((r) => {
    const line = `  ${String(r.id).padEnd(idW)}  ${r.type.padEnd(typeW)}  ${r.fqdn.padEnd(nameW)}  ${r.answer.padEnd(answerW)}  ${String(r.ttl).padEnd(ttlW)}  ${r.priority === undefined ? '' : String(r.priority)}`.trimEnd()
    if (r.managed) return `${line}  (managed${r.hostname ? ` — published for ${r.hostname}` : ' — no hostname claims it; remove drops it'})`
    return line
  })
}

const recordPath = (orgId: string, domainName: string) => `/orgs/${orgId}/domains/${encodeURIComponent(domainName)}/records`

// Number() reads "" as 0 and "1e3" as 1000, and keeps NaN, which the platform refuses as a type error naming no flag.
function whole(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const digits = value.trim()
  if (!/^\d+$/.test(digits)) die(`${flag} must be a whole number, not ${JSON.stringify(value)}`)
  return Number(digits)
}

export async function domainRecordsList(domainName: string, opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<{ items: DnsRecord[] }>('GET', recordPath(orgId, domainName))
  if (opts.json) return printJson(r)
  if (!r.items.length) return info(`no records in ${domainName} — add one: insta domain records add ${domainName} A @ <ip>`)
  for (const line of recordLines(r.items)) info(line)
}

export type RecordAddOpts = RecordsOpts & { ttl?: string; priority?: string }

export async function domainRecordsAdd(domainName: string, type: string, name: string, content: string, opts: RecordAddOpts, deps?: DomainDeps): Promise<void> {
  const body = { type: type.toUpperCase(), host: name, answer: content, ttl: whole('--ttl', opts.ttl), priority: whole('--priority', opts.priority) }
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<DnsRecord>('POST', recordPath(orgId, domainName), body)
  if (opts.json) return printJson(r)
  for (const line of recordLines([r])) info(line)
}

export type RecordSetOpts = RecordsOpts & { type?: string; name?: string; content?: string; ttl?: string; priority?: string }

export async function domainRecordsSet(domainName: string, id: string, opts: RecordSetOpts, deps?: DomainDeps): Promise<void> {
  const body = { type: opts.type?.toUpperCase(), host: opts.name, answer: opts.content, ttl: whole('--ttl', opts.ttl), priority: whole('--priority', opts.priority) }
  if (Object.values(body).every((v) => v === undefined)) die('nothing to change — pass --type, --name, --content, --ttl or --priority')
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<DnsRecord>('PATCH', `${recordPath(orgId, domainName)}/${encodeURIComponent(id)}`, body)
  if (opts.json) return printJson(r)
  for (const line of recordLines([r])) info(line)
}

export async function domainRecordsRemove(domainName: string, id: string, opts: RecordsOpts, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request('DELETE', `${recordPath(orgId, domainName)}/${encodeURIComponent(id)}`)
  if (opts.json) return printJson(r)
  info(`removed record ${id} from ${domainName}`)
}

// `insta domain check|detach <hostname>` — the hostname-level reads and writes. Both normalize the
// hostname exactly as `attach` does: DNS is case-insensitive, `attach` lowercases before it sends,
// and forwarding `Docs.MyApp.com` verbatim asked the plane about a binding it never wrote.
type HostOpts = { branch?: string; group?: string; json?: boolean }

export async function domainCheck(host: string, opts: HostOpts, deps?: DomainDeps): Promise<void> {
  return checkDomain(host.trim().toLowerCase(), opts, deps)
}

/** The bought domain `host` sits under, or null — including when the question cannot be answered.
 *
 *  This lookup is a GUARD on a command that worked without it: a control plane without the
 *  org-scoped domains route (an older deployment, insta-oss), a 403, or a transient 5xx must not
 *  turn a bring-your-own detach into a hard failure. A failed read means "nothing says this is a
 *  bought name", which is exactly how the command behaved before the guard existed. A read that
 *  SUCCEEDS is authoritative, and its refusal stands. */
async function boughtOwner(d: DomainDeps, orgId: string, host: string): Promise<Purchased | null> {
  try {
    const { items } = await d.api.request<{ items: Purchased[] }>('GET', `/orgs/${orgId}/domains`)
    return ownerOf(host, items)
  } catch {
    return null
  }
}

/**
 * Release a hostname from its compute service. Bring-your-own only: a hostname under a domain
 * bought through InstaCloud is refused here.
 *
 * `attach` writes a bought hostname into the platform's DOMAINS record (state, serviceId,
 * releaseFrom) and lets a reconciler bind it on the compute plane; this verb's only route,
 * DELETE /projects/:id/compute/domain, unbinds on the compute plane alone and the platform
 * exposes no detach route for the domains record. Running it would leave the record still
 * claiming a binding that no longer exists — and, for an apex, `attach` binds both the name and
 * its www while this takes one hostname. The supported way to move a bought hostname is another
 * `attach`, which releases it from the old service itself.
 */
export async function domainDetach(host: string, opts: HostOpts, deps?: DomainDeps): Promise<void> {
  const d = await domainDeps(deps)
  const name = host.trim().toLowerCase()
  // Without an org there is no domains list to check against (INSTA_PROJECT_ID-only CI links name
  // none); a bring-your-own detach must keep working there, so the guard is simply not applied.
  if (d.project.orgId) {
    const owner = await boughtOwner(d, d.project.orgId, name)
    if (owner) {
      die(`${name} belongs to ${owner.domainName}, a domain bought through InstaCloud — its binding lives on the domain, not on the compute plane, so detaching it here would leave the domain still claiming it. `
        + `Move it with \`insta domain attach ${name} --group <other service>\` (attach releases it from the current one), and see where it stands with \`insta domain status ${owner.domainName}\`.`)
    }
  }
  return removeDomain(name, opts, d)
}
