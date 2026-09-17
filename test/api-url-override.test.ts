// The runtime `--api-url` flag: highest precedence, never persisted, and — like the env-var
// override before it — a URL for another deployment must not carry the stored session with it.
import { describe, expect, it } from 'vitest'
import { pickApiUrl } from '../src/config.js'

const PROD = 'https://api.instacloud.com'
const STAGING = 'https://api.staging.instacloud.com'
const stored = {
  apiUrl: PROD, accessToken: 'at', refreshToken: 'rt',
  user: { id: 'u1', email: 'a@b.c', name: null }, agentCredential: true,
}

describe('pickApiUrl', () => {
  it('defaults to prod with nothing stored and nothing set', () => {
    expect(pickApiUrl(null, {})).toEqual({ apiUrl: PROD })
  })

  it('the runtime flag beats INSTA_API_URL, INSTA_ENV and the stored url', () => {
    const r = pickApiUrl(stored, { INSTA_API_URL: 'https://env.example', INSTA_ENV: 'staging' }, 'http://127.0.0.1:8080')
    expect(r.apiUrl).toBe('http://127.0.0.1:8080')
  })

  it('INSTA_API_URL beats INSTA_ENV, which beats the stored url', () => {
    expect(pickApiUrl(stored, { INSTA_API_URL: 'https://env.example', INSTA_ENV: 'staging' }).apiUrl).toBe('https://env.example')
    expect(pickApiUrl(stored, { INSTA_ENV: 'staging' }).apiUrl).toBe(STAGING)
    expect(pickApiUrl(stored, {}).apiUrl).toBe(PROD)
  })

  it('a runtime flag pointing at another deployment scrubs the stored session in memory', () => {
    expect(pickApiUrl(stored, {}, STAGING)).toEqual({ apiUrl: STAGING })
  })

  it('a runtime flag equal to the stored url (trailing slash tolerated) keeps the session', () => {
    expect(pickApiUrl(stored, {}, `${PROD}/`)).toEqual({ ...stored, apiUrl: `${PROD}/` })
  })

  it('with no stored file, the flag alone decides', () => {
    expect(pickApiUrl(null, { INSTA_ENV: 'staging' }, 'http://oss.local:9000')).toEqual({ apiUrl: 'http://oss.local:9000' })
  })
})
