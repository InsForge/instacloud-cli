import { expect, it } from 'vitest'
import { applyRule, displayPolicy, sideEffects } from '../src/commands/agent-policy.js'

const response = {
  policy: { mode: 'branch_specific', protectedBranchIds: [], rules: {} },
  agentSessionEpoch: 0, actions: ['deploy'],
  actionCatalog: [{ action: 'deploy', group: 'services', groupLabel: 'Services & deploys', label: 'Deploy compute', hint: '', editable: true }],
  defaultRules: { unprotectedBranch: { deploy: 'allow' } },
  effectiveRules: { unprotectedBranch: { deploy: 'deny' }, protectedBranch: { deploy: 'deny' }, project: { deploy: 'deny' } },
  bootstrapRules: { 'project.create': 'allow' }, ruleNotes: ['Policy-only guidance, not authorization.'],
}
it('forwards all public rule fields as JSON without client-side evaluation', () => {
  const values: unknown[] = []
  displayPolicy(response, { json: true }, { printJson: value => { values.push(value) }, info: () => { throw Error('unexpected text') } })
  expect(values).toEqual([response])
})
it('shows resolved rules and their authorization boundary in text output', () => {
  const lines: string[] = []
  displayPolicy(response, {}, { info: value => { lines.push(value) }, printJson: () => { throw Error('unexpected JSON') } })
  expect(lines.join('\n')).toContain('unprotectedBranch:')
  expect(lines.join('\n')).toContain('deploy: deny')
  expect(lines.join('\n')).toContain('Policy-only guidance, not authorization.')
})
it('does not invent default rules when talking to an older Platform', () => {
  const lines: string[] = []
  displayPolicy({ policy: response.policy, agentSessionEpoch: 0 }, {}, { info: value => { lines.push(value) }, printJson: () => {} })
  expect(lines.join('\n')).toContain('does not expose resolved rules')
})
it('says how many overrides a customize policy carries, and stays quiet for a preset', () => {
  const show = (policy: unknown) => {
    const lines: string[] = []
    displayPolicy({ ...response, policy }, {}, { info: value => { lines.push(value) }, printJson: () => {} })
    return lines.join('\n')
  }
  expect(show(response.policy)).toContain('agent policy: branch_specific\n')
  expect(show({ mode: 'customize', protectedBranchIds: [], rules: { deploy: 'deny' } })).toContain('agent policy: customize (1 rule)')
  expect(show({ mode: 'customize', protectedBranchIds: [], rules: { deploy: 'deny', 'service.add': 'deny' } })).toContain('(2 rules)')
  // A pre-rename Platform answers with the old field name and no `rules` at all.
  expect(show({ mode: 'branch_developer', protectedBranchIds: [], branchDeveloperRules: { deploy: 'deny' } })).toContain('(1 rule)')
})

// ---- rule editing ----

const catalog = [
  { action: 'deploy', editable: true },
  { action: 'service.remove', editable: true },
  { action: 'compute.shell', editable: true },
  { action: 'secrets.read', editable: false },
  { action: 'project.delete', editable: false },
]
const view = (mode: string, rules: Record<string, string>, unprotected: Record<string, string>) => ({
  policy: { mode, protectedBranchIds: [], rules },
  actionCatalog: catalog,
  effectiveRules: { unprotectedBranch: unprotected },
})

it('snapshots the whole preset before switching to customize, so one edit moves one decision', () => {
  // full_access resolves every action to allow, including the ones a rule may not name.
  const out = view('full_access', {}, { deploy: 'allow', 'service.remove': 'allow', 'compute.shell': 'allow', 'secrets.read': 'allow', 'project.delete': 'allow' })
  const next = applyRule(out.policy, out, 'deploy', 'deny')
  expect(next.mode).toBe('customize')
  // Every editable action is carried across at the value it already had — and only those, because
  // Platform refuses a rule naming a fixed invariant.
  expect(next.rules).toEqual({ deploy: 'deny', 'service.remove': 'allow', 'compute.shell': 'allow' })
})

it('edits in place once the policy is already customize', () => {
  const out = view('customize', { deploy: 'deny', 'service.remove': 'approve' }, { deploy: 'deny' })
  expect(applyRule(out.policy, out, 'service.remove', 'deny').rules)
    .toEqual({ deploy: 'deny', 'service.remove': 'deny' })
})

it('refuses an unknown action and a fixed invariant, naming which', () => {
  const out = view('branch_specific', {}, { deploy: 'allow' })
  expect(() => applyRule(out.policy, out, 'typo.action', 'deny')).toThrow(/unknown action/)
  expect(() => applyRule(out.policy, out, 'project.delete', 'allow')).toThrow(/fixed policy invariant/)
})

it('writes the pre-rename field when the Platform serves no catalog', () => {
  const policy = { mode: 'branch_developer', protectedBranchIds: [], branchDeveloperRules: { deploy: 'approve' } }
  const next = applyRule(policy, { policy }, 'service.remove', 'deny')
  expect(next).toEqual({ ...policy, branchDeveloperRules: { deploy: 'approve', 'service.remove': 'deny' } })
  expect(next.mode).toBe('branch_developer')
})

// ---- side effects ----

it('reports the decisions that moved without being named, and stays silent otherwise', () => {
  const before = { effectiveRules: { unprotectedBranch: { deploy: 'allow', 'project.delete': 'allow' }, protectedBranch: { deploy: 'allow' } } }
  const after = { effectiveRules: { unprotectedBranch: { deploy: 'deny', 'project.delete': 'deny' }, protectedBranch: { deploy: 'deny' } } }
  // `deploy` is what the caller asked for; the other two are the full_access cliff.
  expect(sideEffects(before, after, ['deploy'])).toEqual([
    '  unprotectedBranch.project.delete: allow -> deny',
    '  protectedBranch.deploy: allow -> deny',
  ])
  expect(sideEffects(before, before, ['deploy'])).toEqual([])
  // An older Platform reports no resolved rules at all; nothing to diff, nothing to claim.
  expect(sideEffects({}, after, [])).toEqual([])
})
