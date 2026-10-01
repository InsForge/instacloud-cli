import { test, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configPath, detectAgents, installFor, renderCodexConfig } from '../src/commands/mcp.js'
import { MCP_SERVER_NAME, DEFAULT_MCP_URL } from '../src/commands/setup.js'

async function tmpHome(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'insta-mcp-test-')) }

test('cursor: fresh install writes mcpServers entry with just a url (OAuth, no credential)', async () => {
  const home = await tmpHome()
  expect(await installFor('cursor', home, DEFAULT_MCP_URL)).toBe('installed')
  const cfg = JSON.parse(await fs.readFile(configPath('cursor', home), 'utf8'))
  expect(cfg.mcpServers[MCP_SERVER_NAME]).toEqual({ url: DEFAULT_MCP_URL })
})

test('cursor: merge preserves existing servers and is idempotent', async () => {
  const home = await tmpHome()
  const file = configPath('cursor', home)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ mcpServers: { other: { url: 'https://x' } } }))
  expect(await installFor('cursor', home, DEFAULT_MCP_URL)).toBe('installed')
  expect(await installFor('cursor', home, DEFAULT_MCP_URL)).toBe('already')
  const cfg = JSON.parse(await fs.readFile(file, 'utf8'))
  expect(cfg.mcpServers.other).toEqual({ url: 'https://x' })
  expect(cfg.mcpServers[MCP_SERVER_NAME].url).toBe(DEFAULT_MCP_URL)
})

test('opencode: remote entry under `mcp` with $schema default', async () => {
  const home = await tmpHome()
  expect(await installFor('opencode', home, DEFAULT_MCP_URL)).toBe('installed')
  const cfg = JSON.parse(await fs.readFile(configPath('opencode', home), 'utf8'))
  expect(cfg.mcp[MCP_SERVER_NAME]).toEqual({ type: 'remote', url: DEFAULT_MCP_URL, enabled: true })
  expect(cfg.$schema).toBe('https://opencode.ai/config.json')
})

test('copilot and factory-droid: http entries with their extra fields', async () => {
  const home = await tmpHome()
  await installFor('copilot', home, DEFAULT_MCP_URL)
  await installFor('factory-droid', home, DEFAULT_MCP_URL)
  const cop = JSON.parse(await fs.readFile(configPath('copilot', home), 'utf8'))
  const fac = JSON.parse(await fs.readFile(configPath('factory-droid', home), 'utf8'))
  expect(cop.mcpServers[MCP_SERVER_NAME]).toEqual({ type: 'http', url: DEFAULT_MCP_URL, tools: ['*'] })
  expect(fac.mcpServers[MCP_SERVER_NAME]).toEqual({ type: 'http', url: DEFAULT_MCP_URL, disabled: false })
})

test('codex: TOML table appended once, existing content preserved', async () => {
  const home = await tmpHome()
  const file = configPath('codex', home)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'model = "gpt-5"\n')
  expect(await installFor('codex', home, DEFAULT_MCP_URL)).toBe('installed')
  expect(await installFor('codex', home, DEFAULT_MCP_URL)).toBe('already')
  const out = await fs.readFile(file, 'utf8')
  expect(out).toContain('model = "gpt-5"')
  expect(out).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`)
  expect(out).toContain(`url = "${DEFAULT_MCP_URL}"`)
})

test('renderCodexConfig appends a newline separator when the file lacks one', () => {
  const out = renderCodexConfig('a = 1', 'https://u')!
  expect(out.startsWith('a = 1\n')).toBe(true)
})

test('renderCodexConfig keeps a quote or newline inside the url string', () => {
  const out = renderCodexConfig(null, 'https://x"\n[mcp_servers.evil]\ncommand = "calc"')!
  expect(out).toContain('url = "https://x\\"\\n[mcp_servers.evil]\\ncommand = \\"calc\\""')
  expect(out.split('\n').some((line) => line.startsWith('command ='))).toBe(false)
})

test('unparseable JSON config is skipped, never clobbered', async () => {
  const home = await tmpHome()
  const file = configPath('cursor', home)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{ this is not json')
  expect(await installFor('cursor', home, DEFAULT_MCP_URL)).toBe('skipped')
  expect(await fs.readFile(file, 'utf8')).toBe('{ this is not json')
})

test('detectAgents only reports agents whose config dir exists', async () => {
  const home = await tmpHome()
  expect(detectAgents(home)).toEqual([])
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true })
  await fs.mkdir(path.join(home, '.codex'), { recursive: true })
  expect(detectAgents(home)).toEqual(['cursor', 'codex'])
})

// ---- environment coexistence ----
// Both environments must be installable on one machine: registration is idempotent BY NAME, so if
// prod and staging shared a name a staging install would be a no-op that silently left the agent
// pointed at prod. These cover the `name` parameter that makes the two distinct.

const STAGING_NAME = 'insta-cloud-staging'
const STAGING_URL = 'https://mcp.staging.instacloud.com/mcp'

test('cursor: a staging install adds a SECOND entry beside prod, clobbering neither', async () => {
  const home = await tmpHome()
  expect(await installFor('cursor', home, DEFAULT_MCP_URL)).toBe('installed')
  expect(await installFor('cursor', home, STAGING_URL, STAGING_NAME)).toBe('installed')
  const cfg = JSON.parse(await fs.readFile(configPath('cursor', home), 'utf8'))
  expect(cfg.mcpServers[MCP_SERVER_NAME]).toEqual({ url: DEFAULT_MCP_URL })
  expect(cfg.mcpServers[STAGING_NAME]).toEqual({ url: STAGING_URL })
  expect(Object.keys(cfg.mcpServers).sort()).toEqual([MCP_SERVER_NAME, STAGING_NAME].sort())
})

test('cursor: staging install is idempotent per name', async () => {
  const home = await tmpHome()
  expect(await installFor('cursor', home, STAGING_URL, STAGING_NAME)).toBe('installed')
  expect(await installFor('cursor', home, STAGING_URL, STAGING_NAME)).toBe('already')
  // ...and prod is still installable afterwards, not reported as "already"
  expect(await installFor('cursor', home, DEFAULT_MCP_URL)).toBe('installed')
})

test('codex TOML: staging appends its own table without touching prod\'s', async () => {
  const home = await tmpHome()
  expect(await installFor('codex', home, DEFAULT_MCP_URL)).toBe('installed')
  expect(await installFor('codex', home, STAGING_URL, STAGING_NAME)).toBe('installed')
  const toml = await fs.readFile(configPath('codex', home), 'utf8')
  expect(toml).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`)
  expect(toml).toContain(`[mcp_servers.${STAGING_NAME}]`)
  expect(toml).toContain(STAGING_URL)
  expect(toml).toContain(DEFAULT_MCP_URL)
})

// The prod name is a strict prefix of the staging name, so a substring-based idempotency check
// would wrongly report staging as "already configured" once prod existed (or vice versa).
test('codex TOML: prod name being a prefix of staging name does not confuse detection', async () => {
  const home = await tmpHome()
  expect(await installFor('codex', home, STAGING_URL, STAGING_NAME)).toBe('installed')
  expect(await installFor('codex', home, DEFAULT_MCP_URL)).toBe('installed')
  expect(renderCodexConfig(await fs.readFile(configPath('codex', home), 'utf8'), STAGING_URL, STAGING_NAME)).toBeNull()
})

test('opencode: staging entry coexists under the mcp key', async () => {
  const home = await tmpHome()
  expect(await installFor('opencode', home, DEFAULT_MCP_URL)).toBe('installed')
  expect(await installFor('opencode', home, STAGING_URL, STAGING_NAME)).toBe('installed')
  const cfg = JSON.parse(await fs.readFile(configPath('opencode', home), 'utf8'))
  expect(cfg.mcp[MCP_SERVER_NAME]).toMatchObject({ url: DEFAULT_MCP_URL, type: 'remote' })
  expect(cfg.mcp[STAGING_NAME]).toMatchObject({ url: STAGING_URL, type: 'remote' })
})
