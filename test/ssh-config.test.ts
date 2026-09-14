import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  renderConfigBlock, renderEnsureCertMatch, upsertConfigBlock, upsertCertAuthority,
  planCertAuthority, revertCertAuthority, certifiesPublicKey, parseCAPublicKey, hasOwnedBlock,
  aliasFor, isSafeAlias, isSafeConfigValue, quoteConfigPath, BLOCK_BEGIN, BLOCK_END, CA_MARKER,
} from '../src/commands/ssh-config.js'

const entry = (alias = 'api.insta', hostName = 'ssh.us-west-1.compute.example', user = 'svc-abc') => ({
  alias, hostName, user, certificateFile: `/home/dev/.insta/ssh/${alias}-cert.pub`,
})

const KNOWN_HOSTS = '/home/dev/.ssh/known_hosts'

const block = (entries = [entry()]) => renderConfigBlock({
  entries,
  identityFile: '/home/dev/.insta/ssh/id_ed25519',
  knownHostsFile: KNOWN_HOSTS,
  ensureCertCommand: 'insta compute ssh --ensure-cert',
})

describe('ssh_config block', () => {
  // THE test for this file. OpenSSH takes the FIRST obtained value for each
  // keyword, and ssh_config(5) says host-specific declarations belong near the
  // beginning. A block appended at the end loses every keyword to an earlier
  // `Host *` -- silently, with no error, producing a connection that ignores
  // the IdentityFile we just wrote.
  it('goes at the TOP of an existing config, not the end', () => {
    const existing = 'Host *\n  IdentityFile ~/.ssh/id_rsa\n  User root\n'
    const out = upsertConfigBlock(existing, block())
    expect(out.indexOf(BLOCK_BEGIN), 'our block is not first; an earlier Host * would win every keyword').toBe(0)
    expect(out.indexOf(BLOCK_BEGIN)).toBeLessThan(out.indexOf('Host *'))
    // And the user's own config survives intact.
    expect(out).toContain('  IdentityFile ~/.ssh/id_rsa')
    expect(out).toContain('  User root')
  })

  it('replaces its own block rather than stacking copies', () => {
    const once = upsertConfigBlock('Host *\n  User root\n', block())
    const twice = upsertConfigBlock(once, block())
    expect(twice.split(BLOCK_BEGIN).length - 1, 'running setup twice duplicated the block').toBe(1)
    expect(twice.split(BLOCK_END).length - 1).toBe(1)
    expect(twice).toContain('  User root')
    // Repeated runs must not grow the file with blank lines either.
    expect(twice).toBe(once)
  })

  // Without these two keywords the alias is not routing at all: `ssh api.insta`
  // resolves api.insta in DNS and logs in as the local OS username.
  it('routes each alias to its own host and remote user', () => {
    const b = block()
    expect(b).toContain('Host api.insta')
    expect(b).toContain('  HostName ssh.us-west-1.compute.example')
    expect(b).toContain('  User svc-abc')
  })

  // A certificate is issued for ONE service. A single shared cert file would
  // make the second service's setup silently overwrite the first one's.
  it('points each alias at its own certificate', () => {
    const b = block([entry('api.insta'), entry('worker.insta', 'ssh.eu-west-1.compute.example', 'svc-def')])
    expect(b).toContain('  CertificateFile "/home/dev/.insta/ssh/api.insta-cert.pub"')
    expect(b).toContain('  CertificateFile "/home/dev/.insta/ssh/worker.insta-cert.pub"')
  })

  it('renders one stanza per service so a second --setup keeps the first', () => {
    const b = block([entry('api.insta'), entry('worker.insta', 'ssh.eu-west-1.compute.example', 'svc-def')])
    expect(b).toContain('Host api.insta')
    expect(b).toContain('Host worker.insta')
    expect(b).toContain('  HostName ssh.eu-west-1.compute.example')
    expect(b).toContain('  User svc-def')
  })

  it('carries IdentitiesOnly, without which a full ssh-agent breaks auth at random', () => {
    // SSH offers public keys ONE AT A TIME, so a user with several keys is
    // identified non-deterministically -- exe.dev's heisen-connect. Without
    // this line the server may never see the key carrying our certificate.
    const b = block()
    expect(b).toContain('IdentitiesOnly yes')
    expect(b).toContain('IdentityFile "/home/dev/.insta/ssh/id_ed25519"')
  })

  // Our block goes at the TOP and first-wins protects every keyword we WRITE.
  // It says nothing about a keyword we leave UNSET: OpenSSH goes on filling
  // those from later matching blocks, so a `Host *` carrying
  // `UserKnownHostsFile none` -- or a custom path, or a per-project file --
  // decides where our alias looks for host keys. The CA that `--setup` installed
  // in ~/.ssh/known_hosts is then never consulted, and the alias meets a
  // host-key prompt or an outright refusal that points nowhere near the cause.
  it('pins the known_hosts file the trust anchor was installed in', () => {
    expect(block()).toContain(`  UserKnownHostsFile "${KNOWN_HOSTS}"`)
  })

  // A keyword binds only inside the stanza it appears in, so one pin at the top
  // of the block leaves every other alias exposed to the same later `Host *`.
  it('pins it in every stanza, not just the first', () => {
    const b = block([entry('api.insta'), entry('worker.insta', 'ssh.eu-west-1.compute.example', 'svc-def')])
    expect(b.split('UserKnownHostsFile').length - 1, 'a stanza was left without a pin').toBe(2)
  })

  // Through quoteConfigPath like every other path we write: this one is a home
  // directory too, so a space in it would split the directive and OpenSSH would
  // reject the WHOLE file -- taking the user's unrelated hosts down with it.
  it('quotes the known_hosts path, and refuses one it cannot write literally', () => {
    expect(renderConfigBlock({
      entries: [entry()], identityFile: '/Users/Jun Wen/.insta/ssh/id_ed25519',
      knownHostsFile: '/Users/Jun Wen/.ssh/known_hosts',
    })).toContain('UserKnownHostsFile "/Users/Jun Wen/.ssh/known_hosts"')
    expect(() => renderConfigBlock({
      entries: [entry()], identityFile: '/k', knownHostsFile: '/home/${HOME}/.ssh/known_hosts',
    })).toThrow()
  })

  it('renews the certificate while OpenSSH parses the config', () => {
    // Without this, "after setup it is just ssh" stops being true the moment
    // the first certificate expires -- which, with a TTL measured in hours, is
    // the same day.
    expect(block()).toContain('Match originalhost api.insta exec "insta compute ssh --ensure-cert api.insta"')
  })

  // `Match host` is evaluated AFTER HostName substitution, so it would compare
  // ssh.us-west-1.compute.example against api.insta and never fire -- meaning
  // no renewal ever happens, which is invisible until the first expiry.
  it('matches on originalhost, not the substituted hostname', () => {
    expect(block()).not.toContain('Match host ')
    expect(block()).toContain('Match originalhost ')
  })

  // The hook string is handed to the user's SHELL. OpenSSH expands its tokens
  // FIRST, so `%h` would put an attacker-influenced hostname into a shell
  // command -- ssh_config(5) warns that expansions used by shell-backed
  // directives must be safely handled.
  it('never puts a %-token inside the shell-backed hook', () => {
    const hook = block().split('\n').find((l) => l.startsWith('Match '))!
    expect(hook, 'the renewal hook interpolates an OpenSSH token into a shell command').not.toContain('%')
  })

  it('refuses to write an alias that is not plainly shell-safe', () => {
    for (const bad of ['a;rm -rf ~.insta', '$(id).insta', 'a b.insta', '../../evil.insta', 'api.insta$(id)', 'API.insta']) {
      expect(isSafeAlias(bad), `${bad} passed alias validation`).toBe(false)
      expect(() => renderEnsureCertMatch(bad, 'insta compute ssh --ensure-cert')).toThrow()
      expect(() => renderConfigBlock({ entries: [entry(bad)], identityFile: '/k', knownHostsFile: KNOWN_HOSTS })).toThrow()
    }
  })

  it('builds an alias from a service name, or refuses', () => {
    expect(aliasFor('api')).toBe('api.insta')
    expect(aliasFor('my-worker-2')).toBe('my-worker-2.insta')
    expect(() => aliasFor('Bad Name')).toThrow()
    expect(() => aliasFor('a;id')).toThrow()
  })

  // We insert ABOVE the user's config. `Host`/`Match` blocks run to the next
  // one, so without a closing `Match all` the user's unconditional keywords
  // become conditional on our last stanza -- a setting they wrote for every
  // host would silently apply to one alias.
  it('closes its last stanza so the rest of the file stays unconditional', () => {
    expect(block().trimEnd().split('\n').at(-2)).toBe('Match all')
  })

  it('writes a bare block into an empty config without a leading blank line', () => {
    expect(upsertConfigBlock('', block())).toBe(block())
  })

  it('leaves a hand-edited half-block alone and puts a fresh one on top', () => {
    // A begin marker with no end means someone edited this by hand. Guessing
    // where our block stopped could delete their lines; first-wins means the
    // new block takes effect regardless.
    const mangled = `${BLOCK_BEGIN}\nHost old\n  User someone\n`
    const out = upsertConfigBlock(mangled, block())
    expect(out.indexOf(BLOCK_BEGIN)).toBe(0)
    expect(out).toContain('  User someone')
  })
})

// String placement is not the thing that matters -- what matters is what
// OpenSSH itself resolves `ssh api.insta` to. `ssh -G` prints exactly that, and
// it is the only check that catches a stanza that parses but does not route.
const ssh = (() => {
  try {
    execFileSync('ssh', ['-V'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

// Skipped on Windows: `Match exec` runs the command under the platform's own
// shell, and ssh.exe additionally applies ACL checks to a `-F` config, so a
// failure there would be about the harness rather than about our stanza.
describe.skipIf(!ssh || process.platform === 'win32')('effective configuration (ssh -G)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insta-sshg-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const effective = (alias: string, body: string): Map<string, string> => {
    const cfg = join(dir, 'config')
    writeFileSync(cfg, body, { mode: 0o600 })
    const out = execFileSync('ssh', ['-G', '-F', cfg, alias], { encoding: 'utf8' })
    const map = new Map<string, string>()
    for (const line of out.split('\n')) {
      const i = line.indexOf(' ')
      if (i > 0 && !map.has(line.slice(0, i))) map.set(line.slice(0, i), line.slice(i + 1).trim())
    }
    return map
  }

  /** Everything below renders through this, so the known_hosts pin is part of
   *  every effective-config case rather than only its own. */
  const rendered = (over: Record<string, unknown> = {}) => renderConfigBlock({
    entries: [entry()], identityFile: join(dir, 'id_ed25519'), knownHostsFile: join(dir, 'known_hosts'),
    ...over,
  } as never)

  it('resolves the alias to the service host and remote user', () => {
    // No hook here: `ssh -G` evaluates Match exec, and this assertion is about
    // routing. The hook gets its own test below.
    const body = rendered()
    const g = effective('api.insta', body)
    expect(g.get('hostname'), '`ssh api.insta` would resolve api.insta in DNS').toBe('ssh.us-west-1.compute.example')
    expect(g.get('user'), '`ssh api.insta` would log in as the local OS username').toBe('svc-abc')
    expect(g.get('identitiesonly')).toBe('yes')
    expect(g.get('certificatefile')).toContain('api.insta-cert.pub')
  })

  it('keeps two services routed to their own hosts', () => {
    const body = rendered({
      entries: [entry('api.insta'), entry('worker.insta', 'ssh.eu-west-1.compute.example', 'svc-def')],
    })
    expect(effective('api.insta', body).get('hostname')).toBe('ssh.us-west-1.compute.example')
    expect(effective('worker.insta', body).get('hostname')).toBe('ssh.eu-west-1.compute.example')
    expect(effective('worker.insta', body).get('user')).toBe('svc-def')
  })

  it("does not capture the user's own global settings", () => {
    const body = upsertConfigBlock('ServerAliveInterval 77\n', rendered())
    const g = effective('some.unrelated.host', body)
    expect(g.get('serveraliveinterval'), "our block swallowed the user's global keywords").toBe('77')
    expect(g.get('hostname')).toBe('some.unrelated.host')
  })

  // The finding, and `ssh -G` is the only thing that can settle it. Being first
  // in the file protects the keywords we WRITE; it does nothing for one we
  // leave unset, which OpenSSH goes on filling from later matching blocks. A
  // `Host *` redirecting UserKnownHostsFile is ordinary -- `none` in a hardened
  // config, a per-project file in a shared one -- and either way the CA that
  // `--setup` installed in ~/.ssh/known_hosts stops being consulted for our
  // alias. What the user then sees is a host-key prompt or a refusal, on a
  // connection they were told needs no host-key management at all.
  const LATER_OVERRIDE = 'Host *\n  UserKnownHostsFile none\n'

  it('keeps our known_hosts against a later UserKnownHostsFile', () => {
    const g = effective('api.insta', upsertConfigBlock(LATER_OVERRIDE, rendered()))
    expect(g.get('userknownhostsfile'), 'the CA installed by --setup is never consulted')
      .toBe(join(dir, 'known_hosts'))
  })

  it('is the pin that saves it, not our position in the file', () => {
    // The negative control, and it is not idle: our block is ALREADY first, so
    // a reader can reasonably assume first-wins covers this too. It does not,
    // and this is what says so -- strip the pin and the later block takes over.
    const unpinned = rendered().split('\n').filter((l) => !l.includes('UserKnownHostsFile')).join('\n')
    expect(unpinned, 'the renderer emitted no pin, so this control proves nothing').not.toBe(rendered())
    expect(effective('api.insta', upsertConfigBlock(LATER_OVERRIDE, unpinned)).get('userknownhostsfile'))
      .toBe('none')
  })

  it("leaves the user's own hosts under the setting they chose", () => {
    // The pin is scoped to OUR stanzas. Someone who redirected known_hosts for
    // everything else keeps that for everything else.
    expect(effective('some.unrelated.host', upsertConfigBlock(LATER_OVERRIDE, rendered())).get('userknownhostsfile'))
      .toBe('none')
  })

  it('survives a home directory with a space in the known_hosts path', () => {
    // Unquoted this is two arguments, and OpenSSH rejects the whole FILE for it
    // -- so the pin would break every host the user has rather than just ours.
    const spaced = `${SPACED}/known_hosts`
    expect(effective('api.insta', rendered({ knownHostsFile: spaced })).get('userknownhostsfile')).toBe(spaced)
  })

  it('fires the renewal hook with the alias, and only for that alias', () => {
    // Proves the hook both runs and receives the service it belongs to --
    // which the discarded-%h version could not, since Match host never fired.
    const log = join(dir, 'hook.log')
    // A script rather than an inline `sh -c`: ssh_config groups the exec
    // argument with double quotes, so a nested quote would end it early.
    const hook = join(dir, 'hook.sh')
    writeFileSync(hook, `#!/bin/sh\necho "$1" >> ${log}\n`, { mode: 0o755 })
    const body = rendered({
      entries: [entry('api.insta'), entry('worker.insta', 'ssh.eu-west-1.compute.example', 'svc-def')],
      ensureCertCommand: hook,
    })
    effective('api.insta', body)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['api.insta'])
  })

  // Whether the path QUOTING is right is not a question a string assertion can
  // settle -- only OpenSSH's own parser can, and what it does with an unquoted
  // spaced path is reject the entire FILE rather than the one directive.
  const SPACED = '/Users/Jun Wen/.insta/ssh'

  const spacedBlock = () => rendered({
    entries: [{
      alias: 'api.insta',
      hostName: 'ssh.us-west-1.compute.example',
      user: 'svc-abc',
      certificateFile: `${SPACED}/api.insta-cert.pub`,
    }],
    identityFile: `${SPACED}/id_ed25519`,
  })

  it('keeps a home directory containing a space in one piece', () => {
    // The paths need not exist: `ssh -G` reports the configured value, which is
    // the thing at issue -- unquoted, ssh sees `/Users/Jun` and a stray argument.
    const g = effective('api.insta', spacedBlock())
    expect(g.get('identityfile'), 'the spaced IdentityFile arrived truncated').toBe(`${SPACED}/id_ed25519`)
    expect(g.get('certificatefile')).toBe(`${SPACED}/api.insta-cert.pub`)
    expect(g.get('hostname')).toBe('ssh.us-west-1.compute.example')
  })

  it("does not take the user's unrelated connections down with it", () => {
    // Why this is critical rather than cosmetic: the block is inserted into
    // ~/.ssh/config, and a file OpenSSH refuses is refused for EVERY host --
    // so a bad path of ours breaks the user's github.com too.
    const body = upsertConfigBlock('Host *\n  ServerAliveInterval 77\n', spacedBlock())
    const g = effective('some.unrelated.host', body)
    expect(g.get('serveraliveinterval'), 'a spaced path in OUR block broke the whole config').toBe('77')
    expect(g.get('hostname')).toBe('some.unrelated.host')
  })

  it('is the quoting that saves it, not luck', () => {
    // The negative control. Without it the two tests above would also pass for
    // a renderer that quotes nothing, since nothing else here has a space.
    //
    // Asserted on the PARSED VALUE, not on ssh's exit code. Whether OpenSSH
    // refuses the file or logs-and-continues on an unquoted spaced argument
    // differs by version, so an exit-code assertion fails on a perfectly good
    // build for a reason that has nothing to do with our writer. What is true
    // of every version is that the value it ends up with is NOT the path we
    // meant -- which is the thing the quoting exists to guarantee.
    let parsed: string | undefined
    try {
      parsed = effective('api.insta', spacedBlock().replace(/"/g, '')).get('identityfile')
    } catch {
      // Refused outright: also a pass, and the stricter of the two behaviours.
      parsed = undefined
    }
    expect(parsed, 'an unquoted spaced path still resolved correctly, so these tests prove nothing')
      .not.toBe(`${SPACED}/id_ed25519`)
  })

  it('parses the Windows form of a spaced home directory', () => {
    // Windows CI cannot run this describe (Match exec wants a POSIX shell, and
    // ssh.exe ACL-checks a `-F` config), so the shape quoteConfigPath produces
    // for `C:\Users\Jun Wen\...` is put in front of a real parser here instead.
    // The forward slashes are what makes it parseable at all: OpenSSH reads a
    // backslash as an escape introducer, so `\U` would be eaten.
    const g = effective('api.insta', rendered({
      entries: [{
        alias: 'api.insta', hostName: 'ssh.us-west-1.compute.example', user: 'svc-abc',
        certificateFile: 'C:\\Users\\Jun Wen\\.insta\\ssh\\api.insta-cert.pub',
      }],
      identityFile: 'C:\\Users\\Jun Wen\\.insta\\ssh\\id_ed25519',
      knownHostsFile: 'C:\\Users\\Jun Wen\\.ssh\\known_hosts',
      platform: 'win32',
    }))
    expect(g.get('identityfile')).toBe('C:/Users/Jun Wen/.insta/ssh/id_ed25519')
    expect(g.get('certificatefile')).toBe('C:/Users/Jun Wen/.insta/ssh/api.insta-cert.pub')
    expect(g.get('userknownhostsfile')).toBe('C:/Users/Jun Wen/.ssh/known_hosts')
  })

  // `ssh -G` is NOT the parser to ask about these two keywords: it dumps
  // IdentityFile and CertificateFile verbatim and does the percent/dollar
  // expansion later, on the connect path. So the only way to see the filename
  // ssh will really open is to let it start connecting and read the path back
  // out of `-v`. ProxyCommand keeps that attempt entirely local -- nothing is
  // resolved and no packet leaves the machine.
  const identityFilesSSHWouldOpen = (alias: string, body: string): string[] => {
    const cfg = join(dir, 'config')
    writeFileSync(cfg, body, { mode: 0o600 })
    let log: string
    try {
      log = execFileSync('ssh', ['-v', '-o', 'BatchMode=yes', '-o', 'ProxyCommand=/bin/false', '-F', cfg, alias],
        { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      // ProxyCommand always fails, which is the point: ssh has already logged
      // the identity paths by then. An expansion error kills it EARLIER, so an
      // empty list is a real result rather than a harness failure.
      log = String((e as { stderr?: string | Buffer }).stderr ?? '')
    }
    return [...log.matchAll(/^debug1: identity file (.*) type /gm)].map((m) => m[1]!)
  }

  // A home directory with a `%` in it is ordinary, and OpenSSH does not read one
  // literally: it percent-expands IdentityFile and CertificateFile, so `%te` is
  // an unknown token and ssh ABORTS before it opens the key. The alias does not
  // fail to authenticate, it fails to run.
  const PERCENT = '/Users/dev%team/.insta/ssh'

  const percentBlock = () => rendered({
    entries: [{
      alias: 'api.insta',
      hostName: 'ssh.us-west-1.compute.example',
      user: 'svc-abc',
      certificateFile: `${PERCENT}/api.insta-cert.pub`,
    }],
    identityFile: `${PERCENT}/id_ed25519`,
  })

  it('hands ssh the literal path when the home directory contains a %', () => {
    expect(identityFilesSSHWouldOpen('api.insta', percentBlock()))
      .toContain(`${PERCENT}/id_ed25519`)
    // CertificateFile goes through the same expansion but is only opened once
    // the key itself exists, so it is checked where `ssh -G` does show it:
    // through the quotes, still carrying the escape that keeps it literal.
    expect(effective('api.insta', percentBlock()).get('certificatefile'))
      .toBe('/Users/dev%%team/.insta/ssh/api.insta-cert.pub')
  })

  it('is the %-escaping that saves it, not luck', () => {
    // The negative control: with a single `%` the token is unknown, ssh gives up
    // on the whole connection, and no identity path is ever reached.
    const unescaped = percentBlock().replace(/%%/g, '%')
    expect(unescaped, 'the renderer emitted no escaping, so this control proves nothing').not.toBe(percentBlock())
    expect(identityFilesSSHWouldOpen('api.insta', unescaped))
      .not.toContain(`${PERCENT}/id_ed25519`)
  })

  it('does not let a % in the path reach the ControlPath tokens', () => {
    // ControlPath carries tokens we MEANT, and `ssh -G` does expand that one --
    // so it is the check that the escaping did not spill outside the two path
    // directives.
    const g = effective('api.insta', percentBlock())
    expect(g.get('controlpath')).toContain('cm-')
    expect(g.get('controlpath'), 'our own ControlPath tokens were escaped away').not.toContain('%')
  })

  it('refuses environment-variable syntax, because ssh_config has no escape for it', () => {
    // `${...}` is expanded on the same connect path, and there is no `$$`. A
    // defined variable silently rewrites the filename; an undefined one aborts.
    // Both are wrong for a literal path, so the renderer refuses instead.
    expect(() => quoteConfigPath('/Users/a${HOME}b/.insta/ssh/id_ed25519')).toThrow()
    const hand = 'Host api.insta\n  HostName ssh.us-west-1.compute.example\n  IdentityFile "/Users/a${HOME}b/id_ed25519"\n'
    expect(identityFilesSSHWouldOpen('api.insta', hand), 'ssh read ${...} literally after all')
      .not.toContain('/Users/a${HOME}b/id_ed25519')
  })
})

const USER_ANCHOR = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhI'
const RETIRED_CA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVF'
const ROTATED_CA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dH'

describe('known_hosts trust anchor', () => {
  const CA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIERERERERERERERERERERERERERERERERERERERERERE'

  it('adds the @cert-authority line, tagged as ours', () => {
    const out = upsertCertAuthority('', 'ssh.*.compute.example', CA)
    expect(out).toBe(`@cert-authority ssh.*.compute.example ${CA} ${CA_MARKER}\n`)
  })

  it('is idempotent on the KEY, so a WIDENED host pattern updates rather than duplicates', () => {
    // The pattern this CA is anchored under widened to cover the region label,
    // so the exact line it replaces says nothing the new one does not.
    const first = upsertCertAuthority('', 'ssh.us-west-1.compute.example', CA)
    const second = upsertCertAuthority(first, 'ssh.*.compute.example', CA)
    const lines = second.trim().split('\n').filter((l) => l.startsWith('@cert-authority'))
    expect(lines, 'a re-run left two anchors for one CA').toHaveLength(1)
    expect(lines[0]).toContain('ssh.*.compute.example')
  })

  // Rotation is the case the marker exists for: same host pattern, different
  // key. Filtering on the NEW key's text cannot find the retired one, so the
  // old CA would stay trusted for that pattern indefinitely.
  it('retires the previous CA when the platform rotates for the same host pattern', () => {
    const first = upsertCertAuthority('', 'ssh.*.compute.example', RETIRED_CA)
    const rotated = upsertCertAuthority(first, 'ssh.*.compute.example', ROTATED_CA)
    const lines = rotated.trim().split('\n').filter((l) => l.startsWith('@cert-authority'))
    expect(lines, 'the retired CA is still trusted for this host pattern').toHaveLength(1)
    expect(lines[0]).toContain(ROTATED_CA.split(' ')[1]!)
    expect(rotated).not.toContain(RETIRED_CA.split(' ')[1]!)
  })

  it("keeps the user's other known_hosts entries, including their own anchors", () => {
    const existing = [
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIENDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0ND',
      `@cert-authority ssh.*.compute.example ${USER_ANCHOR}`,
      '',
    ].join('\n')
    const out = upsertCertAuthority(existing, 'ssh.*.compute.example', CA)
    expect(out).toContain('github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIENDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0ND')
    // The user's OWN anchor -- no CA_MARKER, so rotation must never touch it.
    expect(out, 'we deleted an anchor the user added by hand').toContain(USER_ANCHOR)
    expect(out).toContain(`@cert-authority ssh.*.compute.example ${CA} ${CA_MARKER}`)
  })

  it('does not need a trailing newline in the existing file to stay well-formed', () => {
    const out = upsertCertAuthority('github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpK', 'ssh.*.compute.example', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJSUlJ')
    expect(out.split('\n').filter(Boolean)).toHaveLength(2)
  })
})

// A rotation is only half of a change: the certificate the NEW CA signed still
// has to be committed, and that can fail. Retiring the old anchor is the step
// that breaks an alias which worked a moment ago, so it has to be reversible.
describe('an anchor rotation can be taken back', () => {
  const PATTERN = 'ssh.*.compute.example'

  it('reports the anchor it retired, so the caller can put it back', () => {
    const first = upsertCertAuthority('', PATTERN, RETIRED_CA)
    const plan = planCertAuthority(first, PATTERN, ROTATED_CA)
    expect(plan.removed, 'the retired anchor was dropped without being reported').toHaveLength(1)
    expect(plan.removed[0]).toContain(RETIRED_CA.split(' ')[1]!)
    expect(plan.line).toBe(`@cert-authority ${PATTERN} ${ROTATED_CA} ${CA_MARKER}`)
  })

  it('puts the retired anchor back and removes the one it installed', () => {
    const first = upsertCertAuthority('', PATTERN, RETIRED_CA)
    const plan = planCertAuthority(first, PATTERN, ROTATED_CA)
    // The whole point: after the undo the file trusts what it trusted before,
    // so the certificate still installed for this alias still authenticates.
    expect(revertCertAuthority(plan.next, plan)).toBe(first)
  })

  it('reverts against the file as it stands, not against a snapshot', () => {
    // `ssh` appends host keys here without any lock and cannot be made to take
    // one, so restoring the bytes we read would discard whatever landed in
    // between -- turning a tidy-up into a second, larger loss.
    const first = upsertCertAuthority('', PATTERN, RETIRED_CA)
    const plan = planCertAuthority(first, PATTERN, ROTATED_CA)
    const meanwhile = plan.next + 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tL\n'
    const out = revertCertAuthority(meanwhile, plan)
    expect(out, "a host key ssh appended during the command was discarded").toContain('github.com ssh-ed25519')
    expect(out).toContain(RETIRED_CA.split(' ')[1]!)
    expect(out, 'the anchor the failed command installed is still trusted').not.toContain(ROTATED_CA.split(' ')[1]!)
  })

  it('leaves nothing behind when there was no file to begin with', () => {
    const plan = planCertAuthority('', PATTERN, ROTATED_CA)
    expect(plan.removed).toEqual([])
    expect(revertCertAuthority(plan.next, plan)).toBe('')
  })

  it("never puts back an anchor the user's own file no longer wants twice", () => {
    // A concurrent install may already have re-added the retired anchor; a
    // second copy is untidy rather than dangerous, but the undo should not
    // create one.
    const first = upsertCertAuthority('', PATTERN, RETIRED_CA)
    const plan = planCertAuthority(first, PATTERN, ROTATED_CA)
    const out = revertCertAuthority(plan.next + plan.removed[0] + '\n', plan)
    expect(out.split('\n').filter((l) => l.includes(RETIRED_CA.split(' ')[1]!))).toHaveLength(1)
  })

  it('keeps an interior blank line the user put there', () => {
    const existing = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpK\n\nother.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExM\n'
    const plan = planCertAuthority(existing, PATTERN, ROTATED_CA)
    expect(revertCertAuthority(plan.next, plan)).toBe(existing)
  })

  it("keeps the user's TRAILING blank lines too", () => {
    // A loop popping every empty tail line trimmed the user's own blank lines
    // off the end of the file, on the failure path, where nothing else was
    // being reported. Only the ONE blank the split leaves behind a final
    // newline is ours to drop.
    const theirs = 'github.com ssh-ed25519 AAAAuser\n\n\n'
    const plan = planCertAuthority(theirs, 'ssh.*.compute.example', ROTATED_CA)
    expect(plan.next.startsWith(theirs), 'the anchor was not appended after the user\'s blank lines').toBe(true)
    expect(revertCertAuthority(plan.next, plan), 'trailing blank lines were deleted by the revert').toBe(theirs)
  })
})

// `ssh-keygen -L` proves a response is a parseable certificate. It does not
// prove it is a certificate for OUR key -- and one issued for another key
// passes every other gate, replaces the live credential, and fails at
// authentication time with a message pointing at the file.
describe('a CA key is held to the shape of its OWN type, not just to being well-formed fields', () => {
  // Walking the fields proves the blob is a sequence of length-prefixed
  // fields. It does not prove they are the fields of the type on the label:
  // a correct RSA or ECDSA type name followed by any well-formed fields
  // installed an anchor ssh then refused at connect time, where the message
  // points at known_hosts rather than at the response that produced it. Only
  // ed25519 was held to its shape at first.
  const field = (b: Buffer | string) => {
    const body = typeof b === 'string' ? Buffer.from(b) : b
    const n = Buffer.alloc(4); n.writeUInt32BE(body.length, 0)
    return Buffer.concat([n, body])
  }
  const blob = (...fields: Array<Buffer | string>) => Buffer.concat(fields.map(field)).toString('base64')
  const point = (coord: number) => Buffer.concat([Buffer.from([0x04]), Buffer.alloc(coord * 2, 0x22)])
  const modulus = Buffer.concat([Buffer.from([0x00, 0x80]), Buffer.alloc(255, 0x33)])

  const wellFormed: Array<[string, string]> = [
    ['rsa', `ssh-rsa ${blob('ssh-rsa', Buffer.from([1, 0, 1]), modulus)}`],
    ['ecdsa p256', `ecdsa-sha2-nistp256 ${blob('ecdsa-sha2-nistp256', 'nistp256', point(32))}`],
    ['ecdsa p384', `ecdsa-sha2-nistp384 ${blob('ecdsa-sha2-nistp384', 'nistp384', point(48))}`],
    ['ecdsa p521', `ecdsa-sha2-nistp521 ${blob('ecdsa-sha2-nistp521', 'nistp521', point(66))}`],
    // The FIDO types carry the plain type's key material followed by the
    // application string -- every field is an SSH string, so the same walk
    // reads them (a reviewer thought the walk would refuse them; it does not).
    ['sk ed25519', `sk-ssh-ed25519@openssh.com ${blob('sk-ssh-ed25519@openssh.com', Buffer.alloc(32, 0x44), 'ssh:')}`],
    ['sk ecdsa', `sk-ecdsa-sha2-nistp256@openssh.com ${blob('sk-ecdsa-sha2-nistp256@openssh.com', 'nistp256', point(32), 'ssh:')}`],
  ]
  for (const [what, key] of wellFormed) {
    it(`accepts a ${what} key of the shape OpenSSH writes`, () => {
      // The positive control for every refusal below: a rule tight enough to
      // refuse them can refuse every real key too, and setup would then fail
      // against a platform that rotated to a type it has every right to use.
      expect(parseCAPublicKey(key).type).toBe(key.split(' ')[0])
    })
  }

  const malformed: Array<[string, string]> = [
    ['an RSA key with one field where e and n should be', `ssh-rsa ${blob('ssh-rsa', Buffer.alloc(40, 0x33))}`],
    ['an RSA key with a modulus below OpenSSH\'s 1024-bit floor', `ssh-rsa ${blob('ssh-rsa', Buffer.from([1, 0, 1]), Buffer.alloc(64, 0x33))}`],
    ['an RSA key with a fourth field', `ssh-rsa ${blob('ssh-rsa', Buffer.from([1, 0, 1]), modulus, 'extra')}`],
    ['an ECDSA key whose curve disagrees with its type', `ecdsa-sha2-nistp256 ${blob('ecdsa-sha2-nistp256', 'nistp384', point(32))}`],
    ['an ECDSA key whose point is the wrong size for its curve', `ecdsa-sha2-nistp256 ${blob('ecdsa-sha2-nistp256', 'nistp256', point(48))}`],
    ['an ECDSA key whose point is compressed', `ecdsa-sha2-nistp256 ${blob('ecdsa-sha2-nistp256', 'nistp256', Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 0x22)]))}`],
    ['an ECDSA key missing its point', `ecdsa-sha2-nistp256 ${blob('ecdsa-sha2-nistp256', 'nistp256')}`],
    ['a FIDO ed25519 key without its application', `sk-ssh-ed25519@openssh.com ${blob('sk-ssh-ed25519@openssh.com', Buffer.alloc(32, 0x44))}`],
    ['a FIDO ed25519 key with a 16-byte key', `sk-ssh-ed25519@openssh.com ${blob('sk-ssh-ed25519@openssh.com', Buffer.alloc(16, 0x44), 'ssh:')}`],
    ['a FIDO ECDSA key without its application', `sk-ecdsa-sha2-nistp256@openssh.com ${blob('sk-ecdsa-sha2-nistp256@openssh.com', 'nistp256', point(32))}`],
    ['an ed25519 key with an application field it does not have', `ssh-ed25519 ${blob('ssh-ed25519', Buffer.alloc(32, 0x44), 'ssh:')}`],
  ]
  for (const [what, key] of malformed) {
    it(`refuses ${what}`, () => {
      expect(() => parseCAPublicKey(key), `${what} was accepted`).toThrow(/shape of/)
    })
  }

  // The type is a string from an HTTP response looked up in a table. On a
  // plain object that lookup finds Object.prototype: `constructor` is a
  // function that returns its argument, `toString` one that returns a string,
  // and both read as "a shape this type has" -- so a key typed `constructor`
  // with a blob whose first field says the same was accepted and written.
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    it(`refuses a type named ${type} as unsupported, not as anything else`, () => {
      const key = `${type} ${blob(type, Buffer.alloc(32, 0x44))}`
      expect(() => parseCAPublicKey(key), `${type} was accepted`).toThrow(/unsupported type/)
    })
  }
})

describe('a certificate is matched to the key it was issued for', () => {
  const field = (b: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(b.length, 0); return Buffer.concat([n, b]) }
  const pub = (raw: Buffer) =>
    `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64')}`
  // `string type, string nonce, string pk, ...`. Everything after pk is a
  // uint64 serial and beyond, which is not an SSH `string` -- so only the first
  // three fields may be walked, and the tail here stands for the rest.
  const cert = (raw: Buffer, type = 'ssh-ed25519-cert-v01@openssh.com') =>
    `${type} ${Buffer.concat([
      field(Buffer.from(type)), field(Buffer.alloc(32, 0x5a)), field(raw), Buffer.alloc(96, 0x7f),
    ]).toString('base64')}`

  const ours = Buffer.alloc(32, 0x11)
  const theirs = Buffer.alloc(32, 0x22)

  it('accepts the certificate issued for the key we sent', () => {
    // The positive control: a check strict enough to refuse everything below
    // can refuse every real certificate too, and renewal would silently stop.
    expect(certifiesPublicKey(cert(ours), pub(ours))).toBe(true)
    expect(certifiesPublicKey(`${cert(ours)} comment`, `${pub(ours)} user@host`),
      'a trailing comment was rejected').toBe(true)
  })

  it('refuses a perfectly valid certificate for somebody ELSE\'s key', () => {
    // The finding. Nothing else in the pipeline can tell these two apart.
    expect(certifiesPublicKey(cert(theirs), pub(ours))).toBe(false)
  })

  it('refuses a certificate whose key field is the wrong size', () => {
    expect(certifiesPublicKey(cert(Buffer.alloc(16, 0x11)), pub(ours))).toBe(false)
  })

  it('refuses when the blob disagrees with the type it is labelled with', () => {
    const mislabelled = `ssh-ed25519-cert-v01@openssh.com ${cert(ours, 'ssh-rsa-cert-v01@openssh.com').split(' ')[1]}`
    expect(certifiesPublicKey(mislabelled, pub(ours))).toBe(false)
  })

  it('refuses anything that is not an ed25519 certificate and key', () => {
    // ensureKeyPair generates ed25519 and nothing else, so a certificate of
    // another type cannot be a certificate for our key.
    expect(certifiesPublicKey(cert(ours, 'ssh-rsa-cert-v01@openssh.com'), pub(ours))).toBe(false)
    expect(certifiesPublicKey(pub(ours), pub(ours)), 'a plain key passed as a certificate').toBe(false)
    expect(certifiesPublicKey(cert(ours), 'ssh-rsa AAAAB3NzaC1yc2E')).toBe(false)
  })

  it('refuses junk rather than throwing', () => {
    for (const bad of ['', 'not a certificate', undefined, null, 42, `ssh-ed25519-cert-v01@openssh.com ${'A'.repeat(200)}`]) {
      expect(certifiesPublicKey(bad, pub(ours)), `${String(bad)} was accepted`).toBe(false)
    }
  })
})

import {
  certNeedsRenewal, parseCertValidUntil, hostPatternFor, hostEntries, readAliasStore, writeAliasStore,
  computeSSH, instaCertPath, instaAliasStorePath,
} from '../src/commands/compute.js'
import { writeFileAtomicSync } from '../src/util.js'

// Only has to exist: every case below injects the reader instead of shelling
// out, so the file's contents are irrelevant.
const anyExistingFile = fileURLToPath(import.meta.url)

const keygenOut = (from: string, to: string) =>
  `x-cert.pub:\n  Type: ssh-ed25519-cert-v01@openssh.com user certificate\n  Valid: from ${from} to ${to}\n`

describe('certificate renewal', () => {
  // "Cannot confirm it is valid" and "it is valid" must not collapse into the
  // same answer. Every uncertain case renews, because the cost of an
  // unnecessary renewal is one HTTPS call and the cost of the opposite is a
  // login that fails with no explanation.
  it('renews when there is no certificate at all', () => {
    expect(certNeedsRenewal('/nonexistent/path/api.insta-cert.pub')).toBe(true)
  })

  it('renews when the file cannot be parsed', () => {
    expect(certNeedsRenewal(anyExistingFile, {
      read: () => { throw new Error('ssh-keygen: not a certificate file') },
    })).toBe(true)
  })

  // `ssh-keygen -L` prints validity in LOCAL time, and certNeedsRenewal parses
  // it that way, so the test clock has to be local too. Anchoring `now` to UTC
  // while the certificate dates were local made the margin arithmetic shift by
  // the offset -- fine at UTC+0, and wrong by up to fourteen hours elsewhere.
  const localTime = (s: string) => new Date(s).getTime()

  it('leaves a certificate with plenty of life alone', () => {
    const now = localTime('2026-09-14T12:00:00')
    expect(certNeedsRenewal(anyExistingFile, {
      now, read: () => keygenOut('2026-09-14T10:00:00', '2026-09-14T22:00:00'),
    })).toBe(false)
  })

  // The margin is the point of the whole mechanism: a certificate that is
  // technically still valid but expires mid-session must be replaced BEFORE
  // the session starts, not after it drops.
  it('renews inside the margin, even though the certificate is still valid', () => {
    const now = localTime('2026-09-14T12:00:00')
    const read = () => keygenOut('2026-09-14T10:00:00', '2026-09-14T12:03:00')
    expect(certNeedsRenewal(anyExistingFile, { now, read }), 'a cert expiring in 3 minutes was treated as healthy').toBe(true)
    expect(certNeedsRenewal(anyExistingFile, { now, marginMs: 60_000, read })).toBe(false)
  })

  it('renews on an already-expired certificate', () => {
    const now = localTime('2026-09-14T12:00:00')
    expect(certNeedsRenewal(anyExistingFile, {
      now, read: () => keygenOut('2026-09-13T10:00:00', '2026-09-13T22:00:00'),
    })).toBe(true)
  })

  it('renews when ssh-keygen output has no Valid line at all', () => {
    expect(certNeedsRenewal(anyExistingFile, { read: () => 'some other tool entirely\n' })).toBe(true)
  })

  // A NaN date compares false against everything, which reads as healthy --
  // the one failure mode that silently disables renewal forever.
  it('treats an undatable validity as "cannot confirm", never as valid forever', () => {
    expect(parseCertValidUntil('  Valid: from 2026-09-14T10:00:00 to 2026-02-30T99:99:99\n')).toBeUndefined()
    expect(parseCertValidUntil('  Valid: forever\n')).toBeUndefined()
    expect(parseCertValidUntil(keygenOut('2026-09-14T10:00:00', '2026-09-14T22:00:00'))).toBe(
      new Date('2026-09-14T22:00:00').getTime(),
    )
    expect(certNeedsRenewal(anyExistingFile, { read: () => '  Valid: from x to 2026-02-30T99:99:99\n' })).toBe(true)
  })
})

describe('trust anchor scope', () => {
  // The anchor must cover the SSH names and not the whole domain: a pattern of
  // *.compute.example would also make this CA authoritative for every tenant's
  // service hostname.
  it('widens only the region label, and only under a suffix we own', () => {
    // `.example` is not a real gateway suffix, so it is anchored exactly --
    // see ssh-known-hosts-injection.test.ts for why counting labels is not
    // enough to decide this (ssh.*.co.uk).
    expect(hostPatternFor('ssh.ap-southeast-1.compute.instacloud.tech')).toBe('ssh.*.compute.instacloud.tech')
    expect(hostPatternFor('ssh.us-west-1.compute.example')).toBe('ssh.us-west-1.compute.example')
  })

  it('leaves a host too short to have a region label alone', () => {
    expect(hostPatternFor('localhost')).toBe('localhost')
    expect(hostPatternFor('a.b')).toBe('a.b')
  })
})

describe('atomic replacement of user-owned files', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insta-atomic-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('replaces the contents and leaves no temporary file behind', () => {
    const p = join(dir, 'config')
    writeFileSync(p, 'old\n')
    writeFileAtomicSync(p, 'new\n', { mode: 0o600 })
    expect(readFileSync(p, 'utf8')).toBe('new\n')
    expect(readdirSync(dir)).toEqual(['config'])
  })

  it('keeps the previous contents recoverable when asked', () => {
    const p = join(dir, 'config')
    writeFileSync(p, 'Host *\n  User root\n')
    writeFileAtomicSync(p, 'replaced\n', { mode: 0o600, backup: true })
    expect(readFileSync(p + '.insta-bak', 'utf8')).toBe('Host *\n  User root\n')
  })

  // The reason this helper exists: a failed write must not consume what was
  // already there, which a truncating writeFileSync would have done, and it
  // must not leave its scratch file in the user's ~/.ssh either.
  it('leaves the target alone and cleans up when the replace fails', () => {
    const p = join(dir, 'config')
    mkdirSync(p)
    writeFileSync(join(p, 'sentinel'), 'still here\n')
    expect(() => writeFileAtomicSync(p, 'new\n', { mode: 0o600 })).toThrow()
    expect(readFileSync(join(p, 'sentinel'), 'utf8')).toBe('still here\n')
    expect(readdirSync(dir), 'a temporary file was left behind in the user\'s directory').toEqual(['config'])
  })
})

describe('alias store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insta-alias-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const rec = (serviceId: string, host: string, username: string) =>
    ({ projectId: 'p1', branch: 'main', serviceId, host, username })

  it('round-trips what renewal needs: project, branch and service per alias', () => {
    const p = join(dir, 'aliases.json')
    writeAliasStore({ 'api.insta': rec('svc_1', 'ssh.us-west-1.compute.example', 'u1') }, p)
    expect(readAliasStore(p)['api.insta']).toEqual(rec('svc_1', 'ssh.us-west-1.compute.example', 'u1'))
  })

  // A broken store must degrade to "nothing is set up". Throwing here would
  // break `ssh` for every alias, since the hook runs on every config parse.
  it('degrades to empty rather than throwing', () => {
    expect(readAliasStore(join(dir, 'missing.json'))).toEqual({})
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(readAliasStore(bad)).toEqual({})
    writeFileSync(bad, '["an array"]')
    expect(readAliasStore(bad)).toEqual({})
  })

  it('renders every set-up service, so a second --setup does not drop the first', () => {
    const entries = hostEntries({
      'worker.insta': rec('svc_2', 'ssh.eu-west-1.compute.example', 'u2'),
      'api.insta': rec('svc_1', 'ssh.us-west-1.compute.example', 'u1'),
    })
    expect(entries.map((e) => e.alias)).toEqual(['api.insta', 'worker.insta'])
    expect(entries[0]!.hostName).toBe('ssh.us-west-1.compute.example')
    expect(entries[0]!.user).toBe('u1')
    expect(entries[0]!.certificateFile).toBe(instaCertPath('api.insta'))
  })

  it('drops an alias that would not be safe to write into ssh_config', () => {
    const entries = hostEntries({ 'a;id.insta': rec('svc_1', 'h', 'u'), 'api.insta': rec('svc_2', 'h', 'u') })
    expect(entries.map((e) => e.alias)).toEqual(['api.insta'])
  })
})

// The hook runs on EVERY ssh, scp and `ssh -G`. If it can print or throw, that
// output lands in the middle of the user's ssh session; if it does project and
// API work before checking the local certificate, every connection pays for it.
describe('renewal hook is silent and fail-safe', () => {
  let home: string
  let prevHome: string | undefined
  let prevProfile: string | undefined
  let prevApiUrl: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'insta-home-'))
    prevHome = process.env.HOME
    prevProfile = process.env.USERPROFILE
    prevApiUrl = process.env.INSTA_API_URL
    process.env.HOME = home
    process.env.USERPROFILE = home
    // Unroutable: any API call this path makes would hang or fail, and either
    // way it must stay invisible.
    process.env.INSTA_API_URL = 'http://127.0.0.1:1'
  })
  afterEach(() => {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevProfile
    if (prevApiUrl === undefined) delete process.env.INSTA_API_URL
    else process.env.INSTA_API_URL = prevApiUrl
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const quietly = async (alias: string) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(computeSSH(undefined, { ensureCert: alias })).resolves.toBeUndefined()
    for (const s of [log, err, out, errOut]) expect(s, 'the renewal hook printed into the ssh session').not.toHaveBeenCalled()
  }

  it('says nothing when the directory is not linked to any project', async () => {
    await quietly('api.insta')
  })

  it('says nothing when the alias was never set up', async () => {
    writeAliasStore({ 'other.insta': { projectId: 'p1', serviceId: 's1', host: 'h', username: 'u' } })
    await quietly('api.insta')
  })

  // A record exists and the certificate is missing, so this path goes all the
  // way to the platform -- which is not there. Everything downstream of the
  // certificate check lives inside the same silent boundary.
  it('says nothing when the platform cannot be reached', async () => {
    writeAliasStore({ 'api.insta': { projectId: 'p1', branch: 'main', serviceId: 's1', host: 'h', username: 'u' } })
    expect(existsSync(instaCertPath('api.insta'))).toBe(false)
    await quietly('api.insta')
  })

  it('says nothing, and touches nothing, for an alias that is not ours', async () => {
    writeAliasStore({ 'api.insta': { projectId: 'p1', serviceId: 's1', host: 'h', username: 'u' } })
    await quietly('$(id).insta')
    await quietly('../../etc/passwd')
  })

  // The hook must not rewrite the user's ssh files on a path that failed.
  it('never creates ~/.ssh on a failed renewal', async () => {
    await quietly('api.insta')
    expect(existsSync(join(home, '.ssh', 'config'))).toBe(false)
    expect(existsSync(join(home, '.ssh', 'known_hosts'))).toBe(false)
  })

  it('keeps its state under ~/.insta/ssh', () => {
    expect(instaAliasStorePath().startsWith(join(home, '.insta', 'ssh'))).toBe(true)
  })
})

describe('unsafe values never reach ssh_config', () => {
  // ssh_config is whitespace-separated and has no escape mechanism inside a
  // bare token, so a host or username carrying a space, a quote or a newline
  // does not produce a BROKEN alias -- it produces a DIFFERENT directive.
  // `HostName evil.example\n  ProxyCommand curl ...` is a valid config file,
  // and our block is written into the user's own ~/.ssh/config.
  const hostile = [
    ['a space', 'ssh.example.com extra'],
    ['a newline', 'ssh.example.com\n  ProxyCommand /bin/sh'],
    ['a carriage return', 'ssh.example.com\r  ProxyCommand /bin/sh'],
    ['a tab', 'ssh.example.com\tProxyCommand'],
    ['a double quote', 'ssh."example".com'],
    ['a single quote', "ssh.'example'.com"],
    // OpenSSH treats a backslash as an escape introducer in a config argument,
    // so the value ssh ends up using is not the one written. Reachable for the
    // USERNAME in particular: the host is additionally gated by isSafeSSHHost,
    // but the username's only guard is this one.
    ['a backslash', 'ssh.example\\.com'],
    ['a NUL', 'ssh.example.com' + String.fromCharCode(0)],
    ['an empty string', ''],
  ] as const

  for (const [what, value] of hostile) {
    it(`rejects a hostName containing ${what}`, () => {
      expect(isSafeConfigValue(value), `${JSON.stringify(value)} was accepted as a config value`).toBe(false)
      expect(() => block([entry('api.insta', value, 'svc-abc')])).toThrow()
    })
    it(`rejects a user containing ${what}`, () => {
      expect(() => block([entry('api.insta', 'ssh.example.com', value)])).toThrow()
    })
  }

  // The POSITIVE control for the table above: a guard tight enough to reject
  // every hostile value is equally capable of rejecting every REAL one, and
  // over-rejection is the one failure a table of refusals cannot catch.
  it('still renders a full block for the ordinary values it exists to pass through', () => {
    expect(isSafeConfigValue('ssh.us-west-1.compute.example')).toBe(true)
    expect(isSafeConfigValue('svc-abc123')).toBe(true)
    const out = block([entry('api.insta'), entry('web.insta', 'ssh.eu-central-1.compute.example', 'svc-def')])
    expect(out).toContain('HostName ssh.us-west-1.compute.example')
    expect(out).toContain('Host web.insta')
    expect(out).toContain('User svc-def')
  })
})

describe('paths are quoted, because a home directory may contain a space', () => {
  it('quotes IdentityFile and CertificateFile', () => {
    const out = renderConfigBlock({
      entries: [{
        alias: 'api.insta',
        hostName: 'ssh.example.com',
        user: 'svc-abc',
        certificateFile: '/Users/Jun Wen/.insta/ssh/api.insta-cert.pub',
      }],
      identityFile: '/Users/Jun Wen/.insta/ssh/id_ed25519',
      knownHostsFile: '/Users/Jun Wen/.ssh/known_hosts',
    })
    // Unquoted, ssh reads the argument as `/Users/Jun` and every connection
    // fails with a misleading "no such identity" on a perfectly valid home.
    expect(out).toContain('IdentityFile "/Users/Jun Wen/.insta/ssh/id_ed25519"')
    expect(out).toContain('CertificateFile "/Users/Jun Wen/.insta/ssh/api.insta-cert.pub"')
    expect(out).toContain('UserKnownHostsFile "/Users/Jun Wen/.ssh/known_hosts"')
  })

  it('refuses a path that would break out of the quoting', () => {
    // A quoted ssh_config argument has NO escape for `"`, so the only correct
    // answer is to refuse -- emitting it would close the quote early and turn
    // the tail into directives.
    expect(() => quoteConfigPath('/home/dev/a"b')).toThrow()
    expect(() => quoteConfigPath('/home/dev/a\nProxyCommand sh')).toThrow()
    expect(quoteConfigPath('/home/dev/ssh/id')).toBe('"/home/dev/ssh/id"')
  })

  // Quoting alone does not make a path literal. OpenSSH expands tokens INSIDE
  // the quotes for IdentityFile and CertificateFile, so a `%` the user did not
  // mean as a token is either read as one or aborts the connection outright.
  it('escapes a % so the path is a filename rather than a token', () => {
    expect(quoteConfigPath('/home/dev%team/.insta/ssh/id')).toBe('"/home/dev%%team/.insta/ssh/id"')
    expect(quoteConfigPath('/home/%d/id')).toBe('"/home/%%d/id"')
    expect(quoteConfigPath('/home/100%/id')).toBe('"/home/100%%/id"')
  })

  it('refuses a path carrying environment-variable syntax', () => {
    // Unlike `%`, `${...}` has NO escape in ssh_config, so there is no correct
    // string to emit. A lone `$` is not expansion syntax and stays a filename.
    expect(() => quoteConfigPath('/home/${HOME}/id')).toThrow()
    expect(() => quoteConfigPath('/home/dev/${}/id')).toThrow()
    expect(quoteConfigPath('/home/dev$/id')).toBe('"/home/dev$/id"')
    expect(quoteConfigPath('/home/$HOME/id')).toBe('"/home/$HOME/id"')
  })
})


describe('our block is relocated to the top, not replaced where it sits', () => {
  const blk = (host: string) => `${BLOCK_BEGIN}\nHost api.insta\n  HostName ${host}\n${BLOCK_END}\n`

  it('lifts a block that is already BELOW an earlier Host *', () => {
    // The regression: `ssh` takes the FIRST obtained value for each keyword, so
    // a block under a `Host *` has every setting ignored -- and the symptom is
    // a connection that silently uses the wrong identity, not an error. An
    // older CLI appended the block; re-running --setup has to be able to fix
    // that file, which makes POSITION part of what we upsert.
    const existing = `Host *\n  IdentityFile ~/.ssh/id_rsa\n\n${blk('old')}`
    const out = upsertConfigBlock(existing, blk('NEW'))
    expect(out.indexOf(BLOCK_BEGIN), 'the block stayed below Host * and is still ignored').toBeLessThan(out.indexOf('Host *'))
    expect(out).toContain('HostName NEW')
    expect(out, 'the old stanza was left behind').not.toContain('HostName old')
  })

  it('keeps the user config that was above it, just below us now', () => {
    const existing = `Host *\n  IdentityFile ~/.ssh/id_rsa\n\n${blk('old')}`
    const out = upsertConfigBlock(existing, blk('NEW'))
    expect(out, 'the user\'s own config was dropped').toContain('IdentityFile ~/.ssh/id_rsa')
    expect(out).toContain('Host *')
  })

  it('does not duplicate the block across repeated runs', () => {
    let cfg = ''
    for (const h of ['a', 'b', 'c']) cfg = upsertConfigBlock(cfg, blk(h))
    expect(cfg.split(BLOCK_BEGIN).length - 1, 'the block accumulated').toBe(1)
    expect(cfg).toContain('HostName c')
  })

  it('still prepends when there is no block yet', () => {
    const out = upsertConfigBlock('Host *\n  Port 22\n', blk('x'))
    expect(out.startsWith(BLOCK_BEGIN)).toBe(true)
    expect(out).toContain('Port 22')
  })

  it('leaves a hand-truncated block alone and puts a fresh one on top', () => {
    // A begin marker with no end means someone edited by hand; guessing where
    // ours stopped could eat their config.
    const existing = `${BLOCK_BEGIN}\nHost api.insta\n  HostName orphaned\n`
    const out = upsertConfigBlock(existing, blk('NEW'))
    expect(out.startsWith(BLOCK_BEGIN)).toBe(true)
    expect(out).toContain('HostName NEW')
    expect(out, 'the hand-edited remnant was destroyed').toContain('HostName orphaned')
  })
})

describe('a trust anchor is matched field by field, never by substring', () => {
  const CA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZG'

  it('keeps an anchor whose key merely EXTENDS ours', () => {
    // A base64 blob is an unanchored substring of any longer blob sharing its
    // prefix. Deleting that line is not a visible failure -- it is a host-key
    // prompt on every connection to a region that used to be trusted.
    // Built FROM our blob, so the relationship the test is named for holds by
    // construction: a same-length unrelated blob is not a substring of ours
    // and passes an `includes` regression straight through.
    const other = `@cert-authority ssh.*.other.example ssh-ed25519 ${CA.split(' ')[1]}QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB ${CA_MARKER}\n`
    expect(other, 'the fixture no longer extends our blob').toContain(CA.split(' ')[1]!)
    const out = upsertCertAuthority(other, 'ssh.*.compute.example', CA)
    expect(out, 'an unrelated anchor was deleted by a substring match').toContain('ssh.*.other.example')
    expect(out).toContain('ssh.*.compute.example')
  })

  it('keeps an anchor whose HOST PATTERN merely extends ours', () => {
    const other = `@cert-authority ssh.*.compute.example.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC ${CA_MARKER}\n`
    const out = upsertCertAuthority(other, 'ssh.*.compute.example', CA)
    expect(out).toContain('ssh.*.compute.example.net')
  })

  it('still replaces the anchor for the SAME host pattern (rotation)', () => {
    const first = upsertCertAuthority('', 'ssh.*.compute.example', RETIRED_CA)
    const rotated = upsertCertAuthority(first, 'ssh.*.compute.example', ROTATED_CA)
    expect(rotated, 'the retired CA stayed trusted').not.toContain(RETIRED_CA.split(' ')[1]!)
    expect(rotated).toContain(ROTATED_CA.split(' ')[1]!)
    expect(rotated.split('@cert-authority').length - 1).toBe(1)
  })

  // A move is a pattern change that covers the SAME hosts, in either direction.
  // That is the only pattern change one anchor can make on its own, because
  // hostPatternFor derives the pattern from the host: the region label becoming
  // widenable widens it, the suffix leaving the allowlist narrows it back.
  it('still moves the anchor when the SAME key is widened over the region label', () => {
    const exact = upsertCertAuthority('', 'ssh.us-west-1.compute.example', CA)
    const widened = upsertCertAuthority(exact, 'ssh.*.compute.example', CA)
    expect(widened, 'the exact anchor the wildcard already covers was left behind').not.toContain('ssh.us-west-1.compute.example')
    expect(widened.split('@cert-authority').length - 1).toBe(1)
  })

  it('still moves it when the wildcard is narrowed back to one region', () => {
    const wide = upsertCertAuthority('', 'ssh.*.compute.example', CA)
    const narrowed = upsertCertAuthority(wide, 'ssh.us-west-1.compute.example', CA)
    expect(narrowed, 'a wildcard we no longer widen to stayed trusted').not.toContain('ssh.*.compute.example')
    expect(narrowed.split('@cert-authority').length - 1).toBe(1)
  })

  // The regression. Outside CA_WIDENABLE_SUFFIXES hostPatternFor deliberately
  // returns an EXACT hostname -- one anchor per region, which is the documented
  // fallback -- and every region is signed by the same platform CA. Treating
  // "same key" as proof the anchor had merely moved made setting up the second
  // region DELETE the first one's line, so an alias that worked yesterday met a
  // host-key prompt instead.
  it("keeps another region's exact anchor that shares this CA", () => {
    const west = upsertCertAuthority('', 'ssh.us-west-1.self.hosted', CA)
    const both = upsertCertAuthority(west, 'ssh.eu-west-1.self.hosted', CA)
    expect(both, "setting up a second region deleted the first region's anchor").toContain('ssh.us-west-1.self.hosted')
    expect(both).toContain('ssh.eu-west-1.self.hosted')
    expect(both.split('@cert-authority').length - 1).toBe(2)
  })

  // Same defect, one level up: CA_WIDENABLE_SUFFIXES ships TWO gateway domains,
  // so a user with projects on both holds two wildcard anchors under one CA and
  // neither covers the other.
  it("keeps another gateway domain's wildcard anchor that shares this CA", () => {
    const tech = upsertCertAuthority('', 'ssh.*.compute.instacloud.tech', CA)
    const both = upsertCertAuthority(tech, 'ssh.*.compute.insforge.dev', CA)
    expect(both, 'the other gateway domain lost its anchor').toContain('ssh.*.compute.instacloud.tech')
    expect(both).toContain('ssh.*.compute.insforge.dev')
    expect(both.split('@cert-authority').length - 1).toBe(2)
  })

  // And a second run for a region that already has one must still not stack.
  it('does not stack anchors when the same region is set up twice', () => {
    let out = upsertCertAuthority('', 'ssh.us-west-1.self.hosted', CA)
    out = upsertCertAuthority(out, 'ssh.eu-west-1.self.hosted', CA)
    out = upsertCertAuthority(out, 'ssh.us-west-1.self.hosted', CA)
    expect(out.split('@cert-authority').length - 1).toBe(2)
  })

  it('never touches an anchor the user added themselves', () => {
    const mine = '@cert-authority ssh.*.compute.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZG\n'
    const out = upsertCertAuthority(mine, 'ssh.*.compute.example', CA)
    expect(out, 'an unmarked anchor the user owns was deleted').toContain(mine.trim())
  })
})

describe('a Windows path is normalised, not escaped away', () => {
  it('rewrites backslashes to forward slashes', () => {
    // OpenSSH treats `\` in a config argument as an escape introducer, so
    // `C:\Users\...` silently resolves to a DIFFERENT path. Windows OpenSSH
    // accepts forward slashes everywhere, so rewriting is the unambiguous form.
    expect(quoteConfigPath('C:\\Users\\Jun Wen\\.insta\\ssh\\id_ed25519'))
      .toBe('"C:/Users/Jun Wen/.insta/ssh/id_ed25519"')
  })

  it('emits a Windows IdentityFile ssh can actually load', () => {
    const out = renderConfigBlock({
      entries: [{
        alias: 'api.insta', hostName: 'ssh.example.com', user: 'svc-abc',
        certificateFile: 'C:\\Users\\Jun Wen\\.insta\\ssh\\api.insta-cert.pub',
      }],
      identityFile: 'C:\\Users\\Jun Wen\\.insta\\ssh\\id_ed25519',
      knownHostsFile: 'C:\\Users\\Jun Wen\\.ssh\\known_hosts',
    })
    expect(out).toContain('IdentityFile "C:/Users/Jun Wen/.insta/ssh/id_ed25519"')
    expect(out).toContain('CertificateFile "C:/Users/Jun Wen/.insta/ssh/api.insta-cert.pub"')
    expect(out).toContain('UserKnownHostsFile "C:/Users/Jun Wen/.ssh/known_hosts"')
    expect(out, 'a raw backslash survived into the config').not.toContain('\\')
  })

  it('leaves a POSIX path exactly as it was', () => {
    expect(quoteConfigPath('/home/dev/.insta/ssh/id')).toBe('"/home/dev/.insta/ssh/id"')
  })
})

describe('the generated config works on Windows, where multiplexing does not', () => {
  const win = (entries = [entry()]) => renderConfigBlock({
    entries, identityFile: '/home/dev/.insta/ssh/id_ed25519', knownHostsFile: KNOWN_HOSTS, platform: 'win32',
  })

  it('omits ControlMaster, ControlPath and ControlPersist on win32', () => {
    // Win32-OpenSSH does not implement ControlMaster (PowerShell/Win32-OpenSSH
    // #1328, #405) and FAILS the connection rather than ignoring the directive,
    // so every alias would be unusable -- not merely unmultiplexed. The
    // ControlPath also contains a `:` before %p, which is not a legal character
    // in a Windows filename.
    const out = win()
    expect(out, 'ControlMaster would fail every connection on Windows').not.toContain('ControlMaster')
    expect(out).not.toContain('ControlPath')
    expect(out).not.toContain('ControlPersist')
    expect(out, 'a colon reached a Windows path').not.toContain('%r@%h:%p')
  })

  it('still routes, authenticates and renews on Windows', () => {
    // The POSITIVE control: dropping the multiplexing lines must not drop the
    // lines that make the alias work at all.
    const out = renderConfigBlock({
      entries: [entry()], identityFile: '/home/dev/.insta/ssh/id_ed25519', knownHostsFile: KNOWN_HOSTS,
      ensureCertCommand: 'insta __ssh-ensure-cert', platform: 'win32',
    })
    expect(out).toContain('Host api.insta')
    expect(out).toContain('HostName ssh.us-west-1.compute.example')
    expect(out).toContain('User svc-abc')
    expect(out).toContain('IdentitiesOnly yes')
    expect(out).toContain('IdentityFile "/home/dev/.insta/ssh/id_ed25519"')
    expect(out).toContain('CertificateFile "/home/dev/.insta/ssh/api.insta-cert.pub"')
    expect(out).toContain('insta __ssh-ensure-cert api.insta')
    expect(out.trimEnd().endsWith(BLOCK_END)).toBe(true)
  })

  it('keeps multiplexing everywhere else', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const out = renderConfigBlock({ entries: [entry()], identityFile: '/home/dev/.insta/ssh/id_ed25519', knownHostsFile: KNOWN_HOSTS, platform })
      expect(out, `${platform} lost connection multiplexing`).toContain('ControlMaster auto')
      expect(out).toContain('ControlPersist 10m')
    }
  })
})

describe('a marker is a whole line, never a mention of one', () => {
  // The finding. indexOf found the marker TEXT wherever it occurred, so a
  // user's comment that mentioned it -- documentation of this very block, one
  // line above it -- became the start of "our" block, and everything from the
  // middle of that line to the real end marker was cut: their comment
  // truncated, their stanzas in between deleted. `includes` in hasOwnedBlock
  // made the same mention count as an installed block.
  const blk = (host: string) => `${BLOCK_BEGIN}\nHost api.insta\n  HostName ${host}\n${BLOCK_END}\n`

  it("leaves a comment that mentions the begin marker, and the stanzas after it, alone", () => {
    const mention = `# the managed section below starts at ${BLOCK_BEGIN} -- do not edit it`
    const existing = `${mention}\nHost bastion\n  User someone\n${blk('OLD')}Host other\n  Port 2222\n`
    const out = upsertConfigBlock(existing, blk('NEW'))
    expect(out, "the user's comment was cut in half").toContain(mention)
    expect(out, 'a stanza between the mention and the real block was deleted').toContain('Host bastion\n  User someone')
    expect(out).toContain('Host other\n  Port 2222')
    expect(out).toContain('HostName NEW')
    expect(out, 'the real block was not replaced').not.toContain('HostName OLD')
    expect(out.split(BLOCK_END).length - 1).toBe(1)
  })

  it('does not treat a mention as an installed block', () => {
    expect(hasOwnedBlock(`# run --setup to add the ${BLOCK_BEGIN} block\nHost *\n`), 'a mention read as an installed block').toBe(false)
    expect(hasOwnedBlock(`${BLOCK_BEGIN}\nHost api.insta\n`), 'a truncated block is still ours').toBe(true)
    expect(hasOwnedBlock(`  ${BLOCK_BEGIN}  \nHost api.insta\n`), 'a marker line with whitespace around it is still the marker').toBe(true)
  })

  it('ignores an end marker mentioned in a comment when looking for the real one', () => {
    const existing = `# ends at ${BLOCK_END}\n${blk('OLD')}Host *\n`
    const out = upsertConfigBlock(existing, blk('NEW'))
    expect(out).toContain(`# ends at ${BLOCK_END}`)
    expect(out).not.toContain('HostName OLD')
    expect(out).toContain('Host *')
  })

  it('removes every well-formed block, so a file that somehow holds two comes back with one', () => {
    const out = upsertConfigBlock(`${blk('A')}\n${blk('B')}Host *\n`, blk('NEW'))
    expect(out.split(BLOCK_BEGIN).length - 1).toBe(1)
    expect(out).toContain('HostName NEW')
    expect(out).toContain('Host *')
  })
})

describe("a user's own anchor is theirs even when its comment mentions us", () => {
  it('is not retired by a rotation for the same host pattern', () => {
    // The same class as the config markers: `includes(CA_MARKER)` made any
    // anchor whose comment contained our tag ours to retire.
    const theirs = `@cert-authority ssh.*.compute.example ssh-ed25519 ${RETIRED_CA.split(' ')[1]} ${CA_MARKER} (copied from the insta block)\n`
    const out = upsertCertAuthority(theirs, 'ssh.*.compute.example', ROTATED_CA)
    expect(out, 'a user anchor was retired because its comment mentioned our marker').toContain(theirs.trimEnd())
    expect(out).toContain(ROTATED_CA.split(' ')[1]!)
  })
})
