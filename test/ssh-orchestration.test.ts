// computeSSH's ORDER of operations.
//
// Every individual step here had a passing unit test while two defects shipped
// through: the collision check ran after mintCert had already overwritten the
// certificate it was about to refuse, and the printed command could not use the
// credential that had just been issued. Neither is visible from a test of any
// single piece -- only from running the steps together and watching what
// happens, and in what order.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { computeSSH, installCertAuthority, instaCertPath, instaAliasStorePath, instaKeyPath, writeAliasStore, readAliasStore, validateCertResponse, acquireLockFile, acquireRenewalLock, ensureCertForAlias, hostPatternFor, stageCertificate } from '../src/commands/compute.js'
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
// Module scope, so cleaned up at module scope: the per-test `home` is removed
// in afterEach, and this directory was leaking a CA, a user key and every
// generated certificate into the OS temp area on every run.
afterAll(() => { if (fixtures) rmSync(fixtures, { recursive: true, force: true }) })
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
/** A REAL certificate, in date, signed by the same CA -- for a key that is not
 *  ours. `ssh-keygen -L` is perfectly happy with it, and it authenticates
 *  nothing on this machine. */
const OTHER_KEY_CERT = !keygen ? '' : (() => {
  const other = join(fixtures, 'other')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other, '-C', 'other@insta'])
  execFileSync('ssh-keygen', ['-q', '-s', join(fixtures, 'ca'), '-I', 'other', '-n', 'u-svc-1', '-V', '+1h', `${other}.pub`])
  return readFileSync(`${other}-cert.pub`, 'utf8').trim()
})()

/** The CA a machine was anchored to BEFORE a rotation. A rotation is the only
 *  shape in which rollback can destroy something: with nothing to retire, the
 *  anchor install is purely additive and taking it back removes only what it
 *  added. */
const CA_PREV = !keygen ? '' : (() => {
  const prev = join(fixtures, 'ca-prev')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', prev, '-C', 'ca-prev@insta'])
  return readFileSync(`${prev}.pub`, 'utf8').trim()
})()

/** A real certificate for OUR key -- the one ensureKeyPair offers and
 *  stageCertificate checks the response against -- signed by whichever CA is
 *  named. Signed through a uniquely named copy of the public key because
 *  `ssh-keygen -s` derives the output name from the input's, so signing
 *  `user.pub` twice would have the second certificate overwrite the first. */
const signedForOurKey = (caName: string, id: string, window: string) => {
  const base = join(fixtures, `ours-${id}`)
  copyFileSync(join(fixtures, 'user.pub'), `${base}.pub`)
  execFileSync('ssh-keygen', ['-q', '-s', join(fixtures, caName), '-I', id, '-n', 'u-svc-9', '-V', window, `${base}.pub`])
  return readFileSync(`${base}-cert.pub`, 'utf8').trim()
}
/** In date under CA_PREV would never be renewed, so this one is genuinely
 *  stale: certNeedsRenewal has to want it replaced for the race to be reached
 *  at all. */
const WORKER_STALE_CERT = !keygen ? '' : signedForOurKey('ca-prev', 'worker-stale', '-2h:-1h')
const WORKER_FRESH_CERT = !keygen ? '' : signedForOurKey('ca', 'worker-fresh', '+1h')
/** In-date certificates for our key, distinguishable from CERT by their id:
 *  what a renewal hands back once the alias has moved, and what a late mint
 *  hands back after somebody else already renewed. */
const MOVED_CERT = !keygen ? '' : signedForOurKey('ca', 'moved', '+1h')
const LATE_CERT = !keygen ? '' : signedForOurKey('ca', 'late', '+1h')

/** Install the key CERT was issued for where ensureKeyPair looks for it.
 *
 *  The renewal path sends the public key at ~/.insta/ssh/id_ed25519.pub and the
 *  response is checked against it, so a suite that let ensureKeyPair generate a
 *  fresh key would be minting for one key and handed a certificate for another
 *  -- a refusal, by design. This is also the steady state on a real machine:
 *  the key is generated once and every certificate is issued for it. */
const installTheKeyCertWasIssuedFor = () => {
  mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
  copyFileSync(join(fixtures, 'user'), instaKeyPath())
  // copyFileSync does not carry the mode, and 0644 is not a private key a
  // real install ever has: the credential here is the one the feature uses.
  chmodSync(instaKeyPath(), 0o600)
  copyFileSync(join(fixtures, 'user.pub'), instaKeyPath() + '.pub')
}

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

// A lock suite: nothing here needs OpenSSH, so it is not behind the ssh-keygen
// gate -- a lock regression is cheapest to reproduce exactly where OpenSSH is
// absent.
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

d('a rejected response never replaces the working certificate', () => {
  const apiReturning = (certBody: Record<string, unknown>) => async () => ({
    request: async () => ({ services: [{ id: 'svc-1', name: 'api', type: 'compute' }] }),
    rawRequest: async () => ({ status: 200, body: certBody }),
  } as never)

  beforeEach(() => {
    // The real mintCert runs here, and it checks the response against the key
    // it sent -- so the key CERT was issued for has to be the one on disk.
    installTheKeyCertWasIssuedFor()
    writeFileSync(instaCertPath('api.insta'), 'the-working-certificate\n')
  })

  const hostile: Array<[string, Record<string, unknown>]> = [
    ['a host with a newline', { host: 'ssh.example.com\n  ProxyCommand sh' }],
    ['a single-label host', { host: 'localhost' }],
    ['a username with a space', { username: 'u root' }],
    ['a CA key spanning two lines', { caPublicKey: `${CA}\n@cert-authority * ${CA}` }],
    // Real, in date and signed by the trusted CA -- for a key that is not ours.
    // Every other gate in the pipeline accepts it.
    ['a certificate issued for another key', { certificate: OTHER_KEY_CERT }],
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
    // EXPIRED, so the give-up path is actually reached. With a certificate
    // still in date, certNeedsRenewal returns before the first network call and
    // this case passed for a hook that overwrote the file on every failure.
    writeFileSync(instaCertPath('api.insta'), EXPIRED_CERT + '\n')
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    let asked = false
    await raceRenewal(() => { asked = true; return Promise.reject(new Error('network down')) })
    expect(asked, 'renewal never reached the platform, so nothing below was exercised').toBe(true)
    // Silent and fail-safe: the login then proceeds on the certificate it has.
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe(EXPIRED_CERT + '\n')
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
    // The stanza has to send ssh to the very file the anchor was written into a
    // few lines above. Left unset it is inherited from any later `Host *` the
    // user has -- `UserKnownHostsFile none` in a hardened config is the ordinary
    // case -- and a perfectly good anchor then sits in a file this alias never
    // opens. Asserted against the path the anchor was READ from, so the config
    // and the anchor cannot drift apart without this failing.
    expect(cfg, 'the alias does not look for host keys where the anchor was installed')
      .toContain(`UserKnownHostsFile "${asConfigPath(join(sshDir(), 'known_hosts'))}"`)
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
    installTheKeyCertWasIssuedFor()
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

  it('refuses a valid certificate that was issued for a DIFFERENT key', async () => {
    // `ssh-keygen -L` proves the response is a certificate; it does not prove
    // it is a certificate for the key we sent. This one is real, in date and
    // signed by the trusted CA -- and it authenticates nothing here, so
    // installing it would replace a working credential with a dead one and
    // fail later, inside ssh, pointing at the file rather than the response.
    await renew(() => ({ status: 200, body: { ...good, certificate: OTHER_KEY_CERT } }))
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      "a certificate for somebody else's key replaced the live credential").toBe('the-expiring-certificate\n')
    expect(readdirSync(join(home, '.insta', 'ssh')).filter((f) => f.includes('staging')),
      'a staged certificate was left behind').toEqual([])
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
    installTheKeyCertWasIssuedFor()
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
// The children are TypeScript, so they need a loader. tsx is a devDependency
// of this repo, so failing to load it is a BROKEN environment rather than a
// legitimate one the way a missing ssh-keygen is -- and a broken environment
// FAILS these suites rather than skipping them. A lock or ordering regression
// guarded only by a suite that silently skipped is not guarded at all, which
// is the argument ssh-setup-transaction.test.ts makes against skipping on
// OpenSSH; it has to hold for the loader too. Probed once so the failure names
// the cause instead of surfacing as four spawn errors.
const tsxUnavailable = (() => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '-e', ''], { stdio: 'pipe' })
    return undefined
  } catch (e) {
    return e as Error
  }
})()
const requireTsx = () => {
  if (tsxUnavailable) {
    throw new Error(`the multi-process suites need \`node --import tsx\` (Node >= 18.19 with the tsx devDependency installed): ${tsxUnavailable.message}`)
  }
}

const dd = keygen ? describe : describe.skip

dd('separate processes installing anchors at once keep every anchor', () => {
  beforeAll(requireTsx)
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

dd('a setup that fails cannot strand a renewal that succeeded', () => {
  beforeAll(requireTsx)
  // The finding. The known_hosts lock covered each individual EDIT and was
  // released before the transaction that edit belonged to had committed. So:
  // setup A rotates the anchor from CA_PREV to CA and keeps an undo that would
  // put CA_PREV back; renewal B arrives after that write and before A's
  // outcome, sees CA already anchored, is handed a do-nothing undo for it, and
  // commits a certificate signed by CA. A then fails, its undo retires CA and
  // restores CA_PREV -- and B's freshly committed certificate now authenticates
  // nothing. Silently, on the path that runs unattended inside `ssh`.
  //
  // The rule the fix restores: observing the anchor and committing the
  // certificate that depends on it are ONE section, and the rollback happens
  // inside it too. Not reachable from a single process -- that section is
  // synchronous, so an in-process caller only ever serialises itself -- so B is
  // a real process. It is `ensureCertForAlias` rather than a second setup
  // because setups already exclude each other on aliases.lock; the renewal hook
  // never takes that lock, which is exactly why it can land in the middle.
  const HOST = 'ssh.us-west-1.compute.example'

  // B, the renewal. Waits for A to be inside its transaction rather than
  // starting on a timer, so the interleaving is the one being tested and not
  // whichever one the machine's load happened to produce.
  const CHILD = `
const [, , computeMod, apiMod, dir, cert, ca] = process.argv
const { existsSync, writeFileSync } = await import('node:fs')
const { join } = await import('node:path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = Date.now() + 20000
while (!existsSync(join(dir, 'inside')) && Date.now() < deadline) await sleep(10)
const { ensureCertForAlias } = await import(computeMod)
const { ApiClient } = await import(apiMod)
const body = JSON.stringify({
  certificate: cert, host: '${HOST}', username: 'u-svc-9',
  expiresAt: '2026-09-14T22:00:00Z', caPublicKey: ca,
})
ApiClient.load = async () => new ApiClient(
  { apiUrl: 'https://example.invalid', accessToken: 't' },
  async () => ({ status: 200, text: async () => body }),
)
// Swallows its own failures, as the real hook does: whether B renewed is read
// off the certificate it left behind, not off an exit code.
await ensureCertForAlias('worker.insta', 4000)
writeFileSync(join(dir, 'b-done'), 'x')
`

  const startB = () => {
    const script = join(home, 'renewal-child.mts')
    writeFileSync(script, CHILD)
    const args = [
      '--import', 'tsx', script,
      new URL('../src/commands/compute.ts', import.meta.url).href,
      new URL('../src/api.ts', import.meta.url).href,
      home, WORKER_FRESH_CERT, CA,
    ]
    return new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr!.on('data', (chunk) => { err += String(chunk) })
      child.on('exit', (code) => resolve({ code, err }))
    })
  }

  /** Which CA signed the certificate `worker.insta` is actually holding. */
  const signedBy = () => {
    const installed = readFileSync(instaCertPath('worker.insta'), 'utf8').trim()
    return new Map([[WORKER_STALE_CERT, CA_PREV], [WORKER_FRESH_CERT, CA]]).get(installed)
  }
  const anchors = () => readFileSync(join(home, '.ssh', 'known_hosts'), 'utf8')

  beforeEach(() => {
    installTheKeyCertWasIssuedFor()
    writeFileSync(instaCertPath('worker.insta'), WORKER_STALE_CERT + '\n')
    writeAliasStore({
      'worker.insta': { projectId: 'proj-1', serviceId: 'svc-9', host: HOST, username: 'u-svc-9' },
    })
    // The machine as it is before the rotation: already anchored, to the CA
    // that signed the certificate `worker.insta` is holding.
    installCertAuthority(hostPatternFor(HOST), CA_PREV)
  })

  it('leaves the alias holding a certificate whose CA is still anchored', async () => {
    const done = startB()
    // A's LAST step before the commit, so by the time B is let in the anchor
    // has been rotated and A's undo is loaded and waiting.
    const { deps: d } = deps({
      installCA: undefined,
      installConfig: () => {
        writeFileSync(join(home, 'inside'), 'x')
        const deadline = Date.now() + 20_000
        while (!existsSync(join(home, 'b-done')) && Date.now() < deadline) {
          // Sync, because this stands in for a step of a synchronous
          // transaction: yielding to the event loop here would make A's hold
          // on the world looser than the real one.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        }
        throw new Error('disk full')
      },
    })
    await expect(computeSSH('api', { setup: true } as never, d)).rejects.toThrow(/disk full/)
    const b = await done
    expect(b.code, `the renewal process failed outright: ${b.err}`).toBe(0)

    // Unconditional, and deliberately not "B renewed" or "B did not": either
    // outcome is acceptable on its own. What is never acceptable is the alias
    // holding a certificate signed by a CA this machine no longer trusts.
    const ca = signedBy()
    expect(ca, 'worker.insta holds a certificate this test did not produce').toBeDefined()
    expect(anchors(), 'the alias was left with a certificate whose CA is not anchored')
      .toContain(caRecord(ca!))
  }, 40_000)

  it('still renews when no setup is in flight', async () => {
    // The control. Without it the test above passes for the wrong reason the
    // moment B stops working at all -- a stale certificate and a stale anchor
    // agree with each other perfectly.
    writeFileSync(join(home, 'inside'), 'x')
    const b = await startB()
    expect(b.code, `the renewal process failed outright: ${b.err}`).toBe(0)
    expect(signedBy(), 'the renewal did not replace the stale certificate').toBe(CA)
    expect(anchors()).toContain(caRecord(CA))
  }, 40_000)
})

// The lock itself has nothing to do with OpenSSH, so this is NOT behind the
// ssh-keygen gate: gating it there would silently skip the regression wherever
// OpenSSH is absent, which is most of the places a lock bug is cheap to
// reproduce.
describe('simultaneous stale-lock recovery still admits one holder', () => {
  beforeAll(requireTsx)
  // The finding. Stale takeover was `statSync` followed by an unconditional
  // `unlinkSync`, and nothing tied the file removed to the file judged stale.
  // Two contenders both see the dead holder's lock; the first removes it and
  // takes a fresh one; the second's unlink then deletes THAT, and both are
  // inside the protected section -- concurrent writers over aliases.json,
  // ssh_config and known_hosts, which is how stanzas and anchors go missing.
  //
  // Not observable from one process: the whole sequence is synchronous, so an
  // in-process "concurrent" caller serialises itself. Only real processes
  // interleave.
  //
  // Driven through acquireLockFile rather than acquireRenewalLock so the
  // staleness window is milliseconds. With the real one-minute window the race
  // is a few microseconds wide and happens once per run, which a spawned
  // process lands in only by luck -- the first draft of this test passed
  // against the defect. Here every contender ABANDONS the lock periodically, so
  // the pack goes through simultaneous stale recovery dozens of times per run.
  const STALE_MS = 300
  const HOLD_MS = 10
  const ROUNDS = 15

  const CHILD = `
const [, , mod, startAt, id, lock, probe, staleMs, holdMs, rounds] = process.argv
const { readFileSync, writeFileSync } = await import('node:fs')
const { acquireLockFile } = await import(mod)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const STALE = Number(staleMs), HOLD = Number(holdMs)
let held = 0
const overlaps = []
// A common start, so the contenders are on the lock together rather than one
// after another.
await sleep(Number(startAt) - Date.now())
for (let i = 0; i < Number(rounds); i++) {
  // A TIGHT synchronous retry, not a polite poll. Every contender has to be ON
  // the lock at the instant it goes stale; poll it every few milliseconds
  // instead and they arrive one at a time, the first takes it cleanly and the
  // defect never gets its interleaving -- which is exactly how an earlier draft
  // of this test passed against the broken code.
  let release = acquireLockFile(lock, Date.now(), STALE)
  const until = Date.now() + STALE * 4
  while (!release && Date.now() < until) release = acquireLockFile(lock, Date.now(), STALE)
  if (!release) { await sleep(1); continue }
  // A mutual-exclusion probe rather than a count: stamp a shared file, hold,
  // and read it back. A second holder admitted at any point during the section
  // overwrites the stamp, and it does not matter which of the two notices.
  // HOLD is far shorter than STALE, so a holder is never itself stale and a
  // takeover during the section is always a defect rather than the contract.
  writeFileSync(probe, id)
  await sleep(HOLD)
  const seen = readFileSync(probe, 'utf8')
  if (seen === id) held++
  else overlaps.push(id + ' saw ' + seen)
  // Every fifth acquisition is ABANDONED rather than released: the process that
  // died holding the lock. This is what puts every other contender into stale
  // recovery on the same file at the same moment, which is the interleaving
  // under test. Waited out, so this process is well clear of the section before
  // anyone is entitled to break in.
  if (i % 5 === 4) await sleep(STALE + 50)
  else release()
}
process.stdout.write(JSON.stringify({ held, overlaps }))
`

  const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout!.on('data', (x) => { out += String(x) })
    child.stderr!.on('data', (x) => { err += String(x) })
    child.on('exit', (code) => resolve({ code, out, err }))
  })

  it('never lets two contenders break the same stale lock', async () => {
    // `.mts`, because the script is written into a directory with no
    // package.json: a plain `.ts` there is transformed as CommonJS, and the
    // dynamic import below is top-level await.
    const script = join(home, 'lock-child.mts')
    writeFileSync(script, CHILD)
    const compute = new URL('../src/commands/compute.ts', import.meta.url).href

    mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
    const lock = join(home, '.insta', 'ssh', 'contended.lock')
    const probe = join(home, 'probe.txt')
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const startAt = Date.now() + 1_000
    const results = await Promise.all(ids.map((id) => run([
      '--import', 'tsx', script, compute, String(startAt), id, lock, probe,
      String(STALE_MS), String(HOLD_MS), String(ROUNDS),
    ])))
    for (const r of results) expect(r.code, `a contender failed: ${r.err}`).toBe(0)

    const parsed = results.map((r) => JSON.parse(r.out) as { held: number; overlaps: string[] })
    expect(parsed.flatMap((p) => p.overlaps),
      'two contenders were inside the lock at once').toEqual([])
    // The positive control. A takeover that never happens satisfies the line
    // above trivially, and would wedge the lock for good after one crash: every
    // round following the first abandonment would just return undefined.
    expect(parsed.reduce((n, p) => n + p.held, 0),
      'the abandoned lock was never broken at all').toBeGreaterThan(ids.length)
  }, 60_000)
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
    expect(() => stageCertificate(live(), CERT + '\n', { verify: enoent })).toThrow(/not installed/)
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

d('every CA key type OpenSSH can generate passes the shape check', () => {
  // The positive control for the per-type shapes in ssh-config.test.ts, which
  // are hand-built from the wire format. If that reading of the format were
  // wrong, every hand-built case would agree with itself and a REAL key of
  // that type would be refused -- and setup would fail against a platform
  // that rotated to a type it has every right to use. These are the keys
  // ssh-keygen actually writes.
  const real: Array<[string, string[]]> = [
    ['ssh-rsa', ['-t', 'rsa', '-b', '2048']],
    ['ecdsa-sha2-nistp256', ['-t', 'ecdsa', '-b', '256']],
    ['ecdsa-sha2-nistp384', ['-t', 'ecdsa', '-b', '384']],
    ['ecdsa-sha2-nistp521', ['-t', 'ecdsa', '-b', '521']],
  ]
  for (const [type, args] of real) {
    it(`accepts a real ${type} key`, () => {
      const path = join(fixtures, `ca-${type}`)
      execFileSync('ssh-keygen', ['-q', ...args, '-N', '', '-f', path, '-C', 'ca'])
      expect(parseCAPublicKey(readFileSync(`${path}.pub`, 'utf8')).type).toBe(type)
    })
  }
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
    expect(() => parseCAPublicKey(short)).toThrow(/shape of "ssh-ed25519"/)
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

d('an automatic renewal moves the alias with the certificate', () => {
  // The finding. The response names the host and the principal the
  // certificate was issued for, and the installed stanza routes on the ones
  // recorded at setup. Committing the certificate alone left `ssh <alias>`
  // connecting to yesterday's host as yesterday's user carrying a certificate
  // that names today's -- while anchoring today's host, since the anchor is
  // derived from the response. A plain re-issue already moved all four
  // artifacts together (ssh-setup-transaction.test.ts); the hook, the one
  // writer that runs unattended, did not.
  const HOST = 'ssh.us-west-1.compute.example'
  const MOVED = 'ssh.eu-central-1.compute.example'
  const configPath = () => join(home, '.ssh', 'config')
  const knownHosts = () => readFileSync(join(home, '.ssh', 'known_hosts'), 'utf8')

  const renew = async (respond: () => unknown) => {
    const mod = await import('../src/api.js')
    const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify(respond()) })
    const spy = vi.spyOn(mod.ApiClient, 'load').mockResolvedValue(
      new mod.ApiClient({ apiUrl: 'https://example.invalid', accessToken: 't' } as never, fetchImpl as never),
    )
    try { await ensureCertForAlias('api.insta', 2_000) } finally { spy.mockRestore() }
  }
  const movedResponse = { certificate: MOVED_CERT, host: MOVED, username: 'u-moved', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
  const sameResponse = { certificate: MOVED_CERT, host: HOST, username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }

  /** The alias as a real --setup leaves it -- certificate, anchor, store and
   *  stanza all agreeing on HOST / u-svc-1 -- then aged, so renewal is reached. */
  const anInstalledAlias = async () => {
    installTheKeyCertWasIssuedFor()
    const { deps: d } = deps({ installCA: undefined, installConfig: undefined })
    await computeSSH('api', { setup: true }, d)
    writeFileSync(instaCertPath('api.insta'), EXPIRED_CERT + '\n')
  }

  it('routes the alias to the host and principal the new certificate names', async () => {
    await anInstalledAlias()
    await renew(() => movedResponse)

    const cfg = readFileSync(configPath(), 'utf8')
    expect(cfg, 'the alias kept routing to the host the service left').not.toContain(`HostName ${HOST}`)
    expect(cfg).toContain(`HostName ${MOVED}`)
    expect(cfg, 'the alias kept logging in as a principal the certificate no longer names').toContain('User u-moved')
    expect(readAliasStore()['api.insta']).toMatchObject({ host: MOVED, username: 'u-moved' })
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe(MOVED_CERT + '\n')
    expect(knownHosts(), 'the new host was not anchored').toContain(`@cert-authority ${MOVED} ${caRecord(CA)}`)
  })

  it('does not touch the config when nothing in it changed', async () => {
    // OpenSSH is reading that file while the hook runs, and on Windows a
    // rename over an open file fails -- so a renewal that re-rendered the
    // block unconditionally would fail there on every expiry. The
    // config.insta-bak the writer leaves is the tell: a first setup makes none
    // (there was no file to back up), so its presence means a rewrite.
    await anInstalledAlias()
    const before = readFileSync(configPath(), 'utf8')
    await renew(() => sameResponse)
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'), 'the renewal itself did not happen').toBe(MOVED_CERT + '\n')
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    expect(existsSync(configPath() + '.insta-bak'), 'the config was rewritten although nothing in it changed').toBe(false)
  })

  it('puts the stanza, the store and the anchor back when the move cannot be committed', async () => {
    await anInstalledAlias()
    const before = readFileSync(configPath(), 'utf8')
    // The last step is the certificate rename, and a directory in its place
    // makes it fail the way a real filesystem would -- after the store, the
    // anchor and the config have all been written.
    rmSync(instaCertPath('api.insta'))
    mkdirSync(instaCertPath('api.insta'))
    writeFileSync(join(instaCertPath('api.insta'), 'x'), '')
    await renew(() => movedResponse)

    expect(readFileSync(configPath(), 'utf8'), 'a failed renewal left the stanza describing a move that never happened').toBe(before)
    expect(readAliasStore()['api.insta'], 'the store recorded a move that never happened').toMatchObject({ host: HOST, username: 'u-svc-1' })
    expect(knownHosts(), 'the anchor for a host the alias never moved to was left behind').not.toContain(`@cert-authority ${MOVED} `)
    expect(knownHosts(), 'the anchor the alias still depends on was retired').toContain(`@cert-authority ${HOST} ${caRecord(CA)}`)
  })

  it('does not replace a certificate somebody else renewed while its own mint was in flight', async () => {
    // The mint runs outside every lock. A --setup that finishes in that window
    // commits a newer certificate; the renewal's answer is then the OLDER
    // credential, and committing it over the newer one is a step backwards
    // that also re-anchors whatever CA the older answer carried.
    await anInstalledAlias()
    await renew(() => {
      // Stands in for the concurrent setup: it lands while this request is open.
      writeFileSync(instaCertPath('api.insta'), CERT + '\n')
      return { ...sameResponse, certificate: LATE_CERT }
    })
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      'a stale mint replaced the certificate a concurrent setup had just committed').toBe(CERT + '\n')
    expect(readdirSync(join(home, '.insta', 'ssh')).filter((f) => f.includes('staging')), 'a staged certificate was left behind').toEqual([])
  })

  it('does not commit a certificate for a record that was re-pointed while its mint was in flight', async () => {
    await anInstalledAlias()
    await renew(() => {
      writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-other', host: HOST, username: 'u-svc-1' } })
      return sameResponse
    })
    expect(readFileSync(instaCertPath('api.insta'), 'utf8'),
      'a certificate issued for one service was installed for an alias now naming another').toBe(EXPIRED_CERT + '\n')
  })
})

// C2: the key pair is generated once, however many first-ever setups arrive together.
const ddPosix = keygen && process.platform !== 'win32' ? describe : describe.skip

ddPosix('first-ever setups running at once generate ONE key pair', () => {
  beforeAll(requireTsx)
  // The finding. ensureKeyPair ran before the setup lock, so two setups on a
  // fresh machine both saw no key and both ran ssh-keygen at the same path.
  // The second failed on "already exists, overwrite?" against a closed stdin
  // (exit 1, observed); or read a private key whose .pub was not written yet;
  // or the two interleaved and left one process's private key beside the
  // other's public key, with a certificate then issued for a key no longer on
  // disk. The steady-state suite in ssh-setup-transaction.test.ts pre-creates
  // the pair and so never saw it.
  //
  // ssh-keygen makes an ed25519 key in about three milliseconds, so four
  // co-started processes would collide only by luck. The children run it
  // through a shim that SLEEPS first, which makes the window wide enough that
  // an unserialised generation collides every time. A shim on PATH is a shell
  // script, hence not on Windows.
  const CHILD = `
const [, , mod, dir, name, certFile, caFile] = process.argv
const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
const { join } = await import('node:path')
const { computeSSH, instaCertPath, stageCertificate } = await import(mod)
const CERT = readFileSync(certFile, 'utf8').trim()
const CA = readFileSync(caFile, 'utf8').trim()
const deps = {
  loadApi: async () => ({ request: async () => ({ services: [{ id: 'svc-' + name, name, type: 'compute' }] }) }),
  loadProject: async () => ({ projectId: 'proj-1' }),
  mint: async (_a, _p, serviceId, publicKey, alias) => {
    // The key this setup had its certificate issued for.
    writeFileSync(join(dir, 'pub-' + name), publicKey)
    return {
      certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-' + serviceId,
      expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
      staged: stageCertificate(instaCertPath(alias), CERT + '\\n', { verify: () => {} }),
    }
  },
  emit: () => {},
}
writeFileSync(join(dir, 'ready-' + name), 'x')
while (!existsSync(join(dir, 'go'))) await new Promise((r) => setTimeout(r, 5))
await computeSSH(name, { setup: true }, deps)
`

  const run = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr!.on('data', (x) => { err += String(x) })
    child.on('exit', (code) => resolve({ code, err }))
  })
  const waitFor = async (paths: string[]) => {
    const deadline = Date.now() + 20_000
    while (!paths.every((p) => existsSync(p))) {
      if (Date.now() > deadline) throw new Error(`children never became ready: ${paths.filter((p) => !existsSync(p)).join(', ')}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('leaves every setup holding the same key, and every certificate issued for it', async () => {
    const script = join(home, 'keygen-child.mts')
    writeFileSync(script, CHILD)
    const certFile = join(home, 'cert.txt'); writeFileSync(certFile, CERT)
    const caFile = join(home, 'ca.txt'); writeFileSync(caFile, CA)
    const compute = new URL('../src/commands/compute.ts', import.meta.url).href

    // The slow ssh-keygen. Real, apart from the half-second in front.
    const realKeygen = execFileSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).trim()
    const bin = join(home, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'ssh-keygen'), `#!/bin/sh\nsleep 0.5\nexec ${realKeygen} "$@"\n`, { mode: 0o755 })
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, USERPROFILE: home }

    const names = ['api', 'worker', 'web', 'cron']
    const results = names.map((name) => run(['--import', 'tsx', script, compute, home, name, certFile, caFile], env))
    await waitFor(names.map((n) => join(home, `ready-${n}`)))
    writeFileSync(join(home, 'go'), 'x')
    for (const r of await Promise.all(results)) expect(r.code, `a first-ever setup failed: ${r.err}`).toBe(0)

    // ONE pair, and a matching one: the private key on disk derives the public
    // key beside it.
    const derived = execFileSync(realKeygen, ['-y', '-f', instaKeyPath()], { encoding: 'utf8' }).trim().split(/\s+/).slice(0, 2).join(' ')
    const onDisk = readFileSync(instaKeyPath() + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')
    expect(onDisk, 'the public key on disk is not the private key\'s').toBe(derived)
    // And every certificate was issued for THAT key, not for one a sibling
    // setup generated and then lost.
    for (const name of names) {
      expect(readFileSync(join(home, `pub-${name}`), 'utf8').trim().split(/\s+/).slice(0, 2).join(' '),
        `${name} had its certificate issued for a key that is not the one on disk`).toBe(onDisk)
    }
    expect(Object.keys(readAliasStore()).sort()).toEqual(names.map((n) => `${n}.insta`).sort())
  }, 60_000)
})

describe('a lock that guards a file is broken only when its holder is GONE', () => {
  // The finding. Staleness was an AGE, so a holder that was merely slow was
  // broken -- while still inside the section, and still able to release. Its
  // release, landing between the breaker's token check and the breaker's
  // unlink, let a third process create a fresh lock at the path, which the
  // breaker then deleted before taking its own: two writers over aliases.json,
  // ssh_config or known_hosts. The rule for these locks is now that the
  // holder's PROCESS is gone, which is the one condition under which nothing
  // can release; and the takeover writes into the lock rather than replacing
  // it, so the path never changes inode under anybody.
  const lock = () => join(home, '.insta', 'ssh', 'file.lock')
  const NEVER_BY_AGE = Infinity
  /** A holder that died: a real process writes its lock and exits without
   *  releasing. execFileSync returns only once it has exited. */
  const aDeadHolder = () => {
    mkdirSync(dirname(lock()), { recursive: true })
    execFileSync(process.execPath, [
      '-e', "require('fs').writeFileSync(process.argv[1], process.pid + ':' + require('crypto').randomUUID(), { flag: 'wx' })", lock(),
    ])
    return readFileSync(lock(), 'utf8')
  }

  it('never breaks a holder that is merely slow, however old its lock', () => {
    const held = acquireLockFile(lock(), Date.now(), NEVER_BY_AGE)
    expect(held).toBeTruthy()
    // Ten minutes "later". Under the age rule this is the moment the lock was
    // taken from a live holder.
    expect(acquireLockFile(lock(), Date.now() + 10 * 60_000, NEVER_BY_AGE), 'a live holder was broken on age alone').toBeUndefined()
    held!()
    const next = acquireLockFile(lock(), Date.now(), NEVER_BY_AGE)
    expect(next, 'the lock was not released').toBeTruthy()
    next!()
  })

  it('breaks the lock of a process that has exited', () => {
    // The positive control: without it the case above is satisfied by a lock
    // that is never broken at all, and one crash wedges every setup for good.
    const dead = aDeadHolder()
    expect(dead).toMatch(/^\d+:/)
    const got = acquireLockFile(lock(), Date.now(), NEVER_BY_AGE)
    expect(got, 'a dead holder wedged the lock').toBeTruthy()
    expect(readFileSync(lock(), 'utf8'), 'the lock still carries the dead token').not.toBe(dead)
    got!()
    expect(existsSync(lock()), 'the taken-over lock was not released').toBe(false)
  })

  it('takes over by writing INTO the lock, never by replacing it', () => {
    // A second name on the same inode sees the breaker's token only if the
    // takeover wrote into that inode. An unlink-and-recreate leaves the witness
    // holding the dead token while the path holds a new file.
    const dead = aDeadHolder()
    const witness = lock() + '.witness'
    linkSync(lock(), witness)
    const got = acquireLockFile(lock(), Date.now(), NEVER_BY_AGE)
    expect(got).toBeTruthy()
    expect(readFileSync(witness, 'utf8'), 'the takeover replaced the inode instead of writing into it').toBe(readFileSync(lock(), 'utf8'))
    expect(readFileSync(witness, 'utf8')).not.toBe(dead)
    got!()
    unlinkSync(witness)
  })

  it('breaks a lock with no readable owner only once it is old', () => {
    // A process that died between the exclusive create and the write. Nothing
    // can ever release it, so age is the only rule left -- against a bound no
    // live creator spends between two consecutive syscalls.
    mkdirSync(dirname(lock()), { recursive: true })
    writeFileSync(lock(), '')
    expect(acquireLockFile(lock(), Date.now(), NEVER_BY_AGE), 'an unreadable lock was broken while still young').toBeUndefined()
    const got = acquireLockFile(lock(), Date.now() + 61_000, NEVER_BY_AGE)
    expect(got, 'an unreadable lock wedged the file for good').toBeTruthy()
    got!()
  })

  it('still breaks a slow RENEWAL holder by age, because a duplicate mint is harmless', () => {
    // The contrast, so the two rules are both pinned: the renewal lock guards
    // a request, not a file, and a wedged one silently stops an alias renewing.
    const held = acquireRenewalLock('api.insta')
    expect(held).toBeTruthy()
    const broke = acquireRenewalLock('api.insta', Date.now() + 61_000)
    expect(broke, 'the renewal lock no longer breaks by age').toBeTruthy()
    broke!()
    held!()
  })
})
