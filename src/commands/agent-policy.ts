import { ApiClient, requireProject } from '../api.js'
import { handleApproval, info, printJson } from '../util.js'

const PRESETS = ['full_access', 'read_only', 'branch_specific']
const DECISIONS = ['allow', 'deny', 'approve']

// The API surface + project these commands need, injectable so the request flow — what a GET turns
// into on the way back out as a PUT — is testable without a network mock (the repo's deps
// convention). Production loads a real ApiClient + requireProject().
export type AgentPolicyDeps = { api: Pick<ApiClient, 'request' | 'rawRequest'>; project: { projectId: string } }

async function current(deps?: AgentPolicyDeps) {
  const api = deps?.api ?? await ApiClient.load()
  const project = deps?.project ?? await requireProject()
  const path = `/projects/${project.projectId}/agent-policy`
  const out = await api.request('GET', path)
  // `branchDeveloperRules` is a deprecated mirror of `rules`, kept in the response so that a CLI
  // predating the rename can still edit it in place. Platform takes the legacy field over `rules`
  // when a body carries both -- exactly so that old CLI's edit is not dropped -- so echoing the
  // mirror back would silently discard everything this version writes. Only where Platform speaks
  // the new contract, though: `actionCatalog` is how it announces that, and without one the mirror
  // is the only rule set that exists, so dropping it would erase the project's overrides on the
  // next PUT -- from `rule set`, but also from a `protect-branch` that never mentions rules.
  if (out.policy && out.actionCatalog) delete out.policy.branchDeveloperRules
  return { api, project, path, policy: out.policy, out }
}
export function displayPolicy(out: Record<string, any>, opts: { json?: boolean }, output = { info, printJson }) {
  const { info, printJson } = output
  const { policy, agentSessionEpoch } = out
  if (opts.json) return printJson(out)
  const overrides = Object.keys(policy.rules ?? policy.branchDeveloperRules ?? {}).length
  info(`agent policy: ${policy.mode}${overrides ? ` (${overrides} rule${overrides === 1 ? '' : 's'})` : ''}`
    + `\nprotected branches: ${policy.protectedBranchIds.join(', ') || '(none)'}\nsession epoch: ${agentSessionEpoch}`)
  if (out.effectiveRules) {
    for (const [scope, rules] of Object.entries(out.effectiveRules)) {
      info(`\n${scope}:`)
      for (const [action, decision] of Object.entries(rules as Record<string, string>)) info(`  ${action}: ${decision}`)
    }
    info(`\nbootstrap: project.create = ${out.bootstrapRules?.['project.create'] ?? '(not reported)'}`)
    for (const note of out.ruleNotes ?? []) info(note)
  } else info('This Platform does not expose resolved rules; upgrade Platform to inspect defaults.')
}
export async function get(opts: { json?: boolean }) {
  const { out } = await current()
  // Forward the public response, never the internal API client (which holds credentials).
  displayPolicy(out, opts)
}

/**
 * The decisions that moved but were NOT asked for. Switching off `full_access` is the case that
 * needs this: the fixed invariants (project.delete, agent_policy.update, …) stop being allowed and
 * protected branches begin to apply, so a one-rule edit can move a dozen decisions. Diffed from
 * Platform's own resolved view before and after, never re-derived here — the same reason this CLI
 * does not evaluate a policy locally.
 */
export function sideEffects(before: Record<string, any>, after: Record<string, any>, asked: string[]): string[] {
  const from = before.effectiveRules, to = after.effectiveRules
  if (!from || !to) return []
  const lines: string[] = []
  for (const scope of Object.keys(to)) {
    for (const [action, decision] of Object.entries(to[scope] as Record<string, string>)) {
      // The named action is suppressed only in the context the rule governs. That same action
      // moving in another context is a consequence of the mode change, not the edit that was asked
      // for — `rule set deploy deny` off full_access also starts denying deploy on protected
      // branches, and that is precisely what the caller needs told.
      if ((scope === 'unprotectedBranch' && asked.includes(action)) || from[scope]?.[action] === decision) continue
      lines.push(`  ${scope}.${action}: ${from[scope]?.[action] ?? '(unknown)'} -> ${decision}`)
    }
  }
  return lines
}

/**
 * The policy a `rule set` should PUT. Exported because the interesting part is not the request:
 * leaving a preset has to snapshot every decision it was already making, or setting one rule
 * silently rewrites all the others to whatever the new mode's defaults happen to be.
 */
export function applyRule(policy: Record<string, any>, out: Record<string, any>, action: string, decision: string): Record<string, any> {
  const catalog = out.actionCatalog as { action: string; editable: boolean }[] | undefined
  // A Platform predating the rename has neither a catalog nor a `rules` field, and reads only the
  // old one. Nothing below applies there.
  if (!catalog) return { ...policy, branchDeveloperRules: { ...(policy.branchDeveloperRules ?? {}), [action]: decision } }
  const entry = catalog.find(e => e.action === action)
  if (!entry) throw new Error(`unknown action: ${action}\nrun: insta agent-policy get --json`)
  if (!entry.editable) throw new Error(`${action} is a fixed policy invariant and cannot be overridden`)
  // Snapshot taken from the resolved unprotected-branch view, which is the context these rules
  // apply to; protected branches stay a separate, fixed denial.
  const base = policy.mode === 'customize'
    ? policy.rules
    : Object.fromEntries(catalog.filter(e => e.editable).map(e => [e.action, out.effectiveRules.unprotectedBranch[e.action]]))
  return { ...policy, mode: 'customize', rules: { ...base, [action]: decision } }
}

/** `change` either mutates the policy in place or returns the replacement. */
// `asked` opts into the side-effect report and names the actions the caller chose. Only `rule set`
// passes it: a mode change is expected to move everything, so listing the whole table is noise.
async function update(change: (policy: any, state: Awaited<ReturnType<typeof current>>) => Promise<any> | any, opts: { json?: boolean }, asked?: string[], deps?: AgentPolicyDeps) {
  const state = await current(deps)
  const next = (await change(state.policy, state)) ?? state.policy
  const result = await state.api.rawRequest('PUT', state.path, next)
  if (handleApproval(result, opts.json)) return
  if (opts.json) return printJson(result.body)
  info(`agent policy updated: ${result.body.policy.mode}`)
  if (!asked) return
  const moved = sideEffects(state.out, await state.api.request('GET', state.path), asked)
  if (moved.length) process.stderr.write(`note: this also changed decisions you did not name:\n${moved.join('\n')}\n`)
}

export async function set(mode: string, opts: { json?: boolean }, deps?: AgentPolicyDeps) {
  const normalized = mode.replace(/-/g, '_')
  // `branch_developer` is the pre-rename name for `branch_specific`, still accepted here so a
  // script written against the old CLI keeps working. `customize` is deliberately NOT settable:
  // it means "carrying overrides", which is what `agent-policy rule set` produces.
  const resolved = normalized === 'branch_developer' ? 'branch_specific' : normalized
  if (!PRESETS.includes(resolved)) throw new Error('mode must be full-access, read-only, or branch-specific')
  // A preset carries no rules; Platform refuses one that does. Which field carries "no rules"
  // depends on the same capability check `applyRule` makes: without an `actionCatalog` Platform
  // predates the rename, so it only knows the old mode name and only reads the old rule field —
  // clearing `rules` there would leave every override standing under the new mode.
  return update((policy, { out }) => {
    if (out.actionCatalog) { policy.mode = resolved; policy.rules = {} }
    else { policy.mode = resolved === 'branch_specific' ? 'branch_developer' : resolved; policy.branchDeveloperRules = {} }
  }, opts, undefined, deps)
}

export async function protect(branch: string, enabled: boolean, opts: { json?: boolean }, deps?: AgentPolicyDeps) {
  return update(async (policy, { api, project }) => {
    const { branches } = await api.request('GET', `/projects/${project.projectId}/branches`)
    const found = branches.find((b: any) => b.id === branch || b.name === branch)
    if (!found) throw new Error('branch not found')
    policy.protectedBranchIds = enabled ? [...new Set([...policy.protectedBranchIds, found.id])] : policy.protectedBranchIds.filter((id: string) => id !== found.id)
  }, opts, undefined, deps)
}

export async function rule(action: string, decision: string, opts: { json?: boolean }, deps?: AgentPolicyDeps) {
  if (!DECISIONS.includes(decision)) throw new Error('decision must be allow, deny, or approve')
  return update((policy, { out }) => applyRule(policy, out, action, decision), opts, [action], deps)
}

export async function revoke(opts: { json?: boolean }) {
  const api = await ApiClient.load()
  const project = await requireProject()
  const out = await api.request('POST', `/projects/${project.projectId}/agent-sessions/revoke`)
  if (opts.json) return printJson(out)
  info(`all project agent sessions revoked (epoch ${out.agentSessionEpoch})`)
}
