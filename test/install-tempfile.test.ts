import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const setup = installer.slice(installer.indexOf('# ---- agent setup'), installer.indexOf('# ---- PATH:'))

it.skipIf(process.platform === 'win32').each([
  { setupExit: 0, download: false, catFails: false },
  { setupExit: 1, download: false, catFails: false },
  { setupExit: 0, download: true, catFails: false },
  { setupExit: 1, download: true, catFails: false },
  { setupExit: 0, download: true, catFails: true },
])('protects setup diagnostics and cleanup: %j', ({ setupExit, download, catFails }) => {
  const base = mkdtempSync(join(tmpdir(), 'insta-install-temp-'))
  const bin = join(base, 'bin')
  const scratch = join(base, 'temp')
  const target = join(base, 'unrelated')
  const downloadDir = join(base, 'download')
  try {
    mkdirSync(bin)
    mkdirSync(scratch)
    mkdirSync(downloadDir)
    writeFileSync(target, 'preserve this file')
    writeFileSync(join(bin, 'insta'), '#!/bin/sh\nprintf "setup diagnostic\\n" >&2\nexit "$SETUP_EXIT"\n', { mode: 0o755 })
    if (catFails) writeFileSync(join(bin, 'cat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const script = `set -eu
      ${download ? 'tmp="$TEST_DOWNLOAD"; trap \'rm -rf "$tmp"\' EXIT' : ''}
      ln -s "$TEST_TARGET" "$TMPDIR/insta-setup-err.$$"
      ${setup}`
    const result = spawnSync('sh', ['-c', script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, TEST_TARGET: target,
        TEST_DOWNLOAD: downloadDir, INSTALL_DIR: bin, BIN: 'insta', AGENTS: '1', YES: '1', ENV_NAME: '', SETUP_EXIT: String(setupExit) },
      encoding: 'utf8', timeout: 10_000,
    })
    expect(result.status, result.stderr).toBe(catFails ? 1 : 0)
    expect(readFileSync(target, 'utf8')).toBe('preserve this file')
    if (!catFails) expect(result.stderr).toContain('setup diagnostic')
    expect(readdirSync(scratch)).toHaveLength(1)
    if (download) expect(existsSync(downloadDir)).toBe(false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
