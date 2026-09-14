import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findProjectRoot, readProject } from './config.js'
import { alreadyTracked, ensureGitignore } from './gitignore.js'

export type AgentMode = { source: 'cli-explicit' | 'cli-detected'; client: 'codex' | 'claude-code' | 'cursor' | 'unknown' }
let mode: AgentMode | null = null
export function detectAgent(explicit: boolean, env: NodeJS.ProcessEnv = process.env): AgentMode | null {
  const client = env.CODEX_THREAD_ID || env.CODEX_CI === '1' ? 'codex'
    : env.CLAUDECODE === '1' ? 'claude-code'
      : env.CURSOR_AGENT === '1' ? 'cursor' : 'unknown'
  return explicit || client !== 'unknown' ? { source: explicit ? 'cli-explicit' : 'cli-detected', client } : null
}
export function configureAgent(value: AgentMode | null): void { mode = value }
export function agentMode(): AgentMode | null { return mode }
type Session = { token: string; agentSessionId: string; projectId: string | null; expiresAt: string; privateKey: string; client: AgentMode['client']; apiUrl: string }
export type SessionApi = { apiUrl: string; request<T = any>(method: string, path: string, body?: unknown): Promise<T> }
const hash = (v: string): string => createHash('sha256').update(v).digest('hex')
export function canonicalTarget(path: string): string {
  const url = new URL(path, 'https://platform.invalid')
  return url.pathname + url.search
}
const guidance = 'agent session missing, expired, or for another project/environment — run `insta setup agent`'

export async function issueAgentSession(api: SessionApi, projectId?: string): Promise<Session> {
  const pair = generateKeyPairSync('ed25519')
  const client = mode?.client ?? detectAgent(false)?.client ?? 'unknown'
  const out = await api.request('POST', '/agent/sessions', {
    projectId, client, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  })
  return { ...out, client, apiUrl: api.apiUrl.replace(/\/+$/, ''), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

export async function saveAgentSession(session: Session, cwd = process.cwd()): Promise<void> {
  const root = await findProjectRoot(cwd) ?? cwd
  const rel = '.insta/agent-session.json'
  if (alreadyTracked(root, [rel]).length) throw new Error('agent-session.json is tracked by Git; untrack it before running insta setup agent')
  ensureGitignore(root, [rel], '# Local agent credentials')
  const dir = join(root, '.insta')
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.agent-session-${randomUUID()}.tmp`)
  // Ignore crash leftovers too; temporary files contain the same private material.
  ensureGitignore(root, ['.insta/.agent-session-*.tmp'])
  await writeFile(temp, JSON.stringify(session, null, 2), { mode: 0o600 })
  await rename(temp, join(root, rel))
  await chmod(join(root, rel), 0o600)
}

export async function setupProjectAgentSession(api: SessionApi, projectId?: string): Promise<boolean> {
  const id = projectId ?? (await readProject())?.projectId
  if (!id) return false
  await saveAgentSession(await issueAgentSession(api, id))
  return true
}

export async function loadAgentSession(apiUrl: string, projectId: string, cwd = process.cwd()): Promise<Session> {
  try {
    const root = await findProjectRoot(cwd) ?? cwd
    const session = JSON.parse(await readFile(join(root, '.insta/agent-session.json'), 'utf8')) as Session
    if (session.projectId !== projectId || session.apiUrl !== apiUrl.replace(/\/+$/, '') || !session.token || !session.privateKey
      || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) throw new Error()
    return session
  } catch { throw new Error(guidance) }
}

// Which project a request is scoped to, when the path itself does not say. Some project-owned
// resources are addressed by their own id (e.g. GET /template-deployments/:id): the platform
// resolves the owning project from the row and rejects a session bound to any other project —
// including the projectless bootstrap session — so the caller has to name the project it means.
export type AgentScope = { projectId?: string }

// Routes the CLI may call on an account-level (bootstrap) session, by first path segment. Every
// other route is project-owned: either its path names the project or the caller passes
// scope.projectId. A miss fails HERE, naming the route, instead of on the platform as a
// "for a different project" 403 whose setup hint cannot help — keep this list in step with the
// account-level paths in src/commands/.
export const ACCOUNT_ROUTES: ReadonlySet<string> = new Set(['agent', 'auth', 'me', 'orgs', 'regions', 'templates', 'tokens', 'github'])

export async function agentHeaders(api: SessionApi, method: string, path: string, rawBody: string, scope: AgentScope = {}): Promise<Record<string, string>> {
  if (!mode) return {}
  if (canonicalTarget(path) === '/agent/sessions' && method === 'POST') return {
    'Insta-Actor-Type': 'agent', 'Insta-Agent-Source': mode.source, 'Insta-Agent-Client': mode.client,
  }
  const target = canonicalTarget(path)
  const match = target.match(/^\/projects\/([^/?]+)/)
  const projectId = scope.projectId ?? (match ? decodeURIComponent(match[1]!) : undefined)
  if (!projectId && !ACCOUNT_ROUTES.has(target.split('/')[1]?.split('?')[0] ?? '')) {
    throw new Error(`${method.toUpperCase()} ${target} is a project route but no project was given — this is an insta CLI bug; please report it with \`insta feedback\``)
  }
  // Account reads/project creation have no project policy yet. Mint a short-lived bootstrap
  // assertion in memory. It cannot access project routes; never downgrade to a human request.
  const session = projectId ? await loadAgentSession(api.apiUrl, projectId) : await issueAgentSession(api)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomUUID()
  const proof = [method.toUpperCase(), target, hash(rawBody), session.agentSessionId, timestamp, nonce, mode.source, session.client].join('\n')
  return {
    'Insta-Actor-Type': 'agent', 'Insta-Agent-Session': session.agentSessionId,
    'Insta-Agent-Session-Token': session.token, 'Insta-Agent-Source': mode.source,
    'Insta-Agent-Client': session.client, 'Insta-Agent-Timestamp': timestamp,
    'Insta-Agent-Nonce': nonce, 'Insta-Agent-Signature': sign(null, Buffer.from(proof), session.privateKey).toString('base64url'),
  }
}
