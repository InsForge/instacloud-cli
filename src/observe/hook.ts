// PostToolUse hook: reads a tool-use event on stdin (Claude Code / Codex), scans every string
// surface for credential exposure, and appends findings to ./.insta/audit.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanEvent, type ToolEvent } from './scanner.js'

export function recordFindings(event: ToolEvent, baseDir: string): number {
  const instaDir = join(baseDir, '.insta')
  const instaAbs = resolve(instaDir)
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const ignore = (p: string): boolean => {
    let ap: string
    try { ap = resolve(p) } catch { return false }
    return ap.startsWith(instaAbs) || ap.startsWith(selfDir)
  }
  const findings = scanEvent(event, { ignorePath: ignore })
  if (findings.length === 0) return 0
  const common = {
    ts: new Date().toISOString(),
    session_id: event.session_id ?? null,
    tool: event.tool_name ?? null,
    cwd: event.cwd ?? null,
  }
  mkdirSync(instaDir, { recursive: true })
  const lines = findings.map((f) => JSON.stringify({ ...common, ...f })).join('\n') + '\n'
  appendFileSync(join(instaDir, 'audit.jsonl'), lines, 'utf8')
  return findings.length
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// Where findings go. The materialized hook lives at <project root>/.insta/observe/hook.js, so its
// own entry path names the linked project root — the one directory whose .insta/audit.jsonl is
// gitignored and that `insta agent observe report` reads. Anything else (the harness's project-dir env,
// the event cwd) is only a guess: Codex passes the SESSION cwd, which in a monorepo can be a
// subdirectory of the project, and writing there would leave an unignored audit log behind.
export function projectRootFor(entry: string | undefined, env: NodeJS.ProcessEnv, eventCwd: string | undefined): string {
  if (entry) {
    const dir = resolve(dirname(entry))
    if (basename(dir) === 'observe' && basename(dirname(dir)) === '.insta') return dirname(dirname(dir))
  }
  return env.CLAUDE_PROJECT_DIR || eventCwd || '.'
}

export async function main(): Promise<void> {
  let event: ToolEvent
  try { event = JSON.parse(await readStdin()) } catch { process.exit(0) }
  const base = projectRootFor(process.argv[1], process.env, event.cwd as string | undefined)
  try { recordFindings(event, base) } catch (e) { process.stderr.write(`insta-observe: ${e instanceof Error ? e.message : e}\n`) }
  process.exit(0)
}

// Run only when executed directly (the materialized .insta/observe/hook.js entry).
// Imported by tests → guard is false → main() does not run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
