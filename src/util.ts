// Output + small pure helpers (env serialization is unit-tested).
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Replace a file's contents in one step: write a sibling temporary file, then
 * rename it over the target.
 *
 * For files the USER also owns — `~/.ssh/config`, `known_hosts` — a plain
 * writeFileSync is a truncate followed by a write, so an interrupt, a full disk
 * or a crash between the two leaves the user with a half a config and no way to
 * ssh anywhere. rename(2) is atomic, so a reader sees either the old file or
 * the new one. `backup` additionally leaves the previous contents recoverable.
 *
 * A SYMLINK is followed to its target first. Keeping a dotfiles repo and
 * symlinking `~/.ssh/config` at it is a common setup, and rename(2) replaces
 * the link itself rather than writing through it -- so the naive version
 * silently severs the link, leaving the repo holding a copy that no longer
 * matches the file ssh reads and the next dotfiles sync quietly reverting our
 * block. Resolving first keeps the write atomic (the temp file still lands
 * beside the real file, on the real file's filesystem) AND keeps the link.
 */
export function writeFileAtomicSync(target: string, data: string, opts: { mode?: number; backup?: boolean } = {}): void {
  const mode = opts.mode ?? 0o600
  const path = resolveThroughSymlink(target)
  const tmp = join(dirname(path), `.${basename(path)}.insta-${process.pid}-${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(tmp, data, { mode })
    // writeFileSync applies `mode` only when it CREATES the file, and a umask
    // can clear bits even then. ssh refuses a group-readable config outright.
    chmodSync(tmp, mode)
    if (opts.backup && existsSync(path)) copyFileSync(path, path + '.insta-bak')
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* never created, or already gone */ }
    throw e
  }
}

/** The file `path` ultimately NAMES: itself when it is not a link, otherwise the
 *  end of the symlink chain -- whether or not that end exists yet.
 *
 *  A DANGLING link resolves to the target it names, not to itself. `realpath`
 *  gives up with ENOENT there, and returning the link path made the caller
 *  rename over the LINK: a `~/.ssh/config` symlinked into a dotfiles repo that
 *  has not been populated yet -- a fresh clone, a new machine -- was silently
 *  turned into a regular file, destroying wiring that `readlink` could still
 *  read off the link perfectly well. So the chain is walked by hand from there,
 *  and the write lands on the file the user actually pointed at, creating it.
 *
 *  Every OTHER failure still propagates. A blanket catch was a quiet hole:
 *  `ELOOP` (a symlink cycle) and `EACCES` (a directory the user cannot
 *  traverse) would both return the link path and sever a link because we could
 *  not read it. Cannot-confirm is not a licence to write -- and with the
 *  dangling case handled above, there is no longer any case where replacing a
 *  link is the right answer. */
export function resolveThroughSymlink(path: string): string {
  // realpath resolves a live chain in one call and reports ELOOP for a cycle,
  // so a hand-walk only ever runs past the point where the chain dangles --
  // which is finite by construction. The cap is for a link created underneath
  // us mid-walk, where finite is no longer guaranteed.
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
    let link: string
    try {
      if (!lstatSync(path).isSymbolicLink()) return path
      return realpathSync(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
    }
    try {
      link = readlinkSync(path)
    } catch (e) {
      // ENOENT from both calls means nothing is at `path` at all -- it is the
      // file to create, which is what the caller wants written.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return path
      throw e
    }
    // Link text is resolved against the directory holding the LINK, as the
    // kernel does it -- not against the process cwd, which would scatter files
    // into wherever the CLI happened to be run from. The REAL directory, too:
    // the kernel resolves a relative target from where the link actually
    // lives, so when `~/.ssh` is itself a link into a dotfiles repo, a
    // `../x` inside it names a sibling of the repo directory, not of `~/.ssh`.
    // The directory exists (the link was just lstat'ed inside it), and any
    // failure resolving it propagates like every other one above.
    path = resolve(realpathSync(dirname(path)), link)
  }
  throw new Error(`too many levels of symbolic links resolving ${JSON.stringify(path)}`)
}

/** Linux allows 40; the exact number does not matter, only that the walk ends. */
const MAX_SYMLINK_HOPS = 40

/** How to launch the default browser for `url` on `platform`. Pure so the Windows encoding is
 *  testable. On Windows NO shell may ever parse the URL: cmd.exe splits at bare `&` (which #138
 *  fixed by quoting) but ALSO expands `%…%` sequences even inside quotes, and a percent-encoded
 *  OAuth redirect (`http%3A%2F%2F127.0.0.1…`) is nothing but such sequences. So the launch goes
 *  through PowerShell's -EncodedCommand: a pure-ASCII script travels as base64(UTF-16LE) — no
 *  argument parsing anywhere — and the URL itself rides as a second base64 payload INSIDE that
 *  script, decoded by .NET at runtime, so no URL byte ever appears in PowerShell source (see the
 *  win32 branch). Start-Process on a URL is ShellExecute, i.e. the default browser. */
export function openUrlSpawn(
  url: string,
  platform: NodeJS.Platform = process.platform,
  // Absolute path, not bare `powershell`: CreateProcess-style lookup searches the current
  // directory before PATH, so a planted powershell.exe beside the user's shell would win.
  systemRoot: string = process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows',
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    // The URL never appears in PowerShell SOURCE at all: it travels as base64 inside the script
    // and is decoded by .NET at runtime. Interpolating it into a quoted literal is not enough —
    // PowerShell honors smart quotes (U+2018–U+201B) as string delimiters too, so ASCII-only
    // escaping still leaves a breakout. The script below is pure ASCII by construction (the
    // base64 alphabet), so no byte of any URL can terminate anything.
    const urlB64 = Buffer.from(url, 'utf8').toString('base64')
    const script = `Start-Process ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${urlB64}')))`
    return {
      cmd: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    }
  }
  return { cmd: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] }
}

// ShellExecute-family launchers (Start-Process/open/xdg-open) run ANY target they're handed —
// a UNC path is an execution, not a navigation — so only web URLs may reach them.
export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

// Best-effort: open a URL in the user's default browser. Returns false if we couldn't launch —
// but a launcher that starts and THEN fails (ENOENT arrives on the async 'error' event) still
// reads as true, so callers must not treat true as proof the browser opened.
export function openUrl(url: string): boolean {
  if (!isWebUrl(url)) return false
  const { cmd, args } = openUrlSpawn(url)
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch { return false }
}

export class CliExit extends Error {
  constructor() {
    // Preserve the observable error used by direct command-unit tests that previously mocked
    // process.exit(1) by throwing `Error('exit 1')`.
    super('exit 1')
    this.name = 'CliExit'
  }
}

let relayedCode: number | undefined

/** A child's exit status the CLI passes through as its own (run, db connect, compute exec). */
export function relayExitCode(code: number): void {
  relayedCode = code
  process.exitCode = code
}

export function relayedExitCode(): number | undefined { return relayedCode }

/** The user cancelled an interactive prompt: exit 0 with nothing printed. */
export class CliCancel extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CliCancel'
  }
}

export function fail(msg: string): void {
  process.stderr.write(`error: ${msg}\n`)
  process.exitCode = 1
}

// Stop the current command without forcing Node to tear down active libuv handles. On Windows,
// process.exit() can race the detached update-check child and abort in src\win\async.c with
// UV_HANDLE_CLOSING. The guard absorbs CliExit after fail() records the intended exit status.
export function die(msg: string): never {
  fail(msg)
  throw new CliExit()
}

// The CLI declined to act and the caller must choose how to proceed — the same shape as the 202
// approval gate below, so it takes the same exit code 2: not success (a redirected stdout must
// never read the refusal as output), and not a plain failure either (die owns 1). Nothing ran,
// and re-running with the flag the message names will work.
export function refuse(lines: string[]): never {
  for (const line of lines) process.stderr.write(line + '\n')
  process.exitCode = 2
  throw new CliExit()
}

export function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n')
}

export function info(msg: string): void {
  process.stdout.write(msg + '\n')
}

// If the platform gated the action (HTTP 202), tell the user how to get it approved. Returns
// true when an approval is pending (caller should stop). The hint goes to STDERR and the exit
// code is set to 2: a pending gate is not success (redirected stdout must never swallow it as
// output), and not a plain error either (die() owns 1) — it's approvable and re-runnable, and
// scripts/agents branch on the distinct code. With json, stdout carries the platform's raw 202
// envelope so a scripted caller can lift approvalId/action.
export function handleApproval(res: { status: number; body: any }, json?: boolean): boolean {
  if (res.status === 202 && res.body?.status === 'approval_required') {
    if (json) printJson(res.body)
    process.stderr.write(`approval required for ${res.body.action} — run: insta approvals approve ${res.body.approvalId}\n`)
    process.exitCode = 2
    return true
  }
  return false
}

export type NextAction = { op: string; reason: string; args?: Record<string, unknown>; gated?: boolean }

// Neutral op → an `insta` command string. Unknown ops fall back to reason-only (no crash).
const OP_COMMAND: Record<string, (a: Record<string, unknown>) => string> = {
  'service.add': (a) => `insta services add ${a.type ?? '<type>'} ${a.name ?? '<name>'}`,
  deploy: (a) => `insta deploy${a.branch ? ` --branch ${a.branch}` : ''}`,
  'secrets.set': (a) => `insta secrets set ${a.name ?? '<NAME>'} ${a.value ?? '<value>'}`,
  metrics: (a) => `insta metrics ${a.target ?? 'compute'}`,
  logs: (a) => `insta logs ${a.target ?? 'compute'}`,
  'approvals.approve': (a) => `insta approvals approve ${a.approvalId ?? '<id>'}`,
}

// Pure — builds the printable lines (unit-tested). Empty input → [].
export function nextActionsLines(actions: NextAction[] | undefined): string[] {
  if (!actions || actions.length === 0) return []
  const lines = ['Next:']
  for (const a of actions) {
    const cmd = OP_COMMAND[a.op]?.(a.args ?? {})
    const gated = a.gated ? '  [needs approval]' : ''
    lines.push(cmd ? `  • ${a.reason}  →  ${cmd}${gated}` : `  • ${a.reason}${gated}`)
  }
  return lines
}

export function renderNextActions(actions: NextAction[] | undefined): void {
  for (const line of nextActionsLines(actions)) info(line)
}

// Serialize a credential bundle to .env text. All values are double-quoted (connection strings
// contain special chars); backslashes and quotes are escaped so dotenv parsers read them back exactly.
export function serializeEnv(bundle: Record<string, string>): string {
  return (
    Object.entries(bundle)
      .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join('\n') + '\n'
  )
}

// Hidden password prompt (best-effort: mutes echo on a TTY).
export function promptPassword(label = 'Password: '): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void }
    process.stdout.write(label)
    let captured = ''
    stdout._writeToOutput = (s: string) => { if (s.includes('\n')) process.stdout.write('\n') }
    rl.on('line', (line) => { captured = line; rl.close() })
    rl.on('close', () => resolve(captured))
  })
}
