// `ApiClient.persist()`'s override guard, exercised directly.
//
// The guard's live path is the 401 `refresh()` — `logout()` now builds its client from
// readPersistedGlobal(), so the logout spawn test in api-url-override.test.ts no longer proves
// anything about persist() itself. This does: a client whose in-memory apiUrl differs from the
// file's (exactly what readGlobal() hands back under --api-url / INSTA_API_URL / INSTA_ENV) must
// leave the file's URL alone, while an explicit setApiUrl — a login choosing its deployment — must
// move it.
//
// The global config file is derived from homedir() when config.ts is EVALUATED, so HOME is pointed
// at a temp directory before the dynamic import below. Static imports would be hoisted above that.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'insta-persist-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.INSTA_API_URL
delete process.env.INSTA_ENV
mkdirSync(join(home, '.insta'), { recursive: true })
const file = join(home, '.insta', 'config.json')

const { ApiClient } = await import('../src/api.js')

const PROD = 'https://api.instacloud.com'
const STAGING = 'https://api.staging.instacloud.com'
const OSS = 'http://oss.local:9000'

const onDisk = () => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(() => {
  writeFileSync(file, JSON.stringify({ apiUrl: PROD, accessToken: 'at', refreshToken: 'rt', autoUpdate: false }, null, 2))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('ApiClient.persist', () => {
  it('keeps the stored apiUrl when the in-memory one came from an ambient override', async () => {
    // What readGlobal() returns under `--api-url https://api.staging…` on a prod-logged-in machine.
    const api = new ApiClient({ apiUrl: STAGING, accessToken: 'staging-at' })
    await api.persist()
    expect(onDisk().apiUrl).toBe(PROD)
    // Everything else the client holds is still written — only the URL is pinned to the file's.
    expect(onDisk().accessToken).toBe('staging-at')
  })

  it('moves the stored apiUrl when it was set explicitly — a login choosing its deployment', async () => {
    const api = new ApiClient({ apiUrl: STAGING, accessToken: 'staging-at' })
    api.setApiUrl(OSS)
    await api.persist()
    expect(onDisk().apiUrl).toBe(OSS)
    expect(onDisk().accessToken).toBe('staging-at')
  })

  it('leaves an unoverridden config exactly as it is', async () => {
    const api = new ApiClient({ apiUrl: PROD, accessToken: 'at', refreshToken: 'rt2' })
    await api.persist()
    expect(onDisk()).toMatchObject({ apiUrl: PROD, refreshToken: 'rt2' })
  })
})
