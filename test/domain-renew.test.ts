import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { cliVersion } from '../src/version.js'

it('domain renew sends only the selected renewal setting through the CLI', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'insta-domain-renew-'))
  const updateCache = join(scratch, 'update-check.json')
  writeFileSync(updateCache, JSON.stringify({ checkedAt: Date.now(), latest: cliVersion() }))
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const response = { domainName: 'example.com', autorenew: false, locked: true }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method!, path: req.url!, body: body ? JSON.parse(body) : undefined })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: scratch, USERPROFILE: scratch,
    INSTA_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    INSTA_UPDATE_CACHE: updateCache, INSTA_NO_AUTOUPDATE: '1', INSTA_NO_TELEMETRY: '1',
  }
  for (const key of ['CODEX_THREAD_ID', 'CODEX_CI', 'CLAUDECODE', 'CURSOR_AGENT', 'INSTA_ENV']) delete env[key]
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'domain', 'renew', 'example.com', 'off', '--org', 'org9', '--json',
    ], { cwd: scratch, env, timeout: 15_000 })
    expect(calls).toEqual([{ method: 'PATCH', path: '/orgs/org9/domains/example.com', body: { autorenew: false } }])
    expect(JSON.parse(stdout)).toEqual(response)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}, 20_000)
