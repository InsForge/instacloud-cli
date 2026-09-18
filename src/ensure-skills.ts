// Install the related agent skills into a linked project so the developer's coding agent has
// context for what InstaCloud provisions — the `insta` CLI itself plus the services you build
// directly against (Tigris storage, Better Auth). Postgres gets no vendor skill: instadb is
// plain Postgres, and agents talk to it directly via DATABASE_URL. Runs `npx skills add`
// (vercel-labs/skills) fully non-interactively. Best-effort: a failure (offline, npx missing, a
// repo moved) prints a manual fallback and never blocks or fails the host command — same contract
// as the observe-hook install.
import { spawn } from 'node:child_process'
import { resolveEnv } from './config.js'
import { resolveSpawnable } from './commands/setup.js'
import { DEFAULT_ENV, ENVS } from './env.js'
import { alreadyTracked, ensureGitignore, untrackHint } from './gitignore.js'

export { ensureGitignore } from './gitignore.js'

// Where `npx skills add` drops skills for the agents we pin below: Claude Code → .claude/skills/,
// Codex → .agents/skills/ (.github/skills/ is the third well-known dir), plus the skills-lock.json
// it writes at the project root. All regenerable agent context, not the developer's source — keep
// them out of git. The lock goes too: its payload is already ignored, it pins only a content hash
// (not the prod/staging source this CLI resolves per environment), and `insta project link` is
// the restore path — so a committed lock would be a lockfile for nothing.
const SKILL_DIRS = ['.claude/skills/', '.agents/skills/', '.github/skills/', 'skills-lock.json']
const GITIGNORE_COMMENT = '# InstaCloud: agent skills installed by `npx skills add` (regenerable, not source)'

export type Runner = (cmd: string, args: string[], inherit?: boolean) => Promise<{ ok: boolean }>

// `skills` prints a full-screen ASCII banner at the top of every `add`, so our 3 invocations
// would stack 3 banners. It skips the banner when it detects an agent driving it rather than a
// human — AI_AGENT is its first-checked signal (any non-empty value ⇒ agent mode). Setting it is
// honest here (this IS programmatic, not an interactive prompt) and, because we already pin the
// agents/skills/-y, has no effect on the install beyond quieting the banner. Preserve a caller's
// existing AI_AGENT (e.g. running inside another agent) rather than clobbering it.
const defaultRunner: Runner = (cmdIn, argsIn, inherit = false) =>
  new Promise((resolve) => {
    // resolveSpawnable: on Windows `npx` is a .cmd shim spawn() refuses without a shell —
    // re-enter npm's CLI script via node instead (same treatment as `insta agent setup`).
    const { cmd, args } = resolveSpawnable(cmdIn, argsIn)
    const env: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: process.env.AI_AGENT || 'insta' }
    // npx exports its flags as npm_config_* to children; npm_config_package would pin the inner
    // `npx -y skills …` to whatever package launched this CLI (see setup.ts defaultRunner).
    delete env.npm_config_package
    delete env.npm_config_call
    const p = spawn(cmd, args, { stdio: inherit ? 'inherit' : 'ignore', env })
    p.on('error', () => resolve({ ok: false })) // e.g. npx not on PATH
    p.on('close', (code) => resolve({ ok: code === 0 }))
  })

// `npx skills add` is non-interactive only when we remove every prompt: pin the target agents
// (-a claude-code -a codex) so it neither asks which agent nor fans out to every known agent dir;
// name the exact skills (-s …) so there's no skill picker; -y to skip the scope/confirm prompt;
// --copy to write real files (not symlinks into a transient npx cache).
const AGENT_FLAGS = ['-a', 'claude-code', '-a', 'codex', '-y', '--copy']

// npx's OWN -y, distinct from the skills tool's -y above: without it, a machine whose npx cache
// lacks the `skills` package refuses the auto-install in non-TTY runs and the whole command
// degrades to `sh: skills: command not found`.
const NPX_YES = ['-y']

// `instaSpec` is the insta skill source for the resolved environment (`owner/repo[@ref]`), so a
// project created against staging gets the staging skill text. The third-party stack skills are
// environment-independent — they document Tigris/Better Auth, not our control plane.
const skillTargets = (instaSpec: string): Array<{ label: string; args: string[] }> => [
  { label: 'insta', args: [...NPX_YES, 'skills', 'add', instaSpec, '-s', 'insta', ...AGENT_FLAGS] },
  { label: 'tigris', args: [...NPX_YES, 'skills', 'add', 'tigrisdata/skills',
    '-s', 'tigris-object-operations', '-s', 'file-storage', '-s', 'tigris-sdk-guide',
    '-s', 'tigris-security-access-control', '-s', 'tigris-image-optimization',
    '-s', 'tigris-s3-migration', '-s', 'tigris-static-assets', '-s', 'tigris-agent-kit',
    ...AGENT_FLAGS] },
  { label: 'better-auth', args: [...NPX_YES, 'skills', 'add', 'better-auth/skills',
    '-s', 'better-auth-best-practices', '-s', 'email-and-password-best-practices',
    '-s', 'better-auth-security-best-practices', ...AGENT_FLAGS] },
]

/** Production's targets — kept for tests and as the fallback when no env resolves. */
const SKILLS = skillTargets(ENVS[DEFAULT_ENV].skills)

type Deps = { cwd: string; run?: Runner; print?: (s: string) => void }

// Install all related skills. Production omits `run`/`print` → the real spawn + stdout; tests inject
// a fake runner and capture output. Continues past a per-skill failure so one bad repo doesn't skip
// the rest, and never throws.
export async function installSkills(deps: Deps): Promise<void> {
  const run = deps.run ?? defaultRunner
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'))
  try {
    // Resolve once per call so the insta skill follows this machine's environment. Falls back to
    // production's targets if anything about the resolve fails — a bad read must not skip the
    // whole best-effort install.
    let targets = SKILLS
    try {
      const { skills } = await resolveEnv()
      targets = skillTargets(skills)
    } catch { /* keep production defaults */ }
    print('  installing related agent skills (insta, tigris, better-auth) …')
    let installed = 0
    for (const s of targets) {
      // Don't stream: the `skills` tool's clack UI (clone spinner, banners) is noise. Run it
      // silent (stdio 'ignore') and let the per-skill ✓/failed line below be the clean output —
      // it appears as each skill finishes, so there's still live progress. (Also avoids the
      // child inheriting a piped stdin.)
      const r = await run('npx', s.args)
      if (r.ok) installed++
      print(r.ok ? `  ${s.label} ✓` : `  ${s.label} failed — add manually: npx ${s.args.join(' ')}`)
    }
    // The already-tracked hint is independent of this run: a repo that committed the skill dirs
    // or the lock months ago needs the `git rm --cached` line whether or not today's adds worked.
    const hint = untrackHint(alreadyTracked(deps.cwd, SKILL_DIRS))
    if (hint) print(hint)
    // The ignore entries only when something was actually written: an offline run that failed
    // every add has no new skill dirs or lock, and a `.gitignore +=` line would claim otherwise.
    if (installed === 0) return
    const added = ensureGitignore(deps.cwd, SKILL_DIRS, GITIGNORE_COMMENT)
    if (added.length) print(`  .gitignore += ${added.join(', ')}`)
  } catch {
    /* best-effort convenience — never block the host command */
  }
}
