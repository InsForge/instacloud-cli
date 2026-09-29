// CI entry for rule 6. Reads the leaves this pull request added out of the surface.json diff, and
// checks the pull request body declares what MCP does about them.
//
// Diffing the committed surface.json rather than rebuilding the base tree: the base's leaves are
// already in git, so this needs no second checkout and no second npm install, and the added lines
// show up in the pull request diff where a reviewer sees them too.
import { readFileSync } from 'node:fs'

const base = process.env.BASE_REF
if (!base) { console.error('BASE_REF is required'); process.exit(1) }

const { addedLeaves, gitBaseReader, parseSurface } = await import('../src/surface.ts')
const current = parseSurface(readFileSync('surface.json', 'utf8'), 'surface.json')
const added = addedLeaves(gitBaseReader(`origin/${base}`), current)

const { checkDeclaration } = await import('../src/mcp-declaration.ts')
const verdict = checkDeclaration(added, process.env.PR_BODY)

if (verdict.ok) {
  console.log(added.length ? `declared: ${added.join(', ')}` : 'no leaf command added')
  process.exit(0)
}
console.error(verdict.message)
process.exit(1)
