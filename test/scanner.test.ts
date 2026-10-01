import { describe, it, expect } from 'vitest'
import { scanEvent, isSecretFile } from '../src/observe/scanner.js'

describe('credential scanner', () => {
  it('flags a secret written into a non-secret file as a high exposure', () => {
    const f = scanEvent({ tool_name: 'Write', tool_input: { file_path: 'src/app.ts', content: 'const k = "sk_live_abcdef0123456789ABCDEF"' } })
    const hit = f.find((x) => x.detector === 'stripe_secret_key')
    expect(hit).toBeTruthy()
    expect(hit!.kind).toBe('exposure')
    expect(hit!.severity).toBe('high')
  })

  it('detects a DB connection string with an inline password', () => {
    const f = scanEvent({ tool_name: 'Bash', tool_input: { command: 'psql postgres://user:secretpass@db:5432/app' } })
    expect(f.some((x) => x.detector === 'db_conn_string')).toBe(true)
  })

  it('flags a secret in an outbound network command as an exposure', () => {
    const f = scanEvent({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer eyJabc.defghijkl.mnopqrstuv" https://x' } })
    expect(f.some((x) => x.kind === 'exposure' && x.sink === 'network')).toBe(true)
  })

  it('ignores placeholders and code references', () => {
    expect(scanEvent({ tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'password = "changeme"' } })).toEqual([])
    expect(scanEvent({ tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'password = process.env.DB_PASS' } })).toEqual([])
  })

  it('treats reading a .env as an informational touch, not an exposure', () => {
    const f = scanEvent({ tool_name: 'Read', tool_input: { file_path: '.env' } })
    expect(f.length).toBeGreaterThan(0)
    expect(f.every((x) => x.kind === 'touch')).toBe(true)
  })

  it('classifies secret files', () => {
    expect(isSecretFile('.env')).toBe(true)
    expect(isSecretFile('config/prod.pem')).toBe(true)
    expect(isSecretFile('.env.example')).toBe(false)
    expect(isSecretFile('src/index.ts')).toBe(false)
  })

  it('never emits the raw secret — only a fingerprint', () => {
    const f = scanEvent({ tool_name: 'Write', tool_input: { file_path: 'src/app.ts', content: 'const k = "sk_live_abcdef0123456789ABCDEF"' } })
    const hit = f.find((x) => x.detector === 'stripe_secret_key')!
    expect(hit.fingerprint).not.toContain('abcdef0123456789')
    expect(hit.snippet).not.toContain('abcdef0123456789')
    expect(hit.fingerprint).toMatch(/^stripe_secret_key:••••[A-Za-z0-9]{4}:#[0-9a-f]{8}$/)
  })

  it('redacts adjacent secrets in every finding context', () => {
    const first = 'ghp_' + 'a1'.repeat(180)
    const second = 'ghp_' + 'b2'.repeat(18)
    const findings = scanEvent({ tool_name: 'Bash', tool_response: `before ${first} beside ${second} after` })
    expect(findings).toHaveLength(2)
    for (const finding of findings) {
      expect(finding.snippet).not.toContain('a1'.repeat(5))
      expect(finding.snippet).not.toContain('b2'.repeat(5))
      expect(finding.snippet).toContain(finding.fingerprint)
    }
    expect(findings[0]!.snippet).toContain('before')
    expect(findings[1]!.snippet).toContain('after')
  })

  it.each(['', '\n-----END RSA PRIVATE KEY-----'])('redacts private key bodies with ending %j', (ending) => {
    const body = 'MII' + 'c3'.repeat(40)
    const findings = scanEvent({ tool_name: 'Bash', tool_response: `key: -----BEGIN RSA PRIVATE KEY-----\n${body}${ending}${ending ? '\nafter-key-context' : ''}` })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.detector).toBe('private_key_block')
    expect(findings[0]!.snippet).toContain('key:')
    expect(findings[0]!.snippet).not.toContain('c3'.repeat(5))
    if (ending) expect(findings[0]!.snippet).toContain('after-key-context')
  })

  it.each(['private_key=', 'private_key=prefix'])('redacts the complete key when detectors overlap after %s', (prefix) => {
    const body = 'MII' + 'd4'.repeat(40)
    const findings = scanEvent({ tool_name: 'Bash', tool_response: `${prefix}-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----` })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.snippet).not.toContain('d4'.repeat(5))
    expect(findings[0]!.fingerprint).toContain('••••----:')
  })
})
