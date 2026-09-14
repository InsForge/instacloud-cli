import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, die, printJson, handleApproval, renderNextActions, CliExit } from '../util.js'
import { flyctlBuildAndPush, ensureFlyctl, defaultBuildRunner, stderrBuildRunner, type BuildRunner } from '../flyctl-build.js'
import { packDirectory, windowsModeCaveat, type ArchiveLimits } from '../pack.js'
import { deployArchive, uploadArchive, type DeployOutcome, type Uploader } from '../deploy-archive.js'
import { parsePort } from './services.js'

type DeployOpts = { image?: string; branch?: string; group?: string; port?: string; websocket?: boolean; replaceSource?: boolean; json?: boolean }

// With --json, stdout must carry exactly one JSON document (the deploy result), so every progress
// line moves to stderr.
const note = (opts: DeployOpts) => (opts.json ? (m: string) => void process.stderr.write(m + '\n') : info)

// Map CLI options to the platform deploy request body. Pure, so it's unit-tested. --websocket is only
// sent when set (plain deploys unchanged). Exactly one of image | archive rides along.
export function deployRequestBody(source: { image: string }, branch: string, opts: DeployOpts): Record<string, unknown> {
  return {
    image: source.image,
    branch,
    group: opts.group,
    port: opts.port ? Number(opts.port) : undefined,
    websocket: opts.websocket ? true : undefined,
    replaceSource: opts.replaceSource ? true : undefined,
  }
}

// What a source directory resolved to. flyctl and local-docker build an image locally and hand it
// back for the ordinary `/deploy` call. The archive lane is different in kind: its one gated call
// enqueues the build AND the deploy as a single operation, so by the time it returns the deploy
// has already happened and there is nothing left to call -- it hands back the outcome instead.
export type DeploySource = { image: string } | { deployed: DeployOutcome }

type Lane =
  | { lane: 'flyctl' }
  | { lane: 'local-docker' }
  | { lane: 'archive'; limits: ArchiveLimits }
  | { lane: 'none'; reason: string }
  | { lane: 'legacy' }

// Ask the platform which lane serves this target, so the CLI stops knowing which provider backs
// its service. A 404 means the platform predates the contract — and because this is a GET, it
// 404s the same way for a human and an agent, which a POST would not.
async function discoverLane(api: Pick<ApiClient, 'rawRequest'>, projectId: string, branch: string, opts: DeployOpts): Promise<Lane> {
  const q = new URLSearchParams({ branch, ...(opts.group ? { group: opts.group } : {}) })
  try {
    const res = await api.rawRequest('GET', `/projects/${projectId}/source-build?${q}`)
    // Validated, not cast. Every value other than the four we know silently fell through to the
    // flyctl path below, so a server that grew a fifth lane would send this CLI down the wrong
    // one and fail somewhere unrelated. An unknown answer is the server being ahead of us, and
    // saying that is more useful than guessing.
    const lane = (res.body ?? {}) as Lane
    const tag = (lane as { lane?: string }).lane ?? ''
    const known = ['flyctl', 'local-docker', 'archive', 'none']
    if (!known.includes(tag)) {
      die(`this platform answered with a source-build lane this CLI does not know (${JSON.stringify(tag)}) — upgrade with \`insta upgrade\``)
    }
    // The tag alone is not the contract: each branch carries a payload this code then trusts.
    // An `archive` with malformed limits fell back to local defaults, so the CLI would enforce
    // caps the SERVER does not have, and a `none` with no reason died with `undefined`.
    if (tag === 'archive') {
      const l = (lane as { limits?: Record<string, unknown> }).limits
      const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
      if (!l || !positive(l.maxArchiveBytes) || !positive(l.maxExtractedBytes) || !positive(l.maxFiles)) {
        die('this platform offered the archive lane without usable size limits — upgrade with `insta upgrade`')
      }
    }
    const reason = (lane as { reason?: unknown }).reason
    if (tag === 'none' && (typeof reason !== 'string' || !reason.trim())) {
      die('this platform refused a source build without saying why — upgrade with `insta upgrade`')
    }
    return lane
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      // The route answered and the TARGET is what is missing: say so, or flyctl turns it into "no Dockerfile".
      // Both ways out: the project has several groups and none is named, or it has none at all.
      if (/compute group not found|branch not found/.test(e.message)) die(`${e.message} — name it with \`--group <name>\` (see \`insta services list\`), or add one: \`insta services add compute <name>\``)
      return { lane: 'legacy' }
    }
    throw e
  }
}

// Turn a source directory into something deployable. Returns null when an approval is pending.
export async function prepareSource(
  api: Pick<ApiClient, 'rawRequest'>,
  projectId: string,
  dir: string,
  branch: string,
  opts: DeployOpts,
  run: BuildRunner = opts.json ? stderrBuildRunner : defaultBuildRunner,
  upload?: Uploader,
): Promise<DeploySource | null> {
  const lane = await discoverLane(api, projectId, branch, opts)
  if (lane.lane === 'none') die(lane.reason)
  if (lane.lane !== 'archive') {
    // flyctl, local-docker and legacy all end in an image, and all three need a Dockerfile.
    return { image: await buildFromSource(api, projectId, dir, branch, opts, run) }
  }
  const log = note(opts)
  const absDir = resolve(process.cwd(), dir)
  const caveat = windowsModeCaveat()
  if (caveat) log(caveat)
  const packed = packDirectory(absDir, lane.limits)
  log(`packed ${dir}: ${packed.files} files, ${packed.archive.length} bytes`)
  const ref = await uploadArchive(api, projectId, packed, branch, opts, upload)
  if (!ref) return null
  log(`deploying ${packed.archive.length} bytes via the gateway (${ref.build.type})`)
  // One gated call enqueues build+deploy as an operation; the wait is ours, one short poll at a
  // time, because a platform request has to answer inside the ALB's 60s while a build runs minutes.
  // A repo-connected service refuses this with a 409 the same way it refuses an image deploy, and
  // the hint that names the FLAG rather than the API field lives here, beside the `/deploy` path.
  const out = await deployArchive(api, projectId, ref, branch, opts, Date.now, undefined, log)
    .catch((e) => { throw e instanceof ApiError && e.status === 409 ? new ApiError(e.status, repoConnectedHint(e.message), e.body) : e })
  if (!out) return null
  if ('failed' in out) die(out.failed)
  return { deployed: out }
}

// A port mismatch is the #1 deploy mistake: the app boots "successfully" but the proxy routes to
// the wrong internal port and every request is refused. For source deploys the Dockerfile states
// the truth — use its (last) EXPOSE as the default instead of a blind 8080.
export function dockerfileExposedPort(dockerfile: string): number | undefined {
  let port: number | undefined
  for (const line of dockerfile.split('\n')) {
    const m = /^\s*EXPOSE\s+(\d+)/i.exec(line)
    if (m) port = Number(m[1])
  }
  return port
}

// This message is for the target that still REQUIRES a Dockerfile: a Fly-backed service, where a
// directory deploy builds the Dockerfile in the directory and dies without one. On insta-compute
// the archive lane carries the directory to the gateway and nixpacks builds it, so this dead end is
// no longer universal. It names every way forward instead of the bare "add one".
//
// It deliberately does NOT say "save the Dockerfile `insta build --explain` prints": that file is
// not standalone — it COPYs `.nixpacks/nixpkgs-<hash>.nix` support files nixpacks writes beside it,
// which the source dir does not have. Pointing at it would swap one false promise for another. The
// detected install/start commands ARE reusable, so the message points at those.
// Pure, so it's unit-tested.
export function noDockerfileMessage(absDir: string): string {
  return [
    `no Dockerfile at ${join(absDir, 'Dockerfile')} — a directory deploy builds the Dockerfile in the directory.`,
    'Options:',
    `  - add a Dockerfile to ${absDir} (\`insta build ${absDir}\` prints the install/start commands nixpacks detected, as a starting point)`,
    '  - deploy a prebuilt image instead: `insta deploy --image <url>`',
    '  - connect the GitHub repo to the service (`insta compute connect-repo <owner/repo>`) — that lane builds Dockerfile-less repos with nixpacks server-side',
  ].join('\n')
}

// Deploy either a prebuilt image (`--image`) or a source directory (positional `<dir>`, built
// remotely on Fly and pushed with a short-lived platform-minted token). Exactly one mode.
export async function deploy(dir: string | undefined, opts: DeployOpts): Promise<void> {
  if (dir && opts.image) die('pick one: a source <dir> OR --image <url>, not both')
  if (!dir && !opts.image) die('usage: insta deploy <dir> | --image <url>  [--branch <b>] [--group <g>] [--port <n>]')

  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const log = note(opts)

  // Junk fails here, before a directory is packed and uploaded for a body the platform would only
  // refuse: the same parser every other --port in this CLI runs. `Number()` alone sent NaN as
  // `null` and let 0 or 70000 travel to the server.
  let port: number | undefined
  try {
    port = opts.port === undefined ? undefined : parsePort(opts.port)
  } catch (e) {
    die(`--${(e as Error).message}`)
  }
  if (dir && port === undefined) {
    const dockerfile = join(resolve(process.cwd(), dir), 'Dockerfile')
    const exposed = existsSync(dockerfile) ? dockerfileExposedPort(readFileSync(dockerfile, 'utf8')) : undefined
    if (exposed) {
      port = exposed
      log(`using port ${exposed} (Dockerfile EXPOSE) — override with --port`)
    }
  }

  const effOpts = { ...opts, port: port?.toString() }
  const source = dir ? await prepareSource(api, p.projectId, dir, branch, effOpts) : { image: opts.image! }
  if (!source) return // an approval is pending; the user approves and re-runs
  if ('deployed' in source) {
    // The archive lane's operation already deployed. One output shape whichever lane ran, minus
    // nextActions, which the operation read does not carry.
    const d = source.deployed
    if (opts.json) return printJson({ image: d.image, url: d.url, branch: d.branch, group: d.group, machineId: d.machineId })
    info(`deployed ${d.image} -> ${d.url} (branch ${d.branch}, group ${d.group})`)
    return
  }
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/deploy`, deployRequestBody(source, branch, effOpts))
    .catch((e) => { throw e instanceof ApiError && e.status === 409 ? new ApiError(e.status, repoConnectedHint(e.message), e.body) : e })
  if (handleApproval(res, opts.json)) return
  const what = source.image
  if (opts.json) return printJson({ image: source.image, ...res.body })
  info(`deployed ${what} -> ${res.body.url} (branch ${res.body.branch}, group ${res.body.group})`)
  renderNextActions(res.body.nextActions)
}

// The platform refuses an image deploy onto a repo-connected service and names the body field it
// wants; a CLI user can only pass the flag. Pure, so it's unit-tested.
export function repoConnectedHint(message: string): string {
  return message.replace(/pass replaceSource: true/g, 'pass --replace-source')
}

// The local image tag a daemon-side deploy runs: unique per build so a redeploy replaces, and
// legible in `docker images`. Pure, so it's unit-tested.
export function localImageTag(projectId: string, group: string | undefined, now: number = Date.now()): string {
  return `insta-src-${projectId.slice(0, 8)}-${group ?? 'default'}:${now}`
}

// Local build for a local daemon (insta-oss): the CLI and the daemon share ONE docker, so a
// locally-built tag is directly runnable — no registry, no push. Same injectable-runner pattern
// as flyctl-build.ts.
export async function dockerBuildLocal(absDir: string, tag: string, run: BuildRunner = defaultBuildRunner): Promise<string> {
  const { code } = await run('docker', ['build', '-t', tag, '.'], { cwd: absDir, env: process.env as Record<string, string> })
  if (code !== 0) throw new Error(`docker build failed (exit ${code}). See output above.`)
  return tag
}

// Source mode: mint a scoped Fly deploy token from the platform, then build+push <dir> (needs a
// Dockerfile) with flyctl's remote builder, returning the pushed image ref to deploy. Against a
// local daemon (insta-oss) the token mint answers 501 — build with docker instead, same contract.
// Exported with injectable pieces for tests (the repo's DI pattern; no global mocks).
export async function buildFromSource(
  api: Pick<ApiClient, 'rawRequest'>,
  projectId: string,
  dir: string,
  branch: string,
  opts: DeployOpts,
  run: BuildRunner = opts.json ? stderrBuildRunner : defaultBuildRunner,
): Promise<string> {
  const absDir = resolve(process.cwd(), dir)
  if (!existsSync(join(absDir, 'Dockerfile'))) die(noDockerfileMessage(absDir))
  const log = note(opts)

  let tok
  try {
    tok = await api.rawRequest('POST', `/projects/${projectId}/deploy-token`, { branch, group: opts.group })
  } catch (e) {
    // 501 = no remote builder here (insta-oss is the only deployment that answers it) — the
    // daemon deploys from the SAME docker this shell uses, so build locally and hand it the tag.
    if (!(e instanceof ApiError) || e.status !== 501) throw e
    const tag = localImageTag(projectId, opts.group)
    log(`no remote builder on this daemon — building ${dir} locally with docker…`)
    const built = await dockerBuildLocal(absDir, tag, run)
    log(`  built ${built}`)
    return built
  }
  if (handleApproval(tok, opts.json)) throw new CliExit()
  const { token, flyApp } = tok.body

  await ensureFlyctl() // cloud path only — the local path needs docker, which the daemon requires anyway
  const port = opts.port ? Number(opts.port) : 8080
  log(`building ${dir} for ${flyApp} (remote builder)…`)
  const { imageRef } = await flyctlBuildAndPush({ dir: absDir, flyApp, imageLabel: `insta-${Date.now()}`, token, port }, run)
  log(`  pushed ${imageRef}`)
  return imageRef
}
