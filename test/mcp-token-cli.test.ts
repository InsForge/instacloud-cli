import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

test.each([true, false])('CLI exits nonzero for failed token registration (stored login: %s)', async (loggedIn) => {
  const home = await mkdtemp(join(tmpdir(), 'insta-mcp-token-cli-'))
  const requests: Array<{ url?: string; agent?: string; signed: boolean }> = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, agent: req.headers['insta-actor-type'] as string, signed: !!req.headers['insta-agent-signature'] })
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/agent/sessions') {
      res.end(JSON.stringify({ token: 'test-bootstrap-token', agentSessionId: 'test-session', projectId: null }))
    } else {
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'unclassified_agent_action' }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    const apiUrl = `http://127.0.0.1:${address.port}`
    const bin = join(home, 'bin')
    await mkdir(bin)
    await mkdir(join(home, '.insta'))
    await writeFile(join(home, '.insta', 'config.json'), JSON.stringify({ apiUrl, ...(loggedIn ? { accessToken: 'test-user-session' } : {}) }))
    const callsFile = join(home, 'claude-calls.jsonl')
    const script = join(bin, 'claude-stub.cjs')
    await writeFile(script, `require('fs').appendFileSync(process.env.CLAUDE_CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(process.argv[3] === 'get' ? 1 : 0)`)
    if (process.platform === 'win32') {
      await writeFile(join(bin, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
    } else {
      await writeFile(join(bin, 'claude'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 })
    }
    const childEnv = { ...process.env, HOME: home, USERPROFILE: home,
      PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      INSTA_API_URL: apiUrl, INSTA_MCP_URL: `${apiUrl}/mcp`, INSTA_NO_AUTOUPDATE: '1', INSTA_NO_TELEMETRY: '1',
      CLAUDE_CALLS_FILE: callsFile,
    }
    for (const key of ['INSTA_ENV', 'INSTA_PROJECT_ID', 'INSTA_ORG_ID', 'INSTA_BRANCH']) delete childEnv[key as keyof typeof childEnv]
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loader, entry,
        '--agent', 'mcp', 'install', '--agent', 'claude-code', '--mcp-token'], { cwd: home, env: childEnv })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')) }, 10000)
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
    expect(output.code).toBe(1)
    if (loggedIn) {
      expect(output.stderr).toContain('unclassified_agent_action (HTTP 403)')
      expect(output.stdout).not.toContain('needs a login')
      expect(requests.map((req) => req.url)).toEqual(['/agent/sessions', '/tokens'])
      expect(requests[1]).toMatchObject({ agent: 'agent', signed: true })
    } else {
      expect(output.stdout).toContain('needs a login')
      expect(requests).toEqual([])
    }
    const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(calls.some((args) => args[1] === 'add')).toBe(false)
    expect(output.stdout + output.stderr).not.toContain('test-user-session')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
