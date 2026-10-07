// `insta template` authoring commands: the org's community templates, from drafts to the gallery.
import { ApiClient } from '../api.js'
import type { ProjectConfig } from '../config.js'
import { info, printJson } from '../util.js'
import { resolveOrgId } from './billing.js'

// ---- the platform's draft view, as far as this file reads it (--json passes all of it) ----

/** One publish requirement. The code is read as a string so a newer platform's code prints too. */
export type TemplateRequirement = { code: string; ok: boolean; items: string[] }
export type TemplateDraftVariable = {
  name: string; kind: string; value?: string; description?: string; brokenReference?: string; originalName?: string
}
export type TemplateDraftService = {
  name: string; type: string; image: string | null; port: number | null; volume: boolean; mountPath: string | null
  public?: boolean; pgVersion?: number; removed: boolean; variables: TemplateDraftVariable[]
}
export type TemplateDraft = {
  code: string; orgId: string; name: string; status: string; publishedVersion: string | null
  hasUnpublishedChanges: boolean; takenDown: boolean; tagline: string | null; category: string | null
  readme: string | null; logoUrl: string | null; services: TemplateDraftService[]
  publishRequirements: TemplateRequirement[]; updatedAt: string
}
type DraftAnswer = { template: TemplateDraft }

export type TemplateAuthorDeps = {
  api?: Pick<ApiClient, 'apiUrl' | 'request'>
  /** The linked project, read only when neither --org nor --project names the target. */
  project?: () => Promise<ProjectConfig>
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

function serviceText(s: TemplateDraftService): string {
  const kind = s.type === 'postgres' && s.pgVersion !== undefined ? `postgres ${s.pgVersion}`
    : s.type === 'storage' ? `storage, ${s.public ? 'public' : 'private'}`
    : s.type
  const bits = [
    kind,
    s.port != null ? `port ${s.port}` : undefined,
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
