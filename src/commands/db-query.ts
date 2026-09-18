// `insta redis|mysql|mongodb query <service> [args...]` — run a query/command against a MANAGED
// database through the platform's console exec API. Postgres is not a console target (it has the
// SQL editor / DATABASE_URL, and `insta postgres url|connect`), so a postgres service is rejected
// here. The shape logic — path, request body, result rendering — lives in pure, unit-tested seams;
// the handler just resolves the service and wires them to the API, this repo's pure-seam
// convention.
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, die, handleApproval } from '../util.js'
import { q } from './services.js'

export const MANAGED_ENGINES = ['mysql', 'redis', 'mongodb'] as const
export type Engine = (typeof MANAGED_ENGINES)[number]

// pure: the console exec route for a managed-DB service.
export function consoleExecPath(projectId: string, serviceId: string): string {
  return `/projects/${projectId}/database/console/${serviceId}/exec`
}

// pure: map the engine + trailing args to the exec request body. mysql/mongodb take a single
// command string (args joined with a space — the user quotes the whole statement); redis takes a
// pre-tokenized argv (each arg verbatim, so a value with spaces survives as one token). Only
// mongodb carries an optional --database.
export function execBody(engine: Engine, args: string[], database?: string): Record<string, unknown> {
  if (engine === 'redis') return { argv: args }
  const command = args.join(' ')
  if (engine === 'mongodb') return { command, ...(database ? { database } : {}) }
  return { command }
}

// pure: render a mysql result set as a simple left-aligned table — the header from columns, then
// the rows, every column but the last padded so cells line up. A null cell renders as an em-dash
// (the repo norm for a missing value), never an empty string. A trailing count line closes it.
export function renderMysqlRows(data: {
  columns?: Array<{ name: string }>
  rows?: Array<Array<string | null>>
  rowCount?: number
  truncated?: boolean
}): string[] {
  const headers = (data.columns ?? []).map((c) => c.name)
  const rows = data.rows ?? []
  const cell = (v: string | null | undefined): string => (v === null || v === undefined ? '—' : String(v))
  const widths = headers.map((h, i) => {
    let w = h.length
    for (const r of rows) w = Math.max(w, cell(r[i]).length)
    return w
  })
  const fmtRow = (vals: string[]): string =>
    vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i] ?? 0))).join('  ')
  const lines = [fmtRow(headers)]
  for (const r of rows) lines.push(fmtRow(headers.map((_, i) => cell(r[i]))))
  const rowCount = typeof data.rowCount === 'number' ? data.rowCount : rows.length
  lines.push(`(${rowCount} rows${data.truncated ? ', truncated' : ''})`)
  return lines
}

// pure: a redis reply — a scalar prints raw, anything structured pretty-prints as JSON.
export function renderRedisReply(reply: unknown): string {
  if (typeof reply === 'string' || typeof reply === 'number') return String(reply)
  return JSON.stringify(reply, null, 2)
}

// pure: a mongodb result is arbitrary JSON — pretty-print it.
export function renderMongoResult(result: unknown): string {
  return JSON.stringify(result, null, 2)
}

type Opts = { database?: string; branch?: string; json?: boolean }

// The API surface + project this command needs, injectable so the handler flow — service
// resolution, the engine guards, --json/202 passthrough — is testable without a network mock
// (the DomainDeps convention in compute.ts). Production loads a real ApiClient + requireProject().
export type DbQueryApi = Pick<ApiClient, 'request' | 'rawRequest'>
export type DbQueryDeps = { api: DbQueryApi; project: { projectId: string; branch?: string } }
async function dbQueryDeps(deps?: DbQueryDeps): Promise<DbQueryDeps> {
  if (deps) return deps
  const [api, project] = [await ApiClient.load(), await requireProject()]
  return { api, project }
}

// Resolve <service> (a service NAME) to its id + engine, then dispatch to the console exec API.
// `engine` is the group the command was typed under (`insta redis query …`): a service of another
// type is refused with the right group named, never queried through the wrong renderer.
export async function dbQuery(service: string, args: string[], opts: Opts = {}, deps?: DbQueryDeps, engine?: Engine): Promise<void> {
  // An empty command is never valid — reject it before loading config or hitting the network,
  // rather than posting an empty statement/argv to the console.
  if (args.length === 0) {
    die(`usage: insta ${engine ?? '<redis|mysql|mongodb>'} query <service> <query…> (mysql/mongodb: one quoted statement; redis: e.g. GET mykey)`)
  }
  const { api, project: p } = await dbQueryDeps(deps)
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const svc = (services as Array<{ id: string; type: string; name: string }>).find((s) => s.name === service)
  if (!svc) die(`service not found: ${service}`)
  if (!(MANAGED_ENGINES as readonly string[]).includes(svc.type)) {
    die('query is for managed databases (mysql/redis/mongodb); postgres uses `insta postgres url|connect` / the SQL editor')
  }
  if (engine && svc.type !== engine) die(`${service} is a ${svc.type} service — use: insta ${svc.type} query ${service} …`)
  const resolved = svc.type as Engine
  // --database is a mongodb-only selector (execBody drops it for the others). Rejecting it here,
  // rather than silently ignoring it, keeps the documented mongodb-only contract honest.
  if (opts.database !== undefined && resolved !== 'mongodb') {
    die('--database is only supported for mongodb services')
  }
  const res = await api.rawRequest('POST', consoleExecPath(p.projectId, svc.id), execBody(resolved, args, opts.database))
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  if (resolved === 'mysql') {
    for (const line of renderMysqlRows(res.body ?? {})) info(line)
  } else if (resolved === 'redis') {
    info(renderRedisReply(res.body?.reply))
  } else {
    info(renderMongoResult(res.body?.result))
  }
}
