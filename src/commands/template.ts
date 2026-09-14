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
// of the CLI (storage list, compute check-domain) — no table library.
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
type InfoService = { name: string; type?: string; port?: number; volumeGib?: number; volume?: boolean }

// The info endpoint may list services as an array or keep the manifest's map shape — render both.
export function normalizeInfoServices(raw: unknown): InfoService[] {
  const one = (name: string, s: any): InfoService => ({
    name, type: s?.type, port: s?.port,
    volumeGib: s?.volumeGib ?? s?.volume?.size,
    volume: s?.volume === true || s?.volumeGib != null || s?.volume?.size != null,
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
      const disk = s.volumeGib ? `${s.volumeGib}Gi volume` : s.volume ? 'persistent /data' : undefined
      const bits = [s.type && s.type !== 'compute' ? s.type : undefined, s.port ? `port ${s.port}` : undefined, disk].filter(Boolean)
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
export function serviceStateLines(dep: any): string[] {
  return (dep?.services ?? []).map((s: any) => {
    const mark = s?.state === 'healthy' ? '✓' : s?.state === 'failed' ? '✗' : '•'
    return `  ${mark} ${s?.name ?? 'service'}${s?.url ? ` — ${s.url}` : ''}${s?.state && s.state !== 'healthy' ? ` [${s.state}]` : ''}`
  })
}

// `partial` is TERMINAL: some services came up healthy, others failed, and the created resources
// are kept either way — so the message must say what stands and how to move (retry re-running the
// deploy, or clean up), not just that something went wrong.
export function partialMessage(dep: any): string {
  const services: any[] = dep?.services ?? []
  const healthy = services.filter((s) => s?.state === 'healthy').length
  return [
    `template deployment finished partial: ${healthy}/${services.length} services healthy`,
    ...serviceStateLines(dep),
    ...(dep?.error ? [`  ${dep.error}`] : []),
    ...(dep?.logsTail ? ['--- log tail ---', String(dep.logsTail).trimEnd()] : []),
    'created services are kept — inspect with `insta logs compute <name>`, re-run the deploy to retry, or remove them with `insta services remove <type> <name>`',
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
  throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)}m waiting for template deployment ${id} — check \`insta events\``)
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

export type TemplateDeployOpts = { branch?: string; set?: string[]; yes?: boolean; json?: boolean }

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
  if (mode.kind === 'github') {
    const fetched = await (deps.fetchGitHub ?? ((t: GitHubTarget) => fetchGitHubTemplate(t)))(mode.target)
    manifest = fetched.manifest
    source = fetched.source
    vars = collectManifestVariables(manifest)
    // Spec 4.4: exactly ONE line in front of today's output. A second "deploying template …" line
    // would read as a duplicate of the "deploying template <code> to branch <branch>" line below,
    // so the manifest's code@version rides on this one instead.
    if (!quiet) {
      info(`fetching template ${manifest.code}@${manifest.version} from github.com/${source.repo}@${source.ref}${source.path ? ` (${source.path})` : ''} at ${source.commit.slice(0, 7)}`)
    }
  } else if (mode.kind === 'local') {
    manifest = loadTemplateManifest(mode.dir) // parse + local validation (pinned images, described vars)
    vars = collectManifestVariables(manifest)
    if (!quiet) info(`deploying local template ${manifest.code}@${manifest.version}`)
  } else {
    // Learn the variable set up front from the registry so prompting happens before the POST.
    const tpl = await api.request('GET', `/templates/${encodeURIComponent(mode.code)}`)
    vars = normalizeInfoVariables((tpl.template ?? tpl).variables)
  }

  // --json asked for parseable output, so a caller that happens to own a TTY still gets the error.
  const tty = !opts.json && !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  const onAutoResolved = quiet ? undefined : (v: TemplateVar) =>
    info(`  ${v.name}: ${v.generate ? `platform-generated (${v.generate})` : `default (${v.default})`}`)
  const variables = await resolveVariables(vars, given, { tty, ask, onAutoResolved })

  // The endpoint takes the branch NAME directly (branchId is its uuid alias) — no lookup needed.
  const body = { ...(mode.kind === 'registry' ? { templateCode: mode.code } : { manifest }), branch: branchName, variables }
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
  const codeLabel = manifest?.code ?? target
  if (!quiet) info(`deploying template ${codeLabel} to branch ${branchName} (${deploymentId})`)
  // The poll route is keyed by deployment id, not project: name the project so agent mode signs
  // with the project-bound session (a bootstrap session is rejected as "for a different project").
  const dep = await watchDeployment((id) => api.request('GET', `/template-deployments/${id}`, undefined, { projectId: p.projectId }), deploymentId, quiet ? () => {} : info, deps.wait)
  if (opts.json) return printJson(source ? { source, ...dep } : dep)
  info(`template ${codeLabel} deployed to branch ${branchName}`)
  for (const u of deploymentUrls(dep)) info(`  ${u}`)
  // Provider credentials are not in the `insta secrets` bundle — point at the paths that exist.
  info('next: `insta db url` prints the postgres DSN; bind service credentials into compute with `insta secrets bind`; `insta secrets` refreshes user-defined secrets in .env')
  renderNextActions(dep.nextActions)
}
