// `--setup` as ONE transaction over three files.
//
// The certificate, the trust anchor in known_hosts and the alias block in
// ssh_config only mean anything together: a certificate whose CA is not
// anchored authenticates nothing, and a config stanza naming an alias that is
// not in the store is not rendered at all. Each individual write is atomic and
// each has a passing test, and that is precisely what hid the two defects here
// -- both of them visible only from what the OTHER writes were doing at the
// time.
//
// Deliberately free of ssh-keygen, unlike ssh-orchestration.test.ts: what is
// under test is the ORDER and ATOMICITY of the writes, not whether OpenSSH can
// read the bytes, and a suite that skips wholesale on a machine without
// OpenSSH is a suite that does not defend these two cases at all.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  computeSSH, installCertAuthority, instaAliasStorePath, instaCertPath, readAliasStore, stageCertificate, writeAliasStore,
} from '../src/commands/compute.js'

// BOTH variables: os.homedir() reads $HOME on POSIX and $USERPROFILE on
// Windows, and a redirection that silently does nothing produces tests that
// pass against the real home.
let home: string
let prevHome: string | undefined
let prevProfile: string | undefined

beforeEach(() => {
  prevHome = process.env.HOME
  prevProfile = process.env.USERPROFILE
  home = mkdtempSync(join(tmpdir(), 'insta-ssh-txn-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  const want = join(home, '.insta', 'ssh', 'aliases.json')
  if (instaAliasStorePath() !== want) {
    throw new Error(`the home redirection did not take: got ${instaAliasStorePath()}, want ${want}`)
  }
  mkdirSync(join(home, '.insta', 'ssh'), { recursive: true })
  // The key pair already exists, which is the steady state: it is generated
  // once, by the first --setup ever run, and every later one reads it. Written
  // here rather than generated so ensureKeyPair never shells out to ssh-keygen.
  writeFileSync(join(home, '.insta', 'ssh', 'id_ed25519'), 'PRIVATE\n')
  writeFileSync(join(home, '.insta', 'ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA test@insta\n')
})
afterEach(() => {
  process.env.HOME = prevHome
  process.env.USERPROFILE = prevProfile
  rmSync(home, { recursive: true, force: true })
})

const field = (b: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(b.length, 0); return Buffer.concat([n, b]) }
/** A structurally valid ed25519 CA key: parseCAPublicKey walks the whole blob,
 *  so a made-up base64 string will not do. */
const caKey = (fill: number) =>
  `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(Buffer.alloc(32, fill))]).toString('base64')}`
const CA_OLD = caKey(0xa1)
const CA_NEW = caKey(0xb2)
/** The `<type> <blob>` pair renderCertAuthority writes, comment stripped. */
const caRecord = (key: string) => key.split(/\s+/).slice(0, 2).join(' ')

const CERT_TYPE = 'ssh-ed25519-cert-v01@openssh.com'
const certFor = (fill: number) => `${CERT_TYPE} ${Buffer.concat([
  field(Buffer.from(CERT_TYPE)), field(Buffer.alloc(32, 0x5a)), field(Buffer.alloc(32, fill)), Buffer.alloc(96, 0x7f),
]).toString('base64')}`
const NEW_CERT = certFor(0x11)
const OLD_CERT = certFor(0x22)

const HOST = 'ssh.us-west-1.compute.example'
const ALIAS = 'api.insta'
const knownHosts = () => join(home, '.ssh', 'known_hosts')
const sshConfig = () => join(home, '.ssh', 'config')

const deps = (over: Record<string, unknown> = {}) => ({
  loadApi: (async () => ({ request: async () => ({ services: [{ id: 'svc-1', name: 'api', type: 'compute' }] }) })) as never,
  loadProject: (async () => ({ projectId: 'proj-1' })) as never,
  mint: (async (_a: unknown, _p: string, serviceId: string, _k: string, alias: string) => ({
    certificate: NEW_CERT, host: HOST, username: `u-${serviceId}`,
    expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA_NEW,
    // The real mintCert STAGES as part of succeeding and leaves committing to
    // the caller; that hand-off is what makes the ordering destructive rather
    // than merely untidy, so it is reproduced through the real stageCertificate.
    // `verify` is stubbed because OpenSSH's opinion of the bytes is not what
    // this file is about.
    staged: stageCertificate(instaCertPath(alias), NEW_CERT + '\n', { verify: () => {} }),
  })) as never,
  emit: () => {},
  ...over,
}) as never

/** The state of a WORKING alias: an anchor for the CA that signed the
 *  certificate sitting at `<alias>-cert.pub`, and a store entry naming it. */
const anAlreadyWorkingAlias = () => {
  installCertAuthority(HOST, CA_OLD)
  writeAliasStore({ [ALIAS]: { projectId: 'proj-1', serviceId: 'svc-1', host: HOST, username: 'u-svc-1' } })
  writeFileSync(instaCertPath(ALIAS), OLD_CERT + '\n')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(sshConfig(), 'Host bastion\n  User someone\n')
}

describe('a setup that fails AFTER rotating the anchor leaves the alias working', () => {
  // The finding. installCertAuthority retires the previous CA for this host
  // pattern as part of installing the new one, and the steps that follow it --
  // the ssh_config write, the certificate rename -- can still fail. Without a
  // way back, the old certificate stays installed with its CA gone: an alias
  // that worked a moment ago cannot authenticate, the command exited with an
  // error saying it had done nothing, and nothing points at known_hosts.
  //
  // The positive control is the last case: a rotation that SUCCEEDS really does
  // retire the old CA, so these are not satisfied by an install that never
  // rotates anything.

  it('puts the retired CA back when the config write fails', async () => {
    anAlreadyWorkingAlias()
    const d = deps({ installConfig: () => { throw new Error('disk full') } })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/disk full/)

    const anchors = readFileSync(knownHosts(), 'utf8')
    expect(anchors, 'the CA vouching for the installed certificate was left retired')
      .toContain(caRecord(CA_OLD))
    expect(anchors, 'a failed setup left the new anchor behind').not.toContain(caRecord(CA_NEW))
    expect(readFileSync(instaCertPath(ALIAS), 'utf8'),
      'the working certificate was replaced by a setup that failed').toBe(OLD_CERT + '\n')
  })

  it('puts it back when the certificate rename itself fails', async () => {
    // The last step is a rename, which does not fail HALFWAY -- but it can
    // still fail outright, and by then the anchor has already rotated. This is
    // the interleaving a test that only fails the config write never reaches.
    anAlreadyWorkingAlias()
    const before = readFileSync(sshConfig(), 'utf8')
    const d = deps({
      mint: async () => ({
        certificate: NEW_CERT, host: HOST, username: 'u-svc-1',
        expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA_NEW,
        staged: { commit: () => { throw new Error('rename failed') }, discard: () => {} },
      }),
    })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/rename failed/)

    expect(readFileSync(knownHosts(), 'utf8')).toContain(caRecord(CA_OLD))
    expect(readFileSync(instaCertPath(ALIAS), 'utf8')).toBe(OLD_CERT + '\n')
    expect(readFileSync(sshConfig(), 'utf8'),
      'the ssh config was left describing a setup that never completed').toBe(before)
    expect(readAliasStore()[ALIAS], 'the alias store recorded a setup that never completed')
      .toMatchObject({ host: HOST, username: 'u-svc-1' })
  })

  it('leaves no store entry behind for an alias that was never set up', async () => {
    // Nothing existed before, so "restore what was there" means leaving the
    // command's own half-written entry out of the store rather than putting an
    // older one back.
    const d = deps({ installConfig: () => { throw new Error('disk full') } })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/disk full/)
    expect(readAliasStore(), 'a failed setup recorded its alias anyway').toEqual({})
    expect(existsSync(sshConfig()), 'a failed setup created an ssh config').toBe(false)
  })

  it('does retire the old CA when the setup succeeds', async () => {
    // Without this the three cases above are satisfied by an installCA that
    // never rotates -- which would leave the retired CA trusted forever, the
    // defect the marker and the rotation rule exist for.
    anAlreadyWorkingAlias()
    await computeSSH('api', { setup: true }, deps())

    const anchors = readFileSync(knownHosts(), 'utf8')
    expect(anchors).toContain(caRecord(CA_NEW))
    expect(anchors, 'the retired CA is still trusted for this host pattern').not.toContain(caRecord(CA_OLD))
    expect(readFileSync(instaCertPath(ALIAS), 'utf8')).toBe(NEW_CERT + '\n')
    expect(readFileSync(sshConfig(), 'utf8')).toContain(`Host ${ALIAS}`)
  })
})

describe('a certificate issued for another key never replaces a working one', () => {
  // ssh-keygen -L proves the response is a parseable certificate. It does not
  // prove it is a certificate for the key we sent, and one issued for a
  // different key passes every other gate, replaces the live credential and
  // fails at authentication time -- where the message points at the file rather
  // than at the response that produced it.
  const ourKey = `ssh-ed25519 ${Buffer.concat([
    field(Buffer.from('ssh-ed25519')), field(Buffer.alloc(32, 0x11)),
  ]).toString('base64')} insta compute ssh`

  it('refuses it, and leaves the installed certificate alone', () => {
    writeFileSync(instaCertPath(ALIAS), OLD_CERT + '\n')
    expect(() => stageCertificate(instaCertPath(ALIAS), certFor(0x99) + '\n', { verify: () => {}, publicKey: ourKey }))
      .toThrow(/different key/)
    expect(readFileSync(instaCertPath(ALIAS), 'utf8'),
      'a certificate for another key replaced the working one').toBe(OLD_CERT + '\n')
  })

  it('accepts the certificate issued for the key we sent', () => {
    // The positive control: a check strict enough to refuse the case above can
    // refuse every real certificate too, and renewal would silently stop.
    writeFileSync(instaCertPath(ALIAS), OLD_CERT + '\n')
    stageCertificate(instaCertPath(ALIAS), certFor(0x11) + '\n', { verify: () => {}, publicKey: ourKey }).commit()
    expect(readFileSync(instaCertPath(ALIAS), 'utf8')).toBe(certFor(0x11) + '\n')
  })
})

// Two `--setup` runs for DIFFERENT services -- a project with an `api` and a
// `worker` is the ordinary case, not a contrived one -- both read the same
// aliases.json, each adds only its own entry, and each writes both the store
// and the ssh_config block rendered from it. Whichever finished second wins
// outright: the other alias is gone from both files, and BOTH commands printed
// the alias they had configured.
//
// This cannot be observed from one process: the read-modify-write is
// synchronous, so an in-process "concurrent" call serialises itself. Only real
// processes interleave, so the test spawns them.
//
// The children are TypeScript, so they need the same loader vitest uses.
const tsx = (() => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '-e', ''], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const dd = tsx ? describe : describe.skip

dd('separate setups running at once keep every alias', () => {
  const CHILD = `
const [, , mod, startAt, name, certFile, caFile] = process.argv
const { readFileSync } = await import('node:fs')
const { computeSSH, instaCertPath, stageCertificate } = await import(mod)
const CERT = readFileSync(certFile, 'utf8').trim()
const CA = readFileSync(caFile, 'utf8').trim()
const deps = {
  loadApi: async () => ({ request: async () => ({ services: [{ id: 'svc-' + name, name, type: 'compute' }] }) }),
  loadProject: async () => ({ projectId: 'proj-1' }),
  mint: async (_a, _p, serviceId, _k, alias) => ({
    certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-' + serviceId,
    expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
    staged: stageCertificate(instaCertPath(alias), CERT + '\\n', { verify: () => {} }),
  }),
  emit: () => {},
}
// A common start, so the processes are inside the shared files together rather
// than one after another.
await new Promise((r) => setTimeout(r, Number(startAt) - Date.now()))
await computeSSH(name, { setup: true }, deps)
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

  it('records every one of them, in the store and in the config', async () => {
    // `.mts`, because the script is written into a directory with no
    // package.json: a plain `.ts` there is transformed as CommonJS, and the
    // dynamic import below is top-level await.
    const script = join(home, 'setup-child.mts')
    writeFileSync(script, CHILD)
    const certFile = join(home, 'cert.txt'); writeFileSync(certFile, NEW_CERT)
    const caFile = join(home, 'ca.txt'); writeFileSync(caFile, CA_NEW)
    const compute = new URL('../src/commands/compute.ts', import.meta.url).href

    const names = ['api', 'worker', 'web', 'cron']
    const startAt = Date.now() + 1_000
    const results = await Promise.all(names.map((name) =>
      run(['--import', 'tsx', script, compute, String(startAt), name, certFile, caFile])))
    for (const r of results) expect(r.code, `a setup process failed: ${r.err}`).toBe(0)

    const store = readAliasStore()
    const config = readFileSync(sshConfig(), 'utf8')
    for (const name of names) {
      // In the STORE, which is what renewal reads...
      expect(store[`${name}.insta`], `${name}.insta was erased by a concurrent setup`)
        .toMatchObject({ serviceId: `svc-${name}`, host: HOST })
      // ...and in the CONFIG, which is what `ssh <alias>` reads. The block is
      // rendered from the whole store and replaced wholesale, so a stale read
      // deletes somebody else's stanza even when the store survives.
      expect(config, `the stanza for ${name}.insta was deleted by a concurrent setup`)
        .toContain(`Host ${name}.insta`)
    }
  }, 60_000)
})
