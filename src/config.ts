// CLI config: global (~/.insta/config.json: api url + tokens) and per-project (./.insta/project.json).
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { ensureGitignore } from './gitignore.js'
import { die } from './util.js'
import { DEFAULT_ENV, ENVS, envForApiUrl, envFromEnvVar, normalizeUrl, type EnvName } from './env.js'

const GLOBAL_DIR = join(homedir(), '.insta')
const GLOBAL_FILE = join(GLOBAL_DIR, 'config.json')
const PROJECT_DIR = '.insta'
const PROJECT_FILE = 'project.json'
// Machine-local, gitignored: which project this machine linked here, and on which control plane.
// It is NOT in project.json because that file is the team's committed binding — a URL chosen by one
// machine (a staging switch, a local box, a transient INSTA_API_URL) would make every teammate's
// CLI treat the shared link as foreign. It records the project id too, because project.json is
// committed and this file is not: a pull or checkout can replace the project underneath it.
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

export const HOME_LINK_REFUSAL = 'refusing to link the home directory — ~/.insta is the insta CLI\'s global config, not a project. Run this inside a project directory'

/** Where a link written from `cwd` lands: the existing project root, or `cwd` itself. */
async function linkTarget(cwd: string): Promise<string> {
  return (await findProjectRoot(cwd)) ?? resolve(cwd)
}

/** True when a link written from `cwd` would land in the home directory, which never holds one.
 *  Lets a caller refuse BEFORE it does anything else with side effects. */
export async function isHomeLinkTarget(cwd = process.cwd()): Promise<boolean> {
  return isHomeDir(await linkTarget(cwd))
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

/** Why a link is not for this control plane. `plane`: this machine linked this project against a
 *  different control plane. `changed`: project.json names a different project than the one this
 *  machine recorded — it was replaced by a pull or checkout, so its control plane is unknown. */
export type ForeignLink = {
  reason: 'plane' | 'changed'
  file: string
  projectId: string
  linkedProjectId: string
  linkedApiUrl: string
  currentApiUrl: string
}

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
  const record = await readLinkPlane(root)
  if (record) {
    const current = safeUrl((await readGlobal()).apiUrl)
    const base = {
      file: join(root, PROJECT_DIR, PROJECT_FILE), projectId: String(link.projectId),
      linkedProjectId: record.projectId, linkedApiUrl: record.apiUrl, currentApiUrl: current,
    }
    // The record vouches for the project it was written for, and only that one. A record for
    // another project says nothing about this one: trusting it would send this project to the
    // control plane of the project it replaced, or refuse it for a reason that is not true. Fail
    // closed with the real reason instead.
    if (record.projectId !== base.projectId) return { link, foreign: { reason: 'changed', ...base } }
    if (normalizeUrl(record.apiUrl) !== normalizeUrl(current)) return { link, foreign: { reason: 'plane', ...base } }
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
  // Every field can come from a file (a committed project.json, a copied or hand-edited record),
  // so all of it is stripped of control characters before it reaches a terminal.
  const file = safeText(f.file)
  const id = safeText(f.projectId)
  const linked = safeUrl(f.linkedApiUrl)
  const current = safeUrl(f.currentApiUrl)
  if (f.reason === 'changed') {
    return `${file} now links project ${id}, but this machine linked project ${safeText(f.linkedProjectId)} there, on ${linked}. `
      + `The link changed since (a pull or checkout), so its control plane is unknown. `
      + `Confirm it for ${current} with \`insta project link ${id}\`.`
  }
  return `${file} links project ${id} on ${linked}, but the CLI is pointed at ${current}. `
    + `Link this directory for ${current} with \`insta project link <id>\`, or point the CLI back at ${linked}.`
}

async function readLinkPlane(root: string): Promise<{ projectId: string; apiUrl: string } | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, PROJECT_DIR, LINK_PLANE_FILE), 'utf8')) as { projectId?: unknown; apiUrl?: unknown }
    // Validated, not cast: a malformed record is ignored rather than crashing every command. A
    // record with no project id cannot say which project it vouches for, so it is ignored too.
    if (!raw || typeof raw.projectId !== 'string' || !raw.projectId || typeof raw.apiUrl !== 'string' || !raw.apiUrl) return null
    // Untrusted input (it may have been copied or edited), so sanitized before it is compared or printed.
    return { projectId: raw.projectId, apiUrl: safeUrl(raw.apiUrl) }
  } catch {
    return null
  }
}

/** Text safe to echo to a terminal: control characters (escape sequences included) removed. */
function safeText(text: string): string {
  return String(text).replace(/[\u0000-\u001f\u007f]/g, '')
}

/** A control-plane URL safe to persist and to print: control characters removed, surrounding
 *  whitespace trimmed, and any userinfo (INSTA_API_URL may carry credentials) removed.
 *
 *  Userinfo is removed with the same WHATWG parser fetch uses, not with a pattern. That parser is
 *  lenient in ways a pattern keeps missing: it accepts leading whitespace, `\` for `/`, and a
 *  missing `//` on special schemes, and each of those defeated an anchored pattern while fetch
 *  would still have sent the credentials. A value the parser rejects is never requested, but it can
 *  still be stored or printed, so everything up to its last `@` is dropped. */
export function safeUrl(url: string): string {
  const text = safeText(url).trim()
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return text.includes('@') ? text.slice(text.lastIndexOf('@') + 1) : text
  }
  if (!parsed.username && !parsed.password) return text
  parsed.username = ''
  parsed.password = ''
  return parsed.href
}

/** Writes to the existing project root when inside a linked project (branch switches from a
 *  subdirectory must not mint a nested link); a fresh `link` in an unlinked tree writes to cwd.
 *  Records the control plane in the machine-local sidecar beside it. Never writes into the home
 *  directory: `~/.insta/` is the global config, not a project. */
export async function writeProject(c: ProjectConfig, cwd = process.cwd()): Promise<void> {
  const target = await linkTarget(cwd)
  if (isHomeDir(target)) die(HOME_LINK_REFUSAL)
  const { apiUrl } = await readGlobal()
  await mkdir(join(target, PROJECT_DIR), { recursive: true })
  ensureGitignore(target, ['.insta/agent-session.json'], '# Local agent credentials')
  ensureGitignore(target, [`.insta/${LINK_PLANE_FILE}`], '# Local: the control plane this machine linked against')
  await writeFile(join(target, PROJECT_DIR, PROJECT_FILE), JSON.stringify(c, null, 2))
  // Owner-only, like agent-session.json: it can name a private self-hosted box. writeFile's mode
  // applies only when it creates the file, so an existing record is chmod-ed too.
  const record = join(target, PROJECT_DIR, LINK_PLANE_FILE)
  await writeFile(record, JSON.stringify({ projectId: c.projectId, apiUrl: safeUrl(apiUrl) }, null, 2), { mode: 0o600 })
  await chmod(record, 0o600)
}

/** Save a link that auto-resolution chose. Unlike an explicit `insta project link`, the command it
 *  was resolved for must still run: in the home directory the choice is used for this command and
 *  simply not remembered, rather than showing the picker and then failing the command. Returns
 *  whether the link was saved. */
export async function persistAutoLink(c: ProjectConfig, cwd = process.cwd()): Promise<boolean> {
  if (await isHomeLinkTarget(cwd)) return false
  await writeProject(c, cwd)
  return true
}
