import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertAliasFree, isValidAliasRecord, readAliasStore, writeAliasStore, hostEntries, sshAdvice, ENSURE_CERT_COMMAND,
  type AliasStore,
} from '../src/commands/compute.js'

let dir: string
let store: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insta-alias-'))
  store = join(dir, 'aliases.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rec = (over: Record<string, unknown> = {}) => ({
  projectId: 'proj-1', serviceId: 'svc-1', host: 'ssh.us-west-1.example', username: 'u-1', ...over,
})

describe('an alias is never silently repointed at another service', () => {
  const held: AliasStore = { 'api.insta': rec() as never }

  it('accepts the same service setting itself up again', () => {
    // Re-running --setup after a certificate expires is the NORMAL path; it
    // must not look like a collision.
    expect(() => assertAliasFree(held, 'api.insta', { projectId: 'proj-1', serviceId: 'svc-1' })).not.toThrow()
  })

  it('accepts an alias nobody holds', () => {
    expect(() => assertAliasFree(held, 'web.insta', { projectId: 'proj-2', serviceId: 'svc-2' })).not.toThrow()
  })

  // Every dimension separately: a collision on ANY of them means `ssh api.insta`
  // would land somewhere other than where the developer just looked.
  it('refuses a different PROJECT with a service of the same name', () => {
    expect(() => assertAliasFree(held, 'api.insta', { projectId: 'proj-2', serviceId: 'svc-9' }))
      .toThrow(/already set up for a different service/)
  })

  it('refuses a different SERVICE ID inside the same project', () => {
    // Delete-and-recreate gives the same name a new id; the stored host is the
    // dead one's.
    expect(() => assertAliasFree(held, 'api.insta', { projectId: 'proj-1', serviceId: 'svc-2' })).toThrow()
  })

  it('refuses a different BRANCH of the same project and service name', () => {
    expect(() => assertAliasFree(held, 'api.insta', { projectId: 'proj-1', serviceId: 'svc-1', branch: 'preview' }))
      .toThrow()
  })

  it('refuses when the holder has a branch and the newcomer does not', () => {
    const onBranch: AliasStore = { 'api.insta': rec({ branch: 'preview' }) as never }
    expect(() => assertAliasFree(onBranch, 'api.insta', { projectId: 'proj-1', serviceId: 'svc-1' })).toThrow()
  })

  it('names the holder, so the message says which project to go fix', () => {
    let msg = ''
    try { assertAliasFree(held, 'api.insta', { projectId: 'proj-2', serviceId: 'svc-9' }) } catch (e) { msg = String(e) }
    expect(msg).toContain('proj-1')
    expect(msg).toContain('svc-1')
  })
})

describe('a hand-mangled store degrades to "not set up", never to a broken config', () => {
  const bad: Array<[string, unknown]> = [
    ['a missing host', { projectId: 'p', serviceId: 's', username: 'u' }],
    ['a missing username', { projectId: 'p', serviceId: 's', host: 'h.example' }],
    ['a null record', null],
    ['an array', []],
    ['a string', 'nope'],
    ['a host with a space', { projectId: 'p', serviceId: 's', host: 'h.example x', username: 'u' }],
    ['a username with a newline', { projectId: 'p', serviceId: 's', host: 'h.example', username: 'u\nProxyCommand sh' }],
    ['an empty projectId', { projectId: '', serviceId: 's', host: 'h.example', username: 'u' }],
    ['a numeric serviceId', { projectId: 'p', serviceId: 7, host: 'h.example', username: 'u' }],
    ['a port that is a string', { projectId: 'p', serviceId: 's', host: 'h.example', username: 'u', port: '2222' }],
    ['a port of zero', { projectId: 'p', serviceId: 's', host: 'h.example', username: 'u', port: 0 }],
    ['a port past 65535', { projectId: 'p', serviceId: 's', host: 'h.example', username: 'u', port: 70000 }],
  ]

  for (const [what, r] of bad) {
    it(`rejects ${what}`, () => expect(isValidAliasRecord(r)).toBe(false))
  }

  it('accepts the record the CLI itself writes', () => {
    expect(isValidAliasRecord(rec())).toBe(true)
    expect(isValidAliasRecord(rec({ branch: 'preview' }))).toBe(true)
  })

  it('drops only the bad entry and keeps every good one', () => {
    // One bad stanza is enough for OpenSSH to reject the WHOLE file, so a
    // single hand-edit must not take every other alias down with it.
    writeFileSync(store, JSON.stringify({
      'api.insta': rec(),
      'broken.insta': { projectId: 'p', serviceId: 's' },
      'web.insta': rec({ serviceId: 'svc-2', host: 'ssh.eu-central-1.example', username: 'u-2' }),
    }))
    const out = readAliasStore(store)
    expect(Object.keys(out).sort(), 'the broken entry survived, or took a good one with it').toEqual(['api.insta', 'web.insta'])
    expect(hostEntries(out).map((e) => e.alias)).toEqual(['api.insta', 'web.insta'])
  })

  it('survives a store that is not JSON at all', () => {
    writeFileSync(store, 'not json {')
    expect(readAliasStore(store)).toEqual({})
  })

  it('survives a missing store', () => {
    expect(readAliasStore(join(dir, 'absent.json'))).toEqual({})
  })

  it('round-trips what it wrote', () => {
    writeAliasStore({ 'api.insta': rec() as never }, store)
    expect(readAliasStore(store)).toEqual({ 'api.insta': rec() })
    expect(readFileSync(store, 'utf8').endsWith('\n')).toBe(true)
  })
})

describe('the command only advertises an alias it actually installed', () => {
  const base = {
    alias: 'api.insta', host: 'ssh.us-west-1.example', username: 'svc-abc', port: 2222,
    expiresAt: '2026-09-14T22:00:00Z', serviceName: 'api',
    identityFile: '/home/dev/.insta/ssh/id_ed25519',
    certificateFile: '/home/dev/.insta/ssh/api.insta-cert.pub',
  }

  it('offers the short alias once --setup has written it', () => {
    const out = sshAdvice({ ...base, configured: true }).join('\n')
    expect(out).toContain('ssh api.insta')
    expect(out).toContain('svc-abc@ssh.us-west-1.example')
  })

  it('offers a command that actually uses the credential just issued', () => {
    // Two regressions in one line, and the second replaced the first. Printing
    // `ssh api.insta` fails because no ssh_config stanza exists. Printing a
    // bare `ssh user@host` fails for a subtler reason: the key lives at
    // ~/.insta/ssh/id_ed25519 and the certificate at <alias>-cert.pub, and
    // NEITHER is a path OpenSSH looks in, so ssh offers the user's own keys and
    // never the credential this command just minted. Both print success and
    // then fail on first use.
    const command = sshAdvice({ ...base, configured: false })[0]!
    // The alias must not be the DESTINATION (the cert filename legitimately
    // contains it), because nothing has taught ssh what `api.insta` resolves to.
    expect(command.split(/\s+/), 'the uninstalled alias was advertised as the destination').not.toContain('api.insta')
    expect(command.trimEnd().endsWith('svc-abc@ssh.us-west-1.example')).toBe(true)
    expect(command, 'the private key was not offered').toContain('-i /home/dev/.insta/ssh/id_ed25519')
    expect(command, 'the certificate was not offered').toContain('-o CertificateFile=/home/dev/.insta/ssh/api.insta-cert.pub')
    // Without this a loaded agent can burn the server's MaxAuthTries on
    // unrelated keys before ours is ever offered.
    expect(command, 'IdentitiesOnly was missing').toContain('-o IdentitiesOnly=yes')
    expect(command).toContain('svc-abc@ssh.us-west-1.example')
    // The gateway is on :2222 and :22 is closed: a pasted command without -p
    // fails before the credential is ever offered.
    expect(command.split(/\s+/), 'the port was not passed').toEqual(expect.arrayContaining(['-p', '2222']))
  })

  it('prints the port the plane returned, not 2222 by habit', () => {
    const argv = sshAdvice({ ...base, configured: false, port: 22 })[0]!.split(/\s+/)
    expect(argv[argv.indexOf('-p') + 1]).toBe('22')
    expect(sshAdvice({ ...base, configured: true, port: 22 })[0]).toContain('(port 22)')
  })

  it('quotes paths containing a space, since the line is meant to be pasted', () => {
    const command = sshAdvice({
      ...base, configured: false,
      identityFile: '/Users/Jun Wen/.insta/ssh/id_ed25519',
      certificateFile: '/Users/Jun Wen/.insta/ssh/api.insta-cert.pub',
    })[0]!
    expect(command).toContain(`-i '/Users/Jun Wen/.insta/ssh/id_ed25519'`)
    expect(command).toContain(`-o CertificateFile='/Users/Jun Wen/.insta/ssh/api.insta-cert.pub'`)
  })

  it('still tells the unconfigured user how to GET the alias', () => {
    // Suppressing the alias entirely would hide the feature; the fix is to
    // name the step, not to drop the mention.
    const out = sshAdvice({ ...base, configured: false }).join('\n')
    expect(out).toContain('--setup')
    expect(out).toContain('insta compute ssh api --setup')
    expect(out).toContain('api.insta')
  })

  it('reports the expiry either way', () => {
    for (const configured of [true, false]) {
      expect(sshAdvice({ ...base, configured }).at(-1)).toContain('2026-09-14T22:00:00Z')
    }
  })
})

describe('the renewal hook enters through an internal command name', () => {
  it('uses the __-prefixed command telemetry skips', () => {
    // OpenSSH runs this while PARSING the config -- on every ssh, scp, `ssh -G`
    // and IDE connection. Under `compute ssh --ensure-cert`, guard awaited
    // trackCommand() after the action regardless of how early the action
    // returned: it reads global and project config, can create
    // ~/.insta/telemetry.json, and issues a PostHog request with a timeout of
    // up to 1.5s. A network round trip on the critical path of every ordinary
    // ssh is exactly what the hook was specified not to do. trackCommand skips
    // command paths beginning `__` (the rule __update-check already relies on),
    // so the fast path is only genuinely local under that name.
    expect(ENSURE_CERT_COMMAND).toContain('__')
    expect(ENSURE_CERT_COMMAND.split(/\s+/).some((t) => t.startsWith('__')),
      'the hook command is not __-prefixed, so telemetry runs on every ssh').toBe(true)
    expect(ENSURE_CERT_COMMAND).not.toContain('--ensure-cert')
  })
})

describe('the port an alias dials', () => {
  it('is the one the store holds', () => {
    expect(hostEntries({ 'api.insta': rec({ port: 22 }) as never })[0]?.port).toBe(22)
  })
  it('defaults to 2222 for a record written before the plane said which port', () => {
    // Those aliases dialled :22 and could not connect; reading them as :2222
    // is what makes an existing setup start working without another --setup.
    expect(isValidAliasRecord(rec())).toBe(true)
    expect(hostEntries({ 'api.insta': rec() as never })[0]?.port).toBe(2222)
  })
})
