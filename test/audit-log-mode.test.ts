import { mkdtempSync, rmSync, statSync } from 'node:fs'
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
})
