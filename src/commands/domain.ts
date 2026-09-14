import { readFile } from 'node:fs/promises'
import { ApiClient } from '../api.js'
import { info, printJson, handleApproval, die } from '../util.js'
import { presentUrl, resolveOrgId } from './billing.js'
import { domainDeps, domainTarget, type DomainDeps } from './compute.js'

type Quote = { domainName: string; purchasable: boolean; priceCents?: number; renewalPriceCents?: number; reason?: string }
type Order = { id: string; domainName: string; years: number; status: string; priceCents: number; renewalPriceCents: number | null; branch: string | null; checkoutUrl?: string; failedReason: string | null }
type HostnameState = { hostname: string; state: string; reason?: string }
type Purchased = { domainName: string; status: string; hostnames: HostnameState[]; service: string | null; expiresAt: string | null; autorenew: boolean }

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
    : `  ${r.domainName.padEnd(w)}  unavailable${r.reason ? ` — ${r.reason}` : ''}`)
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

// ---- registrant contact ----

export type ContactOpts = { firstName?: string; lastName?: string; companyName?: string; address1?: string; address2?: string; city?: string; state?: string; zip?: string; country?: string; email?: string; phone?: string; contactFile?: string }
const CONTACT_KEYS = ['firstName', 'lastName', 'companyName', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'email', 'phone'] as const

export function contactFromOpts(opts: ContactOpts, file?: unknown): Record<string, unknown> | undefined {
  if (file !== undefined) return file as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of CONTACT_KEYS) if (opts[k] !== undefined) out[k] = opts[k]
  return Object.keys(out).length ? out : undefined
}

async function readContactFile(path?: string): Promise<unknown> {
  if (!path) return undefined
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (e) { throw new Error(`cannot read ${path} as JSON: ${(e as Error).message}`) }
}

function contactLines(c: Record<string, any> | null): string[] {
  if (!c) return ['no registrant contact set — set one with: insta domain contact set --first-name … (or --contact-file contact.json)']
  return [
    `${c.firstName} ${c.lastName}${c.companyName ? ` (${c.companyName} — the organization is the legal registrant)` : ''}`,
    `${c.address1}${c.address2 ? `, ${c.address2}` : ''}, ${c.city}, ${c.state} ${c.zip}, ${c.country}`,
    `${c.email}  ${c.phone}`,
  ]
}

export async function domainContactShow(opts: { org?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const r = await api.request<{ contact: Record<string, unknown> | null }>('GET', `/orgs/${orgId}/domains/contact`)
  if (opts.json) return printJson(r)
  for (const line of contactLines(r.contact)) info(line)
}

export async function domainContactSet(opts: ContactOpts & { org?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, orgId } = await orgDeps(opts, deps)
  const contact = contactFromOpts(opts, await readContactFile(opts.contactFile))
  if (!contact) die('pass the contact as flags (--first-name … --phone) or as --contact-file <contact.json>')
  const r = await api.request<{ contact: Record<string, unknown> }>('PUT', `/orgs/${orgId}/domains/contact`, contact)
  if (opts.json) return printJson(r)
  info('registrant contact saved:')
  for (const line of contactLines(r.contact)) info(`  ${line}`)
}

// ---- buy / attach ----

export type BuyOpts = { years?: string; branch?: string; group?: string; contactFile?: string; open?: boolean; json?: boolean }

export async function domainBuy(name: string, opts: BuyOpts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target } = await domainTarget(api, p.projectId, branch, name, opts.group)
  const contact = await readContactFile(opts.contactFile)
  // JSON.stringify drops undefined but keeps NaN as null, which the platform rejects as a type
  // error rather than a bad term — so a malformed --years is refused here, with the reason.
  let years: number | undefined
  if (opts.years !== undefined) {
    years = Number(opts.years)
    if (!Number.isInteger(years)) die(`--years must be a whole number of years, not ${opts.years}`)
  }
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/domains/orders`, { domainName: name, years, branch, group: target.name, contact })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const { order } = res.body as { order: Order }
  info(`${order.domainName} — ${usd(order.priceCents)} for ${order.years} year${order.years === 1 ? '' : 's'}${order.renewalPriceCents !== null ? `, then ${usd(order.renewalPriceCents)}/yr` : ''}`)
  info(`attaches to ${target.name}${order.branch ? ` (branch ${order.branch})` : ''} as ${order.domainName} and www.${order.domainName} once paid`)
  presentUrl(order.checkoutUrl!, 'Complete the payment in your browser:', opts.open)
  info(`then: insta domain status ${order.domainName}`)
}

export async function domainAttach(name: string, opts: { branch?: string; group?: string; json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target } = await domainTarget(api, p.projectId, branch, name, opts.group)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/domains/${encodeURIComponent(name)}/attach`, { branch, group: target.name })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const d = res.body as Purchased
  info(`${d.domainName} will attach to ${target.name} as ${d.hostnames.map((h) => h.hostname).join(' and ')}`)
  info(`then: insta domain status ${d.domainName}`)
}

// ---- list / status ----

function domainLines(d: Purchased): string[] {
  const out = [`${d.domainName}  ${d.status}${d.service ? `  → ${d.service}` : ''}${d.expiresAt ? `  (expires ${d.expiresAt.slice(0, 10)}${d.autorenew ? ', auto-renews' : ''})` : ''}`]
  if (d.status === 'detached' || d.status === 'attach_failed') out.push(`  attach it again: insta domain attach ${d.domainName}`)
  const w = Math.max(0, ...d.hostnames.map((x) => x.hostname.length))
  for (const h of d.hostnames) out.push(`  ${h.hostname.padEnd(w)}  ${h.state}${h.reason ? ` — ${h.reason}` : ''}`)
  return out
}

function orderStatusLines(o: Order): string[] {
  const out = [`order ${o.id}: ${o.domainName} — ${o.status}${o.failedReason ? ` — ${o.failedReason}` : ''}`]
  if (o.status === 'canceled') out.push(`  the checkout closed without payment — order again: insta domain buy ${o.domainName}`)
  return out
}

export async function domainList(opts: { json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const r = await api.request<{ items: Purchased[] }>('GET', `/projects/${p.projectId}/domains`)
  if (opts.json) return printJson(r)
  if (!r.items.length) return info('no domains bought through InstaCloud in this project (search: insta domain search <keyword>)')
  for (const d of r.items) for (const line of domainLines(d)) info(line)
}

export async function domainStatus(name: string, opts: { json?: boolean }, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const host = name.trim().toLowerCase()
  const [{ items: domains }, { items: orders }] = await Promise.all([
    api.request<{ items: Purchased[] }>('GET', `/projects/${p.projectId}/domains`),
    api.request<{ items: Order[] }>('GET', `/projects/${p.projectId}/domains/orders`),
  ])
  const domain = domains.find((d) => d.domainName === host) ?? null
  const order = orders.find((o) => o.domainName === host) ?? null
  if (!domain && !order) die(`${host} was not bought through this project`)
  if (opts.json) return printJson({ domain, order })
  for (const line of domain ? domainLines(domain) : orderStatusLines(order!)) info(line)
}
