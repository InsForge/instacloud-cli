import { ApiClient, requireProject } from '../api.js'
import { die, info, printJson } from '../util.js'

export async function events(opts: { branch?: string; limit?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs: string[] = []
  if (opts.branch) {
    const { branches } = await api.request('GET', `/projects/${p.projectId}/branches`)
    const b = branches.find((x: any) => x.name === opts.branch || x.id === opts.branch!.toLowerCase())
    if (!b) die(`branch not found: ${opts.branch}`)
    qs.push(`branch=${encodeURIComponent(b.id)}`)
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
