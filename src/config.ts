// CLI config: global (~/.insta/config.json: api url + tokens) and per-project (./.insta/project.json).
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ensureGitignore } from './gitignore.js'
import { die } from './util.js'
import { DEFAULT_ENV, ENVS, envForApiUrl, envFromEnvVar, normalizeUrl, type EnvName } from './env.js'

const GLOBAL_DIR = join(homedir(), '.insta')
const GLOBAL_FILE = join(GLOBAL_DIR, 'config.json')
const PROJECT_DIR = '.insta'
const PROJECT_FILE = 'project.json'
// Machine-local, gitignored: the control plane this machine linked against. It is NOT in
// project.json because that file is the team's committed binding — a URL chosen by one machine
// (a staging switch, a local box, a transient INSTA_API_URL) would make every teammate's CLI
// treat the shared link as foreign.
const LINK_PLANE_FILE = 'link-plane.json'

export type GlobalConfig = {
  apiUrl: string
  accessToken?: string
  refreshToken?: string
  user?: { id: string; email: string | null; name: string | null }
  autoUpdate?: boolean // self-update on new releases (default true while pre-1.0)
}

export type ProjectConfig = { projectId: string; orgId: string; branch: string }

// The cloud API default. Uses the instacloud.com brand domain (matches the agents.instacloud.com
// onboarding), NOT the legacy beta-api.insta.insforge.dev host — same backend, branded domain.
// Only affects fresh installs: a persisted apiUrl (from a prior login) or INSTA_API_URL wins below.
const DEFAULT_API = ENVS[DEFAULT_ENV].api

export async function readGlobal(): Promise<GlobalConfig> {
  // Precedence, most explicit first:
  //   1. INSTA_API_URL  — a literal URL. Overrides the persisted apiUrl, not just the default,
  //      otherwise the env var is silently ignored as soon as any login has written a config file.
  //      It also outranks INSTA_ENV: a hand-written URL is the more specific instruction, and it
  //      is the only way to reach a host no environment name covers (insta-oss, a preview).
  //   2. INSTA_ENV      — a named environment (see env.ts), resolved to its api host.
  //   3. the persisted apiUrl, written by `insta login --env|--api-url` or `insta env use`.
  //   4. DEFAULT_API.
  const envApi = process.env.INSTA_API_URL
  const named = envFromEnvVar()
  const override = envApi ?? (named ? ENVS[named].api : undefined)
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_FILE, 'utf8')) as GlobalConfig
    const persisted = parsed.apiUrl ?? DEFAULT_API
    // An override that points at a DIFFERENT deployment than the stored session was minted for
    // must not carry that session along. `env use` already drops it on an explicit switch; without
    // this, `INSTA_ENV=staging insta …` on a prod-logged-in machine sends prod's bearer to staging
    // and then — on the 401 — POSTs prod's REFRESH token to staging's /auth/refresh (api.ts), which
    // is the cross-deployment credential leak env.ts's header calls out as never allowed.
    //
    // In-memory only: the file keeps the real login, so unsetting the override restores it. A
    // custom host (insta-oss, a preview) is treated the same way — its session is equally foreign.
    if (override && normalizeUrl(override) !== normalizeUrl(persisted)) {
      const scrubbed: GlobalConfig = { ...parsed, apiUrl: override }
      delete scrubbed.accessToken
      delete scrubbed.refreshToken
      delete scrubbed.user
      return scrubbed
    }
    return { ...parsed, apiUrl: override ?? persisted }
  } catch {
    return { apiUrl: override ?? DEFAULT_API }
  }
}

/** The environment the CLI is currently pointed at, plus everything derived from it. `env` is null
 *  when apiUrl is a custom host (insta-oss, a preview deployment) — deliberate, and left alone.
 *
 *  API host, MCP host, and skill source are resolved from ONE environment on purpose: the failure
 *  mode of picking them independently is silent (a machine whose CLI talks to staging while its
 *  agents are wired to prod and reading prod's skill text). */
export async function resolveEnv(): Promise<{
  apiUrl: string
  env: EnvName | null
  mcpUrl: string
  skills: string
}> {
  const { apiUrl } = await readGlobal()
  const env = envForApiUrl(apiUrl)
  const hosts = ENVS[env ?? DEFAULT_ENV]
  // Each single-purpose env var still wins outright, for a self-hosted MCP / a tunnel / a skills
  // fork. A custom apiUrl with none of them set falls back to the default environment, since
  // there is nothing better to guess and it preserves today's behaviour.
  const mcpUrl = process.env.INSTA_MCP_URL || hosts.mcp
  const skills = process.env.INSTA_SKILLS_REPO || hosts.skills
  return { apiUrl, env, mcpUrl, skills }
}

/** The config exactly as stored: no env-var overrides, no session scrubbing.
 *
 *  `env use` must read this rather than `readGlobal()`. With INSTA_ENV set, `readGlobal()` already
 *  reports the override's host, so `env use <that same env>` would look like a no-op, print
 *  "already on X" and never write the file — leaving the next process (without the override in its
 *  environment) still pointed at the old one. Deciding "is this a real switch?" has to be done
 *  against what is persisted. */
export async function readPersistedGlobal(): Promise<GlobalConfig> {
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_FILE, 'utf8')) as GlobalConfig
    return { ...parsed, apiUrl: parsed.apiUrl ?? DEFAULT_API }
  } catch {
    return { apiUrl: DEFAULT_API }
  }
}

export async function writeGlobal(c: GlobalConfig): Promise<void> {
  await mkdir(GLOBAL_DIR, { recursive: true })
  await writeFile(GLOBAL_FILE, JSON.stringify(c, null, 2))
}

/** The home directory is never a project root. `~/.insta/` is this CLI's GLOBAL config directory,
 *  so a project.json there is not a project link: honouring one made every directory under the home
 *  dir inherit it, and `insta project link` run anywhere below home silently overwrote it. */
function isHomeDir(dir: string): boolean {
  return resolve(dir) === resolve(homedir())
}

/** Git-style ancestor lookup: the nearest directory at-or-above `cwd` containing
 *  .insta/project.json — so "link once" works from any subdirectory of the project. The home
 *  directory is skipped (see isHomeDir). */
export async function findProjectRoot(cwd = process.cwd()): Promise<string | null> {
  let dir = resolve(cwd)
  for (;;) {
    if (!isHomeDir(dir)) {
      try {
        await readFile(join(dir, PROJECT_DIR, PROJECT_FILE), 'utf8')
        return dir
      } catch { /* keep climbing */ }
    }
    const parent = dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
  }
}

export type ForeignLink = { file: string; projectId: string; linkedApiUrl: string; currentApiUrl: string }

/** The link that applies to `cwd`, and whether it was made against a DIFFERENT control plane. A
 *  project id means nothing on another control plane (cloud, staging and every insta-oss box each
 *  have their own), and the CLI used to reuse a link against whatever API it was pointed at. */
export async function resolveProjectLink(cwd = process.cwd()): Promise<{ link: ProjectConfig; foreign?: ForeignLink } | null> {
  // Linkless targeting (CI / one-offs / agents): INSTA_PROJECT_ID resolves the project with no
  // link file, and beats one when both exist — an explicit parameter outranks ambient state.
  if (process.env.INSTA_PROJECT_ID) {
    return {
      link: {
        projectId: process.env.INSTA_PROJECT_ID,
        orgId: process.env.INSTA_ORG_ID ?? '',
        branch: process.env.INSTA_BRANCH ?? 'main',
      },
    }
  }
  const root = await findProjectRoot(cwd)
  if (!root) return null
  let link: ProjectConfig
  try {
    link = JSON.parse(await readFile(join(root, PROJECT_DIR, PROJECT_FILE), 'utf8')) as ProjectConfig
  } catch {
    return null
  }
  // No sidecar — a link from before this existed, or a teammate who just cloned — resolves as it
  // always did: there is nothing to say which control plane it belongs to.
  const plane = await readLinkPlane(root)
  if (plane) {
    const current = safeUrl((await readGlobal()).apiUrl)
    if (normalizeUrl(plane) !== normalizeUrl(current)) {
      return { link, foreign: { file: join(root, PROJECT_DIR, PROJECT_FILE), projectId: String(link.projectId), linkedApiUrl: plane, currentApiUrl: current } }
    }
  }
  return { link }
}

/** The link for this control plane, or null. A foreign link is NOT returned (it names a project
 *  that does not exist here); callers that must act on a project use requireProject, which stops
 *  with guidance instead of treating a foreign link as "unlinked". */
export async function readProject(cwd = process.cwd()): Promise<ProjectConfig | null> {
  const r = await resolveProjectLink(cwd)
  if (!r) return null
  if (r.foreign) {
    if (!warnedForeignLinks.has(r.foreign.file)) {
      warnedForeignLinks.add(r.foreign.file)
      process.stderr.write(`note: ${foreignLinkMessage(r.foreign)}\n`)
    }
    return null
  }
  return r.link
}

const warnedForeignLinks = new Set<string>()

export function foreignLinkMessage(f: ForeignLink): string {
  return `${f.file} links project ${f.projectId} on ${f.linkedApiUrl}, but the CLI is pointed at ${f.currentApiUrl}. `
    + `Link this directory for ${f.currentApiUrl} with \`insta project link <id>\`, or point the CLI back at ${f.linkedApiUrl}.`
}

async function readLinkPlane(root: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, PROJECT_DIR, LINK_PLANE_FILE), 'utf8')) as { apiUrl?: unknown }
    // Validated, not cast: a malformed sidecar is ignored rather than crashing every command.
    return raw && typeof raw.apiUrl === 'string' && raw.apiUrl ? raw.apiUrl : null
  } catch {
    return null
  }
}

/** A control-plane URL safe to persist and to print: userinfo removed (INSTA_API_URL may carry
 *  credentials) and control characters stripped (it is echoed to a terminal). */
export function safeUrl(url: string): string {
  let out = url
  try {
    const u = new URL(url)
    if (u.username || u.password) { u.username = ''; u.password = ''; out = u.toString() }
  } catch { /* not a parseable URL: keep the string, still strip control characters */ }
  return out.replace(/[\u0000-\u001f\u007f]/g, '')
}

/** Writes to the existing project root when inside a linked project (branch switches from a
 *  subdirectory must not mint a nested link); a fresh `link` in an unlinked tree writes to cwd.
 *  Records the control plane in the machine-local sidecar beside it. Never writes into the home
 *  directory: `~/.insta/` is the global config, not a project. */
export async function writeProject(c: ProjectConfig, cwd = process.cwd()): Promise<void> {
  const target = (await findProjectRoot(cwd)) ?? resolve(cwd)
  if (isHomeDir(target)) {
    die('refusing to link the home directory — ~/.insta is the insta CLI\'s global config, not a project. Run this inside a project directory')
  }
  const { apiUrl } = await readGlobal()
  await mkdir(join(target, PROJECT_DIR), { recursive: true })
  ensureGitignore(target, ['.insta/agent-session.json'], '# Local agent credentials')
  ensureGitignore(target, [`.insta/${LINK_PLANE_FILE}`], '# Local: the control plane this machine linked against')
  await writeFile(join(target, PROJECT_DIR, PROJECT_FILE), JSON.stringify(c, null, 2))
  await writeFile(join(target, PROJECT_DIR, LINK_PLANE_FILE), JSON.stringify({ apiUrl: safeUrl(apiUrl) }, null, 2))
}
