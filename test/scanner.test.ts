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

  it('detects a DB connection string whose password contains a slash', () => {
    const f = scanEvent({ tool_name: 'Bash', tool_input: { command: 'psql postgres://user:secret/pass@db:5432/app' } })
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
})
