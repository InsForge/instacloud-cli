// `insta template` — browse the platform template registry and deploy a template (by registry
// code, from a local directory carrying insta.template.yaml, or from a github.com URL whose
// manifest github-source.ts fetches with the user's own git credentials) onto a branch. The deploy is a
// platform-side pipeline (create services → write variables → deploy → health check); the CLI
// submits it and renders progress by polling the deployment resource.
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import * as clack from '@clack/prompts'
import { ApiClient, ApiError, requireProject } from '../api.js'
import type { ProjectConfig } from '../config.js'
import { info, printJson, handleApproval, renderNextActions, CliCancel } from '../util.js'
import { MANIFEST_FILE, collectManifestVariables, loadTemplateManifest, type TemplateManifest, type TemplateVar } from '../template-manifest.js'
import { parseGitHubTemplateUrl, fetchGitHubTemplate, type GitHubTarget, type GitHubSource, type FetchedTemplate } from '../github-source.js'

// ---- pure, unit-tested helpers ----

export type TemplateIndexEntry = {
  code: string; version: string; name: string; tagline?: string; category?: string
  maintainer?: string; totalProjects?: number; successRate?: number | null
}

// One aligned row per template; numeric columns right-aligned. Plain padded columns, as the rest
// of the CLI (storage list, domain check) — no table library.
export function templateListLines(templates: TemplateIndexEntry[]): string[] {
  if (!templates.length) return ['(no templates published yet)']
  const head = ['CODE', 'VERSION', 'CATEGORY', 'PROJECTS', 'SUCCESS', 'NAME']
  const numeric = [false, false, false, true, true, false]
  const rows = templates.map((t) => [
    t.code, t.version ?? '', t.category ?? '-',
    String(t.totalProjects ?? 0),
    // null = nothing has concluded yet; the platform never sends 0 for that.
    t.successRate == null ? '-' : `${t.successRate}%`,
    t.tagline ? `${t.name} — ${t.tagline}` : (t.name ?? ''),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  return [head, ...rows].map((r) =>
    r.map((c, i) => (i === r.length - 1 ? c : numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ').trimEnd(),
  )
}

// `volume` is the boolean a manifest declares now; `volumeGib` is a size a registry published
// before sizing moved to the platform. Both are read: the catalog serves whichever the row carries,
// and dropping the size on its own would quietly stop saying the service HAS a disk.
type InfoService = { name: string; type?: string; port?: number; healthcheck?: string; volumeGib?: number; volume?: boolean; mountPath?: string; pgVersion?: number; public?: boolean }

// The info endpoint may list services as an array or keep the manifest's map shape — render both.
export function normalizeInfoServices(raw: unknown): InfoService[] {
  const one = (name: string, s: any): InfoService => ({
    name, type: s?.type, port: s?.port,
    healthcheck: typeof s?.healthcheck === 'string' ? s.healthcheck : undefined,
    volumeGib: s?.volumeGib ?? s?.volume?.size,
    volume: s?.volume === true || s?.volumeGib != null || s?.volume?.size != null,
    mountPath: typeof s?.mountPath === 'string' ? s.mountPath : undefined,
    pgVersion: typeof s?.pgVersion === 'number' ? s.pgVersion : undefined,
    public: typeof s?.public === 'boolean' ? s.public : undefined,
  })
  if (Array.isArray(raw)) return raw.map((s: any) => one(s?.name ?? '?', s))
  if (raw && typeof raw === 'object') return Object.entries(raw as Record<string, any>).map(([name, s]) => one(name, s))
  return []
}

// Variables may arrive as one array with a `required` flag, or pre-grouped {required, optional}
// (the registry detail endpoint's shape).
export function normalizeInfoVariables(raw: unknown): TemplateVar[] {
  const one = (v: any, required: boolean): TemplateVar => ({
    name: v.name, required, description: v.description, default: v.default, generate: v.generate,
  })
  if (Array.isArray(raw)) return raw.map((v: any) => one(v, !!v.required))
  if (raw && typeof raw === 'object') {
    const g = raw as { required?: any[]; optional?: any[] }
    return [...(g.required ?? []).map((v) => one(v, true)), ...(g.optional ?? []).map((v) => one(v, false))]
  }
  return []
}

export type TemplateInfo = {
  code: string; name?: string; tagline?: string; version?: string; maintainer?: string
  source?: string; license?: string
  upstream?: { pinned?: string; image?: string; repo?: string }
  services?: unknown
  variables?: unknown
}

// The type plus what the manifest fixes about it: a Postgres major, or whether anyone can read a bucket.
function infoKind(s: InfoService): string | undefined {
  if (s.type === 'postgres' && s.pgVersion !== undefined) return `postgres ${s.pgVersion}`
  if (s.type === 'storage') return `storage, ${s.public ? 'public' : 'private'}`
  return s.type && s.type !== 'compute' ? s.type : undefined
}

// One line per bucket the template opens to the world, so a deploy never makes one public unannounced.
export function publicBucketLines(services: unknown): string[] {
  return normalizeInfoServices(services)
    .filter((s) => s.type === 'storage' && s.public === true)
    .map((s) => `${s.name}: public bucket, anyone can read its files (anonymous public-read)`)
}

// `bold` is injected so the renderer stays pure (tests pass identity; the command passes ANSI
// bold on a TTY).
export function templateInfoLines(t: TemplateInfo, bold: (s: string) => string = (s) => s): string[] {
  const lines: string[] = [`${t.code}${t.name ? ` — ${t.name}` : ''}`]
  if (t.tagline) lines.push(`  ${t.tagline}`)
  const field = (label: string, value: string | undefined) => { if (value) lines.push(`  ${label.padEnd(11)} ${value}`) }
  field('version', t.version)
  field('maintainer', t.maintainer)
  field('source', t.source)
  field('license', t.license)
  field('upstream', t.upstream?.pinned ?? t.upstream?.image ?? t.upstream?.repo)
  const services = normalizeInfoServices(t.services)
  if (services.length) {
    const summary = services.map((s) => {
      // A size only when the registry still carries one: a manifest names no size any more, so
      // "persistent /data" is all there is to say until the service exists.
      const disk = s.volumeGib ? `${s.volumeGib}Gi volume` : s.volume ? `persistent ${s.mountPath ?? '/data'}` : undefined
      // Only a web service has a path to probe, and a manifest that names none has no health check.
      const health = s.type === 'web' ? (s.healthcheck ? `health check ${s.healthcheck}` : 'no health check') : undefined
      const bits = [infoKind(s), s.port ? `port ${s.port}` : undefined, health, disk].filter(Boolean)
      return `${s.name}${bits.length ? ` (${bits.join(', ')})` : ''}`
    })
    lines.push(`services (${services.length}): ${summary.join(', ')}`)
  }
  const vars = normalizeInfoVariables(t.variables)
  if (vars.length) {
    lines.push('variables:')
    const render = (v: TemplateVar, emph: (s: string) => string) => {
      const extra = [v.generate ? `generated: ${v.generate}` : undefined, v.default !== undefined ? `default: ${v.default}` : undefined].filter(Boolean)
      lines.push(`    ${emph(v.name.padEnd(24))} ${v.description ?? ''}${extra.length ? ` (${extra.join(', ')})` : ''}`.trimEnd())
    }
    const required = vars.filter((v) => v.required)
    const optional = vars.filter((v) => !v.required)
    if (required.length) { lines.push('  required:'); for (const v of required) render(v, bold) }
    if (optional.length) { lines.push('  optional:'); for (const v of optional) render(v, (s) => s) }
  }
  return lines
}

// Parse repeated --set K=V flags. Names must be platform env-var names (the same rule the
// manifest's env maps live under), so a typo fails here instead of surviving to a server 400.
// Later occurrences of a name win (shell-override semantics).
export function parseSetFlags(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const pair of pairs) {
    const m = /^([A-Z][A-Z0-9_]{0,63})=([\s\S]*)$/.exec(pair)
    if (!m) throw new Error(`--set expects NAME=value (NAME matching ^[A-Z][A-Z0-9_]{0,63}$), got: ${pair}`)
    values[m[1]!] = m[2]!
  }
  return values
}

export function missingVariablesMessage(missing: TemplateVar[]): string {
  return [
    'missing required template variables:',
    ...missing.map((v) => `  ${v.name.padEnd(24)} ${v.description ?? ''}`.trimEnd()),
    'supply them with --set NAME=value (repeatable)',
  ].join('\n')
}

export type ResolveVarsOpts = {
  tty?: boolean
  ask?: (v: TemplateVar) => Promise<string>
  onAutoResolved?: (v: TemplateVar) => void
}

/**
 * Decide which deploy-time variables to SEND. The platform's own resolution order is
 * provided → generator → default (templateManifest.ts resolveVariables), so anything a generator
 * or default answers is left OFF the wire — the executor generates secrets itself (they never
 * transit) and applies defaults. What remains: --set wins; required vars with no machine answer
 * are prompted on a TTY and are an error anywhere else. Unknown --set names pass through — the
 * platform's variable set may be newer than local parsing.
 */
export async function resolveVariables(vars: TemplateVar[], given: Record<string, string>, opts: ResolveVarsOpts = {}): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...given }
  const missing: TemplateVar[] = []
  for (const v of vars) {
    if (values[v.name] !== undefined) continue
    if (v.generate || v.default !== undefined) { opts.onAutoResolved?.(v); continue }
    if (!v.required) continue
    if (opts.tty && opts.ask) { values[v.name] = await opts.ask(v); continue }
    missing.push(v)
  }
  if (missing.length) throw new Error(missingVariablesMessage(missing))
  return values
}

// The platform's machine-readable "you forgot these" answer to the POST (error=missing_variables,
// missing: [{name, key, description}]) — turned back into promptable variables. null = some other
// error, not ours to interpret.
export function missingVariablesFrom(body: any): TemplateVar[] | null {
  if ((body?.error ?? body?.code) !== 'missing_variables') return null
  const list = body?.missing ?? []
  if (!Array.isArray(list)) return []
  return list.map((v: any) => ({ name: String(v.name ?? v.key ?? v), required: true, description: v.description }))
}

// A deploy target that reads as a filesystem path must resolve as one — a typo'd directory should
// not fall through to a registry lookup that 404s with a confusing "no such template".
export function looksLikePath(target: string): boolean {
  return target.startsWith('.') || target.startsWith('/') || target.startsWith('~') || target.includes('/') || target.includes('\\')
}

export type DeployMode =
  | { kind: 'local'; dir: string }
  | { kind: 'registry'; code: string }
  | { kind: 'github'; target: GitHubTarget }

// Expanding `~` is normally the shell's job, but it only does it unquoted — `deploy "~/tpl"`, or a
// target assembled by an agent, arrives literally, and path.resolve() would then look for a
// directory actually named "~". looksLikePath advertises `~` as a local path, so honour it here.
// `~user` is left alone: resolving another user's home needs a passwd lookup, which no shell-less
// tool should fake.
const expandHome = (target: string): string => target.replace(/^~(?=[/\\]|$)/, () => homedir())

/**
 * Which deploy mode a target selects. A URL is classified FIRST — it contains `/`, which
 * looksLikePath would otherwise claim as a directory, and a non-GitHub URL must be named as
 * unsupported rather than reported as a missing manifest. Then: local mode is OPTED INTO by a
 * path-looking target (./dir, /abs, sub/dir); a bare word is ALWAYS a registry code — even when a
 * same-named directory with a manifest sits in the working directory, deploying it must be
 * explicit (./plausible), never a cwd coincidence. And a path-looking target with no manifest is a
 * mistake, never a registry code.
 */
export function deployMode(target: string, hasManifest: (dir: string) => boolean = (d) => existsSync(join(d, MANIFEST_FILE))): DeployMode {
  const github = parseGitHubTemplateUrl(target)
  if (github) return { kind: 'github', target: github }
  if (!looksLikePath(target)) return { kind: 'registry', code: target }
  const dir = resolve(process.cwd(), expandHome(target))
  if (!hasManifest(dir)) throw new Error(`no ${MANIFEST_FILE} at ${join(dir, MANIFEST_FILE)}`)
  return { kind: 'local', dir }
}

// ---- deployment progress ----

// The platform pipeline (insta-platform TemplateDeployment): status is running|succeeded|failed|
// partial, and `step` names where the run is (or stopped) — create_services → write_variables →
// deploy → health_check.
export const DEPLOY_STEPS = ['create services', 'write variables', 'deploy', 'health check'] as const
const STEP_KEYS = ['create_services', 'write_variables', 'deploy', 'health_check']

/** The index of the step a deployment is on, or null when it reports none (or one this CLI does
 *  not know) — the watcher then holds progress instead of guessing. */
export function stepIndexFor(step?: string): number | null {
  const i = STEP_KEYS.indexOf(step ?? '')
  return i >= 0 ? i : null
}

/** Success URLs, one line each: per-service `name: url` (plus bare urls, defensively). */
export function deploymentUrls(dep: any): string[] {
  const lines: string[] = []
  for (const u of dep?.urls ?? []) lines.push(String(u))
  for (const s of dep?.services ?? []) if (s?.url) lines.push(`${s.name ?? 'service'}: ${s.url}`)
  return lines
}

// One line per service with its terminal state — the anatomy of a partial/failed run.
// `skipped` is the platform saying the user deleted that service and the run stepped over it. Its
// `state` stays `pending`, which under the marks below would read as "not reached yet" — a run that
// is still going — so it gets its own mark and names the reason instead.
export function serviceStateLines(dep: any): string[] {
  return (dep?.services ?? []).map((s: any) => {
    if (s?.skipped) return `  - ${s?.name ?? 'service'} [skipped: it no longer exists, so the run stepped over it]`
    const mark = s?.state === 'healthy' ? '✓' : s?.state === 'failed' ? '✗' : '•'
    return `  ${mark} ${s?.name ?? 'service'}${s?.url ? ` — ${s.url}` : ''}${s?.state && s.state !== 'healthy' ? ` [${s.state}]` : ''}`
  })
}

// `partial` is TERMINAL: some services came up healthy, others failed, and the created resources
// are kept either way — so the message must say what stands and how to move (retry re-running the
// deploy, or clean up), not just that something went wrong.
export function partialMessage(dep: any): string {
  const services: any[] = dep?.services ?? []
  // A skipped service was never part of this run — the user had deleted it — so counting it in the
  // denominator would report a run that did everything it could as having left something behind.
  // It is still LISTED below, because "where did it go" is the question the count then raises.
  const ran = services.filter((s) => !s?.skipped)
  const healthy = ran.filter((s) => s?.state === 'healthy').length
  return [
    `template deployment finished partial: ${healthy}/${ran.length} services healthy`,
    ...serviceStateLines(dep),
    ...(dep?.error ? [`  ${dep.error}`] : []),
    ...(dep?.logsTail ? ['--- log tail ---', String(dep.logsTail).trimEnd()] : []),
    'created services are kept — inspect with `insta compute logs <name>`, re-run the deploy to retry, or remove them with `insta service remove <type> <name>`',
  ].join('\n')
}

export function failureMessage(dep: any, fallbackStep: number): string {
  const at = DEPLOY_STEPS[Math.min(stepIndexFor(dep?.step) ?? fallbackStep, DEPLOY_STEPS.length - 1)]
  return [
    `template deployment failed during ${at}${dep?.error ? `: ${dep.error}` : ''}`,
    ...serviceStateLines(dep),
    ...(dep?.logsTail ? ['--- log tail ---', String(dep.logsTail).trimEnd()] : []),
  ].join('\n')
}

const sleepSeconds = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000))

/**
 * Poll a template deployment until it settles, emitting each step exactly once as it completes
 * (✓) or becomes active (…). Terminal states: succeeded (returns), failed and partial (throw —
 * partial would otherwise poll forever, the platform never leaves it). Injectable getter/output/
 * wait keep this testable without a network or real timers (the deviceGrant pattern in auth.ts).
 */
export async function watchDeployment(
  getDeployment: (id: string) => Promise<any>,
  id: string,
  out: (line: string) => void = info,
  wait: (s: number) => Promise<void> = sleepSeconds,
  timeoutMs = 15 * 60_000,
): Promise<any> {
  let done = 0 // steps already reported ✓
  let active = -1 // step already reported …
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dep = await getDeployment(id)
    const status = String(dep?.status ?? '')
    const idx = stepIndexFor(dep?.step)
    const completed = status === 'succeeded' ? DEPLOY_STEPS.length : (idx ?? done)
    for (; done < completed; done++) out(`  ✓ ${DEPLOY_STEPS[done]}`)
    if (status === 'failed') throw new Error(failureMessage(dep, done))
    if (status === 'partial') throw new Error(partialMessage(dep))
    if (status === 'succeeded') return dep
    // No step named (or one this CLI doesn't know): HOLD — announcing `create services` off a
    // payload that never said so would be a guess, and the run may well be somewhere else.
    if (idx !== null) {
      const current = Math.min(idx, DEPLOY_STEPS.length - 1)
      if (active !== current) { out(`  … ${DEPLOY_STEPS[current]}`); active = current }
    }
    await wait(2)
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)}m waiting for template deployment ${id} — check \`insta agent events\``)
}

// ---- commands ----

export async function templateList(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const { templates } = await api.request('GET', '/templates')
  if (opts.json) return printJson(templates)
  for (const line of templateListLines(templates ?? [])) info(line)
}

export async function templateInfo(code: string, opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const tpl = await api.request('GET', `/templates/${encodeURIComponent(code)}`)
  if (opts.json) return printJson(tpl)
  const bold = process.stdout.isTTY ? (s: string) => `\x1b[1m${s}\x1b[0m` : (s: string) => s
  for (const line of templateInfoLines(tpl.template ?? tpl, bold)) info(line)
}

/** Real prompt (clack, as feedback.ts); cancelling exits without deploying anything. */
async function promptVariable(v: TemplateVar): Promise<string> {
  const answer = await clack.text({
    message: `${v.name}${v.description ? ` — ${v.description}` : ''}:`,
    validate: (s) => (s.trim() ? undefined : 'required'),
  })
  if (clack.isCancel(answer)) throw new CliCancel()
  return answer.trim()
}

export type TemplateDeployOpts = { branch?: string; set?: string[]; yes?: boolean; json?: boolean; region?: string }

// What the deploy path needs of the API client — ApiClient satisfies it.
export type TemplateApi = {
  request: (method: string, path: string, body?: unknown, opts?: { projectId?: string }) => Promise<any>
  rawRequest: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
}

// The outside world this command touches. Injectable (the deps pattern in feedback.ts) so the
// deploy path itself — which mode a target selects, and what reaches stdout — is testable without
// a network or a linked project.
export type TemplateDeployDeps = {
  api?: TemplateApi
  project?: ProjectConfig
  ask?: (v: TemplateVar) => Promise<string>
  wait?: (s: number) => Promise<void>
  fetchGitHub?: (t: GitHubTarget) => Promise<FetchedTemplate>
}

export async function templateDeploy(target: string, opts: TemplateDeployOpts = {}, deps: TemplateDeployDeps = {}): Promise<void> {
  const given = parseSetFlags(opts.set ?? []) // a typo'd --set fails before any network access
  // --json asked for parseable output: every human progress line is suppressed so stdout carries
  // exactly one JSON document (the repo's --json convention).
  const quiet = !!opts.json
  const api = deps.api ?? (await ApiClient.load())
  const p = deps.project ?? (await requireProject())
  const branchName = opts.branch ?? p.branch
  const ask = deps.ask ?? promptVariable

  // Local directory mode is opted into by a path-looking target; a bare word is always a registry
  // code, so a same-named local directory can never shadow the registry template.
  const mode = deployMode(target)

  let manifest: TemplateManifest | undefined
  let source: GitHubSource | undefined
  let vars: TemplateVar[]
  let services: unknown // what the template declares, for the one thing the deployer must be told
  if (mode.kind === 'github') {
    const fetched = await (deps.fetchGitHub ?? ((t: GitHubTarget) => fetchGitHubTemplate(t)))(mode.target)
    manifest = fetched.manifest
    source = fetched.source
    services = manifest.services
    vars = collectManifestVariables(manifest)
    // Exactly ONE line in front of today's output. A second "deploying template …" line
    // would read as a duplicate of the "deploying template <code> to branch <branch>" line below,
    // so the manifest's code@version rides on this one instead.
    if (!quiet) {
      info(`fetching template ${manifest.code}@${manifest.version} from github.com/${source.repo}@${source.ref}${source.path ? ` (${source.path})` : ''} at ${source.commit.slice(0, 7)}`)
    }
  } else if (mode.kind === 'local') {
    manifest = loadTemplateManifest(mode.dir) // parse + local validation (pinned images, described vars)
    services = manifest.services
    vars = collectManifestVariables(manifest)
    if (!quiet) info(`deploying local template ${manifest.code}@${manifest.version}`)
  } else {
    // Learn the variable set up front from the registry so prompting happens before the POST.
    const tpl = await api.request('GET', `/templates/${encodeURIComponent(mode.code)}`)
    vars = normalizeInfoVariables((tpl.template ?? tpl).variables)
    services = (tpl.template ?? tpl).services
  }

  // --json asked for parseable output, so a caller that happens to own a TTY still gets the error.
  const tty = !opts.json && !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  const onAutoResolved = quiet ? undefined : (v: TemplateVar) =>
    info(`  ${v.name}: ${v.generate ? `platform-generated (${v.generate})` : `default (${v.default})`}`)
  const variables = await resolveVariables(vars, given, { tty, ask, onAutoResolved })

  // The endpoint takes the branch NAME directly (branchId is its uuid alias) — no lookup needed.
  // Presence, not truthiness: `--region ''` must reach the platform's 400 rather than be dropped
  // into the default region. An omitted flag still sends no key, so a retry keeps the recorded one.
  const body = {
    ...(mode.kind === 'registry' ? { templateCode: mode.code } : { manifest }),
    branch: branchName,
    variables,
    ...(opts.region !== undefined ? { region: opts.region } : {}),
  }
  let res
  try {
    res = await api.rawRequest('POST', `/projects/${p.projectId}/template-deployments`, body)
  } catch (e) {
    // The platform's own variable check is the authority; when it names what is missing in a
    // machine-readable way, prompt from that and retry once instead of parroting an opaque 4xx.
    const missing = e instanceof ApiError ? missingVariablesFrom(e.body) : null
    if (!missing?.length) throw e
    Object.assign(variables, await resolveVariables(missing, {}, { tty, ask }))
    res = await api.rawRequest('POST', `/projects/${p.projectId}/template-deployments`, { ...body, variables })
  }
  // handleApproval owns the whole 202 contract (hint on stderr, raw envelope on stdout under
  // --json, exit code 2) — pass the flag through as every other gated command does.
  if (handleApproval(res, opts.json)) return

  const deploymentId = res.body.deploymentId ?? (res.body.deployment ?? res.body).id
  const acceptedRegion = (res.body.deployment ?? res.body).region
  const codeLabel = manifest?.code ?? target
  if (!quiet) {
    info(`deploying template ${codeLabel} to branch ${branchName}${acceptedRegion ? ` in ${acceptedRegion}` : ''} (${deploymentId})`)
    for (const line of publicBucketLines(services)) info(line)
  }
  // The poll route is keyed by deployment id, not project: name the project so agent mode signs
  // with the project-bound session (a bootstrap session is rejected as "for a different project").
  const dep = await watchDeployment((id) => api.request('GET', `/template-deployments/${id}`, undefined, { projectId: p.projectId }), deploymentId, quiet ? () => {} : info, deps.wait)
  if (opts.json) return printJson(source ? { source, ...dep } : dep)
  info(`template ${codeLabel} deployed to branch ${branchName}`)
  for (const u of deploymentUrls(dep)) info(`  ${u}`)
  // Provider credentials are not in the `insta secrets` bundle — point at the paths that exist.
  info('next: `insta postgres url` prints the postgres DSN; bind service credentials into compute with `insta secrets bind`; `insta secrets` refreshes user-defined secrets in .env')
  renderNextActions(dep.nextActions)
}

// ---- upgrade / rollback ----

export type TemplateUpgradeOpts = { set?: string[]; branch?: string; yes?: boolean; json?: boolean }
export type TemplateRollbackOpts = { set?: string[]; branch?: string; yes?: boolean; json?: boolean }

type PlanField = { field: string; label: string; deployed: string | null; live: string | null; next: string | null; drifted: boolean; verdict: string }
type PlanService = { key: string; service_name: string | null; gone: boolean; added: boolean; fields: PlanField[]; missing_variables: string[] }
type UpgradePlanBody = { from_version: string; to_version: string; to_digest: string; services: PlanService[]; removed: string[]; refusals: string[] }

/** The review, as lines. Current is the LIVE value: what the upgrade will overwrite. */
export function upgradePlanLines(plan: UpgradePlanBody): string[] {
  if (plan.refusals.length) {
    return ['This upgrade cannot run:', ...plan.refusals.map((r) => `  ${r}`)]
  }
  const lines = [`${plan.from_version} → ${plan.to_version}`]
  for (const s of plan.services) {
    const who = s.service_name ?? s.key
    if (s.gone) { lines.push(`  ${who}  no longer exists, skipped`); continue }
    if (s.added) { lines.push(`  ${who}  added by ${plan.to_version}`); continue }
    for (const f of s.fields) {
      const drift = f.drifted ? '  (you changed this, the upgrade will overwrite it)' : ''
      lines.push(`  ${who}  ${f.label}  ${f.live ?? '(none)'} → ${f.next}${drift}`)
    }
    for (const name of s.missing_variables) {
      lines.push(`  ${who}  ${name} is required by ${plan.to_version} and has no value, pass --set ${name}=...`)
    }
  }
  for (const key of plan.removed) lines.push(`  ${key}  dropped by ${plan.to_version}, left running`)
  return lines
}

// The 409 codes a user will actually hit, in a sentence that says what to do next.
const UPGRADE_409: Record<string, string> = {
  template_version_changed: 'The template was republished since the plan was shown. Nothing was changed. Run the command again to review the new version.',
}
const ROLLBACK_409: Record<string, string> = {
  template_version_not_recorded: 'The earlier version of this template is no longer recorded, so it cannot be restored. Nothing was changed.',
}

/**
 * Codes whose platform sentence names the deployment or the version to act on. Replacing it with
 * wording of our own would drop the one name that makes it actionable, so the platform's sentence
 * is printed as given and only the next step is appended.
 */
const KEEP_PLATFORM_SENTENCE: Record<string, string> = {
  // "this deployment was already replaced by <code>@<version> — act on that deployment instead".
  // Reachable here only for a service a NEWER version dropped: it keeps pointing at the deployment
  // the instance has moved off, which is the one this CLI resolves from the service name.
  template_superseded: 'Nothing was changed. This command addresses a service, so name one that the newer deployment carries.',
  // "<code>@<version> was republished with different content after this instance ran it …".
  template_version_content_changed: 'Nothing was changed.',
  // Two causes now, and the second one names the version: "this instance was already rolled back
  // to <version> … upgrade it to move forward", beside the original "was not upgraded from
  // anything". Our own wording could only say one of them, and said the wrong one for a rollback.
  template_no_step_back: 'Nothing was changed.',
}

/** The sentence to raise for a coded 409, or undefined when this is not one we explain. */
function coded409(e: unknown, advice: Record<string, string>): Error | undefined {
  if (!(e instanceof ApiError) || e.status !== 409) return undefined
  const code = typeof e.body?.code === 'string' ? e.body.code : ''
  if (advice[code]) return new Error(advice[code])
  const next = KEEP_PLATFORM_SENTENCE[code]
  return next ? new Error(`${e.message}. ${next}`) : undefined
}

async function postWithAdvice(api: TemplateApi, path: string, body: unknown, advice: Record<string, string>) {
  try {
    return await api.rawRequest('POST', path, body)
  } catch (e) {
    throw coded409(e, advice) ?? e
  }
}

/**
 * A service name is what a person has; a deployment uuid is not. The services list already carries
 * the attribution, so the lookup lives here rather than in the user's head.
 */
async function deploymentOfService(api: TemplateApi, projectId: string, branch: string, service: string, verb: 'upgrade' | 'roll back') {
  const body = await api.request('GET', `/projects/${projectId}/services?branch=${encodeURIComponent(branch)}`)
  const row = (body.services ?? []).find((s: any) => s.name === service)
  if (!row) throw new Error(`no service named ${service} on branch ${branch}`)
  // Named by the caller: the same sentence under `rollback` would send the user to upgrade instead.
  if (!row.template_deployment_id) throw new Error(`${service} was not deployed from a template, so there is nothing to ${verb}`)
  return { deploymentId: row.template_deployment_id as string }
}

export async function templateUpgrade(service: string, opts: TemplateUpgradeOpts = {}, deps: TemplateDeployDeps = {}): Promise<void> {
  const given = parseSetFlags(opts.set ?? []) // a typo'd --set fails before any network access
  const api = deps.api ?? (await ApiClient.load())
  const p = deps.project ?? (await requireProject())
  const branchName = opts.branch ?? p.branch
  const ask = deps.ask ?? promptVariable

  const target = await deploymentOfService(api, p.projectId, branchName, service, 'upgrade')
  // The poll and preview routes are keyed by deployment id, not project: name the project so agent
  // mode signs with the project-bound session, exactly as templateDeploy does.
  // The preview is a GET and raises coded 409s of its own (template_superseded among them), so it
  // gets the same reading as the POST rather than the raw "<sentence> (HTTP 409)" the guard prints.
  let plan
  try {
    ;({ plan } = await api.request('GET', `/template-deployments/${target.deploymentId}/upgrade`, undefined, { projectId: p.projectId }))
  } catch (e) {
    throw coded409(e, UPGRADE_409) ?? e
  }
  // --json alone is "tell me" (the plan, no upgrade); --json --yes is "do it and tell me".
  const quiet = !!opts.json
  if (opts.json && (!opts.yes || plan.refusals.length)) {
    printJson(plan)
    if (plan.refusals.length) process.exitCode = 1
    return
  }

  if (!quiet) for (const line of upgradePlanLines(plan)) info(line)
  // A refusal is not a prompt to confirm past: there is nothing to confirm.
  if (plan.refusals.length) { process.exitCode = 1; return }

  // Only what the new version ADDS is ever asked for: the platform recovers every value the
  // instance already holds, so re-prompting would invite the user to overwrite a live credential.
  const missing = plan.services.flatMap((s: PlanService) => s.missing_variables.map((name) => ({ name, required: true }) as TemplateVar))
  const tty = !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  const variables = missing.length ? await resolveVariables(missing, given, { tty, ask }) : given

  if (!opts.yes && tty) {
    const go = await clack.confirm({ message: `Upgrade ${service} from ${plan.from_version} to ${plan.to_version}?` })
    if (clack.isCancel(go)) throw new CliCancel()
    if (!go) return
  }

  // The version and digest the user just read. A republish in between answers 409 rather than
  // running something they never saw.
  const res = await postWithAdvice(api, `/projects/${p.projectId}/template-deployments/${target.deploymentId}/upgrade`, {
    variables, expectedVersion: plan.to_version, expectedDigest: plan.to_digest,
  }, UPGRADE_409)
  if (handleApproval(res, opts.json)) return

  const deploymentId = res.body.deploymentId ?? (res.body.deployment ?? res.body).id
  if (!quiet) info(`upgrading ${service} to ${plan.to_version} (${deploymentId})`)
  const dep = await watchDeployment((id) => api.request('GET', `/template-deployments/${id}`, undefined, { projectId: p.projectId }), deploymentId, quiet ? () => {} : info, deps.wait)
  if (quiet) return printJson(dep)
  info(`${service} is on ${plan.to_version}`)
  info(`next: \`insta template rollback ${service}\` returns it to ${plan.from_version}`)
  renderNextActions(dep.nextActions)
}

export async function templateRollback(service: string, opts: TemplateRollbackOpts = {}, deps: TemplateDeployDeps = {}): Promise<void> {
  const given = parseSetFlags(opts.set ?? []) // a typo'd --set fails before any network access
  const quiet = !!opts.json
  const out = quiet ? () => {} : info
  // Destructive, and its two warnings are load-bearing: a machine-readable run must say --yes out
  // loud rather than roll back unseen through a pipe.
  // Same rule as `template publish`: ask on a terminal, anywhere else (a pipe, --json) say --yes.
  const tty = !opts.json && !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  if (!opts.yes && !tty) throw new Error('rollback needs --yes without a terminal to confirm on: it does not restore data the app migrated, so nothing was rolled back')
  const api = deps.api ?? (await ApiClient.load())
  const p = deps.project ?? (await requireProject())
  const branchName = opts.branch ?? p.branch
  const ask = deps.ask ?? promptVariable
  const target = await deploymentOfService(api, p.projectId, branchName, service, 'roll back')

  // Said BEFORE the confirmation, not after the fact: rollback prints no plan, so these lines are
  // the whole disclosure, and what they warn of is not recoverable by running the command again.
  out('Going back restores every setting that version declares: the image, the start command, the port, always-on, public access, the volume mount path and the recorded variables.')
  out('A setting the older version does not declare keeps its current value.')
  out('Public access on a storage bucket reaches that bucket on every branch that has a copy, not only this one.')
  out('It does not restore data the app migrated under the newer version, and a volume only grows.')
  if (tty) {
    const go = await clack.confirm({ message: `Return ${service} to the version it was upgraded from?` })
    if (clack.isCancel(go)) throw new CliCancel()
    if (!go) return
  }

  // The platform recovers every value the services still hold, so a rollback normally sends
  // nothing. What it cannot recover is a variable the NEWER version stopped declaring: the upgrade
  // deleted that value and the older manifest still requires it. Rollback prints no plan, so the
  // platform's 400 naming them is the only place those names exist — prompt from it and retry
  // once, exactly as templateDeploy does with its own missing_variables.
  const rollbackPath = `/projects/${p.projectId}/template-deployments/${target.deploymentId}/rollback`
  const variables: Record<string, string> = { ...given }
  let res
  try {
    res = await postWithAdvice(api, rollbackPath, { variables }, ROLLBACK_409)
  } catch (e) {
    const missing = e instanceof ApiError ? missingVariablesFrom(e.body) : null
    if (!missing?.length) throw e
    // No TTY (or --yes) fails here with the `--set NAME=value` list, the same rule the deploy and
    // upgrade paths follow — nothing has been rolled back at this point.
    Object.assign(variables, await resolveVariables(missing, {}, { tty, ask }))
    res = await postWithAdvice(api, rollbackPath, { variables }, ROLLBACK_409)
  }
  if (handleApproval(res, opts.json)) return
  const deploymentId = res.body.deploymentId ?? (res.body.deployment ?? res.body).id
  out(`rolling ${service} back (${deploymentId})`)
  const dep = await watchDeployment((id) => api.request('GET', `/template-deployments/${id}`, undefined, { projectId: p.projectId }), deploymentId, out, deps.wait)
  if (quiet) return printJson(dep)
  info(`${service} is back on ${(dep.deployment ?? dep).template_version ?? 'its previous version'}`)
  renderNextActions(dep.nextActions)
}
