// `insta redis|mysql|mongodb …` — the managed Fly databases. Their settings verbs (limits / volume /
// always-on) reuse compute.ts's type-generalized handlers: the platform's /services/:id/{limits,
// volume,always-on} accept "compute or managed-database" services. `status` cannot: GET
// /services/:id/state is compute-only on the platform (services.state() throws for anything else),
// so it reads the project's runtime-health — which covers compute, postgres and the managed DBs in
// one call — and picks this service's entry.
import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'
import { q, resolveSoleService } from './services.js'
import type { Engine } from './db-query.js'

// One entry of GET /projects/:id/runtime-health. `status` is the platform's health vocabulary:
// healthy | crashed | starting | standby | none | unknown — `standby` means scaled to zero and
// waking on request, which is normal, not a failure.
export type HealthEntry = { serviceId: string; status: string; machines: number; failing: number }

// pure: `redis cache: standby  (1 machine, 0 failing)`. Exported for tests.
export function statusLine(type: string, name: string, entry: HealthEntry | undefined): string {
  if (!entry) return `${type} ${name}: unknown  (the runtime-health read did not include this service)`
  const machines = `${entry.machines} machine${entry.machines === 1 ? '' : 's'}`
  return `${type} ${name}: ${entry.status}  (${machines}, ${entry.failing} failing)`
}

// The API surface this command needs, injectable so the flow is testable without a network mock
// (the DomainDeps convention in compute.ts). Production loads a real ApiClient + requireProject().
export type ManagedApi = Pick<ApiClient, 'request'>
export type ManagedDeps = { api: ManagedApi; project: { projectId: string; branch?: string } }
async function managedDeps(deps?: ManagedDeps): Promise<ManagedDeps> {
  if (deps) return deps
  const [api, project] = [await ApiClient.load(), await requireProject()]
  return { api, project }
}

export async function managedStatus(
  type: Engine,
  serviceName: string | undefined,
  opts: { branch?: string; json?: boolean },
  deps?: ManagedDeps,
): Promise<void> {
  const { api, project: p } = await managedDeps(deps)
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const svc = resolveSoleService(services as Array<{ id: string; type: string; name: string }>, type, serviceName)
  const res = await api.request<{ services?: HealthEntry[] }>('GET', `/projects/${p.projectId}/runtime-health${q(branch)}`)
  const entry = res.services?.find((e) => e.serviceId === svc.id)
  if (opts.json) return printJson(entry ?? { serviceId: svc.id, status: 'unknown', machines: 0, failing: 0 })
  info(statusLine(type, svc.name, entry))
}
