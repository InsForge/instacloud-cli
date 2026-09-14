// `insta compute connect-repo` / `repo` / `watch-paths`: the parts that decide, without a network.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, type ApiClient } from '../src/api.js'
import { parseRepoRef, pickCandidate, sourceBody, repoLine, findCallerRepo, authorizeTerminal, canAuthorizeHere, parseWatchPaths, computeWatchPaths, watchPathsClause, type Candidate } from '../src/commands/github.js'

const cand = (o: Partial<Candidate> = {}): Candidate => ({ rootDir: null, builder: 'nixpacks', buildCommand: 'npm run build', startCommand: 'npm start', port: 3000, ...o })

describe('parseRepoRef', () => {
  it('accepts owner/repo and the github.com URL shapes people paste', () => {
    for (const raw of ['acme/app', 'github.com/acme/app', 'https://github.com/acme/app', 'https://www.github.com/acme/app.git', ' https://github.com/acme/app/ ', 'https://github.com/acme/app.git/']) {
      expect(parseRepoRef(raw)).toEqual({ owner: 'acme', repo: 'app' })
    }
  })
  it('refuses anything else before a request is made', () => {
    for (const raw of ['app', 'acme/app/tree/main', 'https://gitlab.com/acme/app', '']) {
      expect(() => parseRepoRef(raw)).toThrow(/not a GitHub repository reference/)
    }
  })
})

describe('pickCandidate', () => {
  it('a single detected directory is the pick', () => {
    expect(pickCandidate([cand()])).toEqual(cand())
  })
  it('several without --root-dir refuse and list them', () => {
    expect(() => pickCandidate([cand({ rootDir: 'apps/web' }), cand({ rootDir: 'apps/api' })]))
      .toThrow(/2 deployable directories[\s\S]*apps\/web[\s\S]*apps\/api/)
  })
  it('--root-dir picks by path; repo-root spellings mean the platform\'s null', () => {
    const root = cand(); const api = cand({ rootDir: 'apps/api' })
    expect(pickCandidate([root, api], 'apps/api')).toBe(api)
    expect(pickCandidate([root, api], '/apps/api/')).toBe(api)
    for (const spelling of ['', '.', '/', './']) expect(pickCandidate([root, api], spelling)).toBe(root)
    expect(() => pickCandidate([root, api], 'packages/x')).toThrow(/no deployable directory at packages\/x — detected: \(repo root\), apps\/api/)
  })
  it('nothing detected is its own message', () => {
    expect(() => pickCandidate([])).toThrow(/no deployable service detected/)
  })
})

describe('sourceBody', () => {
  const app = { source: 'app' as const, installationId: 7, repoId: 42, owner: 'acme', repo: 'app' }
  it('sends the picked directory and its detected config — no name, no env, no branch unless asked', () => {
    expect(sourceBody(app, cand({ rootDir: 'apps/web' }), {})).toEqual({ installationId: 7, repoId: 42, owner: 'acme', repo: 'app', rootDir: 'apps/web', buildCommand: 'npm run build', startCommand: 'npm start', port: 3000 })
  })
  it('a public repo sends owner/repo flagged public, never installation ids', () => {
    expect(sourceBody({ source: 'public', owner: 'acme', repo: 'app' }, cand(), {})).toMatchObject({ public: true, owner: 'acme', repo: 'app' })
    expect(sourceBody({ source: 'public', owner: 'acme', repo: 'app' }, cand(), {})).not.toHaveProperty('installationId')
  })
  it('--repo-branch, --no-auto-deploy and --watch-paths ride along only when given', () => {
    expect(sourceBody(app, cand(), { repoBranch: 'release', autoDeploy: false })).toMatchObject({ branch: 'release', autoDeploy: false })
    expect(sourceBody(app, cand(), { autoDeploy: true })).not.toHaveProperty('autoDeploy')
    expect(sourceBody(app, cand(), {})).not.toHaveProperty('watchPaths')
    expect(sourceBody(app, cand(), { watchPaths: 'apps/web/**' })).toMatchObject({ watchPaths: ['apps/web/**'] })
    // An unset shell variable must not connect the repo with no filter at all.
    expect(() => sourceBody(app, cand(), { watchPaths: '' })).toThrow(/at least one pattern/)
  })
  it('--port overrides the detected port through the shared parser', () => {
    expect(sourceBody(app, cand(), { port: '8080' }).port).toBe(8080)
    expect(() => sourceBody(app, cand(), { port: '0x1f90' })).toThrow(/port must be/)
  })
})

describe('authorizeTerminal', () => {
  // A failed assertion would otherwise leave the stderr spy installed and cascade into the next test.
  afterEach(() => vi.restoreAllMocks())
  const start = { state: 's1', verificationUri: 'https://github.com/login/device', userCode: 'WDJB-MJHT', interval: 1, expiresAt: new Date(Date.now() + 900_000).toISOString() }
  const drive = (answers: unknown[], startOverride: Record<string, unknown> = {}) => {
    const polls: unknown[] = []; const waits: number[] = []; const said: string[] = []
    const api = { request: async (method: string, path: string, body?: unknown) => {
      if (path === '/orgs/org_1/github/device') { expect(method).toBe('POST'); return { ...start, ...startOverride } }
      if (path !== '/orgs/org_1/github/device/poll') throw new Error(`unexpected path ${path}`)
      expect(method).toBe('POST')
      polls.push(body)
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a
    } } as unknown as ApiClient
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((l: any) => { said.push(String(l)); return true })
    return { api, polls, waits, said, spy, wait: async (s: number) => { waits.push(s) } }
  }
  it('prints the URL and the code, then polls with its own state until the person confirms', async () => {
    const d = drive([{ pending: true, slowDownBy: 0 }, { pending: false, repos: [{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }] }])
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).resolves.toEqual([{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }])
    expect(d.polls).toEqual([{ state: 's1' }, { state: 's1' }])
    // The URL and the code ARE the flow: without them on screen there is nothing for the person to do.
    expect(d.said.join('')).toContain('https://github.com/login/device')
    expect(d.said.join('')).toContain('WDJB-MJHT')
  })
  it('honours slow_down and refuses a negative one: either way the wait must not collapse', async () => {
    const d = drive([{ pending: true, slowDownBy: 5 }, { pending: true, slowDownBy: -30 }, { pending: false, repos: [] }])
    await authorizeTerminal(d.api, 'org_1', d.wait)
    expect(d.waits).toEqual([1, 6, 6])
  })
  it('clamps an interval Node would fire instantly', async () => {
    for (const [given, expected] of [[0, 5], [1e12, 60], [-4, 5]] as const) {
      const d = drive([{ pending: false, repos: [] }], { interval: given })
      await authorizeTerminal(d.api, 'org_1', d.wait)
      expect(d.waits).toEqual([expected])
    }
  })
  it('a missing expiry is refused, not turned into an endless loop', async () => {
    const d = drive([{ pending: true }], { expiresAt: undefined })
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).rejects.toThrow(/missing expiresAt/)
    expect(d.polls).toEqual([])
  })
  it('stops at the deadline instead of polling forever', async () => {
    const d = drive([{ pending: true }], { expiresAt: new Date(Date.now() - 1).toISOString() })
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).rejects.toThrow(/expired before it was confirmed/)
    expect(d.polls).toEqual([])
  })
  it('a rate-limited or dropped poll backs off instead of ending the authorization', async () => {
    const d = drive([new ApiError(429, 'HTTP 429', {}), new TypeError('socket hang up'), { pending: false, repos: [] }])
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).resolves.toEqual([])
    expect(d.waits).toEqual([1, 6, 11])
  })
  it('a confirmed authorization that carries no repositories fails loudly', async () => {
    const d = drive([{ pending: false }])
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).rejects.toThrow(/returned no repositories/)
  })
})

describe('findCallerRepo', () => {
  const fake = (answers: Record<string, unknown>) => ({ request: async (_m: string, path: string) => {
    const a = answers[path.split('?')[0]!]
    if (a instanceof Error) throw a
    if (a === undefined) throw new Error(`unexpected path ${path}`)
    return a
  } }) as unknown as ApiClient
  const ref = { owner: 'acme', repo: 'app' }
  const never = async () => { throw new Error('must not authorize') }
  const listed = (repos: unknown[]) => fake({ '/orgs/org_1/github/repos': { repos } })
  it('answers the installation the repo came from, as numbers, matching case-insensitively', async () => {
    await expect(findCallerRepo(listed([{ id: 42, owner: 'Acme', repo: 'App', installationId: 7 }]), 'org_1', ref, never)).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('a repo this caller cannot reach says so, with the --public way out', async () => {
    await expect(findCallerRepo(listed([{ id: 9, owner: 'acme', repo: 'other', installationId: 7 }]), 'org_1', ref, never)).rejects.toThrow(/not one your GitHub account can reach[\s\S]*--public/)
  })
  it('reaching nothing at all points at installing the App', async () => {
    await expect(findCallerRepo(listed([]), 'org_1', ref, never)).rejects.toThrow(/install it on the account/)
  })
  it('a listed repo with no usable installation id is named as that, not as unreachable', async () => {
    for (const bad of [null, 0, '', undefined]) {
      await expect(findCallerRepo(listed([{ id: 42, owner: 'acme', repo: 'app', installationId: bad }]), 'org_1', ref, never)).rejects.toThrow(/without an installation to build it through/)
    }
  })
  it('with nothing that can read the code, it fails with something to act on instead of waiting', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(400, 'your github account is not linked — authorize github, then list again', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never, false)).rejects.toThrow(/nothing here can read the code[\s\S]*--public/)
  })
  it('an unlinked terminal authorizes once, and the repos that come back are used', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(400, 'your github account is not linked — authorize github, then list again', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, async () => [{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }], true)).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('a dead authorization also authorizes again', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(400, 'your github authorization is no longer accepted — authorize github again', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, async () => [{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }], true)).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('the same words at another status are a real failure, not a reason to visit GitHub', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(502, 'your github account is not linked', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never)).rejects.toThrow(/not linked/)
  })
  it('an agent refused by policy is not told to go find an admin', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(403, 'unclassified_agent_action', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never)).rejects.toThrow(/does not let an agent authorize GitHub/)
  })
  it('a 403 we cannot name is rethrown as the platform put it, not guessed at', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(403, 'forbidden', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never)).rejects.toThrow(/^forbidden$/)
  })
  it('a member is told what role connecting needs', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(403, 'requires admin role', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never)).rejects.toThrow(/needs the org admin role/)
  })
  it('an org-less link is refused before any request', async () => {
    await expect(findCallerRepo(fake({}), '', ref, never)).rejects.toThrow(/INSTA_ORG_ID/)
  })
})

describe('canAuthorizeHere', () => {
  it('--json has no reader, whatever the terminal is', () => {
    expect(canAuthorizeHere({ json: true })).toBe(false)
  })
  it('a plain pipe has none either — the old fast failure is the right answer there', () => {
    const tty = process.stderr.isTTY
    try {
      Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true })
      expect(canAuthorizeHere({})).toBe(false)
      Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })
      expect(canAuthorizeHere({})).toBe(true)
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', { value: tty, configurable: true })
    }
  })
})

describe('repo line', () => {
  const gh = { type: 'github' as const, owner: 'acme', repo: 'app', branch: 'main', root_dir: null, auto_deploy: true, public: false }
  it('says how it redeploys, or how to connect one', () => {
    expect(repoLine('api', gh)).toBe('compute api: deploys from acme/app@main — every push to main redeploys it')
    expect(repoLine('api', { ...gh, root_dir: 'apps/api', auto_deploy: false })).toBe('compute api: deploys from acme/app@main (apps/api/) — auto-deploy off (pushes do not redeploy)')
    expect(repoLine('api', { ...gh, public: true, auto_deploy: false })).toMatch(/public repo, deploys are manual/)
    expect(repoLine('api', { type: 'image', image: 'nginx:1.27' })).toMatch(/no repository connected \(runs image nginx:1.27\) — connect one with `insta compute connect-repo <owner\/repo> api`/)
    expect(repoLine('api', { type: 'image', image: null })).toMatch(/^compute api: no repository connected — connect one/)
  })

  it('names the watch paths as repo-root paths, since the same line carries root_dir', () => {
    expect(repoLine('api', { ...gh, watch_paths: ['apps/api/**', 'packages/**'] }))
      .toBe('compute api: deploys from acme/app@main — every push to main redeploys it, but only when a push changes these repo-root paths: apps/api/**, packages/**')
    // root_dir is apps/api, the pattern is repo-root src/**: the line must not let those read as one root.
    expect(repoLine('api', { ...gh, root_dir: 'apps/api', watch_paths: ['src/**'] }))
      .toBe('compute api: deploys from acme/app@main (apps/api/) — every push to main redeploys it, but only when a push changes these repo-root paths: src/**')
    expect(repoLine('api', { ...gh, watch_paths: [] })).toBe('compute api: deploys from acme/app@main — every push to main redeploys it')
    expect(repoLine('api', { ...gh, watch_paths: null })).toBe('compute api: deploys from acme/app@main — every push to main redeploys it')
    // A push cannot redeploy these at all, so the line must not promise that it would on a match.
    expect(repoLine('api', { ...gh, public: true, auto_deploy: false, watch_paths: ['apps/api/**'] }))
      .toBe('compute api: deploys from acme/app@main — public repo, deploys are manual (pushes do not redeploy); watch paths apps/api/** are stored but cannot apply')
    expect(repoLine('api', { ...gh, auto_deploy: false, watch_paths: ['apps/api/**'] })).toMatch(/auto-deploy off .*; watch paths apps\/api\/\*\* are stored but cannot apply/)
  })
})

// The clause `insta compute repo` prints and the one `connect-repo` confirms with are the same string:
// a connect that stores a filter must not answer "every push redeploys it".
describe('watchPathsClause', () => {
  it('names the root the patterns are against, since every line carrying it also carries root_dir', () => {
    expect(watchPathsClause(['apps/web/**', 'packages/**'])).toBe(', but only when a push changes these repo-root paths: apps/web/**, packages/**')
  })
  it('is what repoLine appends, so the two lines cannot drift', () => {
    const gh = { type: 'github' as const, owner: 'acme', repo: 'app', branch: 'main', root_dir: null, auto_deploy: true, public: false, watch_paths: ['apps/web/**'] }
    expect(repoLine('api', gh)).toContain(watchPathsClause(['apps/web/**']))
  })
})

describe('computeWatchPaths validation (throws before any network/config access)', () => {
  it('refuses --set together with --clear', async () => {
    await expect(computeWatchPaths('api', { set: 'apps/web/**', clear: true })).rejects.toThrow(/--set or --clear, not both/)
  })
  it('refuses an empty --set before it can be read as a clear', async () => {
    // The server coerces a list that normalizes to nothing into null, i.e. into a clear.
    await expect(computeWatchPaths('api', { set: ' , ' })).rejects.toThrow(/at least one pattern/)
  })
})
describe('parseWatchPaths', () => {
  it('splits the quoted list a shell hands over, and drops what is not a pattern', () => {
    expect(parseWatchPaths('apps/web/**,packages/ui/**')).toEqual(['apps/web/**', 'packages/ui/**'])
    expect(parseWatchPaths(' apps/web/** , , packages/ui/** ')).toEqual(['apps/web/**', 'packages/ui/**'])
  })
  it('refuses an empty list rather than sending one', () => {
    for (const raw of ['', '  ', ',', ' , ']) expect(() => parseWatchPaths(raw)).toThrow(/at least one pattern/)
  })
})

