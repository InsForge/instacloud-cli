import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Regression guard for the release gate: a `v*` tag (or a dispatch) pointing at a commit that is
// not on main must not build or publish anything — not the GitHub Release, not npm.
const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
const jobs: Record<string, { needs?: string | string[]; steps: { name?: string; run?: string }[] }> = workflow.jobs
const needsOf = (job: string) => [jobs[job].needs ?? []].flat()

const gateStep = jobs['require-main'].steps.find((s) => s.name === 'Require the commit to be on main')

describe('release workflow main-only gate', () => {
  it('has the gate job with no dependencies of its own', () => {
    expect(gateStep?.run).toContain('compare/$SHA...main')
    expect(needsOf('require-main')).toEqual([])
  })

  it('makes every other job depend on the gate directly', () => {
    for (const name of Object.keys(jobs).filter((j) => j !== 'require-main')) {
      expect(needsOf(name), name).toContain('require-main')
    }
  })

  it.skipIf(process.platform === 'win32').each([
    { status: 'ahead', ok: true },
    { status: 'identical', ok: true },
    { status: 'behind', ok: false },
    { status: 'diverged', ok: false },
    { status: '', ok: false },
  ])('compare status $status -> passes=$ok', ({ status, ok }) => {
    // Stub `gh` with a shell function that prints the compare status the API would return.
    const script = `set -e\ngh() { printf '%s\\n' "$STATUS"; }\n${gateStep!.run}`
    const r = spawnSync('bash', ['-c', script], {
      env: { ...process.env, STATUS: status, SHA: 'abc123', GITHUB_REPOSITORY: 'o/r' },
      encoding: 'utf8',
    })
    expect(r.status === 0, r.stdout + r.stderr).toBe(ok)
  })
})
