import { ApiClient, requireProject } from '../api.js'
import { die, info, printJson } from '../util.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function events(opts: { branch?: string; limit?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs: string[] = []
  if (opts.branch) {
    let id = opts.branch
    // An id passes through unlooked-up: a deleted branch keeps its events but leaves the branch list.
    if (!UUID.test(id)) {
      const { branches } = await api.request('GET', `/projects/${p.projectId}/branches`)
      const b = branches.find((x: any) => x.name === id)
      if (!b) die(`branch not found: ${id}`)
      id = b.id
    }
    qs.push(`branch=${encodeURIComponent(id)}`)
  }
  if (opts.limit) qs.push(`limit=${opts.limit}`)
  const { events } = await api.request('GET', `/projects/${p.projectId}/events${qs.length ? `?${qs.join('&')}` : ''}`)
  if (opts.json) return printJson(events)
  for (const e of events) info(`${e.created_at}  [${e.source}] ${e.kind}`)
}

export async function approvalsList(opts: { status?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { approvals } = await api.request('GET', `/projects/${p.projectId}/approvals${opts.status ? `?status=${opts.status}` : ''}`)
  if (opts.json) return printJson(approvals)
  if (!approvals.length) return info('(no approvals)')
  for (const a of approvals) info(`${a.id}  ${a.action}  [${a.status}]  ${a.requested_at}`)
}

export async function approvalsApprove(id: string, opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const out = await api.request('POST', `/projects/${p.projectId}/approvals/${id}/approve`, {})
  if (opts.json) return printJson(out)
  info(`approved ${out.approval.action} (${id})`)
}

export async function approvalsDeny(id: string, opts: { json?: boolean } = {}): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const out = await api.request('POST', `/projects/${p.projectId}/approvals/${id}/deny`)
  if (opts.json) return printJson(out)
  info(`denied ${out.approval.action} (${id})`)
}
