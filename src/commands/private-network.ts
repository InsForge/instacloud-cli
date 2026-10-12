// `insta compute public-access` and `insta <redis|mysql|mongodb> public-access`: show, close or
// re-open a compute-plane service's public access (the platform's PUT .../services/:id/access).
//
// Every insta-compute service has a private address in its project branch: `<name>.insta.internal`
// for compute, `<name>-<type>.insta.internal` for a managed database (the platform's private_host;
// this file only prints what the platform reports, never composes one). Closing public access makes
// the service private-only: its URL answers 403 (a database's public *_URL stops connecting) and
// only services in the same branch reach it. Like `insta postgres public-access off`, closing asks
// first, and a non-interactive caller (agent, CI, --json) must pass --yes.
import { ApiClient, ApiError, requireProject } from '../api.js'
import { handleApproval, info, printJson, refuse } from '../util.js'
import { q, resolveSoleService } from './services.js'
import { alwaysOnArgs, confirmOnTerminal } from './postgres.js'

export type PrivateNetworkType = 'compute' | 'redis' | 'mysql' | 'mongodb'
type Opts = { json?: boolean; branch?: string; yes?: boolean }
type Deps = { confirm?: (question: string) => Promise<boolean>; tty?: boolean }
type Row = { id: string; type: string; name: string; public?: boolean; port?: number | null; private_host?: string | null; private_fqdn?: string | null }

const isDb = (type: string) => type !== 'compute'
const credential = (type: string) => `${type.toUpperCase()}_URL`
const privateCredential = (type: string) => `${type.toUpperCase()}_PRIVATE_URL`

/** `<host>:<port>` for the private address, or undefined when the platform reports none. */
export function privateAddress(s: Pick<Row, 'private_host' | 'port'>): string | undefined {
  return s.private_host ? `${s.private_host}${s.port ? `:${s.port}` : ''}` : undefined
}

// The show block. Pure, exported for tests.
export function publicAccessLines(s: Row): string[] {
  const pub = s.public
  const head = `${s.type} ${s.name}: public access ${pub === false ? 'off' : pub === true ? 'on' : 'unknown'}`
  const why = pub === false
    ? (isDb(s.type) ? ` — ${credential(s.type)} does not connect; apps in this branch use ${privateCredential(s.type)}` : ' — its URL answers 403; only services in this branch reach it')
    : pub === true ? (isDb(s.type) ? '' : ' — reachable from the internet at its URL') : ''
  const lines = [head + why]
  const addr = privateAddress(s)
  if (addr) {
    lines.push(`  private: ${addr}${s.type === 'compute' ? ' (TCP and UDP, from services in this branch)' : ` (from services in this branch; ${privateCredential(s.type)} holds the connection string)`}`)
    if (s.private_fqdn) lines.push(`  fqdn:    ${s.private_fqdn} (for tools that skip the search domain, e.g. nslookup, dig)`)
  } else {
    lines.push('  private: none yet — the platform reports no private address for this service (not yet back-filled, a worker, or a region without the private network)')
  }
  return lines
}

// Map a refusal to a CLI-shaped message. Pure, exported for tests.
export function publicAccessErrorMessage(e: ApiError, ctx: { type: string; service: string; branch?: string; what: string }): string {
  const code = e.body?.code
  const b = ctx.branch ? ` --branch ${ctx.branch}` : ''
  if (code === 'private_network_disabled') return `the private network is not yet available on this deployment — ${ctx.type} ${ctx.service} stays public`
  if (code === 'private_network_unavailable_in_region') return `the region of ${ctx.type} ${ctx.service} has no private network yet — it stays public`
  if (code === 'no_private_name') return `${ctx.type} ${ctx.service} has no private network name, so closing public access would leave it unreachable — rename it first: \`insta service rename ${ctx.type} ${ctx.service} <new-name>${b}\``
  if (code === 'private_name_taken') return `${e.message} — rename one of the services: \`insta service rename ${ctx.type} ${ctx.service} <new-name>${b}\``
  return `${ctx.what} failed (${e.status}): ${e.message}`
}

// What closing will break, said before asking. Pure, exported for tests.
export function closeWarning(s: Row): string {
  return isDb(s.type)
    ? `closing public access: ${credential(s.type)} (the public address) stops connecting — external clients, CI and local development can no longer reach ${s.type} ${s.name}, and apps in this branch must use ${privateCredential(s.type)} (bind it and redeploy them)`
    : `closing public access: ${s.type} ${s.name}'s URL will answer 403 and stop waking it — browsers, webhooks and every caller outside this branch lose it; services in this branch keep reaching it at its private address`
}

export async function servicePublicAccess(type: PrivateNetworkType, first: string | undefined, second: string | undefined, opts: Opts, deps: Deps = {}): Promise<void> {
  const { mode, service } = alwaysOnArgs(first, second)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const svc = resolveSoleService(services as Row[], type, service)
  if (!mode) {
    if (opts.json) return printJson({ name: svc.name, type: svc.type, public: svc.public ?? null, private_host: svc.private_host ?? null, private_fqdn: svc.private_fqdn ?? null, port: svc.port ?? null })
    for (const l of publicAccessLines(svc)) info(l)
    return
  }
  if (mode === 'off' && !opts.yes) {
    const tty = deps.tty ?? (!!process.stdin.isTTY && !!process.stdout.isTTY)
    if (opts.json || !tty) refuse([closeWarning(svc), `${type} ${svc.name}: re-run with --yes to confirm`])
    info(closeWarning(svc))
    const ok = await (deps.confirm ?? confirmOnTerminal)(`Close public access to ${type} ${svc.name}?`)
    if (!ok) return info(`${type} ${svc.name}: public access unchanged`)
  }
  let res
  try {
    res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${svc.id}/access`, { public: mode === 'on' })
  } catch (e) {
    if (e instanceof ApiError) throw new Error(publicAccessErrorMessage(e, { type, service: svc.name, branch: opts.branch, what: mode === 'off' ? 'closing public access' : 'opening public access' }))
    throw e
  }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const notice = typeof res.body?.notice === 'string' && res.body.notice ? res.body.notice : undefined
  info(`${type} ${svc.name}: public access ${mode === 'off' ? 'CLOSED' : 'open'}`)
  if (notice) info(`  ${notice}`)
}
