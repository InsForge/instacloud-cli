// computeSSH's ORDER of operations.
//
// Every individual step here had a passing unit test while two defects shipped
// through: the collision check ran after mintCert had already overwritten the
// certificate it was about to refuse, and the printed command could not use the
// credential that had just been issued. Neither is visible from a test of any
// single piece -- only from running the steps together and watching what
// happens, and in what order.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { computeSSH, instaCertPath, instaAliasStorePath, writeAliasStore, readAliasStore, validateCertResponse, acquireRenewalLock } from '../src/commands/compute.js'

// Same convention as the rest of the suite: os.homedir() honours $HOME, so the
// whole ~/.insta and ~/.ssh tree redirects into a temp dir without mocking fs.
let home: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env.HOME
  home = mkdtempSync(join(tmpdir(), 'insta-ssh-orch-'))
  process.env.HOME = home
})
afterEach(() => { process.env.HOME = prevHome; rmSync(home, { recursive: true, force: true }) })

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
      writeFileSync(instaCertPath(alias), `cert-for-${serviceId}\n`)
      return { certificate: `cert-for-${serviceId}`, host: 'ssh.us-west-1.compute.example', username: `u-${serviceId}`, expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
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
    certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA',
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
    certificate: 'cert', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1',
    expiresAt: '2026-09-14T22:00:00Z',
  }
})

describe('the printed command is safe to paste', () => {
  it('quotes a destination carrying shell syntax', async () => {
    // isSafeConfigValue permits `;`, `$`, backticks and friends -- correctly,
    // since they are legal in ssh_config. But this line is printed FOR A HUMAN
    // TO PASTE into a shell, so the destination is quoted there.
    const { deps: d, lines } = deps({
      mint: async () => ({
        certificate: 'c', host: 'ssh.us-west-1.compute.example', username: 'u;id',
        expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
      }),
    })
    await computeSSH('api', {}, d)
    expect(lines[0], 'a username carrying shell syntax was printed unquoted').toContain(`'u;id@ssh.us-west-1.compute.example'`)
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
const keygen = (() => { try { execFileSync('ssh-keygen', ['-A', '-h'], { stdio: 'ignore' }) } catch (e: unknown) {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
} return true })()

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
      const good = { certificate: 'new-cert', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
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
    const good = { certificate: 'new-cert', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1', expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA }
    const { deps: d } = deps({ mint: undefined, loadApi: apiReturning(good) })
    writeAliasStore({ 'api.insta': { projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.compute.example', username: 'u-svc-1' } })
    await computeSSH('api', {}, d)
    expect(readFileSync(instaCertPath('api.insta'), 'utf8')).toBe('new-cert\n')
  })
})
