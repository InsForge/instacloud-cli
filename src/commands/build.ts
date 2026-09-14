// `insta build` — pre-push verification of a source directory: the detection plan (what would
// build), the Dockerfile that would be used (yours, or nixpacks-generated), and static checks.
// Entirely local and offline: no login, no project link, nothing pushed or deployed. Phase 1 is
// static-only — no Docker daemon involved.
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { info, printJson, die } from '../util.js'
import { dockerfileExposedPort } from './deploy.js'
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

export type ContextStats = { totalBytes: number; nodeModulesBytes: number; hasNodeModules: boolean; nodeModulesIgnored: boolean; truncated: boolean }

// Sizes what would actually ship: a dockerignored node_modules is skipped, not counted. (Only the
// node_modules pattern is honored — full .dockerignore glob semantics aren't reimplemented here.)
export function contextStats(dir: string, cap = WALK_CAP): ContextStats {
  const ignoreFile = join(dir, '.dockerignore')
  const ignoreLines = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : []
  const nodeModulesIgnored = ignoreLines.some((l) => ['node_modules', 'node_modules/', '/node_modules', '**/node_modules'].includes(l))
  let totalBytes = 0
  let nodeModulesBytes = 0
  let hasNodeModules = false
  let truncated = false
  let seen = 0
  const walk = (d: string, inNodeModules: boolean) => {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      if (seen++ >= cap) { truncated = true; return }
      if (name === '.git') continue
      const p = join(d, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (name === 'node_modules' && st.isDirectory()) {
        hasNodeModules = true
        if (nodeModulesIgnored) continue // excluded from the context — don't count it
      }
      const isNm = inNodeModules || name === 'node_modules'
      if (st.isDirectory()) walk(p, isNm)
      else {
        totalBytes += st.size
        if (isNm) nodeModulesBytes += st.size
      }
    }
  }
  walk(dir, false)
  return { totalBytes, nodeModulesBytes, hasNodeModules, nodeModulesIgnored, truncated }
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function contextCheck(ctx: ContextStats): BuildCheck {
  const shipsNodeModules = ctx.hasNodeModules && !ctx.nodeModulesIgnored
  const tooBig = ctx.totalBytes > CONTEXT_WARN_BYTES
  const size = `${mb(ctx.totalBytes)}${ctx.truncated ? '+' : ''}`
  const detail = shipsNodeModules
    ? `node_modules (${mb(ctx.nodeModulesBytes)}) would ship in the ${size} build context`
    : ctx.truncated
      ? `over ${WALK_CAP.toLocaleString('en-US')} entries — scan truncated, ${size} is a floor`
      : `${size}${tooBig ? ' — large contexts make remote builds slow' : ''}`
  const bad = shipsNodeModules || tooBig || ctx.truncated
  return {
    id: 'context',
    severity: 'warning',
    status: bad ? 'fail' : 'pass',
    title: 'build context',
    detail,
    ...(bad ? { nextAction: 'add a .dockerignore (node_modules, build artifacts, secrets)' } : {}),
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
          detail: `${dockerfileDetail} — \`insta deploy <dir>\` builds this on the gateway with nixpacks when the service runs on insta-compute, and needs your own Dockerfile on a Fly-backed one`,
          // NOT "save the generated Dockerfile here": it is not standalone (it COPYs the
          // .nixpacks/nixpkgs-<hash>.nix support files nixpacks writes beside it, which this
          // directory does not have). The detected commands above are the reusable part.
          nextAction: `on insta-compute this deploys as-is (nixpacks builds it on the gateway). On a Fly-backed service, write a Dockerfile at ${userDockerfilePath} — the detected install/start commands above are the starting point — or connect the GitHub repo (\`insta compute connect-repo <owner/repo>\`)`,
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

  checks.push(contextCheck(contextStats(dir)))

  return {
    dir,
    plan: { builder, providers: np?.providers ?? [], installCommand: np?.installCommand, buildCommand: np?.buildCommand, startCommand: np?.startCommand, port, portRationale: rationale, envKeys },
    dockerfile,
    checks,
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
  const lane = r.plan.builder === 'nixpacks' ? ' — server-side: insta-compute builds this as-is, a Fly-backed service needs your own Dockerfile' : ''
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
