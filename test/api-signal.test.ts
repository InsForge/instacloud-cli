import { describe, expect, it } from 'vitest'
import { ApiClient, ApiError } from '../src/api.js'
import { deployArchive } from '../src/deploy-archive.js'

// Exercise the real client's refresh path without touching the user's persisted credentials.
class MemoryClient extends ApiClient {
  override async persist(): Promise<void> {}
}
const config = () => ({ apiUrl: 'https://api.test', accessToken: 'expired', refreshToken: 'refresh' })
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('API request cancellation across token refresh', () => {
  it('passes the same signal through the request, refresh, and authenticated retry', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (calls.length === 1) return reply({ error: 'expired' }, 401)
      if (String(url).endsWith('/auth/refresh')) return reply({ accessToken: 'fresh', refreshToken: 'next' })
      return reply({ state: 'building' })
    }
    const api = new MemoryClient(config(), fetcher)
    const { signal } = new AbortController()
    await expect(api.rawRequest('GET', '/projects/p/archive-deploys/op', undefined, { signal })).resolves.toMatchObject({ body: { state: 'building' } })
    expect(calls.map(c => c.init?.signal)).toEqual([signal, signal, signal])
    expect(calls[1]!.init?.headers).not.toHaveProperty('Authorization')
    expect(calls[2]!.init?.headers).toHaveProperty('Authorization', 'Bearer fresh')
  })

  it('preserves a caller abort during refresh instead of returning the original 401', async () => {
    const controller = new AbortController()
    const reason = new DOMException('cancelled by caller', 'AbortError')
    const api = new MemoryClient(config(), async (url, init) => {
      if (!String(url).endsWith('/auth/refresh')) return reply({ error: 'expired' }, 401)
      controller.abort(reason)
      init?.signal?.throwIfAborted()
      throw new Error('refresh did not receive the signal')
    })
    await expect(api.rawRequest('GET', '/projects/p/archive-deploys/op', undefined, { signal: controller.signal })).rejects.toBe(reason)
  })

  it('keeps a normal failed refresh as the original authentication error', async () => {
    const api = new MemoryClient(config(), async (url) => {
      if (String(url).endsWith('/auth/refresh')) throw new Error('network unavailable')
      return reply({ error: 'expired' }, 401)
    })
    await expect(api.rawRequest('GET', '/me')).rejects.toEqual(new ApiError(401, 'expired', { error: 'expired' }))
  })

  it('bounds a status GET -> 401 -> stalled refresh by the deploy deadline', async () => {
    let refreshed = false
    const api = new MemoryClient(config(), async (url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        refreshed = true
        return new Promise<Response>((resolve, reject) => {
          // The fallback makes a missing signal fail as a 401 rather than hanging the test.
          const timer = setTimeout(() => resolve(reply({ error: 'refresh stalled' }, 401)), 100)
          const abort = () => { clearTimeout(timer); reject(init!.signal!.reason) }
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      if (init?.method === 'POST') return reply({ operationId: 'op', state: 'queued' }, 202)
      return reply({ error: 'expired' }, 401)
    })
    let reads = 0
    const now = () => reads++ === 0 ? 0 : 30 * 60 * 1000 - 10
    const ref = { archiveSha256: 'a'.repeat(64), build: { type: 'dockerfile' as const } }
    await expect(deployArchive(api, 'p', ref, 'main', { json: true }, now)).rejects.toThrow(/did not finish within 30 minutes/)
    expect(refreshed).toBe(true)
  })
})
