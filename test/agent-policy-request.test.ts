// What a command actually PUTs. `applyRule` alone cannot answer that: it is handed a policy the
// request flow has already reshaped, so a field dropped on the way in is invisible to it. These go
// through the flow — GET, edit, PUT — and assert on the body that reaches Platform.
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { protect, rule, set } from '../src/commands/agent-policy.js'

const project = { projectId: 'p1' }

// A Platform predating the rename: no `actionCatalog`, no `rules`, and `branchDeveloperRules` is
// the only rule set it reads or writes.
const legacy = () => ({
  policy: { mode: 'branch_developer', protectedBranchIds: ['b1'], branchDeveloperRules: { deploy: 'approve', 'compute.shell': 'deny' } },
  agentSessionEpoch: 3,
})
const current = () => ({
  policy: { mode: 'full_access', protectedBranchIds: [], rules: {}, branchDeveloperRules: { deploy: 'allow' } },
  agentSessionEpoch: 3,
  actionCatalog: [{ action: 'deploy', editable: true }, { action: 'project.delete', editable: false }],
  effectiveRules: { unprotectedBranch: { deploy: 'allow', 'project.delete': 'allow' } },
})

// `settled` is what the policy GET returns *after* the PUT, which is where the side-effect report
// gets the decisions Platform actually resolved. Defaults to the pre-edit view, i.e. nothing moved.
function fake(response: Record<string, any>, settled?: Record<string, any>) {
  const puts: Record<string, any>[] = []
  let written = false
  const api = {
    async request(_method: string, path: string) {
      if (path.endsWith('/branches')) return { branches: [{ id: 'b2', name: 'staging' }] }
      return written ? (settled ?? response) : response
    },
    async rawRequest(_method: string, _path: string, body: any) {
      puts.push(body)
      written = true
      return { status: 200, body: { policy: body } }
    },
  }
  return { deps: { api, project }, puts }
}

beforeEach(() => { vi.spyOn(process.stdout, 'write').mockReturnValue(true) })
afterEach(() => { vi.restoreAllMocks() })

it('keeps the pre-rename rules it was not asked to touch', async () => {
  const { deps, puts } = fake(legacy())
  await rule('service.remove', 'deny', {}, deps)
  expect(puts).toHaveLength(1)
  expect(puts[0]!.branchDeveloperRules).toEqual({ deploy: 'approve', 'compute.shell': 'deny', 'service.remove': 'deny' })
  // Nothing on this Platform reads `rules`; inventing one would only be noise in the body.
  expect(puts[0]!.rules).toBeUndefined()
})

it('does not erase pre-rename rules from an update that never mentions them', async () => {
  const { deps, puts } = fake(legacy())
  await protect('staging', true, {}, deps)
  expect(puts[0]!.protectedBranchIds).toEqual(['b1', 'b2'])
  expect(puts[0]!.branchDeveloperRules).toEqual({ deploy: 'approve', 'compute.shell': 'deny' })
})

it('drops the deprecated mirror once Platform speaks the new contract, so `rules` is what lands', async () => {
  // Platform prefers the legacy field over `rules` when a body carries both — echoing back the
  // mirror it sent us would discard the edit below.
  const { deps, puts } = fake(current())
  await rule('deploy', 'deny', {}, deps)
  expect(puts[0]).not.toHaveProperty('branchDeveloperRules')
  expect(puts[0]!.mode).toBe('customize')
  expect(puts[0]!.rules).toEqual({ deploy: 'deny' })
})

it('reports the decisions a rule set moved but did not name', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const after = { ...current(), effectiveRules: { unprotectedBranch: { deploy: 'deny', 'project.delete': 'deny' } } }
  const { deps } = fake(current(), after)
  await rule('deploy', 'deny', {}, deps)
  const written = stderr.mock.calls.map(c => String(c[0])).join('')
  expect(written).toContain('unprotectedBranch.project.delete: allow -> deny')
  // The action the caller named is the point of the command, not a surprise worth reporting.
  expect(written).not.toContain('unprotectedBranch.deploy')
})

it('clears the pre-rename rules a preset is meant to drop', async () => {
  // `set` is a reset. On this Platform `rules` does not exist and the legacy field is the only one
  // read, so clearing `rules` alone would leave every override in force under the new mode.
  const { deps, puts } = fake(legacy())
  await set('full-access', {}, deps)
  expect(puts[0]!.mode).toBe('full_access')
  expect(puts[0]!.branchDeveloperRules).toEqual({})
  expect(puts[0]!.rules).toBeUndefined()
})

it('sends the pre-rename mode name to a Platform that predates the rename', async () => {
  const { deps, puts } = fake(legacy())
  await set('branch-specific', {}, deps)
  expect(puts[0]!.mode).toBe('branch_developer')
  expect(puts[0]!.branchDeveloperRules).toEqual({})
})

it('sends the current mode name and clears `rules` where Platform speaks the new contract', async () => {
  const { deps, puts } = fake(current())
  await set('branch-developer', {}, deps)
  expect(puts[0]!.mode).toBe('branch_specific')
  expect(puts[0]!.rules).toEqual({})
  expect(puts[0]).not.toHaveProperty('branchDeveloperRules')
})

it('rejects a mode no Platform offers', async () => {
  const { deps, puts } = fake(current())
  await expect(set('customize', {}, deps)).rejects.toThrow(/mode must be/)
  expect(puts).toHaveLength(0)
})
