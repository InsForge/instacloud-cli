// The runtime `--api-url` flag: highest precedence, never persisted, and — like the env-var
// override before it — a URL for another deployment must not carry the stored session with it.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickApiUrl } from '../src/config.js'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

// A child that reads ONLY the temp home: the ambient control-plane env vars are deleted (a value
// of `undefined` in spawnSync's env is passed through as the string "undefined" on some platforms).
function childEnv(home: string): NodeJS.ProcessEnv {
  const e = { ...process.env, INSTA_NO_AUTOUPDATE: '1', INSTA_NO_TELEMETRY: '1', HOME: home, USERPROFILE: home }
  delete e.INSTA_API_URL
  delete e.INSTA_ENV
  return e
}

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

// pickApiUrl decides for the environment it is HANDED. envFromEnvVar defaults its parameter to
// process.env.INSTA_ENV, so an absent property used to fall through to the ambient environment —
// which made this pure function's answer depend on the shell the suite happened to run in.
describe('pickApiUrl purity', () => {
  it('treats an absent INSTA_ENV as unset, not as the ambient one', () => {
    const before = process.env.INSTA_ENV
    process.env.INSTA_ENV = 'staging'
    try {
      expect(pickApiUrl(stored, {}).apiUrl).toBe(PROD)
      expect(pickApiUrl(null, {}).apiUrl).toBe(PROD)
    } finally {
      if (before === undefined) delete process.env.INSTA_ENV
      else process.env.INSTA_ENV = before
    }
  })
})

// The runtime override must never become this machine's control plane. `persist()` is reached by
// logout and by the 401 refresh, and it used to write back the override-resolved config — so
// `insta logout --api-url <somewhere else>` re-pointed the stored apiUrl AND dropped the real
// login with it (readGlobal scrubs a foreign deployment's session, and that view was what got
// written). A spawn test is the honest one: GLOBAL_FILE is derived from homedir() at import time.
describe('--api-url is never persisted', () => {
  it('logout --api-url leaves the stored apiUrl and only clears the session', () => {
    const home = mkdtempSync(join(tmpdir(), 'insta-apiurl-'))
    try {
      mkdirSync(join(home, '.insta'), { recursive: true })
      const file = join(home, '.insta', 'config.json')
      writeFileSync(file, JSON.stringify(stored, null, 2))
      const r = spawnSync(process.execPath, ['--import', 'tsx', entry, 'logout', '--api-url', STAGING], {
        encoding: 'utf8',
        timeout: 30_000,
        env: childEnv(home),
      })
      expect(r.status, r.stderr).toBe(0)
      const after = JSON.parse(readFileSync(file, 'utf8'))
      expect(after.apiUrl).toBe(PROD)
      expect(after.accessToken).toBeUndefined()
      expect(after.refreshToken).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
