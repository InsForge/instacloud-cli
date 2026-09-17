import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { encoding: 'utf8', timeout: 10000 })

it('exposes policy only under agent, and rejects the retired top-level names', () => {
  const help = run('--help')
  expect(help.status).toBe(0)
  expect(help.stdout).toMatch(/^\s+agent\s/m)
  expect(help.stdout).not.toMatch(/^\s+policy\s/m)
  expect(help.stdout).not.toMatch(/^\s+agent-policy\s/m)
  for (const retired of [['policy', 'get'], ['agent-policy', 'get']]) {
    const r = run(...retired)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`unknown command '${retired[0]}'`)
  }
  expect(run('agent', 'policy', 'get', '--help').status).toBe(0)
})

it('rejects approval --always instead of promising a permanent grant', () => {
  const help = run('agent', 'approvals', 'approve', '--help')
  expect(help.status).toBe(0)
  expect(help.stdout).not.toContain('--always')
  const retired = run('agent', 'approvals', 'approve', 'test-id', '--always')
  expect(retired.status).not.toBe(0)
  expect(retired.stderr).toContain("unknown option '--always'")
})
