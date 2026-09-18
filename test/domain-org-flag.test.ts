// The org verbs take `--org`; `buy` and `attach` do not, because both bind the linked project: buy
// spends the org's money under that project's policy, and attach names one of its services.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { encoding: 'utf8', timeout: 10000 })

it('offers --org on the org-wide domain verbs and on neither write', () => {
  for (const verb of [['list'], ['status'], ['search'], ['records', 'list'], ['records', 'add']]) {
    expect(run('domain', ...verb, '--help').stdout, verb.join(' ')).toContain('--org')
  }
  for (const verb of ['buy', 'attach']) {
    expect(run('domain', verb, '--help').stdout, verb).not.toContain('--org')
    expect(run('domain', verb, 'example.com', '--org', 'o1').stderr, verb).toContain("unknown option '--org'")
  }
})
