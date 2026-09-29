// Regenerate surface.json from the live command tree. Run `npm run surface` after adding a command.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.INSTA_DUMP_SURFACE = '1'
const { program } = await import('../src/index.ts')
const { leafPaths, renderSurface } = await import('../src/surface.ts')

const out = fileURLToPath(new URL('../surface.json', import.meta.url))
const leaves = leafPaths(program)
writeFileSync(out, renderSurface(leaves))
console.log(`surface.json: ${leaves.length} leaf commands`)
