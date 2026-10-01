import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { canSymlink } from './support/can-symlink.js'

for (const layout of ['new', 'existing', 'symlink']) {
  it.skipIf(layout === 'symlink' && !canSymlink)(`stores credentials privately with a ${layout} config directory`, () => {
    const home = mkdtempSync(join(tmpdir(), 'insta-config-mode-'))
    const dir = join(home, '.insta')
    const file = join(dir, 'config.json')
    const config = { apiUrl: 'https://test.invalid', accessToken: 'test-access', refreshToken: 'test-refresh' }
    try {
      if (layout === 'symlink') {
        const shared = join(home, 'shared')
        mkdirSync(shared)
        symlinkSync(shared, dir, 'junction')
      }
      if (layout !== 'new') {
        if (layout === 'existing') mkdirSync(dir)
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
      if (layout === 'symlink') expect(lstatSync(dir).isSymbolicLink()).toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(dir).mode & 0o777).toBe(layout === 'symlink' ? 0o755 : 0o700)
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
}
