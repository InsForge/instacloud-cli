import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../src/api.js'
import { mintMcpToken, registerMcp, setupAgent, type Runner } from '../src/commands/setup.js'
import { mcpInstall } from '../src/commands/mcp.js'
import { ENVS } from '../src/env.js'

const originalExitCode = process.exitCode
const env = { ...process.env }
beforeEach(() => {
  process.exitCode = undefined
  process.env.INSTA_API_URL = ENVS.prod.api
  delete process.env.INSTA_ENV
  delete process.env.INSTA_MCP_URL
})
afterEach(() => {
  process.exitCode = originalExitCode
  for (const key of ['INSTA_API_URL', 'INSTA_ENV', 'INSTA_MCP_URL']) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  vi.restoreAllMocks()
})

const absentRegistration: Runner = async (_cmd, args) => ({ ok: args[1] !== 'get' })
const noLogin = { ask: async () => false, login: async () => {}, stdinTty: false, stdoutTty: false }

test('mintMcpToken returns null only when no credential is stored', async () => {
  const request = vi.fn()
  expect(await mintMcpToken({ config: { apiUrl: ENVS.prod.api }, request })).toBeNull()
  expect(request).not.toHaveBeenCalled()
})

test.each([
  new ApiError(403, 'unclassified_agent_action', { error: 'unclassified_agent_action' }),
  new ApiError(401, 'unauthorized', { error: 'unauthorized' }),
  new TypeError('fetch failed', { cause: new Error('ECONNRESET') }),
])('mintMcpToken preserves API and transport failures: %s', async (error) => {
  const api = { config: { apiUrl: ENVS.prod.api, accessToken: 'test-session' }, request: vi.fn().mockRejectedValue(error) }
  await expect(mintMcpToken(api)).rejects.toBe(error)
  expect(api.request).toHaveBeenCalledOnce()
})

test.each([{}, { token: '' }, { token: 42 }])('an invalid token response is an error, not missing login: %j', async (body) => {
  const api = { config: { apiUrl: ENVS.prod.api, accessToken: 'test-session' }, request: vi.fn().mockResolvedValue(body) }
  await expect(mintMcpToken(api)).rejects.toThrow(/did not return a token/)
})

test('a token failure makes no registration writes and keeps the structured error', async () => {
  const error = new ApiError(403, 'unclassified_agent_action', { error: 'unclassified_agent_action' })
  const run = vi.fn(absentRegistration)
  await expect(registerMcp(run, async () => { throw error }, true)).rejects.toBe(error)
  expect(run.mock.calls.some(([, args]) => args[1] === 'add')).toBe(false)
})

test('existing registration is untouched even when --mcp-token is requested', async () => {
  const run = vi.fn(async () => ({ ok: true }))
  const mint = vi.fn(async () => 'test-token')
  expect(await registerMcp(run, mint, true)).toBe('existing')
  expect(mint).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledTimes(2)
})

test('setup --mcp-token fails if logged out even when another client is configured', async () => {
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  await setupAgent({ yes: true, mcpToken: true }, absentRegistration, async () => null,
    async () => ['Cursor'], async () => {}, async () => ({ apiUrl: ENVS.prod.api }), async () => {}, noLogin)
  expect(process.exitCode).toBe(1)
  expect(out).not.toContain('ready to use InstaCloud')
})

test('a post-login token denial is not swallowed as a failed browser login', async () => {
  let signedIn = false
  const error = new ApiError(403, 'unclassified_agent_action')
  let out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  await expect(setupAgent({ mcpToken: true }, absentRegistration,
    async () => { if (!signedIn) return null; throw error },
    async () => [], async () => {}, async () => ({ apiUrl: ENVS.prod.api }), async () => {},
    { ask: async () => true, login: async () => { signedIn = true }, stdinTty: true, stdoutTty: true },
    async () => {}, async () => {}, async () => false,
  )).rejects.toBe(error)
  expect(out).not.toContain('login did not complete')
  expect(out).not.toContain('ready to use InstaCloud')
})

test.each(['no-token', 'failed', 'no-claude'] as const)('mcp install --mcp-token rejects incomplete Claude registration: %s', async (status) => {
  const otherClients = vi.fn(async () => ['Cursor'])
  await mcpInstall({ mcpToken: true }, async () => status, otherClients)
  expect(process.exitCode).toBe(1)
  expect(otherClients).not.toHaveBeenCalled()
})

test('mcp install keeps token failures instead of moving on to other clients', async () => {
  const error = new ApiError(403, 'unclassified_agent_action')
  const otherClients = vi.fn(async () => ['Cursor'])
  await expect(mcpInstall({ mcpToken: true }, async () => { throw error }, otherClients)).rejects.toBe(error)
  expect(otherClients).not.toHaveBeenCalled()
})

test('mcp install rejects --mcp-token for an unsupported client before writing config', async () => {
  const register = vi.fn(async () => 'new' as const)
  const configs = vi.fn(async () => ['Cursor'])
  await expect(mcpInstall({ agent: 'cursor', mcpToken: true }, register, configs)).rejects.toThrow(/Claude Code only/)
  expect(register).not.toHaveBeenCalled()
  expect(configs).not.toHaveBeenCalled()
})

test('OAuth auto-detection still configures other clients when Claude is absent', async () => {
  const configs = vi.fn(async () => ['Cursor'])
  await mcpInstall({}, async () => 'no-claude', configs)
  expect(configs).toHaveBeenCalledOnce()
  expect(process.exitCode).toBeUndefined()
})
