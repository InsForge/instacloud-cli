// `insta mcp install` — write the insta-cloud remote MCP server into each coding agent's own
// config format. Claude Code is NOT handled here — it has a real registry CLI (`claude mcp add`,
// see setup.ts registerMcp); these are the config-file agents. All entries are OAuth (no
// credential written): each client discovers the platform AS via RFC 9728 and runs the browser
// flow on first use.
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { info } from '../util.js'
import { MCP_SERVER_NAME, registerMcp, requireMcpRegistration, resolveMcpTarget } from './setup.js'

export const MCP_AGENT_TARGETS = ['cursor', 'codex', 'opencode', 'copilot', 'factory-droid'] as const
export type McpAgent = (typeof MCP_AGENT_TARGETS)[number]

export function configPath(slug: McpAgent, home: string): string {
  switch (slug) {
    case 'cursor': return path.join(home, '.cursor', 'mcp.json')
    case 'codex': return path.join(home, '.codex', 'config.toml')
    case 'opencode': return path.join(home, '.config', 'opencode', 'opencode.json')
    case 'copilot': return path.join(home, '.copilot', 'mcp-config.json')
    case 'factory-droid': return path.join(home, '.factory', 'mcp.json')
  }
}

// An agent counts as "on this machine" when its config dir already exists — we configure what's
// installed, never scaffold a tool the user doesn't have.
export function detectAgents(home: string): McpAgent[] {
  return MCP_AGENT_TARGETS.filter((slug) => existsSync(path.dirname(configPath(slug, home))))
}

// Merge our entry into existing JSON config. Returns null (skip, leave file alone) when the
// existing content isn't valid JSON — never clobber a config we can't parse.
export function renderJsonConfig(slug: McpAgent, existing: string | null, url: string, name: string = MCP_SERVER_NAME): string | null {
  let root: any = {}
  if (existing && existing.trim()) {
    try { root = JSON.parse(existing) } catch { return null }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) return null
  }
  if (slug === 'opencode') {
    // OpenCode: `mcp` key, `type: "remote"` schema (docs.opencode.ai).
    root.mcp = { ...(root.mcp ?? {}), [name]: { type: 'remote', url, enabled: true } }
    root.$schema ??= 'https://opencode.ai/config.json'
  } else {
    const entry =
      slug === 'cursor' ? { url } // Cursor auto-detects HTTP from `url`
      : slug === 'copilot' ? { type: 'http', url, tools: ['*'] }
      : { type: 'http', url, disabled: false } // factory-droid
    root.mcpServers = { ...(root.mcpServers ?? {}), [name]: entry }
  }
  return JSON.stringify(root, null, 2) + '\n'
}

// Codex config is TOML. Appending a complete `[mcp_servers.<name>]` table is always valid at
// EOF, so we avoid a TOML parser: string-detect for idempotency, append for install.
export function renderCodexConfig(existing: string | null, url: string, name: string = MCP_SERVER_NAME): string | null {
  const base = existing ?? ''
  if (base.includes(`[mcp_servers.${name}]`)) return null // already configured
  const sep = base.length && !base.endsWith('\n') ? '\n' : ''
  return `${base}${sep}\n[mcp_servers.${name}]\nurl = "${url}"\n`
}

// Install for one agent. Returns 'installed' | 'already' | 'skipped' (unparseable config).
export async function installFor(slug: McpAgent, home: string, url: string, name: string = MCP_SERVER_NAME): Promise<'installed' | 'already' | 'skipped'> {
  const file = configPath(slug, home)
  let existing: string | null = null
  try { existing = await fs.readFile(file, 'utf8') } catch { existing = null }
  if (slug === 'codex') {
    const next = renderCodexConfig(existing, url, name)
    if (next === null) return 'already'
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, next)
    return 'installed'
  }
  if (existing) {
    try {
      const root = JSON.parse(existing)
      const entry = slug === 'opencode' ? root?.mcp?.[name] : root?.mcpServers?.[name]
      if (entry) return 'already'
    } catch { /* fall through to renderJsonConfig, which refuses to clobber */ }
  }
  const next = renderJsonConfig(slug, existing, url, name)
  if (next === null) return 'skipped'
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, next)
  return 'installed'
}

const AGENT_LABELS: Record<McpAgent, string> = {
  cursor: 'Cursor', codex: 'OpenAI Codex', opencode: 'OpenCode', copilot: 'GitHub Copilot', 'factory-droid': 'Factory Droid',
}

// Configure every detected config-file agent (or one forced via `agent`). Returns the labels of
// agents now configured (installed or already present) for the caller's summary line.
export async function installAgentConfigs(agent?: string, home: string = os.homedir()): Promise<string[]> {
  const { name, url } = await resolveMcpTarget()
  const targets = agent
    ? (MCP_AGENT_TARGETS as readonly string[]).includes(agent) ? [agent as McpAgent] : []
    : detectAgents(home)
  if (agent && targets.length === 0) {
    info(`unknown --agent "${agent}" — supported: claude-code, ${MCP_AGENT_TARGETS.join(', ')}`)
    return []
  }
  const done: string[] = []
  for (const slug of targets) {
    const result = await installFor(slug, home, url, name)
    if (result === 'skipped') info(`  ${AGENT_LABELS[slug]}: existing config at ${configPath(slug, home)} isn't valid JSON — add ${name} manually`)
    else done.push(AGENT_LABELS[slug])
  }
  return done
}

// `insta mcp install [--agent <slug>] [--mcp-token]` — claude-code goes through its registry CLI
// (registerMcp); everything else is a config-file write. No --agent = claude-code + all detected.
export async function mcpInstall(
  opts: { agent?: string; mcpToken?: boolean },
  register: typeof registerMcp = registerMcp,
  installConfigs: typeof installAgentConfigs = installAgentConfigs,
): Promise<void> {
  if (opts.mcpToken && opts.agent && opts.agent !== 'claude-code') {
    throw new Error('--mcp-token supports Claude Code only; other clients use OAuth')
  }
  if (!opts.agent || opts.agent === 'claude-code') {
    const status = await register(undefined, undefined, !!opts.mcpToken)
    // Missing Claude is an optional discovery miss only for the default OAuth install. A
    // targeted install, token request, or attempted-but-failed add must not report success.
    if ((opts.agent || opts.mcpToken || status === 'failed') && !requireMcpRegistration(status)) return
    if (opts.agent) return
  }
  const done = await installConfigs(opts.agent)
  if (done.length) info(`✓ MCP — configured for ${done.join(', ')} (restart those tools to pick it up)`)
  else if (opts.agent) { /* messages already printed */ }
  else info('  no other MCP-capable agents detected (supported: cursor, codex, opencode, copilot, factory-droid)')
}
