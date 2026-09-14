// Environment resolution (prod | staging) and the guarantees that keep the two from bleeding into
// each other: matched api+mcp hosts, distinct MCP registration names, and a dropped session on
// every switch (prod and staging are separate deployments — a token from one is useless and
// dangerous at the other).
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ENV, ENVS, ENV_NAMES, envForApiUrl, envFromEnvVar, isEnvName, mcpServerName,
} from '../src/env.js'
import { envUseResult } from '../src/commands/env.js'

const PROD_API = 'https://api.instacloud.com'
const STAGING_API = 'https://api.staging.instacloud.com'

describe('env table', () => {
  it('has a matched api + mcp host for every environment', () => {
    for (const name of ENV_NAMES) {
      expect(ENVS[name].api).toMatch(/^https:\/\//)
      expect(ENVS[name].mcp).toMatch(/^https:\/\/.*\/mcp$/)
    }
  })

  it('points prod and staging at genuinely different hosts', () => {
    expect(ENVS.prod.api).toBe(PROD_API)
    expect(ENVS.staging.api).toBe(STAGING_API)
    expect(ENVS.prod.mcp).not.toBe(ENVS.staging.mcp)
  })

  // The whole point of resolving api+mcp from one switch: staging's mcp host must sit under the
  // staging domain, so a staging install can't end up talking to prod's MCP server.
  it('keeps each environment\'s mcp host under that environment\'s domain', () => {
    expect(ENVS.staging.mcp).toContain('staging.instacloud.com')
    expect(ENVS.prod.mcp).not.toContain('staging')
  })

  it('gives every environment a skill source', () => {
    for (const name of ENV_NAMES) {
      expect(ENVS[name].skills).toMatch(/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/)
    }
  })

  // Prod stays unpinned (whatever is on the default branch); staging pins a ref so an installer
  // run reads the staging skill text.
  //
  // The ref MUST be the `#ref` fragment form. `owner/repo@thing` is parsed by the skills tool as a
  // SKILL-NAME FILTER, so the source silently stays on the default branch — while its output still
  // prints "Source: …git @thing", which reads like the ref applied. Proven by installing both
  // forms: `#docs/staging-env` yielded that branch's cli-reference.md, `@docs/staging-env` yielded
  // main's. These assertions exist to stop that footgun coming back.
  it('pins staging skills with the #ref form, never @', () => {
    expect(ENVS.prod.skills).toBe('InsForge/instacloud-skills')
    expect(ENVS.staging.skills).toBe('InsForge/instacloud-skills#devel')
  })

  it('never uses @ in a skill source (it is a skill filter, not a ref)', () => {
    for (const name of ENV_NAMES) {
      expect(ENVS[name].skills).not.toContain('@')
    }
  })
})

describe('mcpServerName', () => {
  it('keeps the bare name for prod so existing registrations are not orphaned', () => {
    expect(mcpServerName('prod')).toBe('insta-cloud')
  })

  // registerMcp treats an existing name as "already done", so a shared name would leave a staging
  // install silently wired to prod. Distinct names let both coexist on one machine.
  it('gives staging its own name so it can coexist with prod', () => {
    expect(mcpServerName('staging')).toBe('insta-cloud-staging')
    expect(mcpServerName('staging')).not.toBe(mcpServerName('prod'))
  })
})

describe('envForApiUrl', () => {
  it('maps known hosts back to their environment', () => {
    expect(envForApiUrl(PROD_API)).toBe('prod')
    expect(envForApiUrl(STAGING_API)).toBe('staging')
  })

  it('ignores a trailing slash', () => {
    expect(envForApiUrl(STAGING_API + '/')).toBe('staging')
  })

  // A localhost/self-hosted URL is a deliberate choice, not an error — callers must leave it alone.
  it('returns null for a custom host', () => {
    expect(envForApiUrl('http://localhost:8080')).toBeNull()
    expect(envForApiUrl('https://beta-api.insta.insforge.dev')).toBeNull()
  })

  // staging.instacloud.com is a deeper label than instacloud.com; a sloppy suffix match would
  // classify the staging host as prod and provision against the wrong control plane.
  it('does not let the prod host swallow the staging host', () => {
    expect(envForApiUrl(STAGING_API)).not.toBe('prod')
  })
})

describe('envFromEnvVar', () => {
  it('accepts the known names, case- and whitespace-insensitively', () => {
    expect(envFromEnvVar('staging')).toBe('staging')
    expect(envFromEnvVar(' STAGING ')).toBe('staging')
    expect(envFromEnvVar('prod')).toBe('prod')
  })

  it('treats unset and empty as no opinion', () => {
    expect(envFromEnvVar(undefined)).toBeNull()
    expect(envFromEnvVar('')).toBeNull()
    expect(envFromEnvVar('  ')).toBeNull()
  })

  // Silently falling back to prod on a typo would provision real production infrastructure and
  // stay invisible until the bill arrived. Fail loudly instead.
  it('throws on an unknown value rather than falling back to prod', () => {
    expect(() => envFromEnvVar('stagng')).toThrow(/unknown INSTA_ENV/)
    expect(() => envFromEnvVar('production')).toThrow(/unknown INSTA_ENV/)
  })
})

describe('isEnvName', () => {
  it('accepts only the declared environments', () => {
    expect(isEnvName('prod')).toBe(true)
    expect(isEnvName('staging')).toBe(true)
    expect(isEnvName('dev')).toBe(false)
  })

  it('defaults to prod', () => {
    expect(DEFAULT_ENV).toBe('prod')
  })
})

// ---- config resolution + `env use`, against a real temp $HOME ----

describe('config + env use', () => {
  let home: string
  const origHome = process.env.HOME
  const origUserProfile = process.env.USERPROFILE
  const origEnv = process.env.INSTA_ENV
  const origApi = process.env.INSTA_API_URL
  const origMcp = process.env.INSTA_MCP_URL
  const origSkills = process.env.INSTA_SKILLS_REPO

  const configFile = () => join(home, '.insta', 'config.json')
  const writeConfig = async (c: unknown) => {
    await mkdir(join(home, '.insta'), { recursive: true })
    await writeFile(configFile(), JSON.stringify(c, null, 2))
  }
  const readConfig = async () => JSON.parse(await readFile(configFile(), 'utf8'))

  // config.ts resolves the OS home at import time, so each test needs a fresh module registry.
  const freshConfig = async () => {
    vi.resetModules()
    return await import('../src/config.js')
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'insta-env-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.INSTA_ENV
    delete process.env.INSTA_API_URL
    delete process.env.INSTA_MCP_URL
    delete process.env.INSTA_SKILLS_REPO
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile
    if (origEnv === undefined) delete process.env.INSTA_ENV; else process.env.INSTA_ENV = origEnv
    if (origApi === undefined) delete process.env.INSTA_API_URL; else process.env.INSTA_API_URL = origApi
    if (origMcp === undefined) delete process.env.INSTA_MCP_URL; else process.env.INSTA_MCP_URL = origMcp
    if (origSkills === undefined) delete process.env.INSTA_SKILLS_REPO; else process.env.INSTA_SKILLS_REPO = origSkills
    vi.resetModules()
  })

  it('defaults a fresh install to prod', async () => {
    const { readGlobal, resolveEnv } = await freshConfig()
    expect((await readGlobal()).apiUrl).toBe(PROD_API)
    expect(await resolveEnv()).toMatchObject({ env: 'prod', apiUrl: PROD_API, mcpUrl: ENVS.prod.mcp })
  })

  it('resolves INSTA_ENV=staging to staging api AND mcp together', async () => {
    process.env.INSTA_ENV = 'staging'
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({
      env: 'staging', apiUrl: STAGING_API, mcpUrl: ENVS.staging.mcp,
    })
  })

  it('lets INSTA_ENV override a persisted prod apiUrl', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 't' })
    process.env.INSTA_ENV = 'staging'
    const { readGlobal } = await freshConfig()
    expect((await readGlobal()).apiUrl).toBe(STAGING_API)
  })

  // A hand-written URL is the more specific instruction, and the only way to reach a host no
  // environment name covers (insta-oss, a preview deployment).
  it('lets INSTA_API_URL outrank INSTA_ENV', async () => {
    process.env.INSTA_ENV = 'staging'
    process.env.INSTA_API_URL = 'http://localhost:9999'
    const { resolveEnv } = await freshConfig()
    const r = await resolveEnv()
    expect(r.apiUrl).toBe('http://localhost:9999')
    expect(r.env).toBeNull()
  })

  // The point of one switch: api, mcp AND skills all move together, so a staging machine can never
  // end up with prod's skill text describing a control plane it isn't talking to.
  it('resolves api, mcp and skills together for staging', async () => {
    process.env.INSTA_ENV = 'staging'
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({
      env: 'staging',
      apiUrl: STAGING_API,
      mcpUrl: ENVS.staging.mcp,
      skills: ENVS.staging.skills,
    })
  })

  it('uses prod skills by default', async () => {
    const { resolveEnv } = await freshConfig()
    expect((await resolveEnv()).skills).toBe(ENVS.prod.skills)
  })

  it('resolves staging skills from a persisted staging apiUrl (the installer path)', async () => {
    await writeConfig({ apiUrl: STAGING_API })
    const { resolveEnv } = await freshConfig()
    expect((await resolveEnv()).skills).toBe(ENVS.staging.skills)
  })

  // The security invariant env.ts's header states: a session minted by one deployment must never be
  // sent to another. `env use` enforced it, but the INSTA_ENV / INSTA_API_URL override path did not
  // — it returned the staging host with the prod session still attached, so api.ts's 401 path would
  // POST prod's REFRESH token to staging's /auth/refresh.
  it('drops the stored session when INSTA_ENV points at a different deployment', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'prod-a', refreshToken: 'prod-r', user: { id: 'u', email: null, name: null } })
    process.env.INSTA_ENV = 'staging'
    const { readGlobal } = await freshConfig()
    const c = await readGlobal()
    expect(c.apiUrl).toBe(STAGING_API)
    expect(c.accessToken).toBeUndefined()
    expect(c.refreshToken).toBeUndefined()
    expect(c.user).toBeUndefined()
  })

  it('drops the stored session when INSTA_API_URL points at a custom host', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'prod-a', refreshToken: 'prod-r' })
    process.env.INSTA_API_URL = 'http://localhost:8080'
    const { readGlobal } = await freshConfig()
    const c = await readGlobal()
    expect(c.apiUrl).toBe('http://localhost:8080')
    expect(c.accessToken).toBeUndefined()
  })

  // Only a MISMATCH scrubs. An override naming the same deployment must keep the session, or
  // exporting INSTA_ENV=prod on a prod machine would silently log you out.
  it('keeps the session when the override names the same deployment', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'prod-a', refreshToken: 'prod-r' })
    process.env.INSTA_ENV = 'prod'
    const { readGlobal } = await freshConfig()
    expect((await readGlobal()).accessToken).toBe('prod-a')
  })

  it('keeps the session when the override differs only by a trailing slash', async () => {
    await writeConfig({ apiUrl: STAGING_API, accessToken: 'stg-a' })
    process.env.INSTA_API_URL = STAGING_API + '/'
    const { readGlobal } = await freshConfig()
    expect((await readGlobal()).accessToken).toBe('stg-a')
  })

  // The scrub is in-memory: the file still holds the real login, so unsetting the override restores
  // it. Otherwise one stray `INSTA_ENV=staging` would permanently log the user out of prod.
  it('does not persist the scrub — the stored login survives', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'prod-a', refreshToken: 'prod-r' })
    process.env.INSTA_ENV = 'staging'
    let mod = await freshConfig()
    expect((await mod.readGlobal()).accessToken).toBeUndefined()
    delete process.env.INSTA_ENV
    mod = await freshConfig()
    expect((await mod.readGlobal()).accessToken).toBe('prod-a')
  })

  it('lets INSTA_SKILLS_REPO override the environment skill source', async () => {
    process.env.INSTA_ENV = 'staging'
    process.env.INSTA_SKILLS_REPO = 'me/my-skills@wip'
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({ env: 'staging', skills: 'me/my-skills@wip' })
  })

  it('lets INSTA_MCP_URL override the environment mcp host', async () => {
    process.env.INSTA_ENV = 'staging'
    process.env.INSTA_MCP_URL = 'http://localhost:1234/mcp'
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({ env: 'staging', mcpUrl: 'http://localhost:1234/mcp' })
  })

  it('honours a persisted staging apiUrl with no env vars set', async () => {
    await writeConfig({ apiUrl: STAGING_API })
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({ env: 'staging', mcpUrl: ENVS.staging.mcp })
  })

  it('surfaces a bad INSTA_ENV as an error instead of using prod', async () => {
    process.env.INSTA_ENV = 'nope'
    const { readGlobal } = await freshConfig()
    await expect(readGlobal()).rejects.toThrow(/unknown INSTA_ENV/)
  })

  it('env use persists the switch so it survives the install pipe', async () => {
    await writeConfig({ apiUrl: PROD_API })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    expect((await readConfig()).apiUrl).toBe(STAGING_API)
  })

  // api.ts's 401 path POSTs the refresh token to whatever apiUrl now resolves to, so carrying a
  // session across a switch would hand one deployment's credential to another.
  it('env use drops the stored session when changing deployment', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'a', refreshToken: 'r', user: { id: 'u', email: null, name: null } })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    const c = await readConfig()
    expect(c.apiUrl).toBe(STAGING_API)
    expect(c.accessToken).toBeUndefined()
    expect(c.refreshToken).toBeUndefined()
    expect(c.user).toBeUndefined()
  })

  it('env use is a no-op that keeps the session when already on that environment', async () => {
    await writeConfig({ apiUrl: STAGING_API, accessToken: 'a', refreshToken: 'r' })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    const c = await readConfig()
    expect(c.apiUrl).toBe(STAGING_API)
    expect(c.accessToken).toBe('a')
  })

  // `die` aborts the command and records exit 1 without forcing Node to tear down active handles.
  it('env use rejects an unknown name', async () => {
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const previousExitCode = process.exitCode
    try {
      await expect(envUse('stagng')).rejects.toThrow(/exit 1/)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previousExitCode
      err.mockRestore()
    }
  })

  // `env use` must decide against the PERSISTED host, not the override-resolved one. Otherwise
  // `INSTA_ENV=staging insta env use staging` sees "already on staging", writes nothing, and the
  // next process — without INSTA_ENV in its environment — is still on prod.
  it('env use persists even when INSTA_ENV already names the target', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'a' })
    process.env.INSTA_ENV = 'staging'
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    expect((await readConfig()).apiUrl).toBe(STAGING_API)
  })

  // A stored trailing slash is the same environment (envForApiUrl says so), so this is a no-op and
  // must not rewrite the URL or discard a valid session.
  it('env use treats a trailing-slash host as already-current and keeps the session', async () => {
    await writeConfig({ apiUrl: STAGING_API + '/', accessToken: 'stg-a', refreshToken: 'stg-r' })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    const c = await readConfig()
    expect(c.apiUrl).toBe(STAGING_API + '/')
    expect(c.accessToken).toBe('stg-a')
  })

  // hadSession used to check accessToken alone, so a config with only a refreshToken kept it — and
  // api.ts's 401 path would POST that token to the new deployment.
  it('env use drops a refresh-token-only session on a real switch', async () => {
    await writeConfig({ apiUrl: PROD_API, refreshToken: 'prod-r' })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    const c = await readConfig()
    expect(c.apiUrl).toBe(STAGING_API)
    expect(c.refreshToken).toBeUndefined()
  })

  it('env use drops a user-only remnant on a real switch', async () => {
    await writeConfig({ apiUrl: PROD_API, user: { id: 'u', email: 'a@b.c', name: null } })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    expect((await readConfig()).user).toBeUndefined()
  })

  it('preserves unrelated config keys across a switch', async () => {
    await writeConfig({ apiUrl: PROD_API, autoUpdate: false })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    expect((await readConfig()).autoUpdate).toBe(false)
  })
})

// envUse's --json output must be ONE schema for both outcomes (no-op and real switch): a scripted
// caller keying on mcpServer/previous must never get undefined just because the env was unchanged.
describe('envUseResult', () => {
  it('emits the same keys for a no-op and a real switch', () => {
    const noop = envUseResult('prod', 'prod', false, false)
    const switched = envUseResult('staging', 'prod', true, true)
    expect(Object.keys(noop).sort()).toEqual(Object.keys(switched).sort())
  })

  it('resolves api/mcp/server from the target environment', () => {
    const r = envUseResult('staging', 'prod', true, false)
    expect(r).toEqual({
      env: 'staging',
      previous: 'prod',
      apiUrl: ENVS.staging.api,
      mcpUrl: ENVS.staging.mcp,
      mcpServer: mcpServerName('staging'),
      changed: true,
      sessionDropped: false,
    })
  })
})
