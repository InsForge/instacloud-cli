import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordFindings } from '../src/observe/hook.js'

describe('recordFindings file mode', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('writes audit.jsonl as 0600 under a 0700 .insta directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'insta-audit-'))
    dirs.push(base)
    const n = recordFindings({
      tool_name: 'Bash',
      tool_input: { command: 'psql postgres://user:secretpass@db:5432/app' },
    }, base)
    expect(n).toBeGreaterThan(0)
    if (process.platform === 'win32') return
    expect(statSync(join(base, '.insta')).mode & 0o777).toBe(0o700)
    expect(statSync(join(base, '.insta', 'audit.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('tightens an existing 0755 directory and 0644 audit log', () => {
    if (process.platform === 'win32') return
    const base = mkdtempSync(join(tmpdir(), 'insta-audit-'))
    dirs.push(base)
    const insta = join(base, '.insta')
    const audit = join(insta, 'audit.jsonl')
    mkdirSync(insta, { mode: 0o755 })
    writeFileSync(audit, '', { mode: 0o644 })
    chmodSync(insta, 0o755)
    chmodSync(audit, 0o644)
    recordFindings({
      tool_name: 'Bash',
      tool_input: { command: 'psql postgres://user:secretpass@db:5432/app' },
    }, base)
    expect(statSync(insta).mode & 0o777).toBe(0o700)
    expect(statSync(audit).mode & 0o777).toBe(0o600)
  })
})
