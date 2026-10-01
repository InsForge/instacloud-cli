import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { cliVersion } from '../src/version.js'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href

it.each([0, 8080])('preserves port %i through service creation, image deploy and source deploy', async port => {
  const scratch = mkdtempSync(join(tmpdir(), 'insta-worker-port-'))
  const source = join(scratch, 'source')
  mkdirSync(source)
  const updateCache = join(scratch, 'update-check.json')
  // A fresh cache prevents a detached update check from retaining the Windows fixture directory.
  writeFileSync(updateCache, JSON.stringify({ checkedAt: Date.now(), latest: cliVersion() }))
  writeFileSync(join(source, 'Dockerfile'), 'FROM scratch\nEXPOSE 3000\n')
  const posts: Array<{ path: string; body: any }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const path = req.url!.split('?')[0]!
      const body = raw ? JSON.parse(raw) : undefined
      const live = { state: 'live', imageRef: 'ghcr.io/acme/worker', url: port === 0 ? '' : 'https://app.example', branch: 'main', group: 'worker' }
      let response: unknown
      if (req.method === 'POST') posts.push({ path, body })
      if (path.endsWith('/services')) response = { service: { id: 'svc', ...body } }
      else if (path.endsWith('/deploy')) response = live
      else if (path.endsWith('/source-build')) response = { lane: 'archive', limits: { maxArchiveBytes: 1_000_000, maxExtractedBytes: 1_000_000, maxFiles: 100 } }
      else if (path.includes('/build-uploads/')) response = { state: 'valid', size: 100 }
      else if (path.endsWith('/archive-deploys')) response = { operationId: 'op_1' }
      else if (path.endsWith('/archive-deploys/op_1')) response = live
      else if (path.includes('/builds/archive/op_1/logs')) response = { state: 'unsupported', steps: [], entries: [] }
      else { res.statusCode = 404; response = { error: `unexpected ${req.method} ${path}` } }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: scratch, USERPROFILE: scratch,
    INSTA_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    INSTA_PROJECT_ID: 'p1', INSTA_BRANCH: 'main', INSTA_UPDATE_CACHE: updateCache, INSTA_NO_AUTOUPDATE: '1', INSTA_NO_TELEMETRY: '1',
  }
  for (const key of ['CODEX_THREAD_ID', 'CODEX_CI', 'CLAUDECODE', 'CURSOR_AGENT', 'INSTA_ENV']) delete env[key]
  async function run(args: string[]) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, entry, ...args], { cwd: source, env })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    })
  }
  try {
    for (const args of [
      ['service', 'add', 'compute', 'worker'],
      ['deploy', '--image', 'ghcr.io/acme/worker', '--group', 'worker'],
      ['deploy', '.', '--group', 'worker'],
    ]) {
      const out = await run([...args, '--port', String(port), '--json'])
      expect(out.status, out.stderr).toBe(0)
      expect(posts.at(-1)?.body.port).toBe(port)
      if (args[0] === 'deploy') expect(JSON.parse(out.stdout).url).toBe(port === 0 ? '' : 'https://app.example')
    }
    expect(posts.map(p => p.path)).toEqual(['/projects/p1/services', '/projects/p1/deploy', '/projects/p1/archive-deploys'])
    const invalid = await run(['deploy', '.', '--port', '0x0'])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toMatch(/port must be an integer/)
    expect(posts).toHaveLength(3)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)
