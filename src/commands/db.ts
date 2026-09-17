import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, printJson, handleApproval, relayExitCode } from '../util.js'
import { parseVolumeGib, q, resolveSoleService } from './services.js'

type Opts = { branch?: string; group?: string; json?: boolean }

// Toggle a postgres service between scale-to-zero (the default: instance suspends when idle,
// cold-starts on the next connection) and always-on (instance stays warm; idle RAM bills at
// actual usage). Thin wrapper over PATCH /database/settings {scaleToZero} — insta-db-backed
// postgres only.
export async function dbAlwaysOn(mode: string, opts: Opts): Promise<void> {
  if (mode !== 'on' && mode !== 'off') throw new Error('mode must be on|off')
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (opts.group) qs.set('group', opts.group)
  const res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${qs.toString() ? `?${qs}` : ''}`, { scaleToZero: mode !== 'on' })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const s2z = res.body?.scaleToZero
  info(`postgres ${opts.group ?? 'default'}: always-on ${s2z === false ? 'ENABLED — instance stays warm (no cold starts; idle RAM bills at actual usage)' : 'disabled — scales to zero when idle (default; first connection after idle cold-starts)'}`)
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
export async function dbLimits(opts: Opts & { cpu?: string; memory?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (opts.group) qs.set('group', opts.group)
  const suffix = qs.toString() ? `?${qs}` : ''

  if (!opts.cpu && !opts.memory) {
    const read = await fetchDbInstance(api, p.projectId, suffix)
    if (read.kind === 'no-instance') {
      info(`postgres ${opts.group ?? 'default'}: no manageable instance (this service manages its own resources)`)
      return
    }
    if (opts.json) return printJson(read.body)
    const cpuMilli = read.body?.cpuMilli
    const mib = read.body?.memoryMib
    if (typeof cpuMilli === 'number' && typeof mib === 'number') {
      const cpu = cpuMilli % 1000 === 0 ? `${cpuMilli / 1000}` : `${cpuMilli}m`
      info(`postgres ${opts.group ?? 'default'}: ceiling ${cpu} vCPU / ${fmtMib(mib)}`)
      info('  billing is actual usage — the ceiling caps what the database may burn, it is not a price')
    } else {
      info(`postgres ${opts.group ?? 'default'}: provider reported no ceiling — set one with --cpu/--memory`)
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
  info(`postgres ${opts.group ?? 'default'}: ceiling set to ${cpu} / ${mem}`)
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
export async function dbStats(opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (opts.group) qs.set('group', opts.group)
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/database/metrics${qs.toString() ? `?${qs}` : ''}`)
  if (opts.json) return printJson(res.body)
  for (const line of dbStatsLines(opts.group ?? 'default', res.body)) info(line)
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
export async function dbVolume(opts: Opts & { size?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (opts.group) qs.set('group', opts.group)
  const suffix = qs.toString() ? `?${qs}` : ''

  if (!opts.size) {
    const read = await fetchDbInstance(api, p.projectId, suffix)
    if (read.kind === 'no-instance') {
      info(`postgres ${opts.group ?? 'default'}: no manageable instance (this service manages its own storage)`)
      return
    }
    if (opts.json) return printJson(read.body)
    for (const line of dbVolumeLines(opts.group ?? 'default', read.body)) info(line)
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
  info(`postgres ${opts.group ?? 'default'}: volume ${typeof vg === 'number' ? `grown to ${vg}Gi` : `set to ${sizeGib}Gi`}`)
}

export type DbUrlResolution = { serviceName: string; url: string }

// Resolve the postgres service (sole, or --group) and its connection string. Two reads: the
// branch's services list names the service; GET /services/:id/credentials (gated secrets.read)
// carries the value. Provider-minted credentials are canonical within their source service
// (DATABASE_URL) and deliberately absent from the general `insta secrets` bundle, so this is the
// read that yields the DSN. The credentials call carries no branch param — the service id is
// already branch-scoped by the list. Returns null when the read parked on an approval
// (handleApproval already spoke). Takes the client as an argument so tests drive it with a stub,
// per this repo's pure-seam convention.
export async function resolveDbUrl(
  api: {
    request: (m: string, p: string) => Promise<any>
    rawRequest: (m: string, p: string) => Promise<{ status: number; body: any }>
  },
  projectId: string,
  branch: string | undefined,
  group: string | undefined,
  json?: boolean,
): Promise<DbUrlResolution | null> {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  const svc = resolveSoleService(services as Array<{ id: string; type: string; name: string }>, 'postgres', group)
  const res = await api.rawRequest('GET', `/projects/${projectId}/services/${svc.id}/credentials`)
  if (handleApproval(res, json)) return null
  const url = res.body?.credentials?.DATABASE_URL
  if (typeof url !== 'string' || !url) {
    throw new Error(`postgres ${svc.name} has no DATABASE_URL credential yet — still provisioning? (\`insta services list\` shows status)`)
  }
  return { serviceName: svc.name, url }
}

// Print the postgres connection string: the bare DSN on stdout, nothing else — pipe-friendly
// (`psql "$(insta db url)"`), like `storage get --json` keeps stdout parseable.
export async function dbUrl(opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const r = await resolveDbUrl(api, p.projectId, branch, opts.group, opts.json)
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
        ? new Error('psql not found on PATH — install the postgres client, or print the DSN with `insta db url`')
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
export async function dbConnect(opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const r = await resolveDbUrl(api, p.projectId, branch, opts.group, opts.json)
  if (!r) return
  // stderr: stdout belongs to psql (the `insta run` rule).
  process.stderr.write(`psql → postgres/${r.serviceName}${branch ? ` (branch ${branch})` : ''} — a suspended instance wakes on connect, so the first prompt can take a few seconds\n`)
  relayExitCode(await connectWithPsql(r.url))
}
