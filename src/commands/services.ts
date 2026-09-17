// `insta service` — manage a project's opt-in services (postgres | storage | compute | redis | mysql | mongodb).
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, handleApproval, renderNextActions } from '../util.js'

export const SERVICE_TYPES = ['postgres', 'storage', 'compute', 'redis', 'mysql', 'mongodb'] as const
export type ServiceType = (typeof SERVICE_TYPES)[number]
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/

export function q(branch?: string): string {
  return branch ? `?branch=${encodeURIComponent(branch)}` : ''
}

// ---- pure, unit-tested helpers (throw plain Errors; the CLI guard turns them into clean output) ----

// Validate a service-type argument against the allowed set for a command.
export function assertType(type: string, allowed: readonly string[] = SERVICE_TYPES): asserts type is ServiceType {
  if (!allowed.includes(type)) throw new Error(`type must be ${allowed.join('|')}`)
}

export function assertServiceName(name: string): void {
  if (!SERVICE_NAME_RE.test(name)) throw new Error('service name must be lower-kebab (a-z, 0-9, -)')
}

const MAX_COMPUTE_REPLICAS = 10

// Parse a replica count inside the compute plane's current safety ceiling.
export function parseCount(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_COMPUTE_REPLICAS) {
    throw new Error(`count must be an integer between 1 and ${MAX_COMPUTE_REPLICAS}, got: ${raw}`)
  }
  return n
}

// Parse a TCP port. Junk fails here rather than reaching the API as NaN (the parseCpu lesson).
// Decimal digits only, as parseVolumeGib: `Number()` alone would quietly read 0x1f90 as 8080 and
// 1e3 as 1000, and a port written in hex is a typo worth reporting, not one worth honouring.
export function parsePort(raw: string): number {
  const m = /^\s*(\d+)\s*$/.exec(raw)
  const n = m ? Number(m[1]) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`port must be an integer between 1 and 65535, got: ${raw}`)
  return n
}

// Parse a volume size in whole Gi: "10" or "10Gi" (suffix case-insensitive — unlike the db
// quantity strings this is not a provider pass-through; the wire value is an integer). Volumes
// are provisioned block disks, so fractional and Mi values are rejected locally with an example
// rather than travelling to the server as junk (the parseCpu lesson: NaN serializes to null).
export function parseVolumeGib(raw: string): number {
  const m = /^\s*(\d+)\s*(gi|gib|g)?\s*$/i.exec(raw)
  if (!m) throw new Error(`invalid volume size: ${raw} (whole Gi — try 1 or 10)`)
  const n = Number(m[1])
  if (n < 1) throw new Error(`invalid volume size: ${raw} (whole Gi — try 1 or 10)`)
  return n
}

// Resolve a service id from a `services list` result by (type, name).
export function resolveServiceId(services: Array<{ id: string; type: string; name: string }>, type: string, name: string): string {
  const svc = services.find((s) => s.type === type && s.name === name)
  if (!svc) throw new Error(`service not found: ${type} ${name}`)
  return svc.id
}

// Resolve one service of a type: by name, or the sole one of that type when name is omitted.
export function resolveSoleService<T extends { id: string; type: string; name: string }>(services: T[], type: string, name?: string): T {
  const of = services.filter((s) => s.type === type)
  if (name) {
    const svc = of.find((s) => s.name === name)
    if (!svc) throw new Error(`${type} service not found: ${name}`)
    return svc
  }
  if (of.length === 0) throw new Error(`no ${type} service in this project (add one with \`insta services add ${type} <name>\`)`)
  if (of.length > 1) throw new Error(`multiple ${type} services — specify one: ${of.map((s) => s.name).join(', ')}`)
  return of[0]!
}

// Resolve a compute service id: by name, or the sole compute service when name is omitted.
export function resolveComputeServiceId(services: Array<{ id: string; type: string; name: string }>, name?: string): string {
  return resolveSoleService(services, 'compute', name).id
}

function defaultDatabasePort(type: string): number {
  return type === 'mysql' ? 3306 : type === 'mongodb' ? 27017 : 6379
}

// ---- commands ----

export type ServicesAddOpts = { branch?: string; public?: boolean; image?: string; port?: string; region?: string; alwaysOn?: boolean; volume?: string; mountPath?: string; json?: boolean }

// Map service-add options to the platform POST body. Pure, so it's unit-tested without a network
// mock (mirrors deployRequestBody in deploy.ts). Validation (which options are valid for which
// type) stays in servicesAdd, ahead of any network/config access.
export function servicesAddRequestBody(type: string, name: string, branch: string | undefined, opts: ServicesAddOpts): Record<string, unknown> {
  return {
    type, name, ...(branch ? { branch } : {}), public: !!opts.public,
    ...(opts.image ? { image: opts.image } : {}), ...(opts.port ? { port: parsePort(opts.port) } : {}),
    ...(opts.region ? { region: opts.region } : {}),
    // Sent whenever the flag was given, false included: compute is born always-on by default,
    // so `--no-always-on` must reach the API as an explicit false. Omitted means the platform default.
    ...(opts.alwaysOn !== undefined ? { alwaysOn: opts.alwaysOn } : {}),
    ...(opts.volume !== undefined ? { volumeGib: parseVolumeGib(opts.volume) } : {}),
    ...(opts.mountPath !== undefined ? { volumeMountPath: opts.mountPath } : {}),
  }
}

export async function servicesAdd(type: string, name: string, opts: ServicesAddOpts = {}): Promise<void> {
  assertType(type)
  if (opts.public && type !== 'storage') throw new Error('--public is only valid for storage services')
  if (opts.region && type === 'storage') throw new Error('--region is not valid for storage services')
  if (opts.image && type !== 'compute') throw new Error('--image is only valid for compute services')
  if (opts.port) {
    if (type !== 'compute') throw new Error('--port is only valid for compute services')
    parsePort(opts.port) // junk fails here, before any config/network access
  }
  // Presence, not truthiness: `--no-always-on` is an explicit false and is just as compute-only.
  if (opts.alwaysOn !== undefined && type !== 'compute') throw new Error('--always-on / --no-always-on is only valid for compute services (for postgres, use `insta db always-on on|off` after creation)')
  if (opts.mountPath !== undefined && (type !== 'compute' || opts.volume === undefined)) throw new Error('--mount-path requires --volume on a compute service')
  if (opts.volume !== undefined) {
    if (type !== 'compute') throw new Error('--volume is only valid for compute services (postgres has one by default — grow it with `insta db volume --size`)')
    parseVolumeGib(opts.volume) // junk fails here, before any config/network access
  }
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services`, servicesAddRequestBody(type, name, branch, opts))
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body.service)
  const svc = res.body.service
  info(serviceAddedLine(type, name, branch, svc))
  // Discoverability: the DB is directly dialable, but its DSN is deliberately absent from the
  // general `insta secrets` bundle — without this line nothing in the product says how to reach it.
  if (type === 'postgres') {
    // The hint must be runnable as printed: carry --branch when the service was created on a
    // branch other than the linked one, and --group so it survives multiple postgres services.
    const flags = `${opts.branch ? ` --branch ${opts.branch}` : ''} --group ${name}`
    info(`  connect: \`insta db url${flags}\` prints the connection string, \`insta db connect${flags}\` opens psql (--group optional with a single postgres service)`)
  }
  renderNextActions(res.body.nextActions)
}

// The `services add` success line. Pure, so the badge's placement is unit-tested: a template string
// nothing asserts on silently loses a segment.
export function serviceAddedLine(type: string, name: string, branch: string | undefined, svc: { id: string; type: string; public?: boolean; image?: string; port?: number; volume_gib?: number | null; volume_mount_path?: string | null; region?: string; domain?: string; pg_version?: number | null }): string {
  const access = svc.type === 'storage' ? `  [${svc.public ? 'public' : 'private'}]` : ''
  const img = svc.image ? `  running ${svc.image}${svc.port ? `:${svc.port}` : ''}` : ''
  const vol = svc.volume_gib ? `  vol ${svc.volume_gib}Gi at ${svc.volume_mount_path ?? "/data"}` : ''
  // The major belongs next to the connect hint: it decides which psql/pg_dump to reach for.
  const pg = svc.type === 'postgres' ? pgBadge(svc.pg_version) : ''
  return `added ${type} service ${name} on ${branch ?? 'default'} (${svc.id})${access}${svc.region ? `  ${svc.region}` : ''}${img}${vol}${pg}${svc.domain ? ` — ${svc.domain}` : ''}`
}

// `  pg <major>` for a postgres row, or '' when the platform sent nothing usable. The field arrives
// as untyped API JSON: only a positive integer renders, so a malformed or nonsense value (true,
// '16', 16.4, 0, -1) can never print as a version an agent would pick tooling by.
export function pgBadge(v: unknown): string {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? `  pg ${v}` : ''
}

// Render one `services list` row. Pure, so it's unit-tested without a network mock (mirrors
// billingLines in billing.ts). Compute rows show the running image when the platform reports one.
export function serviceListLine(s: { type: string; name: string; status: string; id: string; domain?: string; machine_count?: number; public?: boolean; image?: string; port?: number; volume_gib?: number | null; volume_mount_path?: string | null; pg_version?: number | null }): string {
  const extra = s.type === 'compute'
    ? `  x${s.machine_count}${s.volume_gib ? `  vol ${s.volume_gib}Gi at ${s.volume_mount_path ?? '/data'}` : ''}${s.image ? `  running ${s.image}${s.port ? `:${s.port}` : ''}` : ''}`
    : ['redis', 'mysql', 'mongodb'].includes(s.type) ? `  tcp/${s.port ?? defaultDatabasePort(s.type)}${s.volume_gib ? `  vol ${s.volume_gib}Gi` : ''}`
      : s.type === 'storage' ? `  ${s.public ? 'public' : 'private'}`
        // Postgres major, so the reader picks matching pg_dump/psql BEFORE connecting (a newer client
        // dumps statements an older server cannot restore). Older platforms send no pg_version.
        : s.type === 'postgres' ? pgBadge(s.pg_version) : ''
  return `${s.type}/${s.name}  [${s.status}]${extra}${s.domain ? `  ${s.domain}` : ''}  ${s.id}`
}

export async function servicesList(opts: { json?: boolean; branch?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  if (opts.json) return printJson(services)
  if (!services.length) return info(`(no services on ${branch ?? 'default'} — add one with \`insta services add <postgres|storage|compute|redis|mysql|mongodb> <name>\`)`)
  for (const s of services) info(serviceListLine(s))
}

export async function servicesRemove(type: string, name: string, opts: { branch?: string; json?: boolean } = {}): Promise<void> {
  assertType(type)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveServiceId(services, type, name)
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/services/${id}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true, removed: { id, type, name, branch: branch ?? null } })
  info(`removed ${type} service ${name} from ${branch ?? 'default'}`)
}

export async function servicesRename(type: string, name: string, newName: string, opts: { branch?: string; json?: boolean } = {}): Promise<void> {
  assertType(type)
  assertServiceName(newName)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveServiceId(services, type, name)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/rename`, { name: newName })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body.service)
  info(`renamed ${type} service ${name} to ${newName}`)
}

// Validate a bucket access-mode argument.
export function parseAccess(raw: string): boolean {
  if (raw === 'public') return true
  if (raw === 'private') return false
  throw new Error(`access must be public|private, got: ${raw}`)
}
