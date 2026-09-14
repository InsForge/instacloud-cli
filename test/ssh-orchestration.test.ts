// computeSSH's ORDER of operations.
//
// Every individual step here had a passing unit test while two defects shipped
// through: the collision check ran after mintCert had already overwritten the
// certificate it was about to refuse, and the printed command could not use the
// credential that had just been issued. Neither is visible from a test of any
// single piece -- only from running the steps together and watching what
// happens, and in what order.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { computeSSH, instaCertPath, instaAliasStorePath, writeAliasStore, readAliasStore, validateCertResponse, acquireRenewalLock, ensureCertForAlias, hostPatternFor, stageCertificate } from '../src/commands/compute.js'
import { isSSHCertificateRecord, mayWidenCAHost, parseCAPublicKey } from '../src/commands/ssh-config.js'

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

// A REAL certificate, signed by a real CA with ssh-keygen at suite start.
//
// The synthetic blob this replaces was itself a finding: it carried a correct
// type name followed by filler, which the structural decode accepted and
// `ssh-keygen -L` does not. A positive control built from something OpenSSH
// would reject cannot detect the live-credential corruption these tests exist
// to prevent -- it passes for a validator that checks nothing beyond the first
// field.
// Presence only, with NO side effect -- the first version of this probe ran
// `ssh-keygen -A`, which GENERATES HOST KEYS in /etc/ssh. It sits ABOVE the
// fixtures because they depend on it: generating certificates at module scope
// threw ENOENT at import on a machine without ssh-keygen and took the whole
// file down with it, defeating the very skip guards below.
const keygen = (() => {
  const probe = process.platform === 'win32' ? ['where', 'ssh-keygen'] : ['command', '-v', 'ssh-keygen']
  try {
    execFileSync(probe[0]!, probe.slice(1), { stdio: 'ignore', shell: process.platform !== 'win32' })
    return true
  } catch {
    return false
  }
})()

// Every test in this file is about SSH certificates, so without ssh-keygen
// there is nothing here to run -- `d` skips the file wholesale rather than
// failing it.
const d = keygen ? describe : describe.skip

const CERT_TYPE = 'ssh-ed25519-cert-v01@openssh.com'
const fixtures = keygen ? mkdtempSync(join(tmpdir(), 'insta-ssh-fixtures-')) : ''
const CERT = !keygen ? '' : (() => {
  const ca = join(fixtures, 'ca'), user = join(fixtures, 'user')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', ca, '-C', 'ca@insta'])
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', user, '-C', 'user@insta'])
  execFileSync('ssh-keygen', ['-q', '-s', ca, '-I', 'test-id', '-n', 'u-svc-1', '-V', '+1h', `${user}.pub`])
  return readFileSync(`${user}-cert.pub`, 'utf8').trim()
})()
const CA = !keygen ? '' : readFileSync(join(fixtures, 'ca.pub'), 'utf8').trim()
// Signed in the past, so certNeedsRenewal genuinely wants it replaced. The
// tests that exercise renewal need a real certificate that is real-and-stale,
// not one that merely fails to parse -- an unparseable file renews for the
// wrong reason and would pass even if the expiry logic were gone.
/** The `<type> <blob>` pair renderCertAuthority writes, comment stripped. */
const caRecord = (key: string) => key.split(/\s+/).slice(0, 2).join(' ')
const EXPIRED_CERT = !keygen ? '' : (() => {
  const old = join(fixtures, 'old')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', old, '-C', 'old@insta'])
  execFileSync('ssh-keygen', ['-q', '-s', join(fixtures, 'ca'), '-I', 'stale', '-n', 'u-svc-1', '-V', '-2h:-1h', `${old}.pub`])
  return readFileSync(`${old}-cert.pub`, 'utf8').trim()
})()

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
      // The REAL mintCert STAGES the certificate as part of succeeding, and
      // leaves committing it to the caller. Reproduced through the real
      // stageCertificate because that hand-off is precisely what makes the
      // ordering defects destructive rather than merely untidy.
      mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
      return {
        certificate: CERT, host: 'ssh.us-west-1.compute.example', username: `u-${serviceId}`,
        expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
        staged: stageCertificate(instaCertPath(alias), CERT + '\n'),
      }
    },
    installCA: () => {},
    installConfig: () => {},
    emit: (l: string) => { lines.push(l) },
    ...over,
  }
  return { deps: base as never, lines, minted }
}

d('a collision is refused before anything is written', () => {
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

d('what it prints is what will actually work', () => {
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

d('what the plane returns is checked before anything is written', () => {
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

d('--setup does not report success without the trust anchor it promises', () => {
  it('refuses a response with no CA key', async () => {
    // Skipping installCA and carrying on left plain ssh/scp facing a host-key
    // prompt on every new node behind the load balancer -- the exact failure
    // the anchor exists to prevent -- while the command printed the short alias
    // and claimed it was configured.
    const calls: string[] = []
    const { deps: d } = deps({
      mint: mintNoCA,
      installCA: () => calls.push('ca'),
      installConfig: () => calls.push('config'),
    })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/certificate authority/i)
    expect(calls, 'setup installed a config block with no trust anchor behind it').toEqual([])
  })

  it('does not claim the alias when it could not configure it', async () => {
    const { deps: d } = deps({ mint: mintNoCA })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow()
    expect(existsSync(instaAliasStorePath()) ? readAliasStore() : {}).toEqual({})
  })

  it('still works WITHOUT --setup, which promises no anchor', async () => {
    // The refusal is scoped to the promise --setup makes. A plain issue prints
    // a self-contained command and is unaffected.
    const { deps: d, lines } = deps({ mint: mintNoCA })
    await computeSSH('api', {}, d)
    expect(lines[0]).toContain('-o IdentitiesOnly=yes')
  })

  const noCA = {
    certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-svc-1',
    expiresAt: '2026-09-14T22:00:00Z',
  }
  // Stages the certificate and leaves committing it to computeSSH, as the real
  // mint does -- so 'nothing was installed' stays an assertion about the
  // command rather than about this stub.
  const mintNoCA = async () => ({ ...noCA, staged: stageCertificate(instaCertPath('api.insta'), CERT + '\n') })
})

d('the printed command is safe to paste', () => {
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

d('concurrent renewal hooks do not stampede the mint endpoint', () => {
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

d('a rejected response never replaces the working certificate', () => {
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

d('renewal never blocks the ssh it runs inside', () => {
  it('gives up on a server that accepts and then says nothing', async () => {
    // OpenSSH runs this hook while PARSING its config, so an unbounded request
    // blocks ssh, scp, `ssh -G` and every IDE connection for as long as the
    // server likes. The catch only helps once the request has REJECTED, which
    // a never-settling response never does.
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    // A real certificate whose validity window has passed, so renewal is
    // actually attempted rather than short-circuited by the healthy-cert check.
    writeFileSync(instaCertPath('api.insta'), EXPIRED_CERT + '\n')

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

d('the renewal lock survives a holder that outlives the staleness window', () => {
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
d('a successful --setup installs everything the alias needs', () => {
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
    // Without the trailing `ca@insta` comment ssh-keygen wrote: the line is
    // REBUILT from the parsed type and blob, which is what makes "exactly one
    // key record" a property of the output rather than of the input.
    expect(knownHosts).toContain(`@cert-authority ssh.us-west-1.compute.example ${caRecord(CA)}`)
    expect(knownHosts, 'the anchor was not tagged as ours, so rotation cannot retire it').toContain('# insta compute ssh')

    const cfg = readFileSync(join(sshDir(), 'config'), 'utf8')
    expect(cfg).toContain('# BEGIN insta compute ssh')
    expect(cfg).toContain('Host api.insta')
    expect(cfg).toContain('HostName ssh.us-west-1.compute.example')
    expect(cfg).toContain('User u-svc-1')
    expect(cfg).toContain('IdentitiesOnly yes')
    // Quoted, and built from the real instaKeyPath/instaCertPath -- the check
    // that the rendering is wired to the paths actually written above.
    //
    // Compared in the FORWARD-SLASH form, because that is what the config
    // carries on every platform: a native Windows path is `C:\Users\...`, and
    // OpenSSH reads a backslash in a config argument as an escape introducer,
    // so quoteConfigPath normalises it. Asserting the native separator passed
    // on POSIX and failed on the Windows runner. The normalisation is written
    // out here rather than borrowed from quoteConfigPath, so this stays an
    // assertion about the output instead of a tautology.
    const asConfigPath = (p: string) => p.replace(/\\/g, '/')
    expect(cfg).toContain(`IdentityFile "${asConfigPath(join(home, '.insta', 'ssh', 'id_ed25519'))}"`)
    expect(cfg).toContain(`CertificateFile "${asConfigPath(instaCertPath('api.insta'))}"`)
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

d('the branch the alias was set up on is the one it stays on', () => {
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

d('an automatic renewal replaces the certificate it was issued for', () => {
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
      .toContain(`@cert-authority ssh.us-west-1.compute.example ${caRecord(CA)}`)
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

d('the certificate is committed only once its anchor is', () => {
  // A renewal changes TWO files -- the certificate and the trust anchor in
  // known_hosts -- and rename(2) makes each one atomic on its own, which is not
  // the same as making the pair atomic. Installing the certificate first meant
  // that a failed anchor write (a permission, a full disk, an unresolvable
  // symlink) left the alias holding a certificate signed by a CA nothing
  // trusts, while the outer catch swallowed the error: the login then fails
  // with no explanation, and precisely in the case the anchor write matters
  // most -- a CA rotation. The guarantee is that a failed renewal leaves the
  // existing certificate in place.
  //
  // The positive control is the suite above, which renews for real and DOES
  // replace the certificate.
  const good = {
    certificate: CERT, host: 'ssh.us-west-1.compute.example',
    username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
  }

  const renew = async () => {
    const mod = await import('../src/api.js')
    const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify(good) })
    const spy = vi.spyOn(mod.ApiClient, 'load').mockResolvedValue(
      new mod.ApiClient({ apiUrl: 'https://example.invalid', accessToken: 't' } as never, fetchImpl as never),
    )
    try { await ensureCertForAlias('api.insta', 2_000) } finally { spy.mockRestore() }
  }

  beforeEach(() => {
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    // Not a parseable certificate, so certNeedsRenewal reads it as "cannot
    // confirm" and renewal is actually reached.
    writeFileSync(instaCertPath('api.insta'), 'the-expiring-certificate\n')
    writeAliasStore({
      'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' },
    })
  })

  it('keeps the previous certificate when the known_hosts write fails', async () => {
    // A REAL failure rather than an injected one: ~/.ssh is a file, so the
    // anchor install fails the way a permission or a full disk would -- after
    // the response has been validated and the new certificate produced.
    writeFileSync(join(home, '.ssh'), 'not a directory\n')
    await renew()
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      'the certificate was replaced although its CA was never trusted').toBe('the-expiring-certificate\n')
    expect(readdirSync(join(home, '.insta', 'ssh')).filter((f) => f.includes('staging')),
      'a staged certificate was left behind').toEqual([])
  })

  it('keeps it when another process holds the known_hosts lock', async () => {
    // Giving up on the shared file is a give-up on the whole renewal: the
    // alias keeps the certificate it has, whose CA is still the trusted one.
    writeFileSync(join(home, '.insta', 'ssh', 'known_hosts.lock'), 'someone-else')
    await renew()
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe('the-expiring-certificate\n')
    expect(existsSync(join(home, '.ssh', 'known_hosts')),
      'an anchor was written by a caller that never held the lock').toBe(false)
  })
})

// The renewal lock is per ALIAS; known_hosts is ONE file shared by all of them.
// Two aliases expiring together therefore read the same contents, each edits
// its own copy and each renames over the other -- the loser's anchor gone, and
// its certificate already installed against a CA that is no longer trusted.
//
// This cannot be observed from a single process: the read-modify-write is
// synchronous, so an in-process "concurrent" call either serialises itself or
// deadlocks on the lock. Only real processes interleave, so the test spawns
// them.
//
// The children are TypeScript, so they need the same loader vitest uses.
// Probed rather than assumed, and only where the rest of the file already has
// something to run.
const tsx = keygen && (() => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '-e', ''], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const dd = tsx ? describe : describe.skip

dd('separate processes installing anchors at once keep every anchor', () => {
  const CHILD = `
const [, , mod, startAt, ca, ...patterns] = process.argv
const { installCertAuthority } = await import(mod)
// A common start, so the processes are inside the shared file together rather
// than one after another.
await new Promise((r) => setTimeout(r, Number(startAt) - Date.now()))
for (const pattern of patterns) installCertAuthority(pattern, ca)
`

  const run = (args: string[]) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr!.on('data', (d) => { err += String(d) })
    child.on('exit', (code) => resolve({ code, err }))
  })

  it('loses none of them', async () => {
    // `.mts`, because the script is written into a directory with no
    // package.json: a plain `.ts` there is transformed as CommonJS, and the
    // dynamic import below is top-level await.
    const script = join(home, 'anchor-child.mts')
    writeFileSync(script, CHILD)
    const compute = new URL('../src/commands/compute.ts', import.meta.url).href
    // Distinct EXACT patterns, which upsertCertAuthority keeps side by side:
    // one line per region is the ordinary state of this file, and every line
    // is an alias that can still connect.
    const groups = [0, 1, 2, 3].map((n) => Array.from({ length: 5 }, (_, i) => `ssh.r${n}x${i}.compute.example`))
    const startAt = Date.now() + 1_000
    const results = await Promise.all(groups.map((patterns) =>
      run(['--import', 'tsx', script, compute, String(startAt), CA, ...patterns])))
    for (const r of results) expect(r.code, `a renewal process failed: ${r.err}`).toBe(0)

    const lines = readFileSync(join(home, '.ssh', 'known_hosts'), 'utf8').split('\n')
    for (const pattern of groups.flat()) {
      expect(lines.filter((l) => l.startsWith(`@cert-authority ${pattern} `)),
        `the anchor for ${pattern} was discarded by a concurrent renewal`).toHaveLength(1)
    }
  }, 30_000)
})

d('a certificate is DECODED, not just shape-checked', () => {
  // The escalation this closes: a textual check accepts
  // `<valid type> <64+ chars of base64>`, which anyone can construct, and the
  // cost of accepting it is that a working alias's live credential has already
  // been replaced by the time ssh reports the problem.
  const structural: Array<[string, string]> = [
    ['a blob of arbitrary base64 the right length', `${CERT_TYPE} ${'A'.repeat(400)}`],
    ['a blob whose inner type disagrees with the text field', 'ssh-ed25519-cert-v01@openssh.com AAAAHHNzaC1yc2EtY2VydC12MDFAb3BlbnNzaC5jb21BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ=='],
    ['a blob whose first length field overruns it', `${CERT_TYPE} ////8HNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=`],
    ['a blob with a zero-length type field', `${CERT_TYPE} AAAAAEFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==`],
    ['a blob truncated inside its type field', `${CERT_TYPE} AAAAIHNzaC1lZDI1NTE=`],
  ]
  for (const [what, value] of structural) {
    it(`refuses ${what}`, () => {
      expect(isSSHCertificateRecord(value), `${what} was accepted`).toBe(false)
    })
  }

  it('accepts the certificate shape the gateway actually issues', () => {
    // The positive control: a decoder strict enough to refuse everything above
    // can also refuse every real certificate, and that failure is invisible
    // from a table of rejections.
    expect(isSSHCertificateRecord(CERT)).toBe(true)
    expect(isSSHCertificateRecord(`${CERT} user@host`), 'a trailing comment was rejected').toBe(true)
  })
})

d('the CA wildcard stays on the ssh gateway name', () => {
  const S = ['compute.example'] as const

  it('widens the gateway name', () => {
    expect(hostPatternFor('ssh.us-west-1.compute.example', S)).toBe('ssh.*.compute.example')
  })

  // Tenant service hostnames live under the SAME suffix, so a wildcard on any
  // other first label lets the CA vouch for an unrelated platform host that
  // merely shares the shape -- the over-scoping the wildcard exists to avoid.
  const notGateway = ['api.us-west-1.compute.example', 'www.us-west-1.compute.example', 'sshx.us-west-1.compute.example']
  for (const host of notGateway) {
    it(`anchors ${host} exactly, because its first label is not the gateway`, () => {
      expect(mayWidenCAHost(host, S), 'a non-gateway host widened the CA').toBe(false)
      expect(hostPatternFor(host, S)).toBe(host)
    })
  }

  it('still refuses a gateway name with no region label', () => {
    expect(mayWidenCAHost('ssh.compute.example', S)).toBe(false)
    expect(mayWidenCAHost('ssh.a.b.compute.example', S), 'widened a label that is not the region').toBe(false)
  })
})

d('a certificate OpenSSH cannot parse never replaces a working one', () => {
  // The structural decode reads the blob's first field and stops, so a blob
  // with the right type name and noise behind it -- no nonce, public key,
  // serial, principals, validity window or signature -- still passes it. The
  // authority is ssh-keygen, run against a STAGING file, and the live file is
  // replaced only once it agrees.
  const live = () => join(home, '.insta', 'ssh', 'api.insta-cert.pub')

  beforeEach(() => {
    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    writeFileSync(live(), CERT + '\n')
  })

  it('leaves the working certificate in place when ssh-keygen rejects it', () => {
    const shaped = `${CERT_TYPE} ${Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(CERT_TYPE.length, 0); return b })(),
      Buffer.from(CERT_TYPE), Buffer.alloc(260, 0x41),
    ]).toString('base64')}\n`
    // It passes the cheap structural gate -- that is the point of the case.
    expect(isSSHCertificateRecord(shaped.trim()), 'the fixture no longer exercises the gap').toBe(true)

    expect(() => stageCertificate(live(), shaped)).toThrow(/cannot parse|left untouched/)
    expect(readFileSync(live(), 'utf8'), 'a certificate ssh cannot read replaced the working one').toBe(CERT + '\n')
  })

  it('refuses rather than passes when ssh-keygen is missing', () => {
    // Cannot-confirm is not a licence to overwrite a credential that works.
    const enoent = () => { const e: NodeJS.ErrnoException = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e }
    expect(() => stageCertificate(live(), CERT + '\n', enoent)).toThrow(/not installed/)
    expect(readFileSync(live(), 'utf8')).toBe(CERT + '\n')
  })

  it('installs a real certificate, and leaves no staging file behind', () => {
    // The positive control: a gate strict enough to refuse the cases above can
    // refuse every real certificate too, and renewal would silently stop.
    stageCertificate(live(), EXPIRED_CERT + '\n').commit()
    expect(readFileSync(live(), 'utf8')).toBe(EXPIRED_CERT + '\n')
    expect(readdirSync(join(home, '.insta', 'ssh')).filter((f) => f.includes('staging')),
      'a staging file survived').toEqual([])
  })

  it('cleans up the staging file when verification fails', () => {
    try { stageCertificate(live(), 'not a certificate at all\n') } catch { /* expected */ }
    expect(readdirSync(join(home, '.insta', 'ssh')).filter((f) => f.includes('staging'))).toEqual([])
  })
})

d('a CA key is decoded too, not just base64-checked', () => {
  it('refuses a blob whose declared type disagrees with its body', () => {
    // Same class as the certificate gap: an anchor built from a mislabelled
    // blob installs silently and fails at connect time, where the message
    // points at known_hosts rather than at the response that produced it.
    const mislabelled = `ssh-ed25519 ${CA.split(/\s+/)[1]!.slice(0, 8)}${'A'.repeat(60)}`
    expect(() => parseCAPublicKey(mislabelled)).toThrow()
  })

  it('accepts the real CA key ssh-keygen produced', () => {
    expect(parseCAPublicKey(CA).type).toBe('ssh-ed25519')
    expect(parseCAPublicKey(CA).blob).toBe(CA.split(/\s+/)[1])
  })
})

d('a CA key is validated whole, not by its first field', () => {
  const field = (b: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(b.length, 0); return Buffer.concat([n, b]) }

  it('refuses a blob with the right type name and noise behind it', () => {
    // The escalation the first-field check missed. The type string is correct,
    // so a prefix check passes; there is no 32-byte key behind it, so the
    // anchor is installed and then fails at connect time -- where the message
    // points at known_hosts rather than at the response that produced it.
    const noise = `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), Buffer.alloc(200, 0x41)]).toString('base64')}`
    expect(() => parseCAPublicKey(noise), 'a blob with a correct type name and noise was accepted').toThrow()
  })

  it('refuses an ed25519 key whose key field is the wrong size', () => {
    const short = `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.alloc(16, 0x41))]).toString('base64')}`
    expect(() => parseCAPublicKey(short)).toThrow(/32-byte/)
  })

  it('refuses a blob with trailing bytes after its last field', () => {
    // The walk must land EXACTLY on the end: trailing bytes mean the blob is
    // not the structure it claims to be.
    const trailing = `ssh-ed25519 ${Buffer.concat([
      field(Buffer.from('ssh-ed25519')), field(Buffer.alloc(32, 0x41)), Buffer.from([0x41, 0x42]),
    ]).toString('base64')}`
    expect(() => parseCAPublicKey(trailing)).toThrow()
  })

  it('accepts the real CA key ssh-keygen produced', () => {
    // Positive control for the three above.
    expect(parseCAPublicKey(CA).type).toBe('ssh-ed25519')
  })
})

d('a symlinked certificate is written THROUGH, not replaced', () => {
  it('keeps the link and updates its target', () => {
    // Same reason writeFileAtomicSync resolves: rename(2) replaces the LINK,
    // so a certificate someone symlinked into a dotfiles repo would be severed
    // on the first renewal -- quietly, and only on the path that runs
    // unattended.
    const store = join(home, 'dotfiles'); mkdirSync(store, { recursive: true })
    const real = join(store, 'api-cert.pub')
    writeFileSync(real, EXPIRED_CERT + '\n')
    const link = join(home, '.insta', 'ssh', 'api.insta-cert.pub')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(real, link)

    stageCertificate(link, CERT + '\n').commit()

    expect(lstatSync(link).isSymbolicLink(), 'the symlink was replaced with a regular file').toBe(true)
    expect(readFileSync(real, 'utf8'), 'the dotfiles copy was left stale').toBe(CERT + '\n')
  })
})
