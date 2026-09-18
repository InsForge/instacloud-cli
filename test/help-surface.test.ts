// The command surface is a contract with the skill docs and every agent that read them. This pins
// the visible top level (spec 2026-09-17-cli-command-reorg-design §4), the permanent aliases, the
// hidden `env`, that retired paths are GONE (hard cutover, no hidden aliases), and that the runtime
// --api-url is honoured wherever it is typed.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const env = { ...process.env, INSTA_NO_AUTOUPDATE: '1', INSTA_NO_TELEMETRY: '1' }
const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...env, ...extraEnv } })

// Adding a name here is a design decision — see "Command architecture" in
// .claude/skills/developing-insta-cli/SKILL.md.
const VISIBLE = [
  'login', 'logout', 'status',
  'org', 'project', 'branch',
  'service', 'secrets', 'domain', 'compute', 'postgres', 'redis', 'mysql', 'mongodb', 'storage',
  'build', 'deploy', 'run', 'template',
  'billing', 'agent', 'config',
  'feedback', 'upgrade',
]
// Asserted WITHOUT a trailing --help: commander answers `--help` on an unrecognised path by
// printing the nearest known command's help and exiting 0 (it looks for the help flag before it
// decides the command is unknown), so `insta db --help` would pass against any tree. The bare
// path is the invocation that actually has to fail, and it does.
const RETIRED: string[][] = [
  ['services', 'scale'], ['services', 'upgrade'], ['services', 'set-access'], ['services', 'secrets'],
  ['compute', 'set-domain'], ['compute', 'check-domain'], ['compute', 'remove-domain'],
  ['db'], ['metrics'], ['logs'], ['usage'], ['manifest'], ['approvals'], ['agent-policy'], ['observe'], ['events'],
  ['mcp'], ['regions'], ['autoupdate'], ['build-logs'],
  ['billing', 'upgrade'],
]

// Command names from a commander help page: the lines indented exactly two spaces under
// "Commands:" (continuation lines of a wrapped description are indented to the description column).
function commandNames(help: string): string[] {
  const section = help.slice(help.indexOf('Commands:'))
  return section.split('\n').slice(1)
    .map((l) => /^ {2}(\S+)/.exec(l)?.[1])
    .filter((n): n is string => !!n)
    .map((n) => n.split('|')[0]!)
    .filter((n) => n !== 'help')
}

describe('top-level surface', () => {
  it('lists exactly the designed 24 commands, in order', () => {
    const r = run(['--help'])
    expect(r.status).toBe(0)
    expect(commandNames(r.stdout)).toEqual(VISIBLE)
  }, 30_000)
  it('documents --api-url once, on the root', () => {
    expect(run(['--help']).stdout).toContain('--api-url <url>')
    expect(run(['compute', 'status', '--help']).stdout).not.toContain('--api-url')
  }, 30_000)
  it('keeps services and svc as aliases of service', () => {
    for (const alias of ['services', 'svc']) {
      const r = run([alias, '--help'])
      expect(r.status, alias).toBe(0)
      expect(r.stdout).toMatch(/^\s+add\b/m)
      expect(r.stdout).not.toMatch(/^\s+scale\b/m)
    }
  }, 30_000)
  it('hides env from the root help but keeps it working', () => {
    expect(run(['--help']).stdout).not.toMatch(/^\s+env\b/m)
    const r = run(['env', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^\s+use\b/m)
  }, 30_000)
  it.each(RETIRED)('retired path `%s` is gone', (...path) => {
    const r = run([...path])
    expect(r.status).not.toBe(0)
    // commander 12's allowExcessArguments(false) rejects a retired subcommand under a still-live
    // group (e.g. `billing upgrade`) with "too many arguments", not "unknown command".
    expect(r.stderr).toMatch(/unknown command|too many arguments/)
  }, 30_000)
  it('retired `secrets lst` fails loudly instead of silently writing .env', () => {
    const r = run(['secrets', 'lst'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/unknown command|too many arguments/)
  }, 30_000)
  // The console, the landing page and third-party docs print `npx -y insta@latest setup agent …`;
  // that string must keep working on every release, so `setup agent` is a permanent hidden alias
  // of `agent setup` — the same class as `services|svc`.
  it('keeps `setup agent` as a hidden alias of `agent setup` with identical options', () => {
    expect(run(['--help']).stdout).not.toMatch(/^\s+setup\b/m)
    const alias = run(['setup', 'agent', '--help'])
    const canonical = run(['agent', 'setup', '--help'])
    expect(alias.status).toBe(0)
    expect(canonical.status).toBe(0)
    // Option flags only (the column before the description), sorted: a flag added to one
    // registration cannot silently be missing from the other.
    const flags = (help: string) => help.split('\n').filter((l) => /^\s+-/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]).sort()
    expect(flags(alias.stdout)).toEqual(flags(canonical.stdout))
  }, 30_000)
})

describe('group shapes', () => {
  it('postgres verbs take a trailing [service] and no --group', () => {
    for (const verb of ['url', 'connect', 'stats', 'limits', 'volume', 'logs', 'metrics']) {
      const r = run(['postgres', verb, '--help'])
      expect(r.stdout, verb).toMatch(new RegExp(`Usage: insta postgres ${verb} \\[options\\] \\[service\\]`))
      expect(r.stdout, verb).not.toContain('--group')
    }
    expect(run(['postgres', 'always-on', '--help']).stdout).toContain('Usage: insta postgres always-on [options] <mode> [service]')
  }, 30_000)
  it('each managed database has the same verbs', () => {
    for (const type of ['redis', 'mysql', 'mongodb']) {
      const names = commandNames(run([type, '--help']).stdout)
      expect(names, type).toEqual(['query', 'status', 'limits', 'volume', 'always-on', 'metrics', 'logs'])
    }
    expect(run(['mongodb', 'query', '--help']).stdout).toContain('--database')
    expect(run(['redis', 'query', '--help']).stdout).not.toContain('--database')
  }, 30_000)
  it('compute has scale, logs, metrics and no domain verbs; domain has attach, check, detach', () => {
    const compute = commandNames(run(['compute', '--help']).stdout)
    expect(compute).toEqual(expect.arrayContaining(['scale', 'logs', 'metrics', 'limits', 'volume', 'always-on', 'exec', 'ssh']))
    expect(compute).not.toEqual(expect.arrayContaining(['set-domain']))
    const domain = commandNames(run(['domain', '--help']).stdout)
    expect(domain).toEqual(expect.arrayContaining(['attach', 'check', 'detach', 'records']))
    expect(run(['compute', 'scale', '--help']).stdout).toContain('Usage: insta compute scale [options] <count> [service]')
    expect(run(['storage', 'set-access', '--help']).stdout).toContain('Usage: insta storage set-access [options] <access>')
  }, 30_000)
  it('reads source-build output under `build logs`, not a top-level `build-logs`', () => {
    expect(commandNames(run(['build', '--help']).stdout)).toContain('logs')
    const r = run(['build', 'logs', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--source')
    expect(r.stdout).toContain('--follow')
    expect(r.stdout).toContain('--json')
  }, 30_000)
  it('agent, config and billing carry the moved verbs', () => {
    expect(commandNames(run(['agent', '--help']).stdout)).toEqual(['setup', 'manifest', 'policy', 'approvals', 'observe', 'events'])
    expect(commandNames(run(['config', '--help']).stdout)).toEqual(['install-mcp', 'regions', 'autoupdate'])
    expect(commandNames(run(['billing', '--help']).stdout)).toEqual(['subscribe', 'portal', 'usage'])
  }, 30_000)
  it('offers --delete on compute volume only — a managed database volume is its data directory', () => {
    expect(run(['compute', 'volume', '--help']).stdout).toContain('--delete')
    for (const type of ['redis', 'mysql', 'mongodb']) {
      const help = run([type, 'volume', '--help']).stdout
      expect(help, type).not.toContain('--delete')
      expect(help, type).toContain('--size')
    }
  }, 30_000)
})

describe('--api-url placement', () => {
  const URL_A = 'http://127.0.0.1:1'
  const URL_B = 'http://127.0.0.1:2'
  // `env --json` reads config and prints the resolved apiUrl without touching the network.
  it('is honoured after the subcommand, before it, and over INSTA_API_URL', () => {
    expect(JSON.parse(run(['env', '--json', '--api-url', URL_A]).stdout).apiUrl).toBe(URL_A)
    expect(JSON.parse(run(['--api-url', URL_A, 'env', '--json']).stdout).apiUrl).toBe(URL_A)
    expect(JSON.parse(run(['env', '--json', '--api-url', URL_A], { INSTA_API_URL: URL_B }).stdout).apiUrl).toBe(URL_A)
  }, 30_000)
})
