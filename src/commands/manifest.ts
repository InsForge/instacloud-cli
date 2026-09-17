import { ApiClient, requireProject } from '../api.js'
import { pgBadge } from './services.js'
import { info, printJson } from '../util.js'

// A resource row as the platform's project-detail read returns it.
export type ManifestResource = {
  kind?: string
  // The compute plane actually backing a compute row ('fly' | 'microvm'). Only compute rows carry
  // it, and the platform OMITS it when it cannot tell. Older platforms never send it at all.
  provider?: string
  name?: string | null
  branchId?: string | null
  status?: string
  // pgVersion: the Postgres MAJOR a database row runs (root and branch rows alike); absent on
  // older platforms and on legacy rows that never recorded one.
  ref?: { url?: string; bucket?: string; neonProjectId?: string; pgVersion?: number } | null
}

/**
 * The label that names WHERE a resource runs.
 *
 * `kind` is the platform's internal resource kind, and for compute it is always 'fly' — 'fly' is
 * the compute SEAT, occupied by the microvm plane on any environment that has cut over. Printing
 * it tells users and agents that a microvm-backed service runs on Fly.
 *
 * So for compute rows the label is the platform's explicit `provider`, and when that is absent --
 * an older platform, or a row whose provider the platform itself could not determine -- we fall
 * back to the neutral 'compute'. That names the resource without asserting a plane: no provider
 * beats a wrong one. Non-compute kinds keep printing their kind.
 */
export function resourceLabel(r: ManifestResource): string {
  const kind = r.kind ?? 'resource'
  const label = kind === 'fly' ? (r.provider === 'fly' || r.provider === 'microvm' ? r.provider : 'compute') : kind
  return `${label}${r.name ? `(${r.name})` : ''}`
}

// One `manifest` resource line. Pure, so the label is unit-tested without a network mock.
export function resourceLine(r: ManifestResource): string {
  const where = r.ref?.url ?? r.ref?.bucket ?? r.ref?.neonProjectId ?? ''
  // Database rows only: the platform stamps ref.pgVersion on insta-db (and legacy neon) resources.
  const pg = r.kind === 'insta-db' || r.kind === 'neon' ? pgBadge(r.ref?.pgVersion) : ''
  return `    - ${resourceLabel(r)}  ${where}${pg}  [${r.status}]`
}

// Agent-legible view of each environment's databases / storage / compute.
export async function manifest(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const detail = await api.request('GET', `/projects/${p.projectId}`)
  if (opts.json) return printJson(detail)
  info(`project ${detail.project.name} (${detail.project.id}) [${detail.project.status}]`)
  for (const b of detail.branches) {
    info(`  branch ${b.name}${b.is_default ? ' *' : ''} [${b.status}]`)
    const rs = detail.resources.filter((r: any) => r.branchId === b.id || (b.is_default && r.branchId === null))
    for (const r of rs) info(resourceLine(r))
  }
}
