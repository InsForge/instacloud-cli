// What a command actually PUTs. `applyRule` alone cannot answer that: it is handed a policy the
// request flow has already reshaped, so a field dropped on the way in is invisible to it. These go
// through the flow — GET, edit, PUT — and assert on the body that reaches Platform.
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { protect, rule } from '../src/commands/agent-policy.js'

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

function fake(response: Record<string, any>) {
  const puts: Record<string, any>[] = []
  const api = {
    async request(_method: string, path: string) {
      if (path.endsWith('/branches')) return { branches: [{ id: 'b2', name: 'staging' }] }
      return response
    },
    async rawRequest(_method: string, _path: string, body: any) {
      puts.push(body)
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
