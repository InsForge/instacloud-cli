// Fetch a template manifest out of a GitHub repository, on this machine, with the user's own git
// credentials. Parsing, ref resolution and the shallow clone live here; the deploy path stays in
// commands/template.ts. See docs/superpowers/specs/2026-09-04-template-deploy-github-url-design.md.
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, realpathSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { parseManifestYaml, MANIFEST_FILE, type TemplateManifest } from './template-manifest.js'

export type GitHubTarget = { owner: string; repo: string; refAndPath: string }

const GITHUB_HOST = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i
// A scheme (with or without its slashes) or an scp-style user@host:path. The slashes are optional
// because `https:/github.com/o/r`, a URL that lost one, must be named as a bad address rather than
// resolved as a directory called `https:`. Two or more scheme characters are required so a Windows
// drive letter (`C:\src`, `C:/src`) stays a path.
const EXPLICIT_ADDRESS = /^[a-z][a-z0-9+.-]+:|^[^/\\]+@[^/\\]+:/i
// Scheme-less first segments we still read as a host. A bare `<name>/<path>` is otherwise a LOCAL
// PATH: `v1.0/templates` and `my.app/bot` are directories, and reading every dotted first segment
// as a host broke them. Only names that unambiguously host code belong here.
const KNOWN_GIT_HOSTS = new Set([
  'gitlab.com', 'www.gitlab.com', 'bitbucket.org', 'www.bitbucket.org', 'gist.github.com',
  'codeberg.org', 'git.sr.ht', 'dev.azure.com', 'ssh.dev.azure.com', 'gitea.com', 'sourceforge.net',
])
const SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Is this an address rather than a path? Only an explicit scheme/scp form, or a first segment
 *  naming a host we recognise. A scheme-less name is far likelier to be someone's directory than
 *  a git host, so everything else falls through to local and registry modes. */
function isAddress(target: string): boolean {
  if (EXPLICIT_ADDRESS.test(target)) return true
  return KNOWN_GIT_HOSTS.has((target.split(/[/\\]/, 1)[0] ?? '').toLowerCase())
}

export function unsupportedSourceMessage(target: string): string {
  return `unsupported template source: ${target}. Use a registry code, a local directory, or https://github.com/<owner>/<repo>[/tree/<ref>[/<dir>]]`
}

// Percent-decode first, so %2e%2e and %2f cannot smuggle a traversal past the segment check.
function decodedSegments(parts: string[], target: string): string[] {
  return parts.map((raw) => {
    let seg: string
    try { seg = decodeURIComponent(raw) } catch { throw new Error(unsupportedSourceMessage(target)) }
    if (!seg || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) throw new Error(unsupportedSourceMessage(target))
    return seg
  })
}

/** Parse a github.com URL into owner, repo and the still-unsplit ref+path tail.
 *  null = not URL-shaped, so the caller's local-directory and registry modes still get a look.
 *  A URL-shaped target that is not a github.com repository URL throws. */
export function parseGitHubTemplateUrl(target: string): GitHubTarget | null {
  if (!GITHUB_HOST.test(target)) {
    // Name a non-GitHub address for what it is; let everything else reach local/registry mode.
    if (isAddress(target)) throw new Error(unsupportedSourceMessage(target))
    return null
  }
  // Links copied from GitHub's UI carry ?plain=1, #L1-L5 or ?tab=readme-ov-file, and none of that
  // names a file. A `?` or `#` in a real path arrives percent-encoded, so a bare one is always the
  // delimiter. Dropping it silently beats a "directory" called `bot?tab=readme-ov-file`.
  const clean = target.replace(/[?#][\s\S]*$/, '')
  const rest = clean.replace(GITHUB_HOST, '').replace(/\/+$/, '')
  const parts = rest.split('/')
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/i, '')
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw new Error(unsupportedSourceMessage(target))

  const kind = parts[2]
  if (kind === undefined) return { owner, repo, refAndPath: '' }
  if (kind !== 'tree' && kind !== 'blob') throw new Error(unsupportedSourceMessage(target))

  let tail = decodedSegments(parts.slice(3), target)
  if (!tail.length) throw new Error(unsupportedSourceMessage(target))
  if (kind === 'blob') {
    // A file link is read as its directory, and only for the manifest itself.
    if (tail[tail.length - 1] !== MANIFEST_FILE) throw new Error(unsupportedSourceMessage(target))
    tail = tail.slice(0, -1)
    if (!tail.length) throw new Error(unsupportedSourceMessage(target))
  }
  return { owner, repo, refAndPath: tail.join('/') }
}

export const LS_REMOTE_TIMEOUT_MS = 30_000
export const CLONE_TIMEOUT_MS = 120_000

export type GitResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type GitRunner = (args: string[], opts: { timeoutMs: number }) => Promise<GitResult>
export type SpawnFn = typeof nodeSpawn

export function gitMissingMessage(): string {
  return `git is required to deploy a template from a GitHub URL. Install git, or clone the repository yourself and run: insta template deploy ./<dir>`
}

// git asks for nothing: no terminal credential prompt, no SSH host-key or passphrase prompt (an
// insteadOf rewrite can send the clone over SSH). The environment stops it asking; only the
// timeout stops it waiting.
// GIT_SSH_COMMAND is EXTENDED, never replaced: a user's own `ssh -i <key>` IS how their private
// repository authenticates, and overwriting it would drop the credentials this feature runs on.
function nonInteractiveEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const ssh = env.GIT_SSH_COMMAND?.trim()
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: ssh ? `${ssh} -o BatchMode=yes` : 'ssh -o BatchMode=yes',
    GCM_INTERACTIVE: 'never',
  }
}

// git spawns helpers (ssh, a credential manager) that inherit its pipes, so a timeout has to take
// the whole group. Windows has no process groups; taskkill /T walks the tree instead.
function killTree(child: ReturnType<SpawnFn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      // spawn reports a missing binary ASYNCHRONOUSLY: without this listener an absent taskkill
      // becomes an uncaught ENOENT that kills the CLI, and try/catch never sees it.
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => { /* best effort; the SIGKILL below still runs */ })
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL') // negative pid addresses the group
    }
  } catch { /* already gone */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

// A settled promise does not let the CLI exit. Node keeps its event loop alive for an open pipe,
// and a grandchild that escaped the kill still holds the write end. Releasing our read ends and
// unref-ing the child is what actually lets the process end.
function releaseChild(child: ReturnType<SpawnFn>): void {
  try { child.stdout?.destroy() } catch { /* already closed */ }
  try { child.stderr?.destroy() } catch { /* already closed */ }
  try { child.unref() } catch { /* already gone */ }
}

/** spawnFn is injected so the timeout path is testable without a network. */
export function makeGitRunner(spawnFn: SpawnFn = nodeSpawn): GitRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      // Spawned directly, NOT through resolveSpawnable: that wrapper exists for npm-installed
      // `.cmd` shims, and its cmd.exe hop breaks any executable path containing a space —
      // `cmd /s /c "C:\Program Files\Git\cmd\git.exe" --version` has its quotes stripped and
      // dies with `'C:\Program' is not recognized`. git ships a real git.exe, which spawn finds
      // through PATHEXT by itself; a `.cmd`-only git fails ENOENT, which reads as gitMissingMessage.
      const child = spawnFn('git', args, {
        env: { ...process.env, ...nonInteractiveEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX, so killTree can reach git's helpers.
        detached: process.platform !== 'win32',
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (r: GitResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        killTree(child)
        // Then let go of the pipes. Killing can miss a grandchild that changed process group, and
        // its inherited write end would keep BOTH 'close' and the CLI's event loop waiting
        // (measured: promise settled at 203ms, process exited at 20094ms).
        releaseChild(child)
        // Settle NOW. 'close' waits for every inherited pipe; waiting would void the bound.
        finish({ code: -1, stdout, stderr, timedOut: true })
      }, opts.timeoutMs)

      child.stdout?.on('data', (b) => { stdout += b.toString() })
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => finish({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut: false }))
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }))
    })
}

export const defaultGitRunner: GitRunner = makeGitRunner()

export type ResolvedRef = { ref: string; qualifiedRef: string; path: string }

export function repoUrl(t: GitHubTarget): string {
  return `https://github.com/${t.owner}/${t.repo}.git`
}

function repoLabel(t: GitHubTarget): string {
  return `https://github.com/${t.owner}/${t.repo}`
}

export function unreadableRepoMessage(t: GitHubTarget, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-2).join('\n')
  return [
    `could not read ${repoLabel(t)}: repository not found or not accessible.`,
    'If this is a private repository, configure git credentials and retry. With GitHub CLI:',
    '  gh auth login',
    '  gh auth setup-git',
    ...(tail ? [`git said: ${tail}`] : []),
  ].join('\n')
}

/** Read `git ls-remote --symref`: the HEAD symref names the default branch, and every other line
 *  is `<sha>\t<refname>`. Keyed by FULL ref, so refs/heads/x and refs/tags/x stay distinct.
 *  Peeled entries (`^{}`) are dropped: they name a commit, not a ref anyone can clone. */
export function parseLsRemote(stdout: string): { head: string | null; refs: Map<string, string> } {
  let head: string | null = null
  const refs = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line)
    if (symref) { head = symref[1]!; continue }
    const m = /^([0-9a-f]{40})\s+(refs\/(?:heads|tags)\/.+)$/.exec(line)
    if (!m || m[2]!.endsWith('^{}')) continue
    refs.set(m[2]!, m[1]!)
  }
  return { head, refs }
}

/** Longest-first, because a ref may contain `/` and only the real ref list can say where it ends.
 *  A branch beats a tag of the same name, which is what `git clone --branch` does with the short
 *  name; qualifiedRef records that choice for the reader, the clone still gets `ref`. */
export function splitRefAndPath(refAndPath: string, refs: Map<string, string>): ResolvedRef | null {
  const segments = refAndPath.split('/')
  for (let take = segments.length; take > 0; take--) {
    const ref = segments.slice(0, take).join('/')
    const qualifiedRef = refs.has(`refs/heads/${ref}`) ? `refs/heads/${ref}`
      : refs.has(`refs/tags/${ref}`) ? `refs/tags/${ref}`
        : null
    if (qualifiedRef) return { ref, qualifiedRef, path: segments.slice(take).join('/') }
  }
  return null
}

/** One round trip answers two questions: the default branch, and where the ref ends. The commit
 *  is NOT taken from here — an annotated tag lists its tag object, and a branch can move before
 *  the clone. fetchGitHubTemplate reads it from the checkout instead. */
export async function resolveGitHubRef(t: GitHubTarget, run: GitRunner): Promise<ResolvedRef> {
  // HEAD is listed EXPLICITLY: adding refspecs otherwise drops the symref line that names the
  // default branch (measured on this repo: 375 refs unfiltered, 188 with the filter, and no
  // `ref: refs/heads/... HEAD` unless HEAD is asked for by name).
  const res = await run(
    ['ls-remote', '--symref', repoUrl(t), 'HEAD', 'refs/heads/*', 'refs/tags/*'],
    { timeoutMs: LS_REMOTE_TIMEOUT_MS },
  )
  if (res.timedOut) throw new Error(`timed out after ${LS_REMOTE_TIMEOUT_MS / 1000}s resolving ${repoLabel(t)}`)
  if (/\bENOENT\b/.test(res.stderr)) throw new Error(gitMissingMessage())
  if (res.code !== 0) throw new Error(unreadableRepoMessage(t, res.stderr))

  const { head, refs } = parseLsRemote(res.stdout)
  if (!t.refAndPath) {
    if (!head) throw new Error(unreadableRepoMessage(t, 'the remote named no default branch'))
    return { ref: head, qualifiedRef: `refs/heads/${head}`, path: '' }
  }
  const split = splitRefAndPath(t.refAndPath, refs)
  if (!split) throw new Error(`no branch or tag ${t.refAndPath} in ${t.owner}/${t.repo}`)
  return split
}

export type GitHubSource = { repo: string; ref: string; path: string; commit: string }
export type FetchedTemplate = { source: GitHubSource; manifest: TemplateManifest }

/** What to call the manifest in a message: where the user pointed, never the temporary clone that
 *  is deleted before they read it. */
export function manifestLabel(t: GitHubTarget, r: ResolvedRef): string {
  return `${t.owner}/${t.repo}@${r.ref}:${r.path ? `${r.path}/` : ''}${MANIFEST_FILE}`
}

export function missingManifestMessage(t: GitHubTarget, r: ResolvedRef): string {
  return [
    `no ${MANIFEST_FILE} at ${t.owner}/${t.repo}@${r.ref}:${r.path || '/'}.`,
    `Point the URL at the directory that contains it, for example https://github.com/${t.owner}/${t.repo}/tree/${r.ref}/templates/<name>`,
  ].join(' ')
}

export function escapedManifestMessage(t: GitHubTarget, r: ResolvedRef): string {
  return `${MANIFEST_FILE} at ${t.owner}/${t.repo}@${r.ref}:${r.path || '/'} resolves outside the repository — refusing to read it`
}

// The clone root, symlinks resolved, so containment is compared like with like.
function containedRealPath(root: string, candidate: string): string | null {
  const realRoot = realpathSync(root)
  const real = realpathSync(candidate)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null
  return real
}

/** Resolve the ref, shallow-clone it, read the commit that was checked out, prove the manifest
 *  sits inside the clone, parse it, delete the clone. Nothing on disk outlives this call: not the
 *  variable prompt, not the POST, not the watcher. */
export async function fetchGitHubTemplate(
  target: GitHubTarget,
  run: GitRunner = defaultGitRunner,
  parse: (text: string, source: string) => TemplateManifest = parseManifestYaml,
): Promise<FetchedTemplate> {
  const resolved = await resolveGitHubRef(target, run)
  const dir = mkdtempSync(join(tmpdir(), 'insta-tpl-gh-'))
  try {
    // The short name, not resolved.qualifiedRef: `--branch` rejects a fully-qualified ref, and
    // git's own short-name tie-break already agrees with splitRefAndPath.
    const cloned = await run(
      ['clone', '--depth', '1', '--quiet', '--branch', resolved.ref, repoUrl(target), dir],
      { timeoutMs: CLONE_TIMEOUT_MS },
    )
    if (cloned.timedOut) throw new Error(`timed out after ${CLONE_TIMEOUT_MS / 1000}s cloning https://github.com/${target.owner}/${target.repo}`)
    if (/\bENOENT\b/.test(cloned.stderr)) throw new Error(gitMissingMessage())
    if (cloned.code !== 0) throw new Error(unreadableRepoMessage(target, cloned.stderr))

    // The deployed commit is the one in the checkout: an annotated tag's listing entry is its tag
    // object, and a branch can move between ls-remote and here.
    const head = await run(['-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: LS_REMOTE_TIMEOUT_MS })
    // Same three outcomes the other two calls distinguish, so a timeout or a missing git here is
    // not reported as an unreadable repository.
    if (head.timedOut) throw new Error(`timed out after ${LS_REMOTE_TIMEOUT_MS / 1000}s reading the clone of ${repoLabel(target)}`)
    if (/\bENOENT\b/.test(head.stderr)) throw new Error(gitMissingMessage())
    if (head.code !== 0) throw new Error(unreadableRepoMessage(target, head.stderr))
    const commit = head.stdout.trim()

    const manifestDir = resolved.path ? join(dir, resolved.path) : dir
    if (!existsSync(join(manifestDir, MANIFEST_FILE))) throw new Error(missingManifestMessage(target, resolved))
    // A committed symlink can point anywhere; only the resolved path proves what is being read.
    const real = containedRealPath(dir, join(manifestDir, MANIFEST_FILE))
    if (!real || !statSync(real).isFile()) throw new Error(escapedManifestMessage(target, resolved))

    // Read and parse separately so a validation failure names where the user pointed. Handing the
    // loader a directory makes it report the temp path, which is gone by the time they see it.
    const manifest = parse(readFileSync(real, 'utf8'), manifestLabel(target, resolved))
    return {
      source: { repo: `${target.owner}/${target.repo}`, ref: resolved.ref, path: resolved.path, commit },
      manifest,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
