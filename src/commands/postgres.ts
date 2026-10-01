import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { ApiClient, ApiError, requireProject } from '../api.js'
import * as clack from '@clack/prompts'
import { info, printJson, handleApproval, refuse, relayExitCode } from '../util.js'
import { parseVolumeGib, q, resolveSoleService } from './services.js'

type Opts = { branch?: string; json?: boolean }

export function alwaysOnArgs(first: string | undefined, second: string | undefined): { mode?: 'on' | 'off'; service?: string } {
  if (first === 'on' || first === 'off') return { mode: first, service: second }
  if (second !== undefined) throw new Error('mode must be on|off')
  return { service: first }
}

export function alwaysOnLine(group: string, scaleToZero: unknown): string {
  return `postgres ${group}: always-on ${scaleToZero === false ? 'on — instance stays warm' : scaleToZero === true ? 'off — scales to zero when idle' : 'unknown — the provider did not report it'}`
}

// Show or set a postgres service's idle mode: scale-to-zero (the default: instance suspends when
// idle, cold-starts on the next connection) or always-on (instance stays warm; idle RAM bills at
// actual usage). Reads GET /database/instance, sets PATCH /database/settings {scaleToZero} —
// insta-db-backed postgres only.
export async function dbAlwaysOn(first: string | undefined, second: string | undefined, opts: Opts): Promise<void> {
  const { mode, service } = alwaysOnArgs(first, second)
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (service) qs.set('group', service)
  const suffix = qs.toString() ? `?${qs}` : ''
  if (!mode) {
    const read = await fetchDbInstance(api, p.projectId, suffix)
    if (read.kind === 'no-instance') {
      info(`postgres ${service ?? 'default'}: no manageable instance (this service manages its own resources)`)
      return
    }
    if (opts.json) return printJson(read.body)
    info(alwaysOnLine(service ?? 'default', read.body?.scaleToZero))
    return
  }
  const res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${suffix}`, { scaleToZero: mode !== 'on' })
  if (handleApproval(res, opts.json)) return
  const body = await settleScaleToZero(res.body, mode === 'off', async () => {
    try {
      return (await api.rawRequest('GET', `/projects/${p.projectId}/database/instance${suffix}`, undefined, { signal: AbortSignal.timeout(5000) })).body
    } catch { return undefined }
  })
  if (opts.json) return printJson(body)
  info(alwaysOnSetLine(service, opts.branch, mode, body?.scaleToZero))
}

// insta-db applies the change asynchronously and answers with the value from before it, so re-read until they agree.
export async function settleScaleToZero(
  body: any,
  want: boolean,
  read: () => Promise<any>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<any> {
  for (let i = 0; i < 15 && typeof body?.scaleToZero === 'boolean' && body.scaleToZero !== want; i++) {
    await wait(2000)
    const next = await read()
    if (next === undefined) break
    body = next
  }
  return body
}

export function alwaysOnSetLine(service: string | undefined, branch: string | undefined, mode: 'on' | 'off', scaleToZero: unknown): string {
  const group = service ?? 'default'
  if (scaleToZero !== (mode === 'off')) return `postgres ${group}: always-on ${mode} requested — the database has not applied it yet; confirm with \`insta postgres always-on${service ? ` ${service}` : ''}${branch ? ` --branch ${branch}` : ''}\``
  return `postgres ${group}: always-on ${mode === 'on' ? 'ENABLED — instance stays warm (no cold starts; idle RAM bills at actual usage)' : 'disabled — scales to zero when idle (default; first connection after idle cold-starts)'}`
}

// Validated pass-throughs for the provider's quantity strings. The insta-db resize API takes
// k8s-style quantities (cpu: "2", "2500m"; memory: "4Gi", "2048Mi"), so unlike the compute path
// there is no unit conversion here — but junk must still fail LOCALLY with an example, not travel
// to the server as-is. CASE-EXACT deliberately: k8s quantities are case-sensitive ("4gi" is
// rejected server-side), and local validation that accepts a form the backend refuses would
// defeat its own purpose.
export function parseDbCpu(raw: string): string {
  if (!/^\d+(\.\d+)?m?$/.test(raw.trim())) throw new Error(`invalid cpu: ${raw} (try 2, 4, or 2500m)`)
  return raw.trim()
}
export function parseDbMemory(raw: string): string {
  if (!/^\d+(\.\d+)?(Gi|Mi|G|M)$/.test(raw.trim())) throw new Error(`invalid memory: ${raw} (try 4Gi or 8Gi)`)
  return raw.trim()
}

// MiB → display without lying: whole/half GiB collapse, anything else stays exact in MiB
// (1536 MiB is "1.5 GiB", 1300 MiB is "1300 MiB" — never "1 GiB").
export function fmtMib(mib: number): string {
  return mib >= 1024 && mib % 512 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`
}

// The read outcome, as a seam. rawRequest THROWS ApiError on any status >= 400 (api.ts — it only
// differs from request in returning {status,body} below 400, for 202 branching), so the soft
// no-instance case and the friendly wrapping must live in a catch, not in status branching on the
// return value — branches on res.status >= 400 after rawRequest are unreachable. Takes the client
// as an argument so tests drive it with a stub, per this repo's pure-seam convention.
export type DbInstanceRead = { kind: 'ok'; body: any } | { kind: 'no-instance' }

export async function fetchDbInstance(
  api: { rawRequest: (m: string, p: string) => Promise<{ status: number; body: any }> },
  projectId: string,
  suffix: string,
): Promise<DbInstanceRead> {
  try {
    const res = await api.rawRequest('GET', `/projects/${projectId}/database/instance${suffix}`)
    return { kind: 'ok', body: res.body }
  } catch (e) {
    // The platform answers a provider-shaped 502 for services with no manageable instance:
    // a soft case, not a failure. Everything else stays an error — an expired
    // token must not render as "no ceiling set" — but wrapped so the user sees what failed.
    if (e instanceof ApiError && e.status === 502) return { kind: 'no-instance' }
    if (e instanceof ApiError) throw new Error(`reading the instance failed (${e.status}): ${e.message}`)
    throw e
  }
}

// Show or set a postgres service's resource ceiling (insta-db-backed only). Paid plans — the
// ceiling is the tier lever now that billing follows actual usage. Moves both directions:
// unlike storage it is a cgroup limit, not a provisioned volume.
export async function dbLimits(service: string | undefined, opts: Opts & { cpu?: string; memory?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (service) qs.set('group', service)
  const suffix = qs.toString() ? `?${qs}` : ''

  if (!opts.cpu && !opts.memory) {
    const read = await fetchDbInstance(api, p.projectId, suffix)
    if (read.kind === 'no-instance') {
      info(`postgres ${service ?? 'default'}: no manageable instance (this service manages its own resources)`)
      return
    }
    if (opts.json) return printJson(read.body)
    const cpuMilli = read.body?.cpuMilli
    const mib = read.body?.memoryMib
    if (typeof cpuMilli === 'number' && typeof mib === 'number') {
      const cpu = cpuMilli % 1000 === 0 ? `${cpuMilli / 1000}` : `${cpuMilli}m`
      info(`postgres ${service ?? 'default'}: ceiling ${cpu} vCPU / ${fmtMib(mib)}`)
      info('  billing is actual usage — the ceiling caps what the database may burn, it is not a price')
    } else {
      info(`postgres ${service ?? 'default'}: provider reported no ceiling — set one with --cpu/--memory`)
    }
    return
  }

  const body: Record<string, unknown> = {}
  if (opts.cpu) body.cpu = parseDbCpu(opts.cpu)
  if (opts.memory) body.memory = parseDbMemory(opts.memory)
  let res
  try {
    res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${suffix}`, body)
  } catch (e) {
    if (e instanceof ApiError) throw new Error(`setting the ceiling failed (${e.status}): ${e.message}`)
    throw e
  }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const cpu = typeof res.body?.cpuMilli === 'number' ? `${res.body.cpuMilli / 1000} vCPU` : (opts.cpu ?? 'unchanged')
  const mem = typeof res.body?.memoryMib === 'number' ? fmtMib(res.body.memoryMib) : (opts.memory ?? 'unchanged')
  info(`postgres ${service ?? 'default'}: ceiling set to ${cpu} / ${mem}`)
}

// Bytes → human units, one decimal above KiB. Local because the metrics payload is the only
// bytes-denominated read in this file (fmtMib serves the MiB-denominated resize path).
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

// Human-readable stats lines from GET /database/metrics. Pure seam for tests. "—" for anything
// unmeasured (old platform, suspended instance, no cache traffic yet) — never a fake 0: the
// platform omits cacheHitRatio and sends max 0 in exactly those cases.
export function dbStatsLines(group: string, body: any): string[] {
  const c = body?.connections ?? {}
  const max = typeof c.max === 'number' && c.max > 0 ? c.max : null
  const total = typeof c.total === 'number' ? c.total : null
  const conn = total === null ? '—'
    : (max === null ? String(total) : `${total} / ${max}`)
      + (typeof c.active === 'number' && max !== null ? ` (${c.active} active)` : '')
  const ratio = body?.cacheHitRatio
  const cache = typeof ratio === 'number' ? `${(ratio * 100).toFixed(1)}%` : '—'
  const size = typeof body?.dbSizeBytes === 'number' ? fmtBytes(body.dbSizeBytes) : '—'
  const bits = [
    typeof body?.state === 'string' ? body.state : null,
    typeof body?.serverVersion === 'string' && body.serverVersion ? `PG ${body.serverVersion}` : null,
  ].filter(Boolean)
  const state = bits.length ? ` (${bits.join(' · ')})` : ''
  return [
    `postgres ${group}${state}`,
    `  connections  ${conn}`,
    `  cache hit    ${cache}`,
    `  size         ${size}`,
  ]
}

// Point-in-time stats snapshot for a postgres service: connections vs the server's ceiling, cache
// hit rate, database size. Read-only. insta-db-backed: a suspended instance answers from the
// provider's control plane (shown as "(suspended)" with structural zeros), never dialed. That is
// every environment today — the Neon-backed contrast below is historical: Neon is no longer used
// anywhere, and the code that handled it is retained, not live. Neon-backed: the platform read
// over a direct SQL connection, so a one-shot call could wake a suspended endpoint — acceptable
// for an explicit command, which is why nothing here polls.
export async function dbStats(service: string | undefined, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (service) qs.set('group', service)
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/database/metrics${qs.toString() ? `?${qs}` : ''}`)
  if (opts.json) return printJson(res.body)
  for (const line of dbStatsLines(service ?? 'default', res.body)) info(line)
}

// Render the instance's volume from a database/instance read. Pure, exported for tests. Reads the
// CANONICAL volume* names only — storageSize/storageGiB are deprecated aliases the platform drops
// next release, so depending on them here would be a scheduled breakage.
export function dbVolumeLines(group: string, body: any): string[] {
  const gib = typeof body?.volumeGib === 'number' ? `${body.volumeGib}Gi` : (typeof body?.volumeSize === 'string' ? body.volumeSize : undefined)
  if (gib === undefined) return [`postgres ${group}: provider reported no volume size`]
  const cap = body?.cap?.volumeGib
  const region = typeof body?.region === 'string' ? `  ${body.region}` : ''
  return [
    `postgres ${group}: volume ${gib}${typeof cap === 'number' ? `  (plan max ${cap}Gi)` : ''}${region}`,
    '  billing is actual data stored — the size is a cap, not a price; grow with --size (grow-only)',
  ]
}

// Show or grow a postgres service's provisioned volume (block disk; insta-db-backed only). Viewing
// is available on every plan; growth is paid and grow-only — both gates are the backend's to
// enforce, so nothing here pre-blocks: its 403/400 messages carry the upgrade hints and are wrapped
// with context but kept verbatim.
export async function dbVolume(service: string | undefined, opts: Opts & { size?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (service) qs.set('group', service)
  const suffix = qs.toString() ? `?${qs}` : ''

  if (!opts.size) {
    const read = await fetchDbInstance(api, p.projectId, suffix)
    if (read.kind === 'no-instance') {
      info(`postgres ${service ?? 'default'}: no manageable instance (this service manages its own storage)`)
      return
    }
    if (opts.json) return printJson(read.body)
    for (const line of dbVolumeLines(service ?? 'default', read.body)) info(line)
    return
  }

  const sizeGib = parseVolumeGib(opts.size)
  let res
  try {
    res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${suffix}`, { volumeSize: `${sizeGib}Gi` })
  } catch (e) {
    if (e instanceof ApiError) throw new Error(`growing the volume failed (${e.status}): ${e.message}`)
    throw e
  }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const vg = res.body?.volumeGib
  info(`postgres ${service ?? 'default'}: volume ${typeof vg === 'number' ? `grown to ${vg}Gi` : `set to ${sizeGib}Gi`}`)
}

// POST /database/restart (gated: deploy). The platform waits the restart out; `pending` means it
// outlasted that wait and is still rolling.
export async function dbRestart(service: string | undefined, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (service) qs.set('group', service)
  let res
  try {
    res = await api.rawRequest('POST', `/projects/${p.projectId}/database/restart${qs.toString() ? `?${qs}` : ''}`)
  } catch (e) {
    if (e instanceof ApiError) throw new Error(`restart failed (${e.status}): ${e.message}`)
    throw e
  }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(restartLine(service ?? 'default', res.body))
}

export function restartLine(group: string, body: any): string {
  if (body?.pending) return `postgres ${group}: restart accepted and still in progress — settings apply once it is back up`
  if (body?.state === 'suspended') return `postgres ${group}: suspended, not restarted — pending settings apply when the next connection starts it`
  return `postgres ${group}: restarted — ALTER SYSTEM settings that need a restart are now in effect`
}

export type DbUrlResolution = { serviceName: string; url: string }

export async function resolveDbUrl(
  api: {
    request: (m: string, p: string) => Promise<any>
    rawRequest: (m: string, p: string) => Promise<{ status: number; body: any }>
  },
  projectId: string,
  branch: string | undefined,
  service: string | undefined,
  json?: boolean,
): Promise<DbUrlResolution | null> {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  const svc = resolveSoleService(services as Array<{ id: string; type: string; name: string }>, 'postgres', service)
  const res = await api.rawRequest('GET', `/projects/${projectId}/services/${svc.id}/credentials`)
  if (handleApproval(res, json)) return null
  const url = res.body?.credentials?.DATABASE_URL
  if (typeof url !== 'string' || !url) {
    throw new Error(`postgres ${svc.name} has no DATABASE_URL credential yet — still provisioning? (\`insta service list\` shows status)`)
  }
  return { serviceName: svc.name, url }
}

// Print the postgres connection string: the bare DSN on stdout, nothing else — pipe-friendly
// (`psql "$(insta postgres url)"`), like `storage get --json` keeps stdout parseable.
export async function dbUrl(service: string | undefined, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const r = await resolveDbUrl(api, p.projectId, branch, service, opts.json)
  if (!r) return
  if (opts.json) return printJson({ service: r.serviceName, branch: branch ?? null, url: r.url })
  process.stdout.write(r.url + '\n')
}

// Decompose a postgres DSN into libpq PG* environment variables. Pure, exported for tests.
// The credential must NOT ride in psql's argv — process arguments are visible to every local
// user via `ps`, so a secrets.read-gated value would leak the moment the session starts. Child
// environment is not (the `insta run` model), and PG* env is a libpq-supported mechanism, so
// psql runs with an empty argv. `sslmode` is the only query param the platform's DSNs carry;
// anything else would be a platform-side change this mapping should then learn about.
export function psqlEnvFromUrl(url: string): Record<string, string> {
  const u = new URL(url)
  const env: Record<string, string> = {}
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname)
  if (u.port) env.PGPORT = u.port
  if (u.username) env.PGUSER = decodeURIComponent(u.username)
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password)
  const db = u.pathname.replace(/^\//, '')
  if (db) env.PGDATABASE = decodeURIComponent(db)
  const sslmode = u.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  return env
}

/** Core, dependency-injected for tests: spawn psql against the DSN (via PG* env, never argv), return its exit code. */
export async function connectWithPsql(url: string, spawnImpl: typeof spawn = spawn): Promise<number> {
  // Strip ambient PG* first: parent-env PGHOSTADDR/PGSERVICE/PGOPTIONS/PGSSL* would silently
  // redirect or reshape the connection away from the service this command just resolved.
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Case-insensitive: Windows env names are case-insensitive, so ambient `pgservice` redirects
  // psql just as PGSERVICE does.
  for (const k of Object.keys(env)) if (k.slice(0, 2).toUpperCase() === 'PG') delete env[k]
  Object.assign(env, psqlEnvFromUrl(url))
  return await new Promise<number>((resolve, reject) => {
    const child = spawnImpl('psql', [], { stdio: 'inherit', env })
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT'
        ? new Error('psql not found on PATH — install the postgres client, or print the DSN with `insta postgres url`')
        : e))
    // Signal death reports code null — map to the conventional 128+signo (full table from
    // os.constants) so the advertised exit-status passthrough holds for Ctrl-C'd/killed sessions.
    child.on('close', (code, signal) =>
      resolve(code ?? (signal ? 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 0) : 1)))
  })
}

// Open an interactive psql session on the postgres service. The DSN never touches disk or argv
// history beyond the child process. Exits with psql's own exit code (agents rely on this, as
// with `compute exec`).
export async function dbConnect(service: string | undefined, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const r = await resolveDbUrl(api, p.projectId, branch, service, opts.json)
  if (!r) return
  // stderr: stdout belongs to psql (the `insta run` rule).
  process.stderr.write(`psql → postgres/${r.serviceName}${branch ? ` (branch ${branch})` : ''} — a suspended instance wakes on connect, so the first prompt can take a few seconds\n`)
  relayExitCode(await connectWithPsql(r.url))
}

// ---- network access: the public endpoint and the private network lane (instacloud#189) ----
//
// A postgres database is born PUBLIC (reachable on the internet endpoint, DATABASE_URL). Private
// access adds a second connection string, DATABASE_PRIVATE_URL, which only resolves inside
// InstaCloud compute (insta-compute); DATABASE_URL is never rewritten. Closing public access is
// the opt-out, allowed only while private access is on, and it breaks every client outside the
// compute plane (laptops, CI, external services). Wording rule: the closed database is "not
// reachable from the internet" — never "isolated": any workload on the compute plane can still
// reach the private endpoint and authenticates with the password.

export type AccessImpact = {
  warnings?: string[]
  services?: Array<{ name?: string; provider?: string; envName?: string; sourceName?: string; reason?: string }>
}

type AccessOpts = Opts & { yes?: boolean }

export type AccessDeps = {
  /** Ask the human to confirm; false = declined. Only called on a real terminal. */
  confirm?: (question: string) => Promise<boolean>
  /** Whether a human is there to answer (stdin and stdout are terminals). */
  tty?: boolean
}

async function confirmOnTerminal(question: string): Promise<boolean> {
  const answer = await clack.confirm({ message: question, initialValue: false })
  if (clack.isCancel(answer)) return false
  return answer === true
}

const onOff = (v: unknown): string => (v === true ? 'on' : v === false ? 'off' : 'unknown')

// The access block of a database/instance read. Pure, exported for tests. privateConnString in the
// instance view carries NO password (the full URL is DATABASE_PRIVATE_URL in the credentials), so
// printing it is safe.
export function dbAccessLines(group: string, body: any): string[] {
  const pub = body?.publicAccess
  const lines = [
    `postgres ${group}: public access ${onOff(pub)}${pub === false ? ' — not reachable from the internet; only the private network lane connects' : pub === true ? ' — reachable on the public endpoint (DATABASE_URL)' : ' — the provider did not report it'}`,
    `postgres ${group}: private access ${onOff(body?.privateAccess)}${body?.privateAccess === true ? ' — DATABASE_PRIVATE_URL is in the service credentials (resolves only inside InstaCloud compute)' : ''}`,
  ]
  if (typeof body?.privateConnString === 'string' && body.privateConnString) lines.push(`  private: ${body.privateConnString}`)
  if (body?.privateLane?.enabled === false) lines.push('  the private network lane is not yet available on this deployment — private access cannot be turned on, nor public access closed')
  return lines
}

// Human lines for what closing public access will break. The platform's warnings already name each
// affected compute (and always end with the external-clients one), so the services array is left
// to --json rather than repeated.
export function impactLines(impact: AccessImpact | undefined): string[] {
  const warnings = (impact?.warnings ?? []).filter((w) => typeof w === 'string' && w)
  if (!warnings.length) return []
  return ['closing public access will break:', ...warnings.map((w) => `  ! ${w}`)]
}

// Map an access-change refusal to a CLI-shaped message. Pure, exported for tests. The platform's
// 400 texts name REST routes; the CLI names its own command instead, keeping the reason.
export function accessErrorMessage(e: ApiError, ctx: { service: string; branch?: string; what: string }): string {
  const code = e.body?.code
  const b = ctx.branch ? ` --branch ${ctx.branch}` : ''
  if (code === 'private_lane_disabled') {
    return `private network access for postgres is not yet available on this deployment — postgres ${ctx.service} stays reachable on its public endpoint (DATABASE_URL)`
  }
  if (code === 'private_lane_unavailable_in_region') {
    return `the region of postgres ${ctx.service} has no private network lane yet — private access was turned back off and nothing was minted; DATABASE_URL is unchanged`
  }
  if (e.status === 400 && /private network access first/i.test(e.message)) {
    return `turn on private access first: \`insta postgres private-access on ${ctx.service}${b}\` — closing public access without it would leave the database with no way to connect`
  }
  if (e.status === 400 && /re-open public access first/i.test(e.message)) {
    return `re-open public access first: \`insta postgres public-access on ${ctx.service}${b}\` — turning private access off while public access is closed would leave the database with no way to connect`
  }
  return `${ctx.what} failed (${e.status}): ${e.message}`
}

async function resolvePostgres(api: ApiClient, projectId: string, branch: string | undefined, service: string | undefined) {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  return resolveSoleService(services as Array<{ id: string; type: string; name: string }>, 'postgres', service)
}

function settingsSuffix(branch: string | undefined, group: string): string {
  const qs = new URLSearchParams()
  if (branch) qs.set('branch', branch)
  qs.set('group', group)
  return `?${qs}`
}

// `insta postgres public-access [on|off] [service]` — show, open, or close the public endpoint.
// Reads GET /database/instance; writes PUT /services/:id/access {public} (gated: service.setAccess).
// Closing previews GET /services/:id/access/impact?public=false first and asks before acting; a
// non-interactive caller (agent, CI, --json) must pass --yes, having read the preview it printed.
export async function dbPublicAccess(first: string | undefined, second: string | undefined, opts: AccessOpts, deps: AccessDeps = {}): Promise<void> {
  const { mode, service } = alwaysOnArgs(first, second)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await resolvePostgres(api, p.projectId, branch, service)
  if (!mode) return showAccess(api, p.projectId, branch, svc.name, opts)

  const what = mode === 'off' ? 'closing public access' : 'opening public access'
  const ctx = { service: svc.name, branch: opts.branch, what }
  if (mode === 'off') {
    let impact: AccessImpact
    try {
      impact = await api.request('GET', `/projects/${p.projectId}/services/${svc.id}/access/impact?public=false`)
    } catch (e) {
      if (e instanceof ApiError) throw new Error(`previewing the impact failed (${e.status}): ${e.message}`)
      throw e
    }
    const lines = impactLines(impact)
    const tty = deps.tty ?? (!!process.stdin.isTTY && !!process.stdout.isTTY)
    if (!opts.yes) {
      if (opts.json || !tty) {
        refuse([
          ...lines,
          `postgres ${svc.name}: closing public access makes the database not reachable from the internet — re-run with --yes to confirm`,
        ])
      }
      for (const l of lines) info(l)
      const ok = await (deps.confirm ?? confirmOnTerminal)(`Close public access to postgres ${svc.name}?`)
      if (!ok) {
        info(`postgres ${svc.name}: public access unchanged`)
        return
      }
    } else if (!opts.json) {
      for (const l of lines) info(l)
    }
  }

  let res
  try {
    res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${svc.id}/access`, { public: mode === 'on' })
  } catch (e) {
    if (e instanceof ApiError) throw new Error(accessErrorMessage(e, ctx))
    throw e
  }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  for (const l of publicAccessSetLines(svc.name, mode, res.body)) info(l)
}

export function publicAccessSetLines(group: string, mode: 'on' | 'off', body: any): string[] {
  const notice = typeof body?.notice === 'string' && body.notice ? body.notice : undefined
  const head = mode === 'off'
    ? `postgres ${group}: public access CLOSED — not reachable from the internet; external clients, CI and local development can no longer connect. Compute services on InstaCloud connect through DATABASE_PRIVATE_URL`
    : `postgres ${group}: public access open — reachable on the public endpoint (DATABASE_URL)${notice ? '' : ' (it already was; nothing changed)'}`
  return notice ? [head, `  ${notice}`] : [head]
}

// `insta postgres private-access [on|off] [service]` — show or toggle the private network lane.
// Writes PATCH /database/settings {privateAccess} (gated: service.setAccess). On mints
// DATABASE_PRIVATE_URL beside DATABASE_URL (unchanged); off retracts it (refused while public
// access is closed). No confirmation: neither direction takes a working connection away without
// the platform refusing or warning (off answers `warnings` naming computes still bound to it).
export async function dbPrivateAccess(first: string | undefined, second: string | undefined, opts: Opts): Promise<void> {
  const { mode, service } = alwaysOnArgs(first, second)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await resolvePostgres(api, p.projectId, branch, service)
  if (!mode) return showAccess(api, p.projectId, branch, svc.name, opts)

  const ctx = { service: svc.name, branch: opts.branch, what: `turning private access ${mode}` }
  let res
  try {
    res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${settingsSuffix(branch, svc.name)}`, { privateAccess: mode === 'on' })
  } catch (e) {
    if (e instanceof ApiError) throw new Error(accessErrorMessage(e, ctx))
    throw e
  }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  for (const l of privateAccessSetLines(svc.name, mode, res.body)) info(l)
}

export function privateAccessSetLines(group: string, mode: 'on' | 'off', body: any): string[] {
  const lines = mode === 'on'
    ? [
      `postgres ${group}: private access ON — DATABASE_PRIVATE_URL minted beside DATABASE_URL (unchanged)`,
      '  it resolves only inside InstaCloud compute (insta-compute), not from a laptop or CI — keep DATABASE_URL for those',
      `  switch a compute over: insta secrets bind DATABASE_URL postgres/${group} --source-name DATABASE_PRIVATE_URL --to compute/<name>, then \`insta compute restart <name>\``,
      '  other workloads on the compute plane can reach the private endpoint too — the password is what authenticates',
    ]
    : [`postgres ${group}: private access off — DATABASE_PRIVATE_URL retracted; DATABASE_URL is unchanged`]
  for (const w of Array.isArray(body?.warnings) ? body.warnings : []) if (typeof w === 'string' && w) lines.push(`  ! ${w}`)
  return lines
}

async function showAccess(api: ApiClient, projectId: string, branch: string | undefined, group: string, opts: Opts): Promise<void> {
  const read = await fetchDbInstance(api, projectId, settingsSuffix(branch, group))
  if (read.kind === 'no-instance') {
    info(`postgres ${group}: no manageable instance (network access is not configurable for this service)`)
    return
  }
  if (opts.json) return printJson(read.body)
  for (const l of dbAccessLines(group, read.body)) info(l)
}
