import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertAliasFree, isValidAliasRecord, readAliasStore, writeAliasStore, hostEntries, sshAdvice,
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
    alias: 'api.insta', host: 'ssh.us-west-1.example', username: 'svc-abc',
    expiresAt: '2026-09-14T22:00:00Z', serviceName: 'api',
  }

  it('offers the short alias once --setup has written it', () => {
    const out = sshAdvice({ ...base, configured: true }).join('\n')
    expect(out).toContain('ssh api.insta')
    expect(out).toContain('svc-abc@ssh.us-west-1.example')
  })

  it('offers the DIRECTLY USABLE command when --setup was omitted', () => {
    // The regression this guards: printing `ssh api.insta` when no ssh_config
    // stanza exists. The user copies it, ssh says "Could not resolve hostname
    // api.insta", and the feature looks broken rather than merely un-set-up.
    const lines = sshAdvice({ ...base, configured: false })
    const command = lines[0]
    expect(command, 'an uninstalled alias was advertised as the command to run').toBe('ssh svc-abc@ssh.us-west-1.example')
    expect(command).not.toContain('api.insta')
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
