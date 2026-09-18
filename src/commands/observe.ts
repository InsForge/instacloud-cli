// `insta agent observe` — the local credential-audit hook. install wires a PostToolUse hook into the
// agent harness; report renders the local audit; sync uploads findings into the project timeline
// (idempotent via a stable dedup key, matching the platform's audit-event ingest).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { installObserve, uninstallObserve } from '../observe/install.js'
import { untrackHint } from '../gitignore.js'
import { findProjectRoot } from '../config.js'
import { renderReport } from '../observe/report.js'
import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

// Where the audit lives: the hook records at the directory it is materialized in
// (<root>/.insta/observe/hook.js — see projectRootFor), so report/sync must anchor on exactly
// that: the NEAREST materialized hook above cwd, which is what the Codex wrapper and the Claude
// entry run. The link file is only a fallback for a directory where no hook exists yet (it is
// where the next install will land), then cwd (→ "audit log is empty"). Preferring the link file
// would break the moment the two diverge — e.g. a hook materialized below a linked parent —
// because the reader would look where the writer never writes.
export async function auditRoot(cwd = process.cwd()): Promise<string> {
  const hook = nearestHookRoot(cwd)
  if (hook) return hook
  return (await findProjectRoot(cwd)) ?? cwd
}

/** Nearest ancestor (or cwd) holding a materialized hook, or null. */
export function nearestHookRoot(cwd: string): string | null {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.insta', 'observe', 'hook.js'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Where `install` materializes: the linked project root when inside one (so a re-link or
 *  `observe install` from a subdirectory refreshes the project's hook instead of minting a second
 *  one the readers never look at — same rule as writeProject), else cwd. */
export async function installRoot(cwd = process.cwd()): Promise<string> {
  return (await findProjectRoot(cwd)) ?? cwd
}

async function readAudit(): Promise<Array<Record<string, unknown>>> {
  try {
    const txt = await readFile(join(await auditRoot(), '.insta', 'audit.jsonl'), 'utf8')
    return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function dedupKey(r: Record<string, any>): string {
  return `${r.ts}|${r.fingerprint}|${r.surface}|${r.sink}|${r.kind}`
}

function* chunk<T>(a: T[], n: number): Generator<T[]> {
  for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n)
}

export async function observeInstall(): Promise<void> {
  const root = await installRoot()
  const res = installObserve({ cwd: root })
  info(`installed observe hook (claude: ${res.claude}, codex: ${res.codex}) → ${join(root, '.insta', 'observe')}`)
  if (res.ignored.length) info(`  .gitignore += ${res.ignored.join(', ')}`)
  const hint = untrackHint(res.tracked)
  if (hint) info(hint)
  info('it scans agent tool-use for credential exposure; findings append to ./.insta/audit.jsonl')
  info('run `insta agent observe report` to review, `insta agent observe sync` to upload to the project timeline')
}

export async function observeUninstall(): Promise<void> {
  uninstallObserve(await installRoot())
  info('uninstalled observe hook')
}

export async function observeReport(opts: { json?: boolean }): Promise<void> {
  const rows = await readAudit()
  if (opts.json) return printJson(rows)
  info(renderReport(rows))
}

export async function observeSync(): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const rows = await readAudit()
  if (!rows.length) return info('nothing to sync (./.insta/audit.jsonl is empty)')
  const events = rows.map((r) => ({ source: 'agent', kind: `cred.${r.kind ?? 'touch'}`, branchId: null, dedupKey: dedupKey(r), payload: r }))
  let recorded = 0
  let skipped = 0
  for (const c of chunk(events, 200)) {
    const out = await api.request('POST', `/projects/${p.projectId}/events`, { events: c })
    recorded += out.recorded
    skipped += out.skipped
  }
  info(`synced ${rows.length} finding(s) → recorded ${recorded}, skipped ${skipped} (already uploaded)`)
}
