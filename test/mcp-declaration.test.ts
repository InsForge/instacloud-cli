import { afterAll, describe, expect, it } from 'vitest'
import { checkDeclaration } from '../src/mcp-declaration.js'
import { addedLeaves, gitBaseReader, leafPaths, renderSurface } from '../src/surface.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // An unanchored search matches its own negation, which is the worst kind of false pass.
  it('refuses a form that appears inside a sentence denying it', () => {
    for (const line of [
      'This is not no MCP tool: needs this machine',
      'Related issue InsForge/instacloud-mcp#123, but no matching tool exists',
      'We considered no MCP tool: credential minting and rejected it',
    ]) {
      expect(checkDeclaration(['cron create'], body(line)).ok, line).toBe(false)
    }
  })

  it('refuses a heading that is not exactly two hashes', () => {
    expect(checkDeclaration(['cron create'], '### MCP\n\nno MCP tool: credential minting\n').ok).toBe(false)
    expect(checkDeclaration(['cron create'], '#### MCP\n\nno MCP tool: credential minting\n').ok).toBe(false)
  })

  it('reads only the first non-empty line, so prose cannot hide a declaration below it', () => {
    expect(checkDeclaration(['cron create'], body('We are still deciding.\n\nno MCP tool: credential minting')).ok).toBe(false)
  })

  it('allows the linked form to say what the tool is', () => {
    expect(checkDeclaration(['cron create'], body('InsForge/instacloud-mcp#123 adds insta_create_cron_job')).ok).toBe(true)
  })

  // A pull request template carrying a commented-out example would otherwise declare for everyone.
  it('refuses a section that only exists inside an HTML comment', () => {
    expect(checkDeclaration(['cron create'], '## What\n\nAdds cron.\n\n<!--\n## MCP\n\nno MCP tool: needs this machine\n-->\n').ok).toBe(false)
  })

  it('refuses a section that only exists inside a code fence', () => {
    for (const fence of ['```', '~~~']) {
      const b = `## What\n\nExample:\n\n${fence}\n## MCP\n\nno MCP tool: needs this machine\n${fence}\n`
      expect(checkDeclaration(['cron create'], b).ok, fence).toBe(false)
    }
  })

  it('still reads a real section that sits after a comment or a fence', () => {
    const b = '<!-- a note -->\n\n```\n## MCP\nnot this one\n```\n\n## MCP\n\nno MCP tool: credential minting\n'
    expect(checkDeclaration(['cron create'], b).ok).toBe(true)
  })

  // A closing fence takes the same character, no shorter, and nothing after it but whitespace.
  // Treating "```not a closing fence" as a close would expose headings a reader still sees as code.
  it('does not let a line with text after the backticks close a fence', () => {
    const b = '```\n## MCP\nx\n```not a closing fence\n\n## MCP\n\nInsForge/instacloud-mcp#123\n'
    expect(checkDeclaration(['cron create'], b).ok).toBe(false)
  })

  it('does not let a shorter run or a different character close a fence', () => {
    const shorter = '````\n```\n\n## MCP\n\nInsForge/instacloud-mcp#123\n'
    const other = '```\nx\n~~~\n\n## MCP\n\nno MCP tool: credential minting\n'
    expect(checkDeclaration(['cron create'], shorter).ok, 'shorter').toBe(false)
    expect(checkDeclaration(['cron create'], other).ok, 'other character').toBe(false)
  })

  it('accepts a longer closing run and an opening info string, as Markdown does', () => {
    const longer = '```\nx\n`````\n\n## MCP\n\nno MCP tool: credential minting\n'
    const info = '```js\nconst a = 1\n```\n\n## MCP\n\nno MCP tool: credential minting\n'
    expect(checkDeclaration(['cron create'], longer).ok, 'longer').toBe(true)
    expect(checkDeclaration(['cron create'], info).ok, 'info string').toBe(true)
  })

  // The space after the hashes is CommonMark's and it is load-bearing: "##MCP" renders as the
  // literal text, so a body carrying only that shows a reader no section while the gate saw one.
  it('refuses a heading with no space after the hashes, which renders as text', () => {
    expect(checkDeclaration(['cron create'], '##MCP\n\nno MCP tool: credential minting\n').ok).toBe(false)
  })

  it('accepts the optional closing run of hashes, which renders as the same heading', () => {
    expect(checkDeclaration(['cron create'], '## MCP ##\n\nno MCP tool: credential minting\n').ok).toBe(true)
  })

  // Four spaces is an indented code block, not a fence: it opens nothing, so the heading is real.
  it('does not let a four-space-indented run of backticks swallow the section', () => {
    expect(checkDeclaration(['cron create'], '    ```\n## MCP\n\nno MCP tool: credential minting\n').ok).toBe(true)
  })

  it('still strips a fence indented up to three spaces', () => {
    const b = '   ```\n## MCP\nnot this one\n   ```\n'
    expect(checkDeclaration(['cron create'], b).ok).toBe(false)
  })

  it('ends the section at a heading of any depth', () => {
    const b = '## MCP\n\n# Notes\n\nno MCP tool: credential minting\n'
    expect(checkDeclaration(['cron create'], b).ok).toBe(false)
  })

  it('refuses an empty MCP section and says which it was', () => {
    const v = checkDeclaration(['cron create'], '## MCP\n\n## Verify\n\nnpm test\n')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toContain('is empty')
  })
})

describe('addedLeaves', () => {
  const base = (leaves: string[]) => ({ present: () => true, read: () => JSON.stringify({ leaves }) })

  it('reports what the current surface has and the base did not', () => {
    expect(addedLeaves(base(['a b']), ['a b', 'c d'])).toEqual(['c d'])
  })

  it('reports nothing when the base has no snapshot, which is the commit introducing it', () => {
    expect(addedLeaves({ present: () => false, read: () => { throw new Error('unreachable') } }, ['a b'])).toEqual([])
  })

  it('ignores a leaf the pull request removed', () => {
    expect(addedLeaves(base(['a b', 'c d']), ['a b'])).toEqual([])
  })

  // Each of these used to return null and pass the gate.
  it('throws rather than passing when the base snapshot cannot be read', () => {
    expect(() => addedLeaves({ present: () => true, read: () => { throw new Error('bad object') } }, ['a b'])).toThrow(/bad object/)
  })

  it('throws rather than passing when the base snapshot is malformed', () => {
    expect(() => addedLeaves({ present: () => true, read: () => '{ not json' }, ['a b'])).toThrow(/not JSON/)
    expect(() => addedLeaves({ present: () => true, read: () => '{"leaves":"a b"}' }, ['a b'])).toThrow(/leaves.*array/)
    expect(() => addedLeaves({ present: () => true, read: () => '{}' }, ['a b'])).toThrow(/leaves.*array/)
  })
})

// The CI entry reads the base snapshot out of git, and the difference between "absent" and "broken"
// is the whole gate: a broken read reported as absent is a green check on an undeclared command.
// These run against a real repository rather than a stub, because that distinction is git's, not ours.
describe('gitBaseReader', () => {
  const repos: string[] = []
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

  // A base ref with no remote: update-ref writes refs/remotes/origin/main directly.
  const repo = (baseSurface: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-'))
    repos.push(dir)
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'user.email', 't@example.com')
    git(dir, 'config', 'user.name', 'test')
    writeFileSync(join(dir, 'README'), 'x\n')
    if (baseSurface !== null) writeFileSync(join(dir, 'surface.json'), baseSurface)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'base')
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    return dir
  }

  afterAll(() => { for (const d of repos) rmSync(d, { recursive: true, force: true }) })

  it('reports the leaves a pull request added over the base commit', () => {
    const dir = repo(renderSurface(['cron list']))
    expect(addedLeaves(gitBaseReader('origin/main', dir), ['cron create', 'cron list'])).toEqual(['cron create'])
  })

  it('reports nothing when the base commit has no snapshot yet', () => {
    const dir = repo(null)
    expect(addedLeaves(gitBaseReader('origin/main', dir), ['cron create'])).toEqual([])
  })

  it('throws on a malformed base snapshot rather than reporting nothing', () => {
    const dir = repo('{ not json\n')
    expect(() => addedLeaves(gitBaseReader('origin/main', dir), ['cron create'])).toThrow(/not JSON/)
  })

  it('throws on an unknown ref rather than reporting nothing', () => {
    const dir = repo(renderSurface(['cron list']))
    expect(() => addedLeaves(gitBaseReader('origin/nope', dir), ['cron create'])).toThrow()
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
