// known_hosts is the file that decides what the machine TRUSTS, and unlike
// ssh_config it is newline-delimited with no fencing: an unvalidated value does
// not corrupt one line, it appends whatever it likes. Both inputs here arrive
// in an HTTP response body, so they are checked at the boundary rather than
// trusted for where they came from.
import { describe, it, expect } from 'vitest'
import {
  renderCertAuthority, upsertCertAuthority, parseCAPublicKey, isSafeCAHostPattern, isSafeSSHHost,
  CA_MARKER,
} from '../src/commands/ssh-config.js'
import { hostPatternFor } from '../src/commands/compute.js'

const CA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICAcaFakeCAKeyForTestsOnlyAAAAAAAAAAAAAAAAAAAA'
const PATTERN = 'ssh.*.compute.example'

describe('a certificate authority value is parsed, not interpolated', () => {
  it('accepts the real shape and keeps both fields verbatim', () => {
    const { type, blob } = parseCAPublicKey(CA)
    expect(type).toBe('ssh-ed25519')
    expect(blob).toBe(CA.split(' ')[1])
    expect(renderCertAuthority(PATTERN, CA)).toBe(`@cert-authority ${PATTERN} ${CA} ${CA_MARKER}\n`)
  })

  it('accepts a trailing comment without letting it into the line', () => {
    // `ssh-keygen` writes `<type> <blob> user@host`. The comment is legal input
    // and must not be echoed into a file where it is not a comment.
    const out = renderCertAuthority(PATTERN, `${CA} ca@insta.example`)
    expect(out).not.toContain('ca@insta.example')
    expect(out.split('\n').filter(Boolean)).toHaveLength(1)
  })

  const hostile: Array<[string, string]> = [
    ['a second known_hosts line', `${CA}\n@cert-authority * ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEvilKeyTrustedForEverythingAAAAAAAAAA`],
    ['a carriage-return smuggled line', `${CA}\r@cert-authority * ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEvilKeyAAAAAAAAAAAAAAAAAAAAAAAAA`],
    ['an unsupported key type', 'ssh-dss AAAAC3NzaC1lZDI1NTE5AAAAIWeakAlgorithmNobodyShouldTrustAAAAAAAAAAA'],
    ['a type with no body', 'ssh-ed25519'],
    ['a non-base64 body', 'ssh-ed25519 not-base64!!$$%%^^&&**(())____++++====----~~~~````'],
    ['a body too short to be a key', 'ssh-ed25519 AAAA'],
    ['an empty string', ''],
    ['only whitespace', '   '],
  ]
  for (const [what, value] of hostile) {
    it(`refuses ${what}`, () => {
      expect(() => parseCAPublicKey(value), `${JSON.stringify(value.slice(0, 40))} was accepted`).toThrow()
      expect(() => renderCertAuthority(PATTERN, value)).toThrow()
    })
  }

  it('refuses a non-string', () => {
    for (const v of [undefined, null, 42, {}, ['ssh-ed25519', 'AAAA']]) expect(() => parseCAPublicKey(v)).toThrow()
  })

  it('never appends a smuggled line to an existing known_hosts', () => {
    // The end-to-end property: the file is the thing being protected, so assert
    // on the file rather than only on the parser.
    const existing = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGithubHostKeyAAAAAAAAAAAAAAAAAAA\n'
    expect(() => upsertCertAuthority(existing, PATTERN, `${CA}\n@cert-authority * ${CA}`)).toThrow()
  })
})

describe('a trust anchor is never scoped wider than the ssh names', () => {
  it('accepts the pattern hostPatternFor produces', () => {
    expect(isSafeCAHostPattern('ssh.*.compute.example')).toBe(true)
    expect(isSafeCAHostPattern('ssh.us-west-1.compute.example')).toBe(true)
  })

  it('accepts an EXACT host, which is what a short name falls back to', () => {
    // No wildcard means no widening, so there is nothing to bound: anchoring
    // the exact host is always at least as narrow as naming it in known_hosts
    // directly. This is the fallback hostPatternFor takes rather than producing
    // a dangerous wildcard.
    expect(isSafeCAHostPattern('compute.example')).toBe(true)
    expect(isSafeCAHostPattern('ssh.example.com')).toBe(true)
  })

  const wide: Array<[string, unknown]> = [
    ['a bare wildcard, which would trust our CA for github.com', '*'],
    ['a wildcard TLD', '*.*'],
    ['two wildcard labels', 'ssh.*.*.example'],
    ['a single label', 'example'],
    // `ssh.*.com` is the shape that makes this rule about the WILDCARD's depth
    // rather than the label count: three labels, and it hands the CA authority
    // over ssh.vendor.com and every other `ssh.<anything>.com`.
    ['a wildcard directly under a public suffix', 'ssh.*.com'],
    ['a wildcard with only one label after it', 'ssh.*.example'],
    ['a leading wildcard, which covers every tenant service name', '*.compute.example'],
    ['a value with a space', 'ssh.*.compute.example evil.example'],
    ['a value with a newline', 'ssh.*.compute.example\n@cert-authority *'],
    ['an empty string', ''],
    ['a non-string', 42],
  ]
  for (const [what, v] of wide) {
    it(`refuses ${what}`, () => {
      expect(isSafeCAHostPattern(v), `${JSON.stringify(v)} was accepted as a CA scope`).toBe(false)
      expect(() => renderCertAuthority(v as string, CA)).toThrow()
    })
  }
})

describe('the ssh host the plane returns is checked before it is stored', () => {
  it('accepts an ordinary regional gateway name', () => {
    expect(isSafeSSHHost('ssh.us-west-1.compute.example')).toBe(true)
    expect(isSafeSSHHost('ssh.eu-central-1.compute.instacloud.tech')).toBe(true)
  })

  const bad: Array<[string, unknown]> = [
    ['a space', 'ssh.example.com evil'],
    ['a newline', 'ssh.example.com\n  ProxyCommand sh'],
    ['a backslash', 'ssh.example\\.com'],
    ['a single label', 'localhost'],
    ['a leading dot', '.example.com'],
    ['a trailing dot', 'example.com.'],
    ['a wildcard', '*.example.com'],
    ['an empty string', ''],
    ['a non-string', null],
  ]
  for (const [what, v] of bad) {
    it(`refuses a host with ${what}`, () => expect(isSafeSSHHost(v)).toBe(false))
  }
})


describe('widening the region label never escapes the gateway domain', () => {
  it('widens the region when two fixed labels remain after it', () => {
    expect(hostPatternFor('ssh.us-west-1.compute.example')).toBe('ssh.*.compute.example')
    expect(hostPatternFor('ssh.eu-central-1.compute.instacloud.tech')).toBe('ssh.*.compute.instacloud.tech')
  })

  // The finding. `ssh.example.com` is a hostname isSafeSSHHost accepts, and
  // blindly replacing its second label produced `ssh.*.com` -- making the
  // platform's CA authoritative for ssh.vendor.com, ssh.google.com and every
  // other `ssh.<anything>.com`. Narrower-and-works beats wider-and-guesses, so
  // a name that cannot be widened safely is anchored exactly.
  const exact = ['ssh.example.com', 'example.com', 'gateway.internal', 'a.b.c']
  for (const host of exact) {
    it(`anchors ${host} exactly rather than widening it`, () => {
      const pattern = hostPatternFor(host)
      expect(pattern, 'the CA was widened across an unrelated domain').toBe(host)
      expect(pattern).not.toContain('*')
      expect(isSafeCAHostPattern(pattern), 'the fallback produced a pattern setup would then reject').toBe(true)
    })
  }

  it('produces a pattern the validator accepts, for every host the validator accepts', () => {
    // The two used to disagree: isSafeSSHHost accepted a two-label host,
    // hostPatternFor passed it through, and isSafeCAHostPattern then refused it
    // -- so setup failed AFTER the certificate had been minted and stored.
    for (const host of ['ssh.us-west-1.compute.example', 'ssh.example.com', 'example.com', 'a.b.c.d.e']) {
      expect(isSafeSSHHost(host), host).toBe(true)
      expect(isSafeCAHostPattern(hostPatternFor(host)), `setup would fail after minting for ${host}`).toBe(true)
    }
  })
})
