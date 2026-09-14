// `insta login --api-key <insta_…>` — non-interactive login that adopts a durable insta_ token.
// Two seams, both exercised with injected fakes (repo pattern, no disk/network):
//  * applyApiKeyLogin — the verify+store protocol (prefix check, /me probe, 401 handling).
//  * storeApiKeyCredential — the store rule: key becomes the bearer, refresh token is dropped.
import { describe, expect, it } from 'vitest'
import { applyApiKeyLogin, type ApiKeyClient, type AuthedUser } from '../src/commands/auth.js'
import { storeApiKeyCredential, ApiError } from '../src/api.js'

const USER: AuthedUser = { id: 'u1', email: 'tony@example.com', name: 'Tony' }

// A fake ApiKeyClient that records setApiKey calls and the probe's request opts, and serves /me
// from a script (a user object to return, or an ApiError to throw — like the real client does on
// a rejected key).
function fakeClient(me: { user?: AuthedUser; via?: string; agentCredential?: boolean } | ApiError) {
  const stored: Array<{ token: string; user?: AuthedUser; agentCredential?: boolean }> = []
  const requestOpts: Array<{ evidence?: boolean } | undefined> = []
  const client: ApiKeyClient = {
    setApiKey: (token, user, agentCredential) => { stored.push({ token, user, agentCredential }) },
    request: async (method, path, _body, opts) => {
      if (method === 'GET' && path === '/me') {
        requestOpts.push(opts)
        if (me instanceof ApiError) throw me
        return me
      }
      throw new Error(`unexpected request ${method} ${path}`)
    },
  }
  return { client, stored, requestOpts }
}

describe('applyApiKeyLogin', () => {
  it('verifies via /me and stores the key with the resolved user', async () => {
    const { client, stored } = fakeClient({ user: USER })
    await expect(applyApiKeyLogin(client, 'insta_abc123')).resolves.toEqual(USER)
    // Stored the key to auth the probe, then re-stored it with the user.
    expect(stored[0]).toEqual({ token: 'insta_abc123', user: undefined, agentCredential: undefined })
    expect(stored.at(-1)).toEqual({ token: 'insta_abc123', user: USER, agentCredential: false })
  })

  it('stores an agent-minted key with agentCredential true, probed with evidence: false', async () => {
    const { client, stored, requestOpts } = fakeClient({ user: USER, via: 'api', agentCredential: true })
    await expect(applyApiKeyLogin(client, 'insta_abc123')).resolves.toEqual(USER)
    expect(stored.at(-1)).toEqual({ token: 'insta_abc123', user: USER, agentCredential: true })
    expect(requestOpts).toEqual([{ evidence: false }])
  })

  it('rejects a key without the insta_ prefix before making any request', async () => {
    const { client, stored } = fakeClient({ user: USER })
    await expect(applyApiKeyLogin(client, 'sess-nope')).rejects.toThrow(/expects an insta_ token/)
    expect(stored).toEqual([]) // never touched the client
  })

  it('trims surrounding whitespace before checking + storing (`--api-key "$(cat token)"`)', async () => {
    const { client, stored } = fakeClient({ user: USER })
    await expect(applyApiKeyLogin(client, '  insta_abc123\n')).resolves.toEqual(USER)
    expect(stored.every((s) => s.token === 'insta_abc123')).toBe(true) // no stray whitespace stored
  })

  it('rejects an empty / whitespace-only key with the prefix error', async () => {
    const { client, stored } = fakeClient({ user: USER })
    await expect(applyApiKeyLogin(client, '   ')).rejects.toThrow(/expects an insta_ token/)
    expect(stored).toEqual([]) // never touched the client
  })

  it('turns a 401 from /me into a clear "rejected" error', async () => {
    const { client } = fakeClient(new ApiError(401, 'unauthorized'))
    await expect(applyApiKeyLogin(client, 'insta_bad')).rejects.toThrow(/rejected \(invalid or revoked\)/)
  })

  it('propagates a non-401 error (e.g. server 500) unchanged', async () => {
    const { client } = fakeClient(new ApiError(500, 'internal error'))
    await expect(applyApiKeyLogin(client, 'insta_x')).rejects.toThrow('internal error')
  })

  it('fails loudly on a 200 that carries no user', async () => {
    const { client } = fakeClient({})
    await expect(applyApiKeyLogin(client, 'insta_x')).rejects.toThrow(/unexpected response/)
  })
})

describe('storeApiKeyCredential', () => {
  it('stores the key as the bearer and DROPS any refresh token', () => {
    const cfg: any = { apiUrl: 'https://api.test', accessToken: 'old-session', refreshToken: 'old-refresh' }
    storeApiKeyCredential(cfg, 'insta_new', USER)
    expect(cfg.accessToken).toBe('insta_new')
    expect('refreshToken' in cfg).toBe(false) // deleted, so no stale token is POSTed on a 401
    expect(cfg.user).toEqual(USER)
  })

  it('leaves an existing user untouched when none is passed', () => {
    const cfg: any = { apiUrl: 'https://api.test', user: USER }
    storeApiKeyCredential(cfg, 'insta_new')
    expect(cfg.accessToken).toBe('insta_new')
    expect(cfg.user).toEqual(USER)
  })

  it('writes agentCredential true, then a later plain store deletes it', () => {
    const cfg: any = { apiUrl: 'https://api.test' }
    storeApiKeyCredential(cfg, 'insta_agent', USER, true)
    expect(cfg.agentCredential).toBe(true)
    storeApiKeyCredential(cfg, 'insta_human', USER)
    expect('agentCredential' in cfg).toBe(false)
  })
})
