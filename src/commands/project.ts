import { homedir } from 'node:os'
import { agentMode, setupProjectAgentSession } from '../agent.js'
import { ApiClient, requireProject } from '../api.js'
import { HOME_LINK_REFUSAL, isHomeLinkTarget, writeProject } from '../config.js'
import { info, die, printJson, handleApproval, renderNextActions } from '../util.js'
import { installObserve } from '../observe/install.js'
import { installRoot } from './observe.js'
import { untrackHint } from '../gitignore.js'
import { installSkills } from '../ensure-skills.js'

// Generic directory names that make a useless project name ("projects", "~", "tmp", …). When the
// cwd basename is one of these we DON'T invent a name — we guide the user to name it (or let their
// skill-equipped agent do it), rather than provisioning real resources under a junk name.
const GENERIC_DIRS = new Set([
  'projects', 'project', 'home', 'tmp', 'temp', 'desktop', 'documents', 'downloads',
  'src', 'source', 'code', 'dev', 'work', 'workspace', 'repos', 'repo', 'git',
  'app', 'apps', 'users', 'user', 'bin', 'new', 'test', 'tests',
])

// Best-effort: wire the credential-audit hook into the project (no-op if assets aren't built).
// Anchored at the linked project root (writeProject just updated it), not cwd: a re-link from a
// subdirectory must refresh the project's hook, not mint a second one the readers never see.
// quiet: with --json the install still runs, but its note moves to stderr (stdout is JSON-only).
async function tryInstallObserve(quiet = false): Promise<void> {
  try {
    const r = installObserve({ cwd: await installRoot() })
    const say = (line: string) => (quiet ? process.stderr.write(line + '\n') : info(line))
    if (r.claude || r.codex) say('  installed observe hook (credential audit) → ./.insta/observe')
    if (r.ignored.length) say(`  .gitignore += ${r.ignored.join(', ')}`)
    const hint = untrackHint(r.tracked)
    if (hint) say(hint)
  } catch { /* assets missing (dev/unbuilt) — skip silently */ }
}

// installSkills prints to stdout by default; with --json its notes go to stderr instead.
const skillsPrint = (json?: boolean) => (json ? (s: string) => void process.stderr.write(s + '\n') : undefined)

async function resolveOrg(api: ApiClient, given?: string): Promise<string> {
  if (given) return given
  const { orgs } = await api.request('GET', '/orgs')
  if (!orgs.length) die('no org found — run `insta org create <name>`')
  return orgs[0].id
}

/** A valid project name from a raw string: lowercase, non-alnum → hyphen, trimmed. */
export function slugifyName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** Name resolution — NEVER prompts (a paste-and-run one-liner must not block on input). Returns
 *  the name to create, or `null` meaning "no sensible name; guide the user instead of inventing
 *  one". Explicit arg wins; else the cwd basename when it's a real project-dir name; else null
 *  (generic dir like ~/projects or /tmp, or the home dir itself). Agents pass a name via the skill,
 *  so null is only reached when a human runs bare `insta project create` somewhere generic. */
export function resolveProjectName(nameArg: string | undefined, cwd = process.cwd()): string | null {
  if (nameArg) return slugifyName(nameArg)
  const base = slugifyName(cwd.split('/').filter(Boolean).pop() ?? '')
  const home = slugifyName(homedir().split('/').filter(Boolean).pop() ?? '')
  if (base && base !== home && !GENERIC_DIRS.has(base)) return base
  return null
}

export async function projectCreate(name: string | undefined, opts: { org?: string; json?: boolean }): Promise<void> {
  const resolved = resolveProjectName(name, process.cwd())
  if (!resolved) {
    // No name given and the cwd name is generic — don't provision resources under a junk name.
    // A terminal gets guidance (no hang, no error); --json is a scripted caller with no human to
    // guide, so it gets a hard error instead of an empty success.
    if (opts.json) die('no project name — pass one: insta project create <name>')
    info('name your project:  insta project create <name>')
    info('  (or just ask your coding agent — it has the insta skill and will do this for you)')
    return
  }
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const out = await api.request('POST', `/orgs/${orgId}/projects`, { name: resolved })
  await writeProject({ projectId: out.project.id, orgId, branch: out.defaultBranch.name })
  if (agentMode()) await setupProjectAgentSession(api, out.project.id)
  if (opts.json) {
    printJson({ ...out, linked: { projectId: out.project.id, orgId, branch: out.defaultBranch.name } })
  } else {
    info(`created project ${out.project.id} (${resolved})`)
    info(`  resources: ${out.resources.map((r: any) => r.kind).join(', ')}`)
    info(`  linked ./.insta/project.json (branch ${out.defaultBranch.name})`)
    renderNextActions(out.nextActions)
  }
  await tryInstallObserve(opts.json)
  await installSkills({ cwd: process.cwd(), print: skillsPrint(opts.json) })
}

export async function projectList(opts: { org?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const { projects } = await api.request('GET', `/orgs/${orgId}/projects`)
  if (opts.json) return printJson(projects)
  if (!projects.length) return info('(no projects)')
  for (const p of projects) info(`${p.id}  ${p.name}  [${p.status}]`)
}

export async function projectLink(id: string, opts: { json?: boolean } = {}): Promise<void> {
  // Refuse the home directory BEFORE anything with side effects. In agent mode the session below is
  // saved, and .gitignore edited, at the link root; refusing only inside writeProject left both
  // behind in ~ after the command had already failed.
  if (await isHomeLinkTarget()) die(HOME_LINK_REFUSAL)
  const api = await ApiClient.load()
  if (agentMode()) await setupProjectAgentSession(api, id)
  const { project } = await api.request('GET', `/projects/${id}`)
  await writeProject({ projectId: project.id, orgId: project.org_id, branch: 'main' })
  if (opts.json) printJson({ project, linked: { projectId: project.id, orgId: project.org_id, branch: 'main' } })
  else info(`linked project ${project.id} (${project.name})`)
  await tryInstallObserve(opts.json)
  await installSkills({ cwd: process.cwd(), print: skillsPrint(opts.json) })
}

export async function projectDelete(opts: { project?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const projectId = opts.project ?? (await requireProject()).projectId
  const res = await api.rawRequest('DELETE', `/projects/${projectId}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true, projectId })
  info(`deleted project ${projectId}`)
}
