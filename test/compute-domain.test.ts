// renderRemoveDomain — the `domain detach --json` contract: stdout carries the platform
// response as JSON, never prose. Split out of removeDomain (same pattern as applyExecResult) so
// this is testable without a network mock; the flag was once wired in index.ts without the handler
// honoring it, which is exactly the regression this locks out.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { renderRemoveDomain } from '../src/commands/compute.js'

describe('renderRemoveDomain', () => {
  const stdout: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  afterEach(() => { stdout.length = 0 })
  afterAll(() => { outSpy.mockRestore() })

  const body = { hostname: 'app.example.com', flyApp: 'insta-main-app-123' }

  it('--json: stdout is the platform response as parseable JSON, no prose', () => {
    renderRemoveDomain(body, true)
    expect(JSON.parse(stdout.join(''))).toEqual(body)
    expect(stdout.join('')).not.toMatch(/removed custom domain/)
  })

  it('non-json: prints the human line', () => {
    renderRemoveDomain(body)
    expect(stdout.join('')).toMatch(/removed custom domain app\.example\.com from insta-main-app-123/)
  })
})
