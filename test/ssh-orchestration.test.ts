// computeSSH's ORDER of operations.
//
// Every individual step here had a passing unit test while two defects shipped
// through: the collision check ran after mintCert had already overwritten the
// certificate it was about to refuse, and the printed command could not use the
// credential that had just been issued. Neither is visible from a test of any
// single piece -- only from running the steps together and watching what
// happens, and in what order.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { computeSSH, instaCertPath, instaAliasStorePath, writeAliasStore, readAliasStore, validateCertResponse, acquireRenewalLock, ensureCertForAlias } from '../src/commands/compute.js'

// Redirect the whole ~/.insta and ~/.ssh tree into a temp dir.
//
// BOTH variables, and that is not belt-and-braces: os.homedir() reads $HOME on
// POSIX but $USERPROFILE on Windows. Setting only HOME silently redirected
// nothing on the Windows runner, so all 36 tests in this file shared one real
// alias store and leaked into each other -- two failed on CI while passing
// everywhere else, and the rest were writing into the runner's actual home.
let home: string
let prevHome: string | undefined
let prevProfile: string | undefined

beforeEach(() => {
  prevHome = process.env.HOME
  prevProfile = process.env.USERPROFILE
  home = mkdtempSync(join(tmpdir(), 'insta-ssh-orch-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  // A redirection that silently does nothing produces tests that pass against
  // the REAL home, which is exactly how the Windows failure hid. Compared for
  // equality against the path we expect, not by prefix: `home + "-wrong"` has
  // `home` as a string prefix, so a startsWith check passes while pointing
  // somewhere else entirely.
  const want = join(home, '.insta', 'ssh', 'aliases.json')
  if (instaAliasStorePath() !== want) {
    throw new Error(`the home redirection did not take: got ${instaAliasStorePath()}, want ${want}`)
  }
})
afterEach(() => {
  process.env.HOME = prevHome
  process.env.USERPROFILE = prevProfile
  rmSync(home, { recursive: true, force: true })
})

const CERT = 'ssh-ed25519-cert-v01@openssh.com RkFLRS1DRVJULUJPRFktRk9SLVRFU1RTLUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB'
const CA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICAcaFakeCAKeyForTestsOnlyAAAAAAAAAAAAAAAAAAAA'

// A project whose service list holds one compute service named `api`.
const project = (projectId: string, branch?: string) => async () => ({ projectId, branch } as never)
const api = (services: Array<{ id: string; name: string; type: string }>) => async () => ({
  request: async () => ({ services }),
} as never)

const deps = (over: Record<string, unknown> = {}) => {
  const lines: string[] = []
  const minted: Array<{ serviceId: string; alias: string }> = []
  const base = {
    loadApi: api([{ id: 'svc-1', name: 'api', type: 'compute' }]),
    loadProject: project('proj-1'),
    mint: async (_a: unknown, _p: string, serviceId: string, _k: string, alias: string) => {
      minted.push({ serviceId, alias })
      // The REAL mintCert writes the certificate file as part of succeeding.
      // Reproduced here because that write is precisely what made the ordering
      // defect destructive rather than merely untidy.
      mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
      writeFileSync(instaCertPath(alias), CERT + '\n')
      return { certificate: CERT, host: 'ssh.us-west-1.compute.example', username: `u-${serviceId}`, expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
    },
    installCA: () => {},
    installConfig: () => {},
    emit: (l: string) => { lines.push(l) },
    ...over,
  }
  return { deps: base as never, lines, minted }
}

describe('a collision is refused before anything is written', () => {
  beforeEach(() => {
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    // `api.insta` already belongs to a DIFFERENT project's service.
    writeAliasStore({ 'api.insta': { projectId: 'other-proj', serviceId: 'svc-other', host: 'ssh.eu-central-1.compute.example', username: 'u-other' } })
    writeFileSync(instaCertPath('api.insta'), 'cert-for-svc-other\n')
  })

  it('does not mint, so the working alias keeps its certificate', async () => {
    const { deps: d, minted } = deps()
    await expect(computeSSH('api', {}, d)).rejects.toThrow(/already set up for a different service/)
    expect(minted, 'a certificate was minted for an alias that was about to be refused').toHaveLength(0)
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      'the existing alias certificate was overwritten before the collision was reported').toBe('cert-for-svc-other\n')
  })

  it('leaves the alias store pointing where it did', async () => {
    const { deps: d } = deps()
    await expect(computeSSH('api', {}, d)).rejects.toThrow()
    expect(readAliasStore()['api.insta']).toMatchObject({ projectId: 'other-proj', serviceId: 'svc-other' })
  })

  it('installs nothing into ~/.ssh', async () => {
    const calls: string[] = []
    const { deps: d } = deps({ installCA: () => calls.push('ca'), installConfig: () => calls.push('config') })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow()
    expect(calls, 'a refused setup still wrote to ~/.ssh').toEqual([])
  })

  it('still lets the SAME service re-issue, which is the ordinary renewal path', async () => {
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    const { deps: d, minted } = deps()
    await computeSSH('api', {}, d)
    expect(minted).toHaveLength(1)
  })
})

describe('what it prints is what will actually work', () => {
  it('without --setup, offers the key and certificate it just issued', async () => {
    const { deps: d, lines } = deps()
    await computeSSH('api', {}, d)
    const command = lines[0]!
    // The credential lives under ~/.insta, which OpenSSH never looks in, so a
    // bare `ssh user@host` offers the user's own keys and not this one.
    expect(command).toContain('-i ')
    expect(command).toContain('id_ed25519')
    expect(command).toContain('-o CertificateFile=')
    expect(command).toContain('api.insta-cert.pub')
    expect(command).toContain('-o IdentitiesOnly=yes')
    expect(command).toContain('u-svc-1@ssh.us-west-1.compute.example')
    expect(command.split(/\s+/), 'an uninstalled alias was offered as the destination').not.toContain('api.insta')
  })

  it('with --setup, offers the short alias and installs it', async () => {
    const calls: string[] = []
    const { deps: d, lines } = deps({ installCA: () => calls.push('ca'), installConfig: () => calls.push('config') })
    await computeSSH('api', { setup: true }, d)
    expect(calls).toEqual(['ca', 'config'])
    expect(lines[0]).toContain('ssh api.insta')
  })

  it('records the alias only after the mint succeeded', async () => {
    const { deps: d } = deps({
      mint: async () => { throw new Error('the plane refused') },
    })
    await expect(computeSSH('api', {}, d)).rejects.toThrow(/the plane refused/)
    expect(existsSync(instaAliasStorePath()) ? readAliasStore() : {},
      'a failed mint still recorded the alias').toEqual({})
  })
})

describe('what the plane returns is checked before anything is written', () => {
  // The check now lives in mintCert, BEFORE it writes `<alias>-cert.pub` --
  // the certificate file is the live credential for an alias that may already
  // be working, so a response we go on to reject must not have replaced it on
  // the way. Asserted on validateCertResponse (where the rule is) plus a file
  // assertion (that the rule runs before the write).
  const good = {
    certificate: CERT,
    host: 'ssh.us-west-1.compute.example',
    username: 'u-svc-1',
    expiresAt: '2026-09-14T22:00:00Z',
    caPublicKey: CA,
  }

  const hostile: Array<[string, Record<string, unknown>]> = [
    ['a host with a space', { host: 'ssh.example.com evil' }],
    ['a host with a newline', { host: 'ssh.example.com\n  ProxyCommand sh' }],
    ['a host with a backslash', { host: 'ssh.example\\.com' }],
    ['a single-label host', { host: 'localhost' }],
    ['a username with a space', { username: 'u root' }],
    ['a username with a newline', { username: 'u\n  ProxyCommand sh' }],
    ['a missing certificate', { certificate: undefined }],
    ['an empty certificate', { certificate: '   ' }],
    ['a missing expiry', { expiresAt: undefined }],
    // expiresAt is printed straight to a terminal, so a response can otherwise
    // repaint the screen or hide what it actually said.
    ['an expiry carrying an ANSI escape', { expiresAt: '2026-09-14T22:00:00Z\u001b[2K\rall good' }],
    ['an expiry carrying a newline', { expiresAt: '2026-09-14T22:00:00Z\nsomething else' }],
    ['an expiry that is not a date', { expiresAt: 'whenever' }],
    ['a certificate that is not a certificate record', { certificate: 'new-cert' }],
    ['a certificate that is a KEY, not a certificate', { certificate: CA }],
    ['a certificate spanning two lines', { certificate: `${CERT}\n${CERT}` }],
    ['a CA key spanning two lines', { caPublicKey: `${CA}\n@cert-authority * ${CA}` }],
    ['a CA key of an unsupported type', { caPublicKey: 'ssh-dss AAAAC3NzaC1lZDI1NTE5AAAAIWeakAlgorithmAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
  ]

  for (const [what, over] of hostile) {
    it(`refuses ${what}`, () => {
      expect(() => validateCertResponse({ ...good, ...over }), `${what} was accepted`).toThrow()
    })
  }

  it('accepts the ordinary response it exists to pass through', () => {
    expect(validateCertResponse(good)).toMatchObject({ host: good.host, username: good.username })
  })

  it('accepts a response with no CA key, which only --setup needs', () => {
    expect(() => validateCertResponse({ ...good, caPublicKey: undefined })).not.toThrow()
  })

  it('stores what a good response carried', async () => {
    const { deps: d } = deps()
    await computeSSH('api', {}, d)
    expect(readAliasStore()['api.insta']).toMatchObject({
      projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1',
    })
  })
})

describe('--setup does not report success without the trust anchor it promises', () => {
  it('refuses a response with no CA key', async () => {
    // Skipping installCA and carrying on left plain ssh/scp facing a host-key
    // prompt on every new node behind the load balancer -- the exact failure
    // the anchor exists to prevent -- while the command printed the short alias
    // and claimed it was configured.
    const calls: string[] = []
    const { deps: d } = deps({
      mint: async () => ({ ...noCA }),
      installCA: () => calls.push('ca'),
      installConfig: () => calls.push('config'),
    })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/certificate authority/i)
    expect(calls, 'setup installed a config block with no trust anchor behind it').toEqual([])
  })

  it('does not claim the alias when it could not configure it', async () => {
    const { deps: d } = deps({ mint: async () => ({ ...noCA }) })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow()
    expect(existsSync(instaAliasStorePath()) ? readAliasStore() : {}).toEqual({})
  })

  it('still works WITHOUT --setup, which promises no anchor', async () => {
    // The refusal is scoped to the promise --setup makes. A plain issue prints
    // a self-contained command and is unaffected.
    const { deps: d, lines } = deps({ mint: async () => ({ ...noCA }) })
    await computeSSH('api', {}, d)
    expect(lines[0]).toContain('-o IdentitiesOnly=yes')
  })

  const noCA = {
    certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-svc-1',
    expiresAt: '2026-09-14T22:00:00Z',
  }
})

describe('the printed command is safe to paste', () => {
  it('never reaches the printed line with shell syntax or a leading dash', () => {
    // Two layers, and the FIRST is the one that matters. Shell quoting does not
    // stop `ssh` parsing its own argv: a destination of `-oProxyCommand=id`
    // is read as an OPTION however it was quoted, and the user pasting the
    // advertised command runs it. So such a username is refused outright rather
    // than escaped into the line.
    const good = { certificate: CERT, host: 'ssh.us-west-1.compute.example', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
    for (const username of ['-oProxyCommand=id;#', '-l', '--', 'u;id', 'u$(id)', 'u`id`', 'u|id', 'u&&id', 'u>f']) {
      expect(() => validateCertResponse({ ...good, username }),
        `the username ${JSON.stringify(username)} was accepted`).toThrow()
    }
  })

  it('accepts the principals the gateway actually issues', () => {
    // The positive control: a rule tight enough to refuse every hazard above
    // can also refuse every real principal, and that failure is invisible from
    // a table of rejections.
    const good = { certificate: CERT, host: 'ssh.us-west-1.compute.example', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
    for (const username of ['api-h1abcdefghz', 'svc-abc123', 'u_1', 'a.b', 'user@tenant']) {
      expect(() => validateCertResponse({ ...good, username }), username).not.toThrow()
    }
  })

  it('leaves an ordinary destination unquoted', async () => {
    const { deps: d, lines } = deps()
    await computeSSH('api', {}, d)
    expect(lines[0]).toContain('u-svc-1@ssh.us-west-1.compute.example')
    expect(lines[0]).not.toContain(`'u-svc-1@`)
  })
})

describe('concurrent renewal hooks do not stampede the mint endpoint', () => {
  it('lets exactly one caller through', () => {
    // An IDE opens several connections at once and scp adds more, so every one
    // of them observes the same near-expiry certificate simultaneously.
    const first = acquireRenewalLock('api.insta')
    expect(first, 'the first caller could not take the lock').toBeTruthy()
    expect(acquireRenewalLock('api.insta'), 'a second caller also got through').toBeUndefined()
    expect(acquireRenewalLock('api.insta')).toBeUndefined()
    first!()
    // Released, so the next renewal is not blocked forever.
    const second = acquireRenewalLock('api.insta')
    expect(second, 'the lock was not released').toBeTruthy()
    second!()
  })

  it('locks per alias, so one service does not block another', () => {
    const a = acquireRenewalLock('api.insta')
    const b = acquireRenewalLock('web.insta')
    expect(a).toBeTruthy()
    expect(b, 'an unrelated alias was blocked by this one').toBeTruthy()
    a!(); b!()
  })

  it('breaks a lock left behind by a process that died holding it', () => {
    // Without a staleness rule one crash disables renewal for that alias
    // permanently -- a worse failure than the duplicate mint the lock prevents.
    const held = acquireRenewalLock('api.insta')
    expect(held).toBeTruthy()
    const later = Date.now() + 61_000
    const stole = acquireRenewalLock('api.insta', later)
    expect(stole, 'a stale lock wedged renewal forever').toBeTruthy()
    stole!()
    held!()
  })

  it('does not break a lock that is merely in use', () => {
    const held = acquireRenewalLock('api.insta')
    expect(acquireRenewalLock('api.insta', Date.now() + 30_000),
      'a live lock was stolen while the holder was still renewing').toBeUndefined()
    held!()
  })

  it('releasing twice is harmless', () => {
    const held = acquireRenewalLock('api.insta')!
    held()
    expect(() => held()).not.toThrow()
    const next = acquireRenewalLock('api.insta')
    expect(next).toBeTruthy()
    next!()
  })
})

// The ordering property, exercised through the REAL mintCert (no `mint` stub),
// because the finding is not "is the response validated" -- a test of the
// validator alone passes with the check moved back after the write -- but
// "is it validated BEFORE the certificate file is replaced". The file is the
// live credential for an alias that may already be working.
// Presence only, with NO side effect. The first version of this probe ran
// `ssh-keygen -A`, which GENERATES HOST KEYS in /etc/ssh -- at module import
// time, on every run of this file, even when the describe below is skipped.
// ENOENT is the only signal wanted, so ask the OS where the binary is instead
// of running it.
const keygen = (() => {
  const probe = process.platform === 'win32' ? ['where', 'ssh-keygen'] : ['command', '-v', 'ssh-keygen']
  try {
    execFileSync(probe[0]!, probe.slice(1), { stdio: 'ignore', shell: process.platform !== 'win32' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!keygen)('a rejected response never replaces the working certificate', () => {
  const apiReturning = (certBody: Record<string, unknown>) => async () => ({
    request: async () => ({ services: [{ id: 'svc-1', name: 'api', type: 'compute' }] }),
    rawRequest: async () => ({ status: 200, body: certBody }),
  } as never)

  beforeEach(() => {
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    writeFileSync(instaCertPath('api.insta'), 'the-working-certificate\n')
  })

  const hostile: Array<[string, Record<string, unknown>]> = [
    ['a host with a newline', { host: 'ssh.example.com\n  ProxyCommand sh' }],
    ['a single-label host', { host: 'localhost' }],
    ['a username with a space', { username: 'u root' }],
    ['a CA key spanning two lines', { caPublicKey: `${CA}\n@cert-authority * ${CA}` }],
  ]

  for (const [what, over] of hostile) {
    it(`leaves the certificate untouched for ${what}`, async () => {
      const good = { certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
      const { deps: d } = deps({ mint: undefined, loadApi: apiReturning({ ...good, ...over }) })
      // Same alias, so the collision check passes and the mint is actually reached.
      writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
      await expect(computeSSH('api', {}, d)).rejects.toThrow()
      expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
        'a response that was then rejected had already overwritten the live certificate').toBe('the-working-certificate\n')
    })
  }

  it('DOES replace it when the response is good', async () => {
    // The positive control: a check that refuses everything would satisfy every
    // assertion above while breaking renewal entirely.
    const good = { certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
    const { deps: d } = deps({ mint: undefined, loadApi: apiReturning(good) })
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    await computeSSH('api', {}, d)
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe(CERT + '\n')
  })
})

describe('renewal never blocks the ssh it runs inside', () => {
  it('gives up on a server that accepts and then says nothing', async () => {
    // OpenSSH runs this hook while PARSING its config, so an unbounded request
    // blocks ssh, scp, `ssh -G` and every IDE connection for as long as the
    // server likes. The catch only helps once the request has REJECTED, which
    // a never-settling response never does.
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    // An expired certificate, so renewal is actually attempted.
    writeFileSync(instaCertPath('api.insta'), CERT + '\n')

    let sawSignal: AbortSignal | undefined
    const hang = (_url: string, init: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      sawSignal = init.signal
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })

    const started = Date.now()
    await expect(raceRenewal(hang)).resolves.toBeUndefined()
    expect(sawSignal, 'the renewal request carried no abort signal, so nothing could stop it').toBeDefined()
    expect(sawSignal!.aborted, 'the deadline passed without aborting the request').toBe(true)
    // Bounded by the deadline the caller gave, not by the wall clock: asserting
    // elapsed milliseconds is the flaky-test trap. The signal firing IS the
    // property; this only pins that it did not wait out the 5s default.
    expect(Date.now() - started, 'renewal ignored the deadline it was given').toBeLessThan(4_000)
  })

  it('leaves the existing certificate in place when it gives up', async () => {
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    writeFileSync(instaCertPath('api.insta'), CERT + '\n')
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    await raceRenewal(() => Promise.reject(new Error('network down')))
    // Silent and fail-safe: the login then proceeds on the certificate it has.
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe(CERT + '\n')
  })
})

// ensureCertForAlias builds its own client, so the transport is swapped by
// pointing the CLI at a fetch that behaves the way the test needs.
async function raceRenewal(fetchImpl: (url: string, init: any) => Promise<any>): Promise<void> {
  const mod = await import('../src/api.js')
  const spy = vi.spyOn(mod.ApiClient, 'load').mockResolvedValue(new mod.ApiClient({ apiUrl: 'https://example.invalid', accessToken: 't' } as never, fetchImpl as never))
  try {
    await ensureCertForAlias('api.insta', 250)
  } finally {
    spy.mockRestore()
  }
}

describe('the renewal lock survives a holder that outlives the staleness window', () => {
  it('a superseded holder does not delete the new holder lock', () => {
    // The sequence that defeats a pid-only lock: A takes it, A is slow, B
    // breaks the stale lock and takes its own, then A finishes and releases --
    // deleting B's lock and leaving the file unlocked while B is still
    // renewing. The lock fails exactly when it is under load.
    const a = acquireRenewalLock('api.insta')!
    expect(a).toBeTruthy()
    const b = acquireRenewalLock('api.insta', Date.now() + 61_000)!
    expect(b, 'the stale lock was not broken').toBeTruthy()

    a() // the superseded holder releases

    expect(acquireRenewalLock('api.insta'), "the superseded holder deleted the new holder's lock").toBeUndefined()
    b()
    const c = acquireRenewalLock('api.insta')
    expect(c, 'the lock was never released').toBeTruthy()
    c!()
  })
})

// Everything above either stubs the two install steps or asserts a REFUSAL.
// Between them they leave the path the feature actually exists for untested:
// pick the endpoint, validate the response, write the certificate, record the
// alias, install the anchor and install the config -- together, against a real
// filesystem. A suite of refusals is satisfied by a command that refuses
// everything, so these are the positive control for the whole orchestration.
//
// The install steps run for real (installCA/installConfig left undefined so
// computeSSH falls back to its own), writing into the redirected home.
describe.skipIf(!keygen)('a successful --setup installs everything the alias needs', () => {
  const sshDir = () => join(home, '.ssh')
  const real = { installCA: undefined, installConfig: undefined }

  it('writes the certificate, the anchor and the config block', async () => {
    const { deps: d, lines } = deps(real)
    await computeSSH('api', { setup: true }, d)

    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      'the certificate the alias authenticates with was never written').toBe(CERT + '\n')

    // An EXACT anchor: `ssh.us-west-1.compute.example` is not under a suffix we
    // own, so hostPatternFor refuses to widen the region label.
    const knownHosts = readFileSync(join(sshDir(), 'known_hosts'), 'utf8')
    expect(knownHosts).toContain(`@cert-authority ssh.us-west-1.compute.example ${CA}`)
    expect(knownHosts, 'the anchor was not tagged as ours, so rotation cannot retire it').toContain('# insta compute ssh')

    const cfg = readFileSync(join(sshDir(), 'config'), 'utf8')
    expect(cfg).toContain('# BEGIN insta compute ssh')
    expect(cfg).toContain('Host api.insta')
    expect(cfg).toContain('HostName ssh.us-west-1.compute.example')
    expect(cfg).toContain('User u-svc-1')
    expect(cfg).toContain('IdentitiesOnly yes')
    // Quoted, and from the real instaKeyPath/instaCertPath -- the check that
    // the rendering is wired to the paths actually written above.
    expect(cfg).toContain(`IdentityFile "${join(home, '.insta', 'ssh', 'id_ed25519')}"`)
    expect(cfg).toContain(`CertificateFile "${instaCertPath('api.insta')}"`)
    // Without this the alias works exactly until the first certificate expires.
    expect(cfg, 'nothing renews the certificate').toContain('Match originalhost api.insta exec "insta __ssh-ensure-cert api.insta"')
    expect(cfg.trimEnd().endsWith('# END insta compute ssh')).toBe(true)

    expect(readAliasStore()['api.insta']).toMatchObject({
      projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1',
    })
    expect(lines[0]).toContain('ssh api.insta')
  })

  it('keeps the config the user already had, below ours', async () => {
    // The block is PREPENDED into a file the user owns; losing their settings
    // is the failure that turns a convenience into an incident.
    mkdirSync(sshDir(), { recursive: true })
    writeFileSync(join(sshDir(), 'config'), 'Host bastion\n  User someone\n')
    const { deps: d } = deps(real)
    await computeSSH('api', { setup: true }, d)
    const cfg = readFileSync(join(sshDir(), 'config'), 'utf8')
    expect(cfg, "the user's own stanza was dropped").toContain('Host bastion')
    expect(cfg.indexOf('# BEGIN insta compute ssh'),
      'our block landed below the user config, where first-wins makes it inert').toBeLessThan(cfg.indexOf('Host bastion'))
    // And the previous contents stay recoverable.
    expect(readFileSync(join(sshDir(), 'config.insta-bak'), 'utf8')).toBe('Host bastion\n  User someone\n')
  })

  it('renders every alias set up so far, not just this one', async () => {
    // The block is replaced wholesale, so a second --setup that rendered only
    // its own entry would silently delete the first service's stanza.
    writeAliasStore({
      'worker.insta': { projectId: 'proj-1', serviceId: 'svc-9', host: 'ssh.eu-west-1.compute.example', username: 'u-svc-9' },
    })
    const { deps: d } = deps(real)
    await computeSSH('api', { setup: true }, d)
    const cfg = readFileSync(join(sshDir(), 'config'), 'utf8')
    expect(cfg).toContain('Host api.insta')
    expect(cfg, 'the previously configured service lost its stanza').toContain('Host worker.insta')
  })

  it('leaves ~/.ssh untouched without --setup', async () => {
    const { deps: d } = deps(real)
    await computeSSH('api', {}, d)
    expect(existsSync(join(sshDir(), 'config')), 'a plain issue edited the ssh config').toBe(false)
    expect(existsSync(join(sshDir(), 'known_hosts'))).toBe(false)
  })
})

describe.skipIf(!keygen)('the branch the alias was set up on is the one it stays on', () => {
  // `branch` is stored so assertAliasFree can tell two same-named services
  // apart. Nothing else read it, and nothing verified it was recorded at all.
  const recordingApi = (paths: string[]) => async () => ({
    request: async (_m: string, path: string) => {
      paths.push(path)
      return { services: [{ id: 'svc-1', name: 'api', type: 'compute' }] }
    },
  } as never)

  it('resolves the service on --branch, not the linked one', async () => {
    const paths: string[] = []
    const { deps: d } = deps({ loadApi: recordingApi(paths), loadProject: project('proj-1', 'main') })
    await computeSSH('api', { branch: 'feature-x' }, d)
    expect(paths[0], '--branch was ignored, so a different branch\'s service was set up').toBe('/projects/proj-1/services?branch=feature-x')
    expect(readAliasStore()['api.insta']).toMatchObject({ branch: 'feature-x' })
  })

  it('falls back to the linked branch', async () => {
    const paths: string[] = []
    const { deps: d } = deps({ loadApi: recordingApi(paths), loadProject: project('proj-1', 'main') })
    await computeSSH('api', {}, d)
    expect(paths[0]).toBe('/projects/proj-1/services?branch=main')
    expect(readAliasStore()['api.insta']).toMatchObject({ branch: 'main' })
  })

  it('omits the branch entirely when the project has none', async () => {
    // Stored as ABSENT rather than as an empty string: assertAliasFree compares
    // `held.branch ?? ''` to `want.branch ?? ''`, so the two must not diverge.
    const paths: string[] = []
    const { deps: d } = deps({ loadApi: recordingApi(paths), loadProject: project('proj-1') })
    await computeSSH('api', {}, d)
    expect(paths[0]).toBe('/projects/proj-1/services')
    expect(readAliasStore()['api.insta']).not.toHaveProperty('branch')
  })

  it('refuses the same alias on a different branch of the same project', async () => {
    // The collision this field exists for, and the one case the branch is the
    // ONLY thing distinguishing: same project, same service name, two branches.
    writeAliasStore({
      'api.insta': { projectId: 'proj-1', branch: 'main', serviceId: 'svc-2', host: 'ssh.us-west-1.compute.example', username: 'u-svc-2' },
    })
    const { deps: d, minted } = deps({ loadProject: project('proj-1', 'feature-x') })
    await expect(computeSSH('api', {}, d)).rejects.toThrow(/already set up for a different service/)
    expect(minted, 'a certificate was minted for an alias about to be refused').toHaveLength(0)
  })
})

describe.skipIf(!keygen)('an automatic renewal replaces the certificate it was issued for', () => {
  // The hook's SUCCESS path, through the real mintCert and the real anchor
  // install -- only the transport is faked. Everything previously exercised
  // here was a give-up path, which a hook that always gave up would satisfy.
  const renew = async (respond: (url: string) => { status: number; body: unknown }) => {
    const urls: string[] = []
    const mod = await import('../src/api.js')
    const fetchImpl = async (url: string) => {
      urls.push(url)
      const r = respond(url)
      return { status: r.status, text: async () => JSON.stringify(r.body) }
    }
    const spy = vi.spyOn(mod.ApiClient, 'load').mockResolvedValue(
      new mod.ApiClient({ apiUrl: 'https://example.invalid', accessToken: 't' } as never, fetchImpl as never),
    )
    try { await ensureCertForAlias('api.insta', 2_000) } finally { spy.mockRestore() }
    return urls
  }

  const good = {
    certificate: CERT, host: 'ssh.us-west-1.compute.example',
    username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
  }

  beforeEach(() => {
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    // Not a parseable certificate, so `ssh-keygen -L` fails and certNeedsRenewal
    // reads it as "cannot confirm" -- which is how renewal is actually reached.
    writeFileSync(instaCertPath('api.insta'), 'the-expiring-certificate\n')
    writeAliasStore({
      'api.insta': { projectId: 'proj-1', branch: 'feature-x', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' },
    })
  })

  it('addresses the recorded project and service, and installs the rotated anchor', async () => {
    const urls = await renew(() => ({ status: 200, body: good }))
    // The alias is the hook's ONLY input -- there is no cwd to consult and no
    // guarantee it is a linked project -- so the stored record is what the
    // request is built from. serviceId identifies the service outright, which
    // is why the stored branch does not appear here: it is collision identity,
    // not addressing.
    expect(urls).toEqual(['https://example.invalid/projects/proj-1/services/svc-1/ssh-cert'])
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      'the near-expiry certificate was never replaced').toBe(CERT + '\n')
    // Re-installed on EVERY renewal, so a rotated CA is trusted before the
    // retired one stops signing rather than at the user's next --setup.
    expect(readFileSync(join(home, '.ssh', 'known_hosts'), 'utf8'))
      .toContain(`@cert-authority ssh.us-west-1.compute.example ${CA}`)
  })

  it('renews without an anchor when the response carries no CA key', async () => {
    // Unlike --setup, the hook promises no anchor: refusing here would break
    // renewal for an already-working alias over something it never guaranteed.
    const { caPublicKey: _, ...noCA } = good
    await renew(() => ({ status: 200, body: noCA }))
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe(CERT + '\n')
    expect(existsSync(join(home, '.ssh', 'known_hosts')),
      'a response with no CA key still wrote a known_hosts').toBe(false)
  })

  it('leaves both files alone when the CA key is malformed', async () => {
    // Validated before anything is written, so a bad key costs the renewal --
    // the alias keeps working on the certificate it has -- rather than
    // appending an unusable anchor or replacing a live credential.
    await renew(() => ({ status: 200, body: { ...good, caPublicKey: `${CA}\n@cert-authority * ${CA}` } }))
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe('the-expiring-certificate\n')
    expect(existsSync(join(home, '.ssh', 'known_hosts'))).toBe(false)
  })

  it('does nothing at all for an alias it has no record of', async () => {
    writeAliasStore({})
    const urls = await renew(() => ({ status: 200, body: good }))
    expect(urls, 'the hook called the platform for an alias it knows nothing about').toEqual([])
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe('the-expiring-certificate\n')
  })
})
