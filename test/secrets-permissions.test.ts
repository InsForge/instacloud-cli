import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { secrets } from '../src/commands/secrets.js'

it.each([
  { name: 'new file', mode: undefined, linked: false },
  { name: 'existing readable file', mode: 0o644, linked: false },
  { name: 'existing write-only file', mode: 0o200, linked: false },
  { name: 'symlink target', mode: 0o644, linked: true },
])('writes private secret output: $name', async ({ mode, linked }) => {
  if (linked && process.platform === 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'insta-secrets-permissions-'))
  const cwd = process.cwd()
  const target = join(dir, 'secrets.env')
  const output = linked ? join(dir, '.env') : target
  try {
    process.chdir(dir)
    if (mode !== undefined) {
      writeFileSync(target, 'OLD_SECRET=' + 'old-private-value'.repeat(20) + '\n')
      chmodSync(target, mode)
    }
    if (linked) symlinkSync('secrets.env', output)
    await secrets({ output }, {
      projectId: 'p1', linkedBranch: 'main',
      api: { rawRequest: async () => ({ status: 200, body: { secrets: { PASSWORD: 'private-value' } } }) },
    })
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(mode === 0o200 ? 0o200 : 0o600)
    if (linked) expect(lstatSync(output).isSymbolicLink()).toBe(true)
    chmodSync(target, 0o600)
    expect(readFileSync(target, 'utf8')).toBe('PASSWORD="private-value"\n')
  } finally {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  }
})
