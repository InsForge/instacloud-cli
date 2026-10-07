// `insta template` authoring commands: the org's community templates, from drafts to the gallery.
import { readFileSync } from 'node:fs'
import { agentMode } from '../agent.js'
import { ApiClient, ApiError, requireProject } from '../api.js'
import type { ProjectConfig } from '../config.js'
import { info, printJson, refuse } from '../util.js'
import { resolveOrgId } from './billing.js'
import { confirmOnTerminal } from './postgres.js'

// ---- the platform's draft view, as far as this file reads it (--json passes all of it) ----

/** One publish requirement. The code is read as a string so a newer platform's code prints too. */
export type TemplateRequirement = { code: string; ok: boolean; items: string[] }
export type TemplateDraftVariable = {
  name: string; kind: string; value?: string; description?: string; brokenReference?: string; originalName?: string
}
export type TemplateDraftService = {
  name: string; type: string; image: string | null; port: number | null; healthcheck?: string | null; volume: boolean; mountPath: string | null
  public?: boolean; pgVersion?: number; removed: boolean; variables: TemplateDraftVariable[]
}
export type TemplateDraft = {
  code: string; orgId: string; name: string; status: string; publishedVersion: string | null
  hasUnpublishedChanges: boolean; takenDown: boolean; tagline: string | null; category: string | null
  readme: string | null; logoUrl: string | null; services: TemplateDraftService[]
  publishRequirements: TemplateRequirement[]; updatedAt: string
}
type DraftAnswer = { template: TemplateDraft }
/** What regenerate found added or removed in the project since the last build. */
export type TemplateChanges = { addedServices: string[]; removedServices: string[]; addedVariables: string[]; removedVariables: string[] }

export type TemplateAuthorDeps = {
  api?: Pick<ApiClient, 'apiUrl' | 'request'>
  /** The linked project, read only when neither --org nor --project names the target. */
  project?: () => Promise<ProjectConfig>
  readStdin?: () => Promise<string>
  /** Whether a person can answer a prompt: stdin and stdout are terminals. */
  tty?: boolean
  /** Whether an agent runs this command, read from agent mode when not given. */
  agent?: boolean
  confirm?: (question: string) => Promise<boolean>
}
type OrgOpts = { org?: string; json?: boolean }

// ---- pure helpers ----

/** The console editor of a draft: the API host with its leading `api.` label read as `console.`. */
export function templateEditorUrl(apiUrl: string, orgId: string, code: string): string | null {
  let url: URL
  try { url = new URL(apiUrl) } catch { return null }
  const labels = url.hostname.split('.')
  // Any other host has no console this CLI knows of.
  if (labels.length < 2 || labels[0] !== 'api') return null
  url.hostname = ['console', ...labels.slice(1)].join('.')
  return `${url.origin}/orgs/${encodeURIComponent(orgId)}/templates/${encodeURIComponent(code)}`
}

/** The status a person reads. */
export function templateStatusWord(t: Pick<TemplateDraft, 'status' | 'hasUnpublishedChanges' | 'takenDown'>): string {
  if (t.takenDown) return 'taken down'
  if (t.status === 'published' && t.hasUnpublishedChanges) return 'published, with unpublished edits'
  return t.status
}

const headLine = (t: TemplateDraft): string => `${t.code}: ${t.name} (${templateStatusWord(t)})`

/** One aligned row per template of the org, as `template list` prints the gallery. */
export function draftListLines(templates: TemplateDraft[]): string[] {
  if (!templates.length) return ['no templates in this org yet, create one with: insta template create']
  const head = ['CODE', 'STATUS', 'VERSION', 'NAME']
  const rows = templates.map((t) => [t.code, templateStatusWord(t), t.publishedVersion ?? '-', t.name])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  return [head, ...rows].map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd())
}

/** Each requirement with its mark, and what is still missing for an unmet one. */
export function requirementLines(requirements: TemplateRequirement[]): string[] {
  return requirements.map((r) => `  ${r.ok ? '✓' : '✗'} ${r.code}${!r.ok && r.items.length ? `: ${r.items.join(', ')}` : ''}`)
}

/** What still stands between the draft and a publish. */
export function readinessLines(requirements: TemplateRequirement[]): string[] {
  const unmet = requirements.filter((r) => !r.ok)
  return unmet.length ? ['not ready to publish yet:', ...requirementLines(unmet)] : ['ready to publish']
}

/** What a regenerate found changed in the project since the draft was last built. */
export function regenerateChangeLines(c: TemplateChanges): string[] {
  const rows: Array<[string, string[]]> = [
    ['services added', c.addedServices], ['services removed', c.removedServices],
    ['variables added', c.addedVariables], ['variables removed', c.removedVariables],
  ]
  const lines = rows.filter(([, names]) => names.length).map(([label, names]) => `  ${label}: ${names.join(', ')}`)
  return lines.length ? lines : ['  no service or variable was added to or removed from the project']
}

function serviceText(s: TemplateDraftService): string {
  const kind = s.type === 'postgres' && s.pgVersion !== undefined ? `postgres ${s.pgVersion}`
    : s.type === 'storage' ? `storage, ${s.public ? 'public' : 'private'}`
    : s.type
  const bits = [
    kind,
    s.port != null ? `port ${s.port}` : undefined,
    // Only a web service has one, and a platform that does not serve the field says nothing.
    s.type === 'web' && s.healthcheck !== undefined ? (s.healthcheck ? `health check ${s.healthcheck}` : 'no health check') : undefined,
    s.image ? `image ${s.image}` : undefined,
    // A null mount path on a volume is the default /data.
    s.volume ? `volume at ${s.mountPath ?? '/data'}` : undefined,
    s.removed ? 'removed' : undefined,
  ]
  return `${s.name} (${bits.filter(Boolean).join(', ')})`
}

function variableText(v: TemplateDraftVariable): string {
  const notes = [
    v.originalName ? `renamed from ${v.originalName}` : undefined,
    v.brokenReference ? `broken reference ${v.brokenReference}` : undefined,
  ].filter(Boolean)
  return `${v.kind}${v.value !== undefined ? ` ${v.value}` : ''}${v.description ? `: ${v.description}` : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`
}

/** The whole draft as `draft <code>` prints it. */
export function draftLines(t: TemplateDraft, editorUrl: string | null): string[] {
  const lines = [headLine(t)]
  const field = (label: string, value: string | null) => { if (value) lines.push(`  ${label.padEnd(9)} ${value}`) }
  field('tagline', t.tagline)
  field('category', t.category)
  field('readme', t.readme ? `${Buffer.byteLength(t.readme, 'utf8')} bytes` : null)
  field('logo', t.logoUrl)
  field('version', t.publishedVersion)
  field('updated', t.updatedAt)
  lines.push(`services (${t.services.length}):`)
  for (const s of t.services) {
    lines.push(`  ${serviceText(s)}`)
    const width = Math.max(...s.variables.map((v) => v.name.length))
    for (const v of s.variables) lines.push(`    ${v.name.padEnd(width)}  ${variableText(v)}`)
  }
  lines.push('publish requirements:', ...requirementLines(t.publishRequirements))
  if (editorUrl) lines.push(`editor: ${editorUrl}`)
  return lines
}

/** The console editor's PATCH body, as an agent wrote it to a file or to stdin. */
export function parsePatch(text: string, from: string): Record<string, unknown> {
  let value: unknown
  try {
    // A UTF-8 BOM belongs to the file, and JSON.parse rejects it.
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (e) {
    throw new Error(`the patch from ${from} is not valid JSON: ${(e as Error).message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`the patch from ${from} must be one JSON object, the body the console editor sends, for example {"tagline": "Self-hosted analytics"}`)
  }
  return value as Record<string, unknown>
}

export const BLANK_NOT_YET = 'this platform does not create blank templates yet. Create a template from a project instead: insta template create --project <id>'

async function createBlank(api: Pick<ApiClient, 'request'>, orgId: string, body: { name: string } | undefined): Promise<DraftAnswer> {
  try {
    return await api.request<DraftAnswer>('POST', `/orgs/${orgId}/templates`, body)
  } catch (e) {
    // No route yet: Fastify's own 404 for a person, the governance hook's refusal for an agent.
    const missing = e instanceof ApiError
      && ((e.status === 404 && e.body?.error === 'Not Found') || (e.status === 403 && e.body?.error === 'unclassified_agent_action'))
    if (missing) throw new Error(BLANK_NOT_YET)
    throw e
  }
}

// A coded answer is a whole sentence for the person: print it without the HTTP status.
async function platformSentence<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (e) {
    if (e instanceof ApiError && typeof e.body?.code === 'string') throw new Error(e.message)
    throw e
  }
}

// Decode once at the end: a multi-byte character can straddle two chunks.
export async function readAllStdin(stream: AsyncIterable<Buffer> = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const byAgent = (deps: TemplateAuthorDeps): boolean => deps.agent ?? !!agentMode()

// An agent on a pty and --json are never a person at the prompt.
const canAsk = (opts: { json?: boolean }, deps: TemplateAuthorDeps): boolean =>
  !opts.json && !byAgent(deps) && (deps.tty ?? (!!process.stdin.isTTY && !!process.stdout.isTTY))

const noAnswerReason = (deps: TemplateAuthorDeps): string =>
  byAgent(deps) ? 'an agent passes --yes only after the person has said yes.' : 'there is no terminal to confirm on.'

const orgFlag = (opts: { org?: string }): string => (opts.org ? ` --org ${opts.org}` : '')

// ---- commands ----

export async function templateDrafts(opts: OrgOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  const { templates } = await api.request<{ templates: TemplateDraft[] }>('GET', `/orgs/${orgId}/templates`)
  if (opts.json) return printJson(templates)
  for (const line of draftListLines(templates)) info(line)
}

export async function templateDraft(code: string, opts: OrgOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  const { template } = await api.request<DraftAnswer>('GET', `/orgs/${orgId}/templates/${encodeURIComponent(code)}`)
  const editorUrl = templateEditorUrl(api.apiUrl, template.orgId, template.code)
  if (opts.json) return printJson({ template, editorUrl })
  for (const line of draftLines(template, editorUrl)) info(line)
}

export type TemplateCreateOpts = OrgOpts & { project?: string; blank?: boolean; name?: string }

export async function templateCreate(opts: TemplateCreateOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  if (opts.blank && opts.project) throw new Error('--blank starts a template with no project, so it does not take --project')
  if (opts.org && !opts.blank) throw new Error("--org goes with --blank: a draft generated from a project belongs to that project's org")
  // Presence, not truthiness: an empty --name reaches the platform's own sentence.
  const body = opts.name !== undefined ? { name: opts.name } : undefined
  const api = deps.api ?? (await ApiClient.load())
  let answer: DraftAnswer
  if (opts.blank) {
    answer = await createBlank(api, await resolveOrgId(opts, deps.project), body)
  } else {
    const projectId = opts.project ?? (await (deps.project ?? requireProject)()).projectId
    answer = await api.request<DraftAnswer>('POST', `/projects/${projectId}/template-drafts`, body)
  }
  const { template } = answer
  const editorUrl = templateEditorUrl(api.apiUrl, template.orgId, template.code)
  if (opts.json) return printJson({ template, editorUrl })
  info(`created ${headLine(template)}`)
  if (editorUrl) info(`editor: ${editorUrl}`)
}

export type TemplateEditOpts = OrgOpts & { patch: string }

export async function templateEdit(code: string, opts: TemplateEditOpts, deps: TemplateAuthorDeps = {}): Promise<void> {
  const from = opts.patch === '-' ? 'stdin' : opts.patch
  let text: string
  try {
    text = opts.patch === '-' ? await (deps.readStdin ?? readAllStdin)() : readFileSync(opts.patch, 'utf8')
  } catch (e) {
    throw new Error(`cannot read the patch from ${from}: ${(e as Error).message}`)
  }
  const patch = parsePatch(text, from)
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  const path = `/orgs/${orgId}/templates/${encodeURIComponent(code)}`
  // Without one, the edit applies to the draft as it is now.
  const expectedUpdatedAt = patch.expectedUpdatedAt ?? (await api.request<DraftAnswer>('GET', path)).template.updatedAt
  const { template } = await platformSentence(api.request<DraftAnswer>('PATCH', path, { ...patch, expectedUpdatedAt }))
  if (opts.json) return printJson({ template, editorUrl: templateEditorUrl(api.apiUrl, template.orgId, template.code) })
  info(`saved ${headLine(template)}`)
  for (const line of readinessLines(template.publishRequirements)) info(line)
}

export async function templateRegenerate(code: string, opts: OrgOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  let answer: DraftAnswer & { changes: TemplateChanges }
  try {
    answer = await api.request('POST', `/orgs/${orgId}/templates/${encodeURIComponent(code)}/regenerate`)
  } catch (e) {
    // Its 400s are sentences for the person: a blank draft, a deleted source project.
    if (e instanceof ApiError && e.status === 400) throw new Error(e.message)
    throw e
  }
  const { template, changes } = answer
  if (opts.json) return printJson({ template, changes, editorUrl: templateEditorUrl(api.apiUrl, template.orgId, template.code) })
  info(`regenerated ${headLine(template)}`)
  for (const line of regenerateChangeLines(changes)) info(line)
  for (const line of readinessLines(template.publishRequirements)) info(line)
}

export type TemplateConfirmOpts = OrgOpts & { yes?: boolean }

export async function templatePublish(code: string, opts: TemplateConfirmOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  if (!opts.yes && !canAsk(opts, deps)) {
    refuse([
      `refusing to publish ${code} without --yes: ${noAnswerReason(deps)}`,
      `Publishing lists the template in the community gallery at once, with no review. Ask the person first, then run: insta template publish ${code}${orgFlag(opts)} --yes`,
    ])
  }
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  const path = `/orgs/${orgId}/templates/${encodeURIComponent(code)}`
  const { template: current } = await api.request<DraftAnswer>('GET', path)
  if (!opts.yes) {
    info(`${code} becomes public in the community gallery at once, with no review. Anyone can find it and deploy it.`)
    if (!(await (deps.confirm ?? confirmOnTerminal)(`Publish ${code} now?`))) return info('nothing was published')
  }
  const { template } = await platformSentence(api.request<DraftAnswer>('POST', `${path}/publish`, { expectedUpdatedAt: current.updatedAt }))
  if (opts.json) return printJson({ template, editorUrl: templateEditorUrl(api.apiUrl, template.orgId, template.code) })
  info(`published ${template.code} version ${template.publishedVersion} to the community gallery`)
  info(`take it out again with: insta template unpublish ${template.code}${orgFlag(opts)}`)
}

export async function templateUnpublish(code: string, opts: OrgOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  const { template } = await api.request<DraftAnswer>('POST', `/orgs/${orgId}/templates/${encodeURIComponent(code)}/unpublish`)
  if (opts.json) return printJson({ template, editorUrl: templateEditorUrl(api.apiUrl, template.orgId, template.code) })
  info(`unpublished ${template.code}: it is out of the community gallery, and deployed copies keep running`)
}

export async function templateDelete(code: string, opts: TemplateConfirmOpts = {}, deps: TemplateAuthorDeps = {}): Promise<void> {
  if (!opts.yes && !canAsk(opts, deps)) {
    refuse([
      `refusing to delete the draft ${code} without --yes: ${noAnswerReason(deps)}`,
      `Deleting cannot be undone. To go ahead, run: insta template delete ${code}${orgFlag(opts)} --yes`,
    ])
  }
  const api = deps.api ?? (await ApiClient.load())
  const orgId = await resolveOrgId(opts, deps.project)
  if (!opts.yes && !(await (deps.confirm ?? confirmOnTerminal)(`Delete the draft ${code}? This cannot be undone.`))) {
    return info('nothing was deleted')
  }
  await api.request('DELETE', `/orgs/${orgId}/templates/${encodeURIComponent(code)}`)
  if (opts.json) return printJson({ ok: true, orgId, code })
  info(`deleted the draft ${code}`)
}
