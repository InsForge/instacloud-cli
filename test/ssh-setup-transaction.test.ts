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
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  computeSSH, installCertAuthority, instaAliasStorePath, instaCertPath, readAliasStore, stageCertificate, writeAliasStore,
} from '../src/commands/compute.js'
import { canSymlink } from './support/can-symlink.js'

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
const PUBLIC_KEY = 'ssh-ed25519 AAAA test@insta'
const knownHosts = () => join(home, '.ssh', 'known_hosts')
const sshConfig = () => join(home, '.ssh', 'config')

const deps = (over: Record<string, unknown> = {}) => ({
  loadApi: (async () => ({ request: async () => ({ services: [{ id: 'svc-1', name: 'api', type: 'compute' }] }) })) as never,
  loadProject: (async () => ({ projectId: 'proj-1' })) as never,
  // The real one derives the key from the private key with ssh-keygen; this
  // file is about the ORDER of the writes and stays free of OpenSSH.
  keyPair: () => PUBLIC_KEY,
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
  // A user's own line and their trailing blank lines sit in the file too, so
  // "put back" below is measured byte for byte against a file that has more
  // in it than our anchor.
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(knownHosts(), 'github.com ssh-ed25519 AAAAuser\n\n\n')
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
    const before = readFileSync(knownHosts(), 'utf8')
    const d = deps({ installConfig: () => { throw new Error('disk full') } })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/disk full/)

    const anchors = readFileSync(knownHosts(), 'utf8')
    expect(anchors, 'the CA vouching for the installed certificate was left retired')
      .toContain(caRecord(CA_OLD))
    expect(anchors, 'a failed setup left the new anchor behind').not.toContain(caRecord(CA_NEW))
    // BYTE FOR BYTE: the user's line, their blank lines and our anchor, in the
    // order they were. "The old CA is present" is satisfied by a rollback that
    // rewrote everything else.
    expect(anchors, 'known_hosts was not put back exactly as it was').toBe(before)
    expect(readFileSync(instaCertPath(ALIAS), 'utf8'),
      'the working certificate was replaced by a setup that failed').toBe(OLD_CERT + '\n')
  })

  it('puts it back when the certificate rename itself fails', async () => {
    // The last step is a rename, which does not fail HALFWAY -- but it can
    // still fail outright, and by then the anchor has already rotated. This is
    // the interleaving a test that only fails the config write never reaches.
    anAlreadyWorkingAlias()
    const before = readFileSync(sshConfig(), 'utf8')
    const anchorsBefore = readFileSync(knownHosts(), 'utf8')
    const d = deps({
      mint: async () => ({
        certificate: NEW_CERT, host: HOST, username: 'u-svc-1',
        expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA_NEW,
        staged: { commit: () => { throw new Error('rename failed') }, discard: () => {} },
      }),
    })
    await expect(computeSSH('api', { setup: true }, d)).rejects.toThrow(/rename failed/)

    expect(readFileSync(knownHosts(), 'utf8')).toContain(caRecord(CA_OLD))
    expect(readFileSync(knownHosts(), 'utf8'), 'known_hosts was not put back exactly as it was').toBe(anchorsBefore)
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
    expect(existsSync(instaAliasStorePath()), 'a failed setup left an (empty) store behind').toBe(false)
    expect(existsSync(sshConfig()), 'a failed setup created an ssh config').toBe(false)
    expect(existsSync(knownHosts()), 'a failed setup left an empty known_hosts behind').toBe(false)
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

describe.skipIf(!canSymlink)('rolling back the ssh config restores what was there, link and all', () => {
  // The finding. The undo path decided whether ~/.ssh/config had existed from
  // its CONTENTS: an empty read meant "we created this file", so the rollback
  // deleted it. An EMPTY config is not a missing one -- a dotfiles-managed
  // ~/.ssh/config symlinked at a target that has not been populated yet reads
  // exactly the same -- and deleting it severs the link the forward write went
  // to the trouble of FOLLOWING, losing the user's dotfiles wiring on the one
  // path that only runs when something else has already gone wrong.
  const dotfiles = () => join(home, 'dotfiles', 'ssh_config')

  /** ~/.ssh/config as a symlink into a dotfiles repo, target empty. */
  const anEmptySymlinkedConfig = () => {
    mkdirSync(join(home, 'dotfiles'), { recursive: true })
    writeFileSync(dotfiles(), '')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    symlinkSync(dotfiles(), sshConfig())
  }

  /** A setup that gets all the way to the certificate and fails there, so the
   *  config block has been installed and its undo is the thing under test. */
  const failsAtTheCertificate = () => deps({
    mint: async () => ({
      certificate: NEW_CERT, host: HOST, username: 'u-svc-1',
      expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA_NEW,
      staged: { commit: () => { throw new Error('rename failed') }, discard: () => {} },
    }),
  })

  it('keeps an empty symlinked config, and puts its target back empty', async () => {
    anEmptySymlinkedConfig()
    await expect(computeSSH('api', { setup: true }, failsAtTheCertificate())).rejects.toThrow(/rename failed/)

    expect(lstatSync(sshConfig()).isSymbolicLink(), 'the rollback deleted the user’s symlink').toBe(true)
    expect(realpathSync(sshConfig()), 'the link was repointed somewhere else').toBe(realpathSync(dotfiles()))
    expect(readFileSync(dotfiles(), 'utf8'), 'the rollback left our block in the dotfiles copy').toBe('')
  })

  it('keeps an empty regular config rather than deleting it', async () => {
    // The same confusion without any symlink: the file existed, so the rollback
    // owes it back, empty.
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(sshConfig(), '')

    await expect(computeSSH('api', { setup: true }, failsAtTheCertificate())).rejects.toThrow(/rename failed/)

    expect(existsSync(sshConfig()), 'the rollback deleted a config file that was already there').toBe(true)
    expect(readFileSync(sshConfig(), 'utf8')).toBe('')
  })

  it('still deletes a config it created itself', async () => {
    // The positive control: without it, the two cases above are satisfied by a
    // rollback that never cleans up, which would leave a half-written
    // ~/.ssh/config behind on every failed first-ever setup.
    await expect(computeSSH('api', { setup: true }, failsAtTheCertificate())).rejects.toThrow(/rename failed/)

    expect(existsSync(sshConfig()), 'a failed setup left the config file it created').toBe(false)
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

describe('a plain issuance keeps an ALREADY INSTALLED alias coherent', () => {
  // The finding. Every `insta compute ssh` commits the new certificate and
  // rewrites aliases.json, but the ssh_config stanza and the known_hosts anchor
  // were only touched under `--setup`. So a plain issuance that came back with
  // a moved host, a renamed principal or a rotated CA updated half the files
  // backing a WORKING `ssh api.insta` and left the other half saying what it
  // said yesterday: the alias kept routing to the old host, carrying a
  // certificate issued for the new one, and the command printed success.
  const MOVED_HOST = 'ssh.eu-central-1.compute.example'
  const CA_ROT = caKey(0xc3)

  /** The alias as a real `--setup` leaves it: store, anchor, certificate and a
   *  config stanza, all agreeing on HOST / u-svc-1 / CA_NEW. */
  const anInstalledAlias = () => computeSSH('api', { setup: true }, deps())

  /** The service comes back somewhere else, as someone else, under a new CA. */
  const moved = (over: Record<string, unknown> = {}) => deps({
    mint: (async (_a: unknown, _p: string, _s: string, _k: string, alias: string) => ({
      certificate: OLD_CERT, host: MOVED_HOST, username: 'u-moved',
      expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA_ROT,
      staged: stageCertificate(instaCertPath(alias), OLD_CERT + '\n', { verify: () => {} }),
    })) as never,
    ...over,
  })

  it('moves the config stanza with the certificate', async () => {
    await anInstalledAlias()
    await computeSSH('api', {}, moved())

    const config = readFileSync(sshConfig(), 'utf8')
    expect(config, 'the alias kept routing to the host the service left')
      .not.toContain(`HostName ${HOST}`)
    expect(config).toContain(`HostName ${MOVED_HOST}`)
    expect(config, 'the alias kept logging in as a principal the certificate no longer names')
      .toContain('User u-moved')
    expect(readAliasStore()[ALIAS]).toMatchObject({ host: MOVED_HOST, username: 'u-moved' })
    expect(readFileSync(instaCertPath(ALIAS), 'utf8')).toBe(OLD_CERT + '\n')
  })

  it('installs the anchor for the CA that signed what it just committed', async () => {
    await anInstalledAlias()
    await computeSSH('api', {}, moved())
    expect(readFileSync(knownHosts(), 'utf8'),
      'the committed certificate is signed by a CA this machine does not trust')
      .toContain(caRecord(CA_ROT))
  })

  it('tells the user the alias works, because it does', async () => {
    await anInstalledAlias()
    const lines: string[] = []
    await computeSSH('api', {}, moved({ emit: (l: string) => lines.push(l) }))
    // Not the long `ssh -i … -o CertificateFile=…` form: that advice is for an
    // alias that was never installed, and repeating it for one that IS installed
    // reads as a feature that never got set up.
    expect(lines[0]).toContain(`ssh ${ALIAS}`)
    expect(lines[0]).toContain(`u-moved@${MOVED_HOST}`)
  })

  it('still installs NOTHING when no alias was ever set up', async () => {
    // The negative control, and the reason the check reads the LIVE config
    // rather than assuming. Without it every case above is satisfied by
    // installing the block unconditionally -- which turns a plain issuance into
    // a `--setup` nobody asked for.
    const lines: string[] = []
    await computeSSH('api', {}, moved({ emit: (l: string) => lines.push(l) }))
    expect(existsSync(sshConfig()), 'a plain issuance created an ssh config').toBe(false)
    expect(existsSync(knownHosts()), 'a plain issuance wrote a trust anchor').toBe(false)
    expect(lines[0], 'an uninstalled alias was offered as the destination').toContain('-o CertificateFile=')
  })

  it('leaves the installed alias untouched when the re-issue fails', async () => {
    await anInstalledAlias()
    const before = readFileSync(sshConfig(), 'utf8')
    await expect(computeSSH('api', {}, moved({
      mint: (async () => ({
        certificate: OLD_CERT, host: MOVED_HOST, username: 'u-moved',
        expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA_ROT,
        staged: { commit: () => { throw new Error('rename failed') }, discard: () => {} },
      })) as never,
    }))).rejects.toThrow(/rename failed/)

    expect(readFileSync(sshConfig(), 'utf8'),
      'a failed plain issuance left the stanza describing a move that never happened').toBe(before)
    expect(readFileSync(knownHosts(), 'utf8'),
      'the CA vouching for the installed certificate was left retired').toContain(caRecord(CA_NEW))
    expect(readAliasStore()[ALIAS]).toMatchObject({ host: HOST, username: 'u-svc-1' })
  })
})

describe('a failed setup puts the alias store back BYTE FOR BYTE', () => {
  // The undo used to write readAliasStore()'s output back, and the reader
  // drops entries it cannot use -- so the failure path deleted a hand-edited
  // entry the user was about to fix, and turned a store that never existed
  // into `{}`, while the command reported it had changed nothing.
  const failing = () => deps({ installConfig: () => { throw new Error('disk full') } })

  it('keeps an entry the reader would have dropped, and the formatting', async () => {
    const raw = '{\n  "api.insta": {"projectId": "proj-1", "serviceId": "svc-1", "host": "' + HOST + '", "username": "u-svc-1"},\n  "broken.insta": {"projectId": ""}\n}\n'
    writeFileSync(instaAliasStorePath(), raw)
    await expect(computeSSH('api', { setup: true }, failing())).rejects.toThrow(/disk full/)
    expect(readFileSync(instaAliasStorePath(), 'utf8'),
      "the undo rewrote the store from the reader's output").toBe(raw)
  })

  it('leaves no store behind when there was none', async () => {
    await expect(computeSSH('api', { setup: true }, failing())).rejects.toThrow(/disk full/)
    expect(existsSync(instaAliasStorePath()), 'a failed setup created the store it then emptied').toBe(false)
  })
})

describe('a config that is not UTF-8 is refused, not rewritten', () => {
  // Decoding as UTF-8 and writing back turns every byte that did not decode
  // into U+FFFD -- a Latin-1 comment in an old ~/.ssh/config, rewritten by a
  // command that promised to add one block at the top.
  it('refuses, and leaves every byte as it was', async () => {
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const raw = Buffer.concat([Buffer.from('# J'), Buffer.from([0xfc]), Buffer.from('rgen\nHost bastion\n  User someone\n')])
    writeFileSync(sshConfig(), raw)
    await expect(computeSSH('api', { setup: true }, deps())).rejects.toThrow(/not valid UTF-8/)
    expect(readFileSync(sshConfig()).equals(raw), 'the config was rewritten').toBe(true)
    expect(existsSync(instaAliasStorePath()), 'the refused setup recorded its alias').toBe(false)
    expect(existsSync(instaCertPath(ALIAS)), 'the refused setup committed its certificate').toBe(false)
  })

  it('still edits an ordinary UTF-8 config, accents included', async () => {
    // The positive control: a guard that refuses everything non-ASCII would
    // satisfy the case above and lock out every home directory with an accent.
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(sshConfig(), '# Jürgen\nHost bastion\n')
    await computeSSH('api', { setup: true }, deps())
    const cfg = readFileSync(sshConfig(), 'utf8')
    expect(cfg).toContain('# Jürgen')
    expect(cfg).toContain(`Host ${ALIAS}`)
  })
})

// Two `insta compute ssh` runs for DIFFERENT services -- a project with an
// `api` and a `worker` is the ordinary case, not a contrived one -- both read
// the same aliases.json, each adds only its own entry, and each writes both
// the store and the ssh_config block rendered from it. Whichever finished
// second wins outright: the other alias is gone from both files, and BOTH
// commands printed the alias they had configured.
//
// This cannot be observed from one process: the read-modify-write is
// synchronous, so an in-process "concurrent" call serialises itself. Only real
// processes interleave, so the test spawns them.
//
// The children are TypeScript, so they need a loader. tsx is a devDependency
// of this repo, so failing to load it is a BROKEN environment rather than a
// legitimate one the way a missing ssh-keygen is -- and a broken environment
// FAILS this suite rather than skipping it, for the reason the preamble gives
// about OpenSSH: a regression guarded only by a suite that silently skipped is
// not guarded at all. Probed once so the failure names the cause.
const tsxUnavailable = (() => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '-e', ''], { stdio: 'pipe' })
    return undefined
  } catch (e) {
    return e as Error
  }
})()

describe('separate issuances running at once keep every alias', () => {
  beforeAll(() => {
    if (tsxUnavailable) {
      throw new Error(`this suite needs \`node --import tsx\` (Node >= 18.19 with the tsx devDependency installed): ${tsxUnavailable.message}`)
    }
  })

  // FORCED to interleave, not hoped to. Co-starting four processes leaves the
  // read-modify-write wherever the scheduler puts it, and four children each
  // doing a few synchronous file operations can serialise themselves by
  // accident -- the first draft of this test passed with the lock removed.
  //
  // The `configInstalled` seam sits between the store READ and the store WRITE
  // inside the locked section, and it is consulted only WITHOUT --setup. So
  // these are plain issuances over an installed block: the identical section a
  // setup runs, entered through the one door with a seam in it. Every child
  // holds there for half a second. Without the lock all four read an empty
  // store before any of them writes, and three aliases are lost every time;
  // with it they queue, and each read sees the writes before it.
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
  keyPair: () => 'ssh-ed25519 AAAA test@insta',
  mint: async (_a, _p, serviceId, _k, alias) => ({
    certificate: CERT, host: 'ssh.us-west-1.compute.example', username: 'u-' + serviceId,
    expiresAt: '2026-09-14T22:00:00Z', caPublicKey: CA,
    staged: stageCertificate(instaCertPath(alias), CERT + '\\n', { verify: () => {} }),
  }),
  // Between the read and the write of the store. Synchronous, because it
  // stands in for a step of a synchronous transaction: yielding to the event
  // loop here would make this process's hold on the world looser than the
  // real one.
  configInstalled: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); return true },
  emit: () => {},
}
writeFileSync(join(dir, 'ready-' + name), 'x')
while (!existsSync(join(dir, 'go'))) await new Promise((r) => setTimeout(r, 5))
await computeSSH(name, {}, deps)
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
  const waitFor = async (paths: string[]) => {
    const deadline = Date.now() + 20_000
    while (!paths.every((p) => existsSync(p))) {
      if (Date.now() > deadline) throw new Error(`children never became ready: ${paths.filter((p) => !existsSync(p)).join(', ')}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('records every one of them, in the store and in the config', async () => {
    // `.mts`, because the script is written into a directory with no
    // package.json: a plain `.ts` there is transformed as CommonJS, and the
    // dynamic import above is top-level await.
    const script = join(home, 'setup-child.mts')
    writeFileSync(script, CHILD)
    const certFile = join(home, 'cert.txt'); writeFileSync(certFile, NEW_CERT)
    const caFile = join(home, 'ca.txt'); writeFileSync(caFile, CA_NEW)
    const compute = new URL('../src/commands/compute.ts', import.meta.url).href

    const names = ['api', 'worker', 'web', 'cron']
    // Released together by a file the parent writes once every child has
    // finished importing: a timer barrier lets a slow import start one child
    // after the others have already written, and a late reader sees their
    // entries even without the lock.
    const results = names.map((name) => run(['--import', 'tsx', script, compute, home, name, certFile, caFile]))
    await waitFor(names.map((n) => join(home, `ready-${n}`)))
    writeFileSync(join(home, 'go'), 'x')
    for (const r of await Promise.all(results)) expect(r.code, `a setup process failed: ${r.err}`).toBe(0)

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
