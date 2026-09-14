// `insta run -- <cmd>`: the Railway model — credentials are fetched per invocation and injected
// into the child's environment only. Nothing touches disk, nothing can be committed.
// And when `insta secrets` DOES write .env, it must gitignore what it wrote.
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithSecrets } from '../src/commands/run.js'
import { ensureIgnored } from '../src/commands/secrets.js'

test('run injects the bundle into the child env and passes the exit code through', async () => {
  const code = await runWithSecrets(
    process.execPath,
    ['-e', 'process.exit(process.env.DATABASE_URL === "pg://branch-db" && process.env.MY_FLAG === "on" ? 7 : 1)'],
    { fetchBundle: async () => ({ secrets: { DATABASE_URL: 'pg://branch-db', MY_FLAG: 'on' }, collisions: [] }) },
  )
  expect(code).toBe(7) // exact child exit code, proving env arrived AND passthrough works
})

test('run writes nothing to disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-run-'))
  await runWithSecrets(process.execPath, ['-e', 'process.exit(0)'],
    { fetchBundle: async () => ({ secrets: { SECRET: 'x' }, collisions: [] }), cwd: dir })
  expect(existsSync(join(dir, '.env'))).toBe(false)
})

test('ensureIgnored appends the env file to .gitignore once, only in git repos', () => {
  const repo = mkdtempSync(join(tmpdir(), 'insta-gi-'))
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  expect(ensureIgnored(repo, '.env')).toBe(true)
  expect(ensureIgnored(repo, '.env')).toBe(false) // idempotent
  expect(readFileSync(join(repo, '.gitignore'), 'utf8').match(/^\.env$/m)).toBeTruthy()

  const notRepo = mkdtempSync(join(tmpdir(), 'insta-nogit-'))
  expect(ensureIgnored(notRepo, '.env')).toBe(false)
  expect(existsSync(join(notRepo, '.gitignore'))).toBe(false)
})
