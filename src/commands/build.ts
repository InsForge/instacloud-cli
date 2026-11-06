// `insta build` — pre-push verification of a source directory: the detection plan (what would
// build), the Dockerfile that would be used (yours, or nixpacks-generated), and static checks.
// Entirely local and offline: no login, no project link, nothing pushed or deployed. Phase 1 is
// static-only — no Docker daemon involved.
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { info, printJson, die } from '../util.js'
import { dockerfileExposedPort } from './deploy.js'
import { contextEntries, ARCHIVE_LIMITS, type ArchiveLimits } from '../pack.js'
import { nixpacksPlan, nixpacksGeneratedDockerfile, nixpacksAvailable, quietRunner, type NixpacksPlan } from '../nixpacks.js'
import type { BuildRunner } from '../flyctl-build.js'

export type BuildCheck = {
  id: string
  severity: 'critical' | 'warning' | 'info'
  status: 'pass' | 'fail' | 'skip'
  title: string
  detail?: string
  nextAction?: string
}

export type BuildReport = {
  dir: string
  plan: {
    builder: 'dockerfile' | 'nixpacks' | null
    providers: string[]
    installCommand?: string
    buildCommand?: string
    startCommand?: string
    port?: number
    portRationale: string
    envKeys: string[]
  }
  dockerfile: { source: 'user' | 'nixpacks' | null; path?: string; content?: string }
  checks: BuildCheck[]
  // The ceilings `insta deploy <dir>` packs against on the archive lane. These are the CLI's
  // defaults: build is offline, so it cannot ask the server, whose negotiated figures win at deploy.
  archiveLimits: ArchiveLimits & { source: 'default' }
  verdict: 'deployable' | 'needs-attention' | 'failed'
}

// A failed critical sinks the build; a failed warning deserves attention; skips are not failures.
export function computeVerdict(checks: BuildCheck[]): BuildReport['verdict'] {
  const failed = checks.filter((c) => c.status === 'fail')
  if (failed.some((c) => c.severity === 'critical')) return 'failed'
  if (failed.length > 0) return 'needs-attention'
  return 'deployable'
}

// Port resolution mirrors deploy.ts: an explicit --port wins, else the Dockerfile's EXPOSE. The
// rationale string is part of the output — every plan line says why (the `fly launch` pattern).
export function inferPort(flag: string | undefined, dockerfile: string | undefined): { port?: number; rationale: string } {
  if (flag !== undefined) {
    const port = /^\d+$/.test(flag.trim()) ? Number(flag.trim()) : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be an integer between 1 and 65535, got: ${flag}`)
    return { port, rationale: '--port flag' }
  }
  const exposed = dockerfile ? dockerfileExposedPort(dockerfile) : undefined
  if (exposed) return { port: exposed, rationale: `Dockerfile EXPOSE ${exposed}` }
  return { port: undefined, rationale: 'not detected — deploy defaults to 8080' }
}

// Keys the app expects, from .env.example — surfaced so an agent can `insta secrets set` them
// before the first deploy instead of discovering missing config from runtime crashes.
export function envKeysFromDotEnvExample(content: string): string[] {
  const keys: string[] = []
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('#')) continue
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    if (key) keys.push(key)
  }
  return keys
}

const CONTEXT_WARN_BYTES = 100 * 1024 * 1024
const WALK_CAP = 50_000 // entries; hitting it marks the stats truncated (size becomes a floor)

export type ContextStats = {
  totalBytes: number
  nodeModulesBytes: number
  // Bytes in files that are already compressed (by extension): gzip -9 barely shrinks them, so
  // they are a floor on the compressed archive the deploy uploads.
  incompressibleBytes: number
  // Every entry, directories included: the build worker's file cap counts tar headers.
  entries: number
  truncated: boolean
  hasDockerignore: boolean
}

const COMPRESSED_EXT = /\.(gz|tgz|xz|txz|zst|bz2|tbz2|lz4|br|zip|7z|rar|jar|whl|png|jpe?g|gif|webp|avif|heic|mp[34]|m4[av]|mov|webm|mkv|ogg|opus|flac|woff2?|parquet)$/i

export function contextStats(dir: string, cap = WALK_CAP): ContextStats {
  const entries = contextEntries(dir, cap + 1)
  let totalBytes = 0
  let nodeModulesBytes = 0
  let incompressibleBytes = 0
  const counted = entries.slice(0, cap)
  for (const e of counted) {
    totalBytes += e.size
    if (e.path.split('/').includes('node_modules')) nodeModulesBytes += e.size
    if (!e.dir && COMPRESSED_EXT.test(e.path)) incompressibleBytes += e.size
  }
  return {
    totalBytes,
    nodeModulesBytes,
    incompressibleBytes,
    entries: counted.length,
    truncated: entries.length > cap,
    hasDockerignore: existsSync(join(dir, '.dockerignore')),
  }
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

// Worst-case bytes the tar + gzip framing adds on top of the file contents: a 512-byte header and
// up to 511 bytes of block padding per entry, the two closing blocks, and gzip's stored-block
// framing (5 bytes per 64 KiB) for data that does not compress. pack.ts compresses the tar, not the
// bare files, so the upload limit applies to totalBytes plus this.
export function archiveOverheadBytes(ctx: ContextStats, payloadBytes = ctx.totalBytes): number {
  return ctx.entries * 1023 + 1024 + Math.ceil(payloadBytes / 65535) * 5 + 32
}

// Where this context stands against the archive lane's ceilings. `over` is certain (the deploy
// will refuse it, from the walk alone); `maybe` means only the compressed size can tell, and build
// does not compress. Neither uncompressed size nor file extensions prove a compressed overflow: a
// 400 MB tree of text can pack to 50 MiB, and a stored or repetitive .zip/.png still shrinks under
// gzip -9. Only the extracted-size and entry limits are decided by the walk, so only they are `over`.
export function archiveFit(ctx: ContextStats, limits: ArchiveLimits = ARCHIVE_LIMITS): { over?: string; maybe?: string } {
  if (ctx.entries > limits.maxFiles) {
    return { over: `${ctx.entries.toLocaleString('en-US')}${ctx.truncated ? '+' : ''} entries (directories count), over the ${limits.maxFiles.toLocaleString('en-US')}-entry archive limit` }
  }
  if (ctx.totalBytes > limits.maxExtractedBytes) {
    return { over: `${mib(ctx.totalBytes)} uncompressed, over the ${mib(limits.maxExtractedBytes)} extracted-size limit` }
  }
  const already = ctx.incompressibleBytes > 0 ? ` (${mib(ctx.incompressibleBytes)} of it is already compressed and will barely shrink)` : ''
  if (ctx.incompressibleBytes + archiveOverheadBytes(ctx, ctx.incompressibleBytes) > limits.maxArchiveBytes) {
    return { maybe: `already-compressed files alone are ${mib(ctx.incompressibleBytes)}, which will likely not fit the ${mib(limits.maxArchiveBytes)} compressed upload limit (extension-based estimate, only the packed archive is exact)` }
  }
  if (ctx.totalBytes + archiveOverheadBytes(ctx) > limits.maxArchiveBytes) {
    const near = ctx.totalBytes <= limits.maxArchiveBytes ? ` — close to the limit once tar headers are counted` : ''
    return { maybe: `${mib(ctx.totalBytes)} uncompressed${already}${near} — deploy uploads it as a tar.gz archive capped at ${mib(limits.maxArchiveBytes)}, so it ships only if it compresses below that` }
  }
  return {}
}

export function contextCheck(ctx: ContextStats, limits: ArchiveLimits = ARCHIVE_LIMITS): BuildCheck {
  const shipsNodeModules = ctx.nodeModulesBytes > 0
  const tooBig = ctx.totalBytes > CONTEXT_WARN_BYTES
  const fit = archiveFit(ctx, limits)
  const size = `${mb(ctx.totalBytes)}${ctx.truncated ? '+' : ''}`
  const base = shipsNodeModules
    ? `node_modules (${mb(ctx.nodeModulesBytes)}) would ship in the ${size} build context`
    : ctx.truncated
      ? `over ${WALK_CAP.toLocaleString('en-US')} entries — scan truncated, ${size} is a floor`
      : `${size}${tooBig && !fit.over && !fit.maybe ? ' — large contexts make remote builds slow' : ''}`
  const ceiling = fit.over ? `too large for \`insta deploy <dir>\`: ${fit.over}` : fit.maybe
  const detail = ceiling ? `${base}; ${ceiling}` : base
  const bad = shipsNodeModules || tooBig || ctx.truncated || !!ceiling
  const ignore = `${ctx.hasDockerignore ? 'extend your' : 'add a'} .dockerignore (node_modules, build artifacts, secrets)`
  // An intentional large asset (a model checkpoint, a dataset) is not something to ignore away:
  // say what else gets it under the ceiling.
  const nextAction = ceiling
    ? `${ignore}; for a large file the app needs, recompress it more tightly (xz/zstd) or fetch it at start-up from storage instead of shipping it in the source`
    : ignore
  return {
    id: 'context',
    severity: 'warning',
    status: bad ? 'fail' : 'pass',
    title: 'build context',
    detail,
    ...(bad ? { nextAction } : {}),
  }
}

export async function buildReport(
  dirArg: string,
  opts: { port?: string },
  deps: { runner: BuildRunner; nixpacksAvailable: boolean },
): Promise<BuildReport> {
  const dir = resolve(process.cwd(), dirArg)
  const userDockerfilePath = join(dir, 'Dockerfile')
  const hasUserDockerfile = existsSync(userDockerfilePath)

  let dockerfile: BuildReport['dockerfile'] = { source: null }
  let np: NixpacksPlan | null = null
  let dockerfileDetail = ''
  if (hasUserDockerfile) {
    dockerfile = { source: 'user', path: userDockerfilePath, content: readFileSync(userDockerfilePath, 'utf8') }
    dockerfileDetail = 'using the Dockerfile in the directory'
  } else if (!deps.nixpacksAvailable) {
    dockerfileDetail = 'no Dockerfile in the directory, and nixpacks is not installed to generate one'
  } else {
    np = await nixpacksPlan(dir, deps.runner)
    if (!np) {
      dockerfileDetail = 'no Dockerfile, and nixpacks matched no provider for this directory'
    } else {
      const generated = await nixpacksGeneratedDockerfile(dir, deps.runner)
      if (generated) {
        dockerfile = { source: 'nixpacks', content: generated }
        dockerfileDetail = `generated by nixpacks (providers: ${np.providers.join(', ') || 'none'})`
      } else {
        dockerfileDetail = 'nixpacks detected the app but could not generate a Dockerfile'
      }
    }
  }

  const builder: BuildReport['plan']['builder'] = hasUserDockerfile ? 'dockerfile' : np ? 'nixpacks' : null
  const { port, rationale } = inferPort(opts.port, dockerfile.content)
  const envExample = join(dir, '.env.example')
  const envKeys = existsSync(envExample) ? envKeysFromDotEnvExample(readFileSync(envExample, 'utf8')) : []

  const checks: BuildCheck[] = []
  // Only a Dockerfile IN the directory passes. A nixpacks-generated one is a real plan, but it is
  // not one this machine can hand to every target: on a Fly-backed service `insta deploy <dir>`
  // builds the directory's own Dockerfile and dies without one. On insta-compute the gateway runs
  // nixpacks itself, so the same directory ships. The check stays a non-pass because it cannot know
  // the target, and the detail below says both halves rather than promising either.
  checks.push(
    dockerfile.source === 'nixpacks'
      ? {
          id: 'dockerfile',
          severity: 'warning',
          status: 'fail',
          title: 'Dockerfile',
          detail: `${dockerfileDetail} — \`insta deploy <dir>\` builds this on the gateway with nixpacks when the service runs on insta-compute, and needs your own Dockerfile on a legacy-plane one`,
          // NOT "save the generated Dockerfile here": it is not standalone (it COPYs the
          // .nixpacks/nixpkgs-<hash>.nix support files nixpacks writes beside it, which this
          // directory does not have). The detected commands above are the reusable part.
          nextAction: `on insta-compute this deploys as-is (nixpacks builds it on the gateway). On a legacy-plane service, write a Dockerfile at ${userDockerfilePath} — the detected install/start commands above are the starting point — or connect the GitHub repo (\`insta compute connect-repo <owner/repo>\`)`,
        }
      : {
          id: 'dockerfile',
          severity: 'critical',
          status: dockerfile.source ? 'pass' : 'fail',
          title: 'Dockerfile',
          detail: dockerfileDetail,
          ...(dockerfile.source ? {} : { nextAction: `add a Dockerfile at ${userDockerfilePath}, or install nixpacks (https://nixpacks.com/docs/install) so insta can show you the one it would generate` }),
        },
  )

  if (builder === 'dockerfile') {
    const hasCmd = /^\s*(CMD|ENTRYPOINT)\s/im.test(dockerfile.content ?? '')
    checks.push({
      id: 'start-command',
      severity: 'warning',
      status: hasCmd ? 'pass' : 'fail',
      title: 'start command',
      detail: hasCmd ? 'Dockerfile has a CMD/ENTRYPOINT' : 'no CMD or ENTRYPOINT in the Dockerfile — the base image must supply one',
      ...(hasCmd ? {} : { nextAction: 'add a CMD (or ENTRYPOINT) so the image starts your app' }),
    })
  } else if (builder === 'nixpacks') {
    checks.push({
      id: 'start-command',
      severity: 'critical',
      status: np?.startCommand ? 'pass' : 'fail',
      title: 'start command',
      detail: np?.startCommand ?? 'nixpacks found no start command — the built image would not run',
      ...(np?.startCommand ? {} : { nextAction: 'define one (e.g. a package.json "start" script, or a Procfile)' }),
    })
  } else {
    checks.push({ id: 'start-command', severity: 'critical', status: 'skip', title: 'start command', detail: 'skipped — no builder' })
  }

  checks.push({
    id: 'port',
    severity: 'warning',
    status: port !== undefined ? 'pass' : 'fail',
    title: 'port',
    detail: port !== undefined ? `${port} (${rationale})` : rationale,
    ...(port !== undefined ? {} : { nextAction: 'pass --port <n> (or add EXPOSE <n> to the Dockerfile) — a port mismatch is the #1 deploy mistake' }),
  })

  try {
    checks.push(contextCheck(contextStats(dir)))
  } catch (err) {
    checks.push({ id: 'context', severity: 'warning', status: 'fail', title: 'build context', detail: (err as Error).message, nextAction: 'make it readable, or exclude it in .dockerignore — deploy cannot pack it either' })
  }

  return {
    dir,
    plan: { builder, providers: np?.providers ?? [], installCommand: np?.installCommand, buildCommand: np?.buildCommand, startCommand: np?.startCommand, port, portRationale: rationale, envKeys },
    dockerfile,
    checks,
    archiveLimits: { ...ARCHIVE_LIMITS, source: 'default' },
    verdict: computeVerdict(checks),
  }
}

const MARK = { pass: '✓', fail: '✗', skip: '·' } as const

export function renderReport(r: BuildReport, explain: boolean): string[] {
  const lines: string[] = []
  lines.push(`plan for ${r.dir}:`)
  // The builder line is the first thing read (and the thing an agent scrapes), so it carries the
  // lane caveat too — "builder: nixpacks" on its own reads as a promise that is only true on some
  // targets. It has to say the SAME thing the detail below it says, or a scrape sees both claims.
  const lane = r.plan.builder === 'nixpacks' ? ' — server-side: insta-compute builds this as-is, a legacy-plane service needs your own Dockerfile' : ''
  lines.push(`  builder: ${r.plan.builder ?? 'none'}${r.plan.providers.length ? ` (providers: ${r.plan.providers.join(', ')})` : ''}${lane}`)
  if (r.plan.installCommand) lines.push(`  install: ${r.plan.installCommand}`)
  if (r.plan.buildCommand) lines.push(`  build:   ${r.plan.buildCommand}`)
  if (r.plan.startCommand) lines.push(`  start:   ${r.plan.startCommand}`)
  lines.push(`  port:    ${r.plan.port ?? '?'} (${r.plan.portRationale})`)
  if (r.plan.envKeys.length) lines.push(`  env keys (.env.example): ${r.plan.envKeys.join(', ')}`)
  lines.push('checks:')
  for (const c of r.checks) {
    const mark = c.status === 'fail' && c.severity !== 'critical' ? '⚠' : MARK[c.status]
    lines.push(`  ${mark} ${c.title}${c.detail ? ` — ${c.detail}` : ''}`)
    if (c.status === 'fail' && c.nextAction) lines.push(`      → ${c.nextAction}`)
  }
  if (explain && r.dockerfile.content) {
    lines.push(`dockerfile (${r.dockerfile.source}):`)
    // A nixpacks Dockerfile is shown for inspection, NOT for copying: it COPYs the
    // .nixpacks/nixpkgs-<hash>.nix support files nixpacks generates beside it, so saving this text
    // alone as ./Dockerfile produces a build that fails on the missing COPY.
    if (r.dockerfile.source === 'nixpacks') lines.push('  # for inspection — not standalone: it COPYs .nixpacks/ support files generated alongside it')
    for (const l of r.dockerfile.content.trimEnd().split('\n')) lines.push(`  ${l}`)
  }
  lines.push(`verdict: ${r.verdict}`)
  return lines
}

// Dockerfile content is included with --explain; without it the report stays small.
export function jsonReport(report: BuildReport, explain: boolean): BuildReport {
  return explain ? report : { ...report, dockerfile: { ...report.dockerfile, content: undefined } }
}

export async function build(dirArg: string | undefined, opts: { explain?: boolean; json?: boolean; port?: string }): Promise<void> {
  const dir = dirArg ?? '.'
  const abs = resolve(process.cwd(), dir)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) die(`no such directory: ${abs}`)
  // Only probe for nixpacks when there is no Dockerfile to verify. The probe is silent and never
  // installs anything — stdout must stay pure for --json, and a verifier must stay offline.
  const available = existsSync(join(abs, 'Dockerfile')) ? false : await nixpacksAvailable()
  const report = await buildReport(dir, opts, { runner: quietRunner, nixpacksAvailable: available })
  if (opts.json) printJson(jsonReport(report, !!opts.explain))
  else for (const line of renderReport(report, !!opts.explain)) info(line)
  if (report.verdict === 'failed') process.exitCode = 1
}
