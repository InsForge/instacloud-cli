// `insta org member list|invite|remove|role` and `insta org invitation list|revoke` — thin wrappers
// over the platform's /orgs/:orgId/members and /orgs/:orgId/invitations routes. The platform client
// is injected (repo pattern: DI fakes, no disk/network). What is pinned here:
//  * the default-org rule: --org; the bound org of a scoped login; the linked project's org; the
//    only org from GET /orgs; several orgs stop and ask for --org.
//  * invite's wire body and role validation (admin|member, default member) before any request.
//  * remove/role accept a user id or an email and send the user id.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invitationList, invitationRevoke, memberInvite, memberList, memberRemove, memberRole, resolveOrg,
  type MemberRecord, type OrgApi,
} from '../src/commands/org.js'
import type { TokenScopeInfo } from '../src/config.js'

const ORG_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'a' }
const ORG_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'b' }
const MEMBERS: MemberRecord[] = [
  { user_id: 'u_owner', role: 'owner', email: 'owner@example.com' },
  { user_id: 'u_dev', role: 'member', email: 'Dev@Example.com' },
]

type Script = { orgs?: unknown[]; tokenScope?: TokenScopeInfo; gated?: boolean }

const GATED = { status: 'approval_required', approvalId: 'apr_1', action: 'org.invite' }

function fakeApi(script: Script = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = []
  const api: OrgApi = {
    config: { tokenScope: script.tokenScope },
    rawRequest: async (method, path, body) => {
      if (script.gated && method !== 'GET') { calls.push({ method, path, body }); return { status: 202, body: GATED } }
      return { status: 200, body: await api.request(method, path, body) }
    },
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'GET' && path === '/orgs') return { orgs: script.orgs ?? [] }
      if (method === 'GET' && path.endsWith('/members')) return { members: MEMBERS }
      if (method === 'GET' && path.endsWith('/invitations')) return { invitations: [{ id: 'inv_1', email: 'new@example.com', role: 'admin', expires_at: '2026-10-08T00:00:00.000Z' }] }
      if (method === 'POST' && path.endsWith('/invitations')) return { id: 'inv_2' }
      if (method === 'PUT' || method === 'DELETE') return { ok: true }
      throw new Error(`unexpected request ${method} ${path}`)
    },
  }
  return { api, calls }
}

const unlinked = async () => null
const linkedTo = (orgId: string) => async () => ({ projectId: 'linked-project', orgId, branch: 'main' })
const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== 'GET')

function capture() {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { err.push(String(c)); return true })
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ') + '\n') })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ') + '\n') })
  return { out: () => out.join(''), err: () => err.join('') }
}

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('resolveOrg', () => {
  it('--org wins and touches no route', async () => {
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B], tokenScope: { scope: 'org', access: 'full', orgId: ORG_A.id } })
    expect(await resolveOrg(api, { org: ORG_B.id }, linkedTo(ORG_A.id))).toBe(ORG_B.id)
    expect(calls).toEqual([])
  })
  it('a scoped login uses its bound org', async () => {
    const { api } = fakeApi({ orgs: [ORG_A, ORG_B], tokenScope: { scope: 'org', access: 'full', orgId: ORG_A.id } })
    expect(await resolveOrg(api, {}, linkedTo(ORG_B.id))).toBe(ORG_A.id)
  })
  it("the linked project's org, then the only org", async () => {
    const { api, calls } = fakeApi({ orgs: [ORG_A, ORG_B] })
    expect(await resolveOrg(api, {}, linkedTo(ORG_B.id))).toBe(ORG_B.id)
    expect(calls).toEqual([])
    const one = fakeApi({ orgs: [ORG_A] })
    expect(await resolveOrg(one.api, {}, unlinked)).toBe(ORG_A.id)
  })
  it('several orgs stop and ask for --org', async () => {
    const { err } = capture()
    const { api } = fakeApi({ orgs: [ORG_A, ORG_B] })
    await expect(resolveOrg(api, {}, unlinked)).rejects.toThrow()
    expect(err()).toMatch(/--org/)
  })
})

describe('org member', () => {
  it('invite posts email + role (default member) to the org', async () => {
    capture()
    const { api, calls } = fakeApi()
    await memberInvite('new@example.com', { org: ORG_A.id, json: true }, { api, linked: unlinked })
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/orgs/${ORG_A.id}/invitations`, body: { email: 'new@example.com', role: 'member' } }])
  })
  it('invite --role admin', async () => {
    capture()
    const { api, calls } = fakeApi()
    await memberInvite('new@example.com', { org: ORG_A.id, role: 'admin' }, { api, linked: unlinked })
    expect(writes(calls)[0]!.body).toEqual({ email: 'new@example.com', role: 'admin' })
  })
  it('invite rejects owner and unknown roles before any request', async () => {
    capture()
    const { api, calls } = fakeApi()
    await expect(memberInvite('new@example.com', { org: ORG_A.id, role: 'owner' }, { api, linked: unlinked })).rejects.toThrow()
    await expect(memberInvite('new@example.com', { org: ORG_A.id, role: 'developer' }, { api, linked: unlinked })).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it('list --json prints the members', async () => {
    const { out } = capture()
    const { api } = fakeApi()
    await memberList({ org: ORG_A.id, json: true }, { api, linked: unlinked })
    expect(JSON.parse(out())).toEqual(MEMBERS)
  })
  it('remove resolves an email (case-insensitive) to the user id', async () => {
    capture()
    const { api, calls } = fakeApi()
    await memberRemove('dev@example.com', { org: ORG_A.id }, { api, linked: unlinked })
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: `/orgs/${ORG_A.id}/members/u_dev`, body: undefined }])
  })
  it('role accepts a user id and PUTs the role', async () => {
    capture()
    const { api, calls } = fakeApi()
    await memberRole('u_dev', 'admin', { org: ORG_A.id }, { api, linked: unlinked })
    expect(writes(calls)).toEqual([{ method: 'PUT', path: `/orgs/${ORG_A.id}/members/u_dev`, body: { role: 'admin' } }])
  })
  it('an unknown member stops without writing', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi()
    await expect(memberRemove('nobody@example.com', { org: ORG_A.id }, { api, linked: unlinked })).rejects.toThrow()
    expect(writes(calls)).toEqual([])
    expect(err()).toMatch(/no member/)
  })
  it('role rejects an unknown role before any request', async () => {
    capture()
    const { api, calls } = fakeApi()
    await expect(memberRole('u_dev', 'developer', { org: ORG_A.id }, { api, linked: unlinked })).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('gated writes and bad input', () => {
  it('an empty <user> stops before matching a member with no email', async () => {
    const { err } = capture()
    const { api, calls } = fakeApi()
    await expect(memberRemove('', { org: ORG_A.id }, { api, linked: unlinked })).rejects.toThrow()
    expect(calls).toEqual([])
    expect(err()).toMatch(/<user> is required/)
  })
  it('a 202 approval_required is not reported as success', async () => {
    const { out, err } = capture()
    const { api } = fakeApi({ gated: true })
    await memberInvite('new@example.com', { org: ORG_A.id }, { api, linked: unlinked })
    expect(out()).not.toMatch(/invited/)
    expect(err()).toMatch(/approval required/)
    expect(process.exitCode).toBe(2)
  })
  it('a gated remove prints the envelope under --json and exits 2', async () => {
    const { out } = capture()
    const { api } = fakeApi({ gated: true })
    await memberRemove('u_dev', { org: ORG_A.id, json: true }, { api, linked: unlinked })
    expect(JSON.parse(out())).toMatchObject({ status: 'approval_required', approvalId: 'apr_1' })
    expect(process.exitCode).toBe(2)
  })
})

describe('org invitation', () => {
  it('list prints pending invitations', async () => {
    const { out } = capture()
    const { api } = fakeApi()
    await invitationList({ org: ORG_A.id }, { api, linked: unlinked })
    expect(out()).toContain('inv_1  new@example.com  [admin]  expires 2026-10-08')
  })
  it('revoke DELETEs the invitation', async () => {
    capture()
    const { api, calls } = fakeApi()
    await invitationRevoke('inv_1', { org: ORG_A.id }, { api, linked: unlinked })
    expect(writes(calls)).toEqual([{ method: 'DELETE', path: `/orgs/${ORG_A.id}/invitations/inv_1`, body: undefined }])
  })
})
