import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each([false, true])('stores credentials privately with an existing config: %s', (existing) => {
  const home = mkdtempSync(join(tmpdir(), 'insta-config-mode-'))
  const dir = join(home, '.insta')
  const file = join(dir, 'config.json')
  const config = { apiUrl: 'https://test.invalid', accessToken: 'test-access', refreshToken: 'test-refresh' }
  try {
    if (existing) {
      mkdirSync(dir)
      chmodSync(dir, 0o755)
      writeFileSync(file, '{}')
      chmodSync(file, 0o644)
    }
    const script = `import { writeGlobal } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
      process.umask(0o022);
      await writeGlobal(${JSON.stringify(config)});`
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(config)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30_000)
