import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

// One printed series line. Pure seam so the formatting is testable without a backend.
//
// Byte-rate series (compute's egress/ingress) arrive as raw bytes per second, which is unreadable at
// real traffic volumes — 20480031 bytes/s is 20 MB/s. Percent and vCPU units are already
// human-sized, so only bytes and byte rates get scaled.
export function metricLine(s: { name?: string; unit?: string; points?: [number, number][] }): string {
  const last = s.points?.[s.points.length - 1]
  const value = last ? formatMetricValue(last[1], s.unit) : 'n/a'
  const unit = s.unit && !isScaled(s.unit) ? ` (${s.unit})` : ''
  return `${s.name}${unit}: ${value}  [${s.points?.length ?? 0} points]`
}

// The platform's unit strings are the contract here (`bytes` for memory/storage, `bytes/s` for
// egress/ingress — src/adapters/fly.ts and insta-db.ts). Matching them loosely is deliberate: an
// unrecognised unit fails SILENTLY back to the raw 8-digit number this scaling exists to fix, so a
// casing or spacing change on the platform side must not be enough to regress it.
function scaleOf(unit?: string): 'bytes' | 'bytes/s' | undefined {
  const u = unit?.trim().toLowerCase()
  if (u === 'bytes' || u === 'byte' || u === 'b') return 'bytes'
  if (u === 'bytes/s' || u === 'byte/s' || u === 'b/s' || u === 'bytes/sec') return 'bytes/s'
  return undefined
}

function isScaled(unit: string): boolean {
  return scaleOf(unit) !== undefined
}

function formatMetricValue(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return 'n/a'
  const scale = scaleOf(unit)
  // Traffic scales by 1000 because egress is BILLED per decimal GB (`bytes / 1e9`, platform
  // src/adapters/fly.ts) — a 1024-based "GB/s" would sit ~7% off the invoice. Memory and storage
  // stay binary: those ceilings are provisioned in GiB. Same split as the console.
  if (scale === 'bytes') return humanBytes(v, 1024)
  if (scale === 'bytes/s') return `${humanBytes(v, 1000)}/s`
  return String(v)
}

function humanBytes(v: number, base: 1000 | 1024): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = v
  let i = 0
  while (Math.abs(value) >= base && i < units.length - 1) {
    value /= base
    i += 1
  }
  // Sub-KB values keep their integer form (`512 B`, not `512.0 B`), but a RATE is fractional —
  // PromQL rate() of a byte counter yields things like 342.857142, which must not print in full.
  const shown = i === 0 && Number.isInteger(value) ? String(value) : value.toFixed(1)
  return `${shown} ${units[i]}`
}

// shared handler behind `insta <compute|postgres|redis|mysql|mongodb> metrics [service]`
export async function metrics(component: string, group: string | undefined, opts: { branch?: string; from?: string; to?: string; step?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.request('GET', `/projects/${p.projectId}/metrics${qs({ component, group, branch: opts.branch ?? p.branch, from: opts.from, to: opts.to, step: opts.step })}`)
  if (opts.json) return printJson(res)
  if (res.note) info(`note: ${res.note}`)
  if (!res.series?.length) return info('(no series)')
  for (const s of res.series) info(metricLine(s))
}

// Customer-facing name for each internal billing dimension (the platform stores RAM as `ram`).
const DIMENSION_LABEL: Record<string, string> = { ram: 'memory' }

type Dim = { dimension: string; quantity: number; unit: string; costUsd?: number }

// Window line. Defaults to the current billing cycle; `to` is the exclusive next-cycle start, so
// show the inclusive last day (to − 1 day) — e.g. an org created on the 5th reads "…-05 → …next-04".
export function cycleLine(res: { from: number; to: number }): string {
  const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)
  return `billing cycle ${day(res.from)} → ${day(res.to - 86400)}`
}

// Pure: format the per-dimension lines (label: qty unit (cost)). Shared by `insta billing usage` and
// `insta billing` so both render dimensions identically.
export function dimensionLines(dims: Dim[]): string[] {
  return dims.map((d) => {
    const label = DIMENSION_LABEL[d.dimension] ?? d.dimension
    const cost = d.costUsd != null ? `  ($${Number(d.costUsd).toFixed(4)})` : ''
    return `${label}: ${d.quantity} ${d.unit}${cost}`
  })
}

function printDimensions(dims: Dim[]): void {
  for (const l of dimensionLines(dims)) info(l)
}

// insta billing usage — usage across the 5 billing dimensions (cpu/memory/volume/egress/storage) for the
// current billing cycle. Shows the whole ORG by default (with a per-project breakdown); pass --proj
// [id] for a single project (the linked one, or a given id). Billed dimensions, not raw provider
// meters.
export async function usage(opts: { from?: string; to?: string; json?: boolean; proj?: string | boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()

  if (opts.proj !== undefined && opts.proj !== false) {
    const projectId = typeof opts.proj === 'string' ? opts.proj : p.projectId
    const res = await api.request('GET', `/projects/${projectId}/usage${qs({ from: opts.from, to: opts.to })}`)
    if (opts.json) return printJson(res)
    info(cycleLine(res))
    if (!res.dimensions?.length) return info('(no usage recorded)')
    printDimensions(res.dimensions)
    return info(`total: $${Number(res.totalCostUsd ?? 0).toFixed(4)}`)
  }

  // Default: the whole org (the linked project's org), with a per-project cost breakdown.
  const res = await api.request('GET', `/orgs/${p.orgId}/usage${qs({ from: opts.from, to: opts.to })}`)
  if (opts.json) return printJson(res)
  info(cycleLine(res))
  if (!res.org?.dimensions?.length) return info('(no usage recorded)')
  printDimensions(res.org.dimensions)
  info(`total: $${Number(res.org.totalCostUsd ?? 0).toFixed(4)}`)
  if (res.projects?.length) {
    info('by project:')
    for (const pr of res.projects) info(`  ${pr.name}: $${Number(pr.totalCostUsd ?? 0).toFixed(4)}`)
  }
}

// pure: platform path for a deploy-events request (used by `insta compute logs --deploy` and the
// equivalent on redis/mysql/mongodb). Any Fly-backed
// component (compute or a managed database) has machine lifecycle events; omitted → the platform
// defaults to compute.
export function deployEventsPath(projectId: string, opts: { component?: string; group?: string; branch?: string; limit?: string; instance?: string }): string {
  return `/projects/${projectId}/deploy-events${qs({ component: opts.component, group: opts.group, branch: opts.branch, limit: opts.limit, instance: opts.instance })}`
}

// pure: render one deploy event as a log-style line.
export function deployEventLine(ev: { ts?: string; origin?: string; type?: string; status?: string; instance?: string }): string {
  const inst = ev.instance ? `  (${ev.instance})` : ''
  return `${ev.ts ?? ''}  [${ev.origin ?? ''}] ${ev.type ?? ''}: ${ev.status ?? ''}${inst}`
}

// A log-window instant from the CLI: unix seconds (all digits) or anything Date.parse reads
// (ISO-8601 etc.). Throws on junk — a mistyped instant must fail here, not become NaN on the wire.
export function parseLogInstant(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) throw new Error(`invalid ${flag}: ${raw} (unix seconds or an ISO-8601 date)`)
  return Math.floor(ms / 1000)
}

// '90s' | '30m' | '2h' | '1d' → seconds. Throws on junk, zero, and unknown units.
export function parseSinceSeconds(raw: string): number {
  const m = /^(\d+)([smhd])$/.exec(raw.trim())
  if (!m) throw new Error(`invalid --since: ${raw} (e.g. 90s, 30m, 2h, 1d)`)
  const n = Number(m[1])
  if (n === 0) throw new Error(`invalid --since: ${raw} (must be > 0)`)
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd']
}

// The from/to pair for the logs request, from whichever window flags were given. Pure, unit-tested.
export function resolveLogWindow(
  opts: { from?: string; to?: string; since?: string },
  now: number = Math.floor(Date.now() / 1000),
): { from?: number; to?: number } {
  if (opts.since && opts.from) throw new Error('pass --since or --from, not both')
  const from = opts.since ? now - parseSinceSeconds(opts.since) : opts.from !== undefined ? parseLogInstant(opts.from, '--from') : undefined
  const to = opts.to !== undefined ? parseLogInstant(opts.to, '--to') : undefined
  if (from !== undefined && to !== undefined && to < from) throw new Error('--to is before --from')
  return { from, to }
}

// shared handler behind `insta <compute|postgres|redis|mysql|mongodb> logs [service]`
export async function logs(component: string, group: string | undefined, opts: { branch?: string; limit?: string; region?: string; instance?: string; json?: boolean; deploy?: boolean; from?: string; to?: string; since?: string }): Promise<void> {
  const windowFlags = opts.from !== undefined || opts.to !== undefined || opts.since !== undefined
  if (opts.deploy && windowFlags) throw new Error('--from/--to/--since apply to runtime logs, not --deploy events')
  const { from, to } = resolveLogWindow(opts)
  const api = await ApiClient.load()
  const p = await requireProject()
  if (opts.deploy) {
    // Machine lifecycle events exist for every Fly-backed component; 'db' (postgres) has no machines.
    if (component === 'db') return info('deploy events are not available for db — use compute, redis, mysql or mongodb')
    const res = await api.request('GET', deployEventsPath(p.projectId, { component, group, branch: opts.branch ?? p.branch, limit: opts.limit, instance: opts.instance }))
    if (opts.json) return printJson(res)
    if (res.note) info(`note: ${res.note}`)
    if (!res.events?.length) return info('(no deploy events)')
    for (const ev of res.events) info(deployEventLine(ev))
    return
  }
  const res = await api.request('GET', `/projects/${p.projectId}/logs${qs({ component, group, branch: opts.branch ?? p.branch, limit: opts.limit, region: opts.region, instance: opts.instance, from: from !== undefined ? String(from) : undefined, to: to !== undefined ? String(to) : undefined })}`)
  if (opts.json) return printJson(res)
  if (res.note) info(`note: ${res.note}`)
  if (!res.lines?.length) return info('(no logs)')
  for (const l of res.lines) info(`${l.ts}  ${(l.level ?? '').padEnd(5)} ${l.message}`)
}
