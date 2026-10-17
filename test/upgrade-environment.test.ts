import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { upgrade } from '../src/commands/upgrade.js'

const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const environmentStep = installer.slice(installer.indexOf('# ---- environment'), installer.indexOf('# ---- agent setup'))
const repo = fileURLToPath(new URL('..', import.meta.url))

it.skipIf(process.platform === 'win32').each([undefined, 'prod', 'staging'])(
  'binary upgrade preserves saved environment and login with INSTA_ENV=%s', async (override) => {
    const home = mkdtempSync(join(tmpdir(), 'insta-upgrade-env-'))
    const config = join(home, '.insta', 'config.json')
    const saved = { INSTA_ENV: process.env.INSTA_ENV, INSTA_UPDATE_CACHE: process.env.INSTA_UPDATE_CACHE }
    try {
      mkdirSync(join(home, '.insta'))
      const original = JSON.stringify({ apiUrl: 'https://api.staging.instacloud.com', accessToken: 'test-access', refreshToken: 'test-refresh', user: { id: 'test-user' } })
      writeFileSync(config, original)
      writeFileSync(join(home, 'insta'), '#!/bin/sh\nexec "$TEST_NODE" --import tsx "$TEST_CLI" "$@"\n', { mode: 0o755 })
      if (override === undefined) delete process.env.INSTA_ENV
      else process.env.INSTA_ENV = override
      process.env.INSTA_UPDATE_CACHE = join(home, 'update-check.json')
      const runEnvironment = (env: NodeJS.ProcessEnv) => {
        const result = spawnSync('sh', ['-c', `set -eu\n${environmentStep}`], {
          cwd: repo, encoding: 'utf8', timeout: 10_000,
          env: { ...env, HOME: home, INSTALL_DIR: home, BIN: 'insta', ENV_NAME: env.INSTA_ENV ?? '',
            TEST_NODE: process.execPath, TEST_CLI: join(repo, 'src/index.ts'), INSTA_NO_AUTOUPDATE: '1' },
        })
        expect(result.status, result.stderr).toBe(0)
      }
      let installs = 0
      await upgrade('0.0.1', {
        channel: 'binary', latest: '0.0.2', installDir: home, report: () => {}, observe: async () => '0.0.2',
        run: async (spec) => {
          installs++
          expect(spec.env.INSTA_ENV).toBe(override)
          runEnvironment(spec.env)
          expect(readFileSync(config, 'utf8')).toBe(original)
          if (installs === 1) throw new Error('exercise unpinned fallback')
        },
      })
      expect(installs).toBe(2)
      expect(readFileSync(config, 'utf8')).toBe(original)
      runEnvironment({ ...process.env, INSTA_ENV: 'prod', INSTA_UPGRADE: '0' })
      expect(JSON.parse(readFileSync(config, 'utf8')).apiUrl).toBe('https://api.instacloud.com')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(home, { recursive: true, force: true })
    }
  },
)
