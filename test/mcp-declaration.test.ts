import { describe, expect, it } from 'vitest'
import { checkDeclaration } from '../src/mcp-declaration.js'
import { leafPaths } from '../src/surface.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const body = (section: string) => `## What\n\nAdds a thing.\n\n## MCP\n\n${section}\n\n## Verify\n\nnpm test\n`

describe('checkDeclaration', () => {
  it('passes a pull request that adds no leaf, whatever the body says', () => {
    expect(checkDeclaration([], '')).toEqual({ ok: true })
    expect(checkDeclaration([], null)).toEqual({ ok: true })
  })

  it('accepts a linked MCP pull request', () => {
    expect(checkDeclaration(['cron create'], body('InsForge/instacloud-mcp#123 adds insta_create_cron_job')).ok).toBe(true)
  })

  it('accepts each of the three named exemptions', () => {
    for (const reason of ['credential minting', 'needs this machine', 'platform denies agents']) {
      expect(checkDeclaration(['tokens create'], body(`no MCP tool: ${reason}`)).ok, reason).toBe(true)
    }
  })

  it('accepts a product decision that points at an issue', () => {
    expect(checkDeclaration(['cron create'], body('no MCP tool: product decision, InsForge/instacloud-mcp#456')).ok).toBe(true)
  })

  // The whole point of the enumerated forms.
  it('refuses a deferral dressed as a reason', () => {
    for (const reason of ['later', 'not now', 'will do in a follow up', 'product decision']) {
      expect(checkDeclaration(['cron create'], body(`no MCP tool: ${reason}`)).ok, reason).toBe(false)
    }
  })

  it('refuses a body with no MCP section and says so', () => {
    const v = checkDeclaration(['cron create'], '## What\n\nAdds cron.\n')
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.message).toContain('no "## MCP" section')
      expect(v.message).toContain('cron create')
    }
  })

  it('refuses an empty body', () => {
    expect(checkDeclaration(['cron create'], '').ok).toBe(false)
    expect(checkDeclaration(['cron create'], null).ok).toBe(false)
  })

  // A link in the What section is prose about the change, not a declaration about the command.
  it('does not count a link outside the MCP section', () => {
    expect(checkDeclaration(['cron create'], '## What\n\nSee InsForge/instacloud-mcp#123 for context.\n').ok).toBe(false)
  })

  it('stops reading at the next heading', () => {
    const b = '## MCP\n\nnothing yet\n\n## Verify\n\nInsForge/instacloud-mcp#123\n'
    expect(checkDeclaration(['cron create'], b).ok).toBe(false)
  })

  it('names every added leaf, so the author does not have to diff by hand', () => {
    const v = checkDeclaration(['cron create', 'cron list'], '')
    if (!v.ok) expect(v.message).toContain('cron create, cron list')
  })
})

describe('surface.json', () => {
  // The gate diffs this file, so a stale one would silently stop the gate from ever firing.
  it('matches the live command tree', async () => {
    process.env.INSTA_DUMP_SURFACE = '1'
    const { program } = await import('../src/index.js')
    const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../surface.json', import.meta.url)), 'utf8'))
    expect(committed.leaves, 'run `npm run surface` and commit the result').toEqual(leafPaths(program))
  })
})
