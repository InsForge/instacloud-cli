// `insta run -- <cmd>` — the Railway model for credentials: fetch the branch's secret bundle
// per invocation and inject it into the CHILD PROCESS ENVIRONMENT only. Nothing is written to
// disk, so there is no .env to leak, stale-out, or commit. The bundle exists exactly as long
// as the process does.
import { spawn } from 'node:child_process'
import { ApiClient, requireProject } from '../api.js'
import { CliExit, die, refuse, relayExitCode } from '../util.js'
import { assertServiceRef, branchHint, collisionLines, fetchSecretBundle, type Collision, type SecretBundle, type SecretsApi } from './secrets.js'

export type RunDeps = {
  fetchBundle: () => Promise<SecretBundle>
  cwd?: string
  spawnImpl?: typeof spawn
  // Proceed despite a collision — the colliding names are then stripped from the child env.
  ignoreCollisions?: boolean
  // Printed only once we're actually going to spawn, so the "running with N secrets" line can
  // never precede a refusal.
  announce?: (bundle: SecretBundle) => void
  // The branch to name in a refusal's suggested commands — set only when it isn't the linked one.
  branchHint?: string
}

/** The bundle read, as run does it: the same GET as `insta secrets`, general or --service. */
export function bundleFetcher(
  api: SecretsApi,
  projectId: string,
  opts: { branch?: string; service?: string },
): () => Promise<SecretBundle> {
  return async () => {
    const b = await fetchSecretBundle(api, projectId, opts)
    if (!b) throw new CliExit() // gated (202): handleApproval already said how to unblock it
    return b
  }
}

/** The child's environment: the parent's, plus the bundle, MINUS every colliding name.
 *  Deleting is not belt-and-braces. A withheld name is simply ABSENT from the bundle, so the
 *  spread would let the parent's own export stand in for it — the developer who once exported
 *  codex's password would run hermes' command against it, with no sign anything was withheld.
 *
 *  Windows needs more than an exact-key delete, for both halves. Env names there are
 *  case-insensitive; a plain JS object's keys are not, so this object can hold `Database_Url` from
 *  the shell and `DATABASE_URL` from the bundle as two keys for one variable — and CreateProcess,
 *  which does collapse them, picks. That makes a stale shell export able to beat the injected
 *  credential, which is the whole point of `insta run`, not just a hazard for a colliding name.
 *  So on win32 every name we DECIDE — injected or withheld — wins over whatever casings the parent
 *  had: the parent's are removed, then the bundle's own casing is written back. Off win32 nothing
 *  changes: POSIX names really are case-sensitive, so `Database_Url` there is a different variable
 *  that is none of our business, and collapsing the two would itself be the bug. */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  bundle: Record<string, string>,
  collisions: Collision[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const withheld = new Set(collisions.map((c) => c.name.toLowerCase()))
  if (platform === 'win32') {
    const env: NodeJS.ProcessEnv = { ...parent }
    // Every name this run decides, whether it ends up injected or withheld.
    const claimed = new Set([...Object.keys(bundle), ...collisions.map((c) => c.name)].map((n) => n.toLowerCase()))
    for (const key of Object.keys(env)) if (claimed.has(key.toLowerCase())) delete env[key]
    // A withheld name stays gone in every casing — including one the bundle itself carried, which
    // is a platform that answered `collisions` while still merging the values.
    //
    // defineProperty, not `env[k] = v`: a key of `__proto__` would otherwise set the prototype
    // instead of creating an entry, and the secret would vanish silently. The platform's name rule
    // (`^[A-Z][A-Z0-9_]{0,63}$`) makes that unreachable today — and that is exactly why it is worth
    // one call rather than a trusted invariant: this CLI points at whatever `INSTA_API_URL` names,
    // including a self-hosted insta-oss daemon whose validation is not this repo's to guarantee.
    //
    // The same rule is what makes two bundle keys differing ONLY by case impossible (case-differing
    // needs a lowercase letter, which the rule forbids). If it ever loosens, this loop is where it
    // bites: both variants would be written and Windows would resolve one of them arbitrarily.
    for (const [k, v] of Object.entries(bundle)) {
      if (withheld.has(k.toLowerCase())) continue
      Object.defineProperty(env, k, { value: v, enumerable: true, configurable: true, writable: true })
    }
    return env
  }
  const env: NodeJS.ProcessEnv = { ...parent, ...bundle }
  for (const c of collisions) delete env[c.name]
  return env
}

/** Pure: why run stopped, and the two ways forward. `branchHint` is the branch to name in the
 *  suggested commands — set only when the run was NOT on the linked branch, since a hint that
 *  drops an explicit --branch would send the user to read a different branch's secrets. */
export function refusalLines(collisions: Collision[], branchHint?: string): string[] {
  const n = collisions.length
  const b = branchHint ? ` --branch ${branchHint}` : ''
  return [
    `refusing to run: ${n} secret name${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} defined by more than one service, so the bundle cannot say which value the command should get:`,
    ...collisionLines(collisions, branchHint),
    `pick one service's env:   insta run --service ${collisions[0]?.services[0] ?? '<type>/<name>'}${b} -- <cmd>`,
    `or run without the name:  insta run --ignore-collisions${b} -- <cmd>`,
  ]
}

/** Core, dependency-injected for tests: spawn cmd with the bundle in env, return its exit code. */
export async function runWithSecrets(cmd: string, args: string[], deps: RunDeps): Promise<number> {
  const bundle = await deps.fetchBundle()
  const collisions = bundle.collisions ?? []
  if (collisions.length) {
    // Refuse rather than warn: with the name missing from the bundle the child would silently
    // inherit the parent's value, and even clearing it isn't enough — the child may hold a
    // compiled-in default or load its own .env, so a missing credential need not be observable.
    if (!deps.ignoreCollisions) refuse(refusalLines(collisions, deps.branchHint))
    process.stderr.write(
      `warning: --ignore-collisions — ${collisions.map((c) => c.name).join(', ')} removed from the child environment (${collisions.length} name${collisions.length === 1 ? '' : 's'} defined by more than one service)\n`,
    )
  }
  const env = childEnv(process.env, bundle.secrets, collisions)
  deps.announce?.(bundle)
  return await new Promise<number>((resolve, reject) => {
    const child = (deps.spawnImpl ?? spawn)(cmd, args, { stdio: 'inherit', cwd: deps.cwd, env })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export async function run(
  cmdAndArgs: string[],
  opts: { branch?: string; service?: string; ignoreCollisions?: boolean },
): Promise<void> {
  const [cmd, ...rest] = cmdAndArgs
  if (!cmd) die('usage: insta run [--branch <b>] [--service <type/name>] -- <command> [args…]')
  assertServiceRef(opts.service)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const code = await runWithSecrets(cmd!, rest, {
    fetchBundle: bundleFetcher(api, p.projectId, { branch, service: opts.service }),
    ignoreCollisions: opts.ignoreCollisions,
    branchHint: branchHint(branch, p.branch),
    // stderr, not stdout: `insta run`'s stdout belongs entirely to the child command (that's why
    // run has no --json — wrapping would break the child's own output contract).
    announce: (b) =>
      process.stderr.write(
        `running with ${Object.keys(b.secrets).length} injected secrets (${opts.service ? `${opts.service}, ` : ''}branch ${branch}) — nothing written to disk\n`,
      ),
  })
  relayExitCode(code)
}
