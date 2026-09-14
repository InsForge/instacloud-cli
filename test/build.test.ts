import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  computeVerdict, inferPort, envKeysFromDotEnvExample, buildReport, renderReport,
  contextStats, contextCheck, jsonReport,
  type BuildCheck, type ContextStats,
} from '../src/commands/build.js'
import type { BuildRunner } from '../src/flyctl-build.js'

const check = (over: Partial<BuildCheck>): BuildCheck =>
  ({ id: 'x', severity: 'info', status: 'pass', title: 't', ...over })

describe('computeVerdict', () => {
  it('deployable when nothing failed (skips are not failures)', () => {
    expect(computeVerdict([check({}), check({ status: 'skip', severity: 'critical' })])).toBe('deployable')
  })
  it('needs-attention on a failed warning', () => {
    expect(computeVerdict([check({ status: 'fail', severity: 'warning' })])).toBe('needs-attention')
  })
  it('failed on a failed critical (beats warnings)', () => {
    expect(computeVerdict([
      check({ status: 'fail', severity: 'warning' }),
      check({ status: 'fail', severity: 'critical' }),
    ])).toBe('failed')
  })
})

describe('inferPort', () => {
  it('an explicit --port wins', () => {
    expect(inferPort('3000', 'EXPOSE 5000')).toEqual({ port: 3000, rationale: '--port flag' })
  })
  it('falls back to the Dockerfile EXPOSE', () => {
    expect(inferPort(undefined, 'FROM x\nEXPOSE 5000')).toEqual({ port: 5000, rationale: 'Dockerfile EXPOSE 5000' })
  })
  it('reports the platform default when nothing declares a port', () => {
    expect(inferPort(undefined, undefined)).toEqual({ port: undefined, rationale: 'not detected — deploy defaults to 8080' })
  })
  it('rejects a --port that is not an integer in 1..65535 (a verifier must not bless bad input)', () => {
    expect(() => inferPort('abc', undefined)).toThrow(/1.*65535/)
    expect(() => inferPort('0', undefined)).toThrow(/1.*65535/)
    expect(() => inferPort('70000', undefined)).toThrow(/1.*65535/)
    expect(() => inferPort('80.5', undefined)).toThrow(/1.*65535/)
    expect(() => inferPort('', undefined)).toThrow(/1.*65535/) // explicit-but-empty is a mistake, not an omission
  })
})

describe('contextStats', () => {
  it('excludes a dockerignored node_modules from the shipped size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-ctx-'))
    writeFileSync(join(dir, '.dockerignore'), 'node_modules\n')
    writeFileSync(join(dir, 'app.js'), 'x'.repeat(100))
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'big.js'), 'x'.repeat(10_000))
    const ctx = contextStats(dir)
    expect(ctx.hasNodeModules).toBe(true)
    expect(ctx.nodeModulesIgnored).toBe(true)
    expect(ctx.totalBytes).toBeLessThan(10_000) // the ignored tree does not count
  })

  it('flags truncation when the walk cap is hit instead of silently undercounting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-ctx-'))
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(dir, `${n}.txt`), 'x')
    expect(contextStats(dir, 2).truncated).toBe(true)
    expect(contextStats(dir).truncated).toBe(false)
  })
})

describe('contextCheck', () => {
  const base: ContextStats = { totalBytes: 1024, nodeModulesBytes: 0, hasNodeModules: false, nodeModulesIgnored: false, truncated: false }
  it('passes a small clean context', () => {
    expect(contextCheck(base).status).toBe('pass')
  })
  it('fails when node_modules would ship', () => {
    const c = contextCheck({ ...base, hasNodeModules: true, nodeModulesBytes: 5_000_000 })
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('node_modules')
  })
  it('fails an oversized context even without node_modules', () => {
    const c = contextCheck({ ...base, totalBytes: 200 * 1024 * 1024 })
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('slow')
  })
  it('fails conservatively when the scan was truncated (size is a floor, not a fact)', () => {
    const c = contextCheck({ ...base, truncated: true })
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('truncated')
    expect(c.detail).toContain('entries') // the cap counts entries (dirs included), not files
  })
})

describe('jsonReport', () => {
  it('strips Dockerfile content without --explain and keeps it with — stdout stays parseable JSON either way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    const r = await buildReport(dir, {}, { runner: nixpacksFake(PLAN), nixpacksAvailable: true })
    const bare = JSON.parse(JSON.stringify(jsonReport(r, false)))
    expect(bare.dockerfile.content).toBeUndefined()
    expect(bare.dockerfile.source).toBe('nixpacks')
    const full = JSON.parse(JSON.stringify(jsonReport(r, true)))
    expect(full.dockerfile.content).toContain('FROM node:18')
  })

  it('is pure on the nixpacks-missing path too (the agent contract must survive a fresh machine)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    const runner: BuildRunner = async () => { throw new Error('nixpacks must not be invoked when unavailable') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: false })
    expect(JSON.parse(JSON.stringify(jsonReport(r, false))).verdict).toBe('failed')
  })
})

describe('envKeysFromDotEnvExample', () => {
  it('extracts keys, ignoring comments, blanks, and export prefixes', () => {
    expect(envKeysFromDotEnvExample('DATABASE_URL=postgres://x\n# API note\n\nexport API_KEY="y"\nnot a kv line\n'))
      .toEqual(['DATABASE_URL', 'API_KEY'])
  })
})

// A runner that answers both nixpacks calls: `plan <dir>` prints a plan, `build <dir> --out <tmp>`
// writes the generated Dockerfile.
const nixpacksFake = (planJson: string, dockerfile = 'FROM node:18\nCMD ["npm","start"]\n'): BuildRunner =>
  async (_cmd, args) => {
    if (args[0] === 'plan') return { code: 0, output: planJson }
    const out = args[args.indexOf('--out') + 1]
    mkdirSync(join(out, '.nixpacks'), { recursive: true })
    writeFileSync(join(out, '.nixpacks', 'Dockerfile'), dockerfile)
    return { code: 0, output: 'saved' }
  }

const PLAN = JSON.stringify({
  providers: ['node'],
  phases: { install: { cmds: ['npm ci'] }, build: { cmds: ['npm run build'] } },
  start: { cmd: 'npm run start' },
})

describe('buildReport', () => {
  it('user Dockerfile: dockerfile builder, EXPOSE port, no nixpacks invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\nCMD ["npm","start"]\n')
    const runner: BuildRunner = async () => { throw new Error('nixpacks must not run when a Dockerfile exists') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: true })
    expect(r.plan.builder).toBe('dockerfile')
    expect(r.dockerfile.source).toBe('user')
    expect(r.plan.port).toBe(3000)
    expect(r.plan.portRationale).toBe('Dockerfile EXPOSE 3000')
    expect(r.verdict).toBe('deployable')
  })

  it('no Dockerfile: nixpacks detects, generates, and the report carries the plan + content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"app","scripts":{"start":"node i.js"}}')
    writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=postgres://x\n')
    const r = await buildReport(dir, { port: '3000' }, { runner: nixpacksFake(PLAN), nixpacksAvailable: true })
    expect(r.plan.builder).toBe('nixpacks')
    expect(r.plan.providers).toEqual(['node'])
    expect(r.plan.startCommand).toBe('npm run start')
    expect(r.plan.envKeys).toEqual(['DATABASE_URL'])
    expect(r.dockerfile.source).toBe('nixpacks')
    expect(r.dockerfile.content).toContain('FROM node:18')
    // NOT 'deployable': `insta deploy <dir>` refuses a directory with no Dockerfile of its own, so a
    // verifier that blessed this directory would promise exactly what deploy rejects.
    expect(r.verdict).toBe('needs-attention')
  })

  it('a nixpacks-only dir is never blessed as deployable — the dockerfile check names the lane split', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"app","scripts":{"start":"node i.js"}}')
    const r = await buildReport(dir, { port: '3000' }, { runner: nixpacksFake(PLAN), nixpacksAvailable: true })
    const df = r.checks.find((c) => c.id === 'dockerfile')!
    expect(df.status).toBe('fail')
    // Warning, not critical: the plan is real (the GitHub lane does build it), so this must not
    // exit 1 — it must only stop short of "deployable".
    expect(df.severity).toBe('warning')
    expect(df.detail).toContain('insta deploy <dir>')
    // The split is now BY TARGET, not by GitHub connection: insta-compute builds this directory
    // as-is on the gateway, Fly still needs the user's own Dockerfile. Naming only one of the two
    // is what previously blessed a directory deploy refuses.
    expect(df.detail).toContain('insta-compute')
    expect(df.detail).toContain('Fly')
    expect(df.nextAction).toContain(join(dir, 'Dockerfile'))
    expect(df.nextAction).toContain('insta-compute')
    // Must NOT tell the user to save the generated Dockerfile: it COPYs .nixpacks/ support files
    // this directory has no copy of, so that advice would be a second false promise.
    expect(df.nextAction).not.toMatch(/save the generated/i)
    expect(r.verdict).toBe('needs-attention')
  })

  it('--explain labels a nixpacks Dockerfile as not standalone (it COPYs .nixpacks/ support files)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"app","scripts":{"start":"node i.js"}}')
    const generated = 'FROM node:18\nCOPY .nixpacks/nixpkgs-deadbeef.nix .nixpacks/nixpkgs-deadbeef.nix\nCMD ["npm","start"]\n'
    const r = await buildReport(dir, { port: '3000' }, { runner: nixpacksFake(PLAN, generated), nixpacksAvailable: true })
    const text = renderReport(r, true).join('\n')
    expect(text).toContain('not standalone')
    expect(text).toContain('.nixpacks/')
    expect(text).toContain('COPY .nixpacks/nixpkgs-deadbeef.nix')
  })

  it('a user Dockerfile is dumped by --explain with no not-standalone caveat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\nCMD ["npm","start"]\n')
    const runner: BuildRunner = async () => { throw new Error('nixpacks must not run when a Dockerfile exists') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: true })
    const text = renderReport(r, true).join('\n')
    expect(text).toContain('FROM node:20')
    expect(text).not.toContain('not standalone')
  })

  it('a user Dockerfile still passes the check outright (the honest case is unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\nCMD ["npm","start"]\n')
    const runner: BuildRunner = async () => { throw new Error('nixpacks must not run when a Dockerfile exists') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: true })
    const df = r.checks.find((c) => c.id === 'dockerfile')!
    expect(df.status).toBe('pass')
    expect(df.severity).toBe('critical')
    expect(r.verdict).toBe('deployable')
  })

  it('no Dockerfile and no nixpacks: critical failure with a next action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    const runner: BuildRunner = async () => ({ code: 1, output: 'unused' })
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: false })
    expect(r.verdict).toBe('failed')
    expect(r.dockerfile.source).toBeNull()
    const df = r.checks.find((c) => c.id === 'dockerfile')
    expect(df?.status).toBe('fail')
    expect(df?.severity).toBe('critical')
    expect(df?.nextAction).toContain('Dockerfile')
  })

  it('nixpacks plan without a start command is a critical failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"app"}')
    const noStart = JSON.stringify({ providers: ['node'], phases: { install: { cmds: ['npm ci'] } } })
    const r = await buildReport(dir, { port: '3000' }, { runner: nixpacksFake(noStart), nixpacksAvailable: true })
    expect(r.checks.find((c) => c.id === 'start-command')?.status).toBe('fail')
    expect(r.verdict).toBe('failed')
  })

  it('warns when node_modules would ship in the build context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\nCMD ["x"]\n')
    mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(1024))
    const runner: BuildRunner = async () => { throw new Error('unused') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: true })
    expect(r.checks.find((c) => c.id === 'context')?.status).toBe('fail')
    expect(r.verdict).toBe('needs-attention')
  })

  it('a .dockerignore covering node_modules silences the context warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\nCMD ["x"]\n')
    writeFileSync(join(dir, '.dockerignore'), 'node_modules\n.git\n')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const runner: BuildRunner = async () => { throw new Error('unused') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: true })
    expect(r.checks.find((c) => c.id === 'context')?.status).toBe('pass')
  })
})

describe('renderReport', () => {
  it('prints plan lines with rationale, check marks, and the verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    const r = await buildReport(dir, { port: '3000' }, { runner: nixpacksFake(PLAN), nixpacksAvailable: true })
    const text = renderReport(r, false).join('\n')
    expect(text).toContain('nixpacks')
    expect(text).toContain('--port flag')
    expect(text).toContain('verdict: needs-attention')
    expect(text).not.toContain('FROM node:18') // Dockerfile content only with --explain
    expect(renderReport(r, true).join('\n')).toContain('FROM node:18')
  })

  // Not just "a caveat exists": it must say the SAME thing the dockerfile check's detail says a few
  // lines below, or an agent scraping the report reads two contradicting claims about one directory.
  it('the builder line carries the same per-target caveat the report body does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    const r = await buildReport(dir, { port: '3000' }, { runner: nixpacksFake(PLAN), nixpacksAvailable: true })
    const builderLine = renderReport(r, false).find((l) => l.trim().startsWith('builder:'))!
    expect(builderLine).toContain('nixpacks')
    expect(builderLine).toContain('insta-compute')
    expect(builderLine).toContain('Dockerfile')
    // The old wording promised the lane was GitHub-only, which the archive lane made false.
    expect(builderLine).not.toContain('GitHub lane only')
    const detail = renderReport(r, false).join('\n')
    expect(detail).not.toContain('nixpacks lane runs server-side for GitHub-connected repos only')
  })

  it('a dockerfile-builder report keeps a clean builder line (no caveat where none applies)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-'))
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20\nEXPOSE 3000\nCMD ["npm","start"]\n')
    const runner: BuildRunner = async () => { throw new Error('nixpacks must not run when a Dockerfile exists') }
    const r = await buildReport(dir, {}, { runner, nixpacksAvailable: true })
    const builderLine = renderReport(r, false).find((l) => l.trim().startsWith('builder:'))!
    expect(builderLine.trim()).toBe('builder: dockerfile')
  })
})
