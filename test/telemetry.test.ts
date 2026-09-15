// Usage analytics: routing by environment, the opt-out switches, and — above all — that only ids,
// enums and numbers leave the machine in an event.
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/api.js'
import { ENSURE_CERT_COMMAND } from '../src/commands/compute.js'
import type { GlobalConfig } from '../src/config.js'
import {
  buildCommandEvent, commandPath, detectAgent, readState, redactArgs, redactOptions,
  sendBatch, telemetryDisabled, telemetryKey, trackCommand, POSTHOG_HOST,
} from '../src/telemetry.js'
import { CliCancel, die } from '../src/util.js'

const PROD = 'https://api.instacloud.com'
const STAGING = 'https://api.staging.instacloud.com'
const CUSTOM = 'http://localhost:4800'

const loggedIn: GlobalConfig = { apiUrl: PROD, accessToken: 'insta_' + 'k'.repeat(30), user: { id: 'user_1', email: 'a@b.c', name: 'A' } }
const anon: GlobalConfig = { apiUrl: PROD }

function fakeFetch(status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response('{"status":1}', { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function tree(): { program: Command; leaf: Command } {
  const program = new Command('insta')
  const secrets = program.command('secrets')
  const leaf = secrets.command('set <name> [value]').option('--branch <b>').action(() => {})
  return { program, leaf }
}

const ctx = (config: GlobalConfig, extra: Partial<Parameters<typeof buildCommandEvent>[4]> = {}) => ({
  cliVersion: '1.2.3', channel: 'npm', config, project: null, anonymousId: 'anon-1', env: {}, tty: false, ...extra,
})

describe('opt-out and routing', () => {
  it('reads either standard switch', () => {
    expect(telemetryDisabled({})).toBe(false)
    expect(telemetryDisabled({ DO_NOT_TRACK: '1' })).toBe(true)
    expect(telemetryDisabled({ INSTA_NO_TELEMETRY: '1' })).toBe(true)
  })

  it('routes prod and staging to different projects and custom hosts to nothing', () => {
    expect(telemetryKey(PROD)).toMatch(/^phc_/)
    expect(telemetryKey(STAGING)).toMatch(/^phc_/)
    expect(telemetryKey(PROD)).not.toBe(telemetryKey(STAGING))
    expect(telemetryKey(CUSTOM)).toBeUndefined()
  })

  it('names the subcommand chain without the program', () => {
    const { program, leaf } = tree()
    expect(commandPath(leaf)).toBe('secrets set')
    expect(commandPath(program)).toBe('')
  })

  it('recognises the agent hosting the shell', () => {
    expect(detectAgent({ CLAUDECODE: '1' })).toBe('claude-code')
    expect(detectAgent({ CURSOR_TRACE_ID: 'x' })).toBe('cursor')
    expect(detectAgent({})).toBeNull()
  })
})

describe('redaction', () => {
  it('keeps flags, numbers and allowlisted ids/enums; drops every other option value', () => {
    const out = redactOptions({
      json: true, create: true, limit: '100', branch: 'main', org: 'org_1', region: 'us-east', type: 'bug',
      password: 'hunter2', apiKey: 'insta_abc', email: 'a@b.c', detail: 'my db is down', command: 'insta secrets set K v',
      image: 'ghcr.io/acme/app:1', output: '/Users/jane/f.pdf', group: 'api', prefix: 'customers/', to: 'compute/api',
    })
    expect(out).toEqual({
      json: true, create: true, limit: '100', branch: '[REDACTED]', org: 'org_1', region: 'us-east', type: 'bug',
      password: '[REDACTED]', apiKey: '[REDACTED]', email: '[REDACTED]', detail: '[REDACTED]', command: '[REDACTED]',
      image: '[REDACTED]', output: '[REDACTED]', group: '[REDACTED]', prefix: '[REDACTED]', to: '[REDACTED]',
    })
  })

  it('drops allowlisted values that do not have the declared shape', () => {
    expect(redactOptions({ port: 'yesterday', limit: '100', region: 'New York', org: 'acme', project: 'proj_1', env: 'stagng', memory: '512mb' }))
      .toEqual({ port: '[REDACTED]', limit: '100', region: '[REDACTED]', org: '[REDACTED]', project: 'proj_1', env: '[REDACTED]', memory: '512mb' })
    expect(redactArgs('services add', ['lambda', 'x'])).toEqual(['[REDACTED]', '[REDACTED]'])
    expect(redactArgs('env use', ['stagng'])).toEqual(['[REDACTED]'])
    expect(redactArgs('env use', ['STAGING'])).toEqual(['STAGING'])
    expect(redactOptions({ env: 'Prod' })).toEqual({ env: 'Prod' })
    expect(redactArgs('approvals approve', ['appr_1'])).toEqual(['appr_1'])
    expect(redactArgs('approvals approve', ['please'])).toEqual(['[REDACTED]'])
    expect(redactArgs('metrics', ['db'])).toEqual(['db'])
    expect(redactArgs('metrics', ['prod-db'])).toEqual(['[REDACTED]'])
  })

  it('drops --set assignments whole, names included', () => {
    expect(redactOptions({ set: ['CUSTOMER_ACME_TOKEN=x', 'MODE=prod'] })).toEqual({ set: '[REDACTED]' })
  })

  it('keeps positionals only where the command declares an id or enum', () => {
    expect(redactArgs('services add', ['postgres', 'main'])).toEqual(['postgres', '[REDACTED]'])
    expect(redactArgs('services scale', ['compute', 'api', '3', 'us-east'])).toEqual(['compute', '[REDACTED]', '3', 'us-east'])
    expect(redactArgs('agent-policy rule set', ['deploy', 'approve'])).toEqual(['deploy', 'approve'])
    expect(redactArgs('run', ['/Users/jane/bin/dev.sh', 'x'])).toEqual(['[REDACTED]', '[REDACTED]'])
    expect(redactArgs('branch create', ['feat/acme-pilot'])).toEqual(['[REDACTED]'])
    expect(redactArgs('secrets set', ['DB_PASSWORD', 's3cret'])).toEqual(['[REDACTED]', '[REDACTED]'])
    expect(redactArgs('org create', ['Acme Inc'])).toEqual(['[REDACTED]'])
    expect(redactArgs('storage get', ['customers/acme/tax.pdf'])).toEqual(['[REDACTED]'])
    expect(redactArgs('deploy', ['./app'])).toEqual(['[REDACTED]'])
    expect(redactArgs('project create', [undefined])).toEqual([null])
  })
})

describe('buildCommandEvent', () => {
  it('identifies by user id when signed in, else personless by the anonymous id; never carries the email', () => {
    const a = buildCommandEvent('org list', [], {}, { durationMs: 5, exitCode: 0 }, ctx(loggedIn))
    const b = buildCommandEvent('org list', [], {}, { durationMs: 5, exitCode: 0 }, ctx(anon))
    expect(a.distinct_id).toBe('user_1')
    expect(b.distinct_id).toBe('anon-1')
    expect(JSON.stringify(a)).not.toContain('a@b.c')
    expect(JSON.stringify(a)).not.toContain(loggedIn.accessToken)
    expect(b.properties.$process_person_profile).toBe(false)
    expect(a.properties).not.toHaveProperty('$process_person_profile')
  })

  it('records outcome, auth kind, environment and linked project', () => {
    const e = buildCommandEvent('deploy', ['./app'], { json: true }, { durationMs: 900, exitCode: 2 },
      ctx(loggedIn, { project: { projectId: 'p1', orgId: 'o1', branch: 'feat' }, env: { CI: 'true', CLAUDECODE: '1' } }))
    expect(e.event).toBe('cli_command')
    expect(e.properties).toMatchObject({
      command: 'deploy', args: ['[REDACTED]'], options: { json: true }, success: false, cancelled: false, exit_code: 2,
      duration_ms: 900, env: 'prod', api_host: 'api.instacloud.com', logged_in: true, auth_kind: 'api_key',
      project_id: 'p1', org_id: 'o1', $groups: { org: 'o1', project: 'p1' }, ci: true, agent: 'claude-code', cli_version: '1.2.3', channel: 'npm',
    })
    expect(e.properties).not.toHaveProperty('branch')
    expect(buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 0 }, ctx(loggedIn)).properties).not.toHaveProperty('$groups')
    const envOnly = buildCommandEvent('deploy', [], {}, { durationMs: 1, exitCode: 0 }, ctx(loggedIn, { project: { projectId: 'p1', orgId: '', branch: 'main' } }))
    expect(envOnly.properties.$groups).toEqual({ project: 'p1' })
    const s = buildCommandEvent('status', [], {}, { durationMs: 1, exitCode: 0 }, ctx({ apiUrl: CUSTOM, accessToken: 'eyJsession' }))
    expect(s.properties).toMatchObject({ env: 'custom', api_host: 'localhost:4800', auth_kind: 'session', success: true })
    expect(buildCommandEvent('status', [], {}, { durationMs: 1, exitCode: 0 }, ctx(anon)).properties.auth_kind).toBeNull()
  })

  it('reports a relayed child status apart from the CLI outcome', () => {
    const run = buildCommandEvent('run', ['npm', 'test'], {}, { durationMs: 1, exitCode: 1, childExitCode: 1 }, ctx(loggedIn))
    expect(run.properties).toMatchObject({ success: true, exit_code: 1, child_exit_code: 1 })
    const plain = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1 }, ctx(loggedIn))
    expect(plain.properties).toMatchObject({ success: false, child_exit_code: null })
  })

  it('classifies failures by kind only — never the message', () => {
    const silent = buildCommandEvent('build', ['.'], {}, { durationMs: 1, exitCode: 1 }, ctx(anon))
    expect(silent.properties).toMatchObject({ success: false, exit_code: 1 })
    expect(silent.properties).not.toHaveProperty('error_type')

    const api = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1, error: new ApiError(403, 'forbidden for jane@example.com') }, ctx(loggedIn))
    expect(api.properties).toMatchObject({ error_type: 'api', http_status: 403 })
    expect(JSON.stringify(api)).not.toContain('forbidden')

    const stderr = process.stderr.write
    process.stderr.write = (() => true) as any
    let exit: unknown
    try { die('storage get customers/acme/: no filename') } catch (e) { exit = e } finally { process.stderr.write = stderr; process.exitCode = 0 }
    const cli = buildCommandEvent('storage get', ['customers/acme/'], {}, { durationMs: 1, exitCode: 1, error: exit }, ctx(anon))
    expect(cli.properties).toMatchObject({ error_type: 'cli', args: ['[REDACTED]'] })
    expect(JSON.stringify(cli)).not.toContain('customers/acme')

    const net = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const offline = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1, error: net }, ctx(anon))
    expect(offline.properties).toMatchObject({ error_type: 'TypeError', error_code: 'ECONNREFUSED' })
    expect(offline.properties).not.toHaveProperty('error_message')
  })

  it('reports a cancelled prompt as neither success nor error', () => {
    const e = buildCommandEvent('feedback', [], {}, { durationMs: 1, exitCode: 0, error: new CliCancel() }, ctx(anon))
    expect(e.properties).toMatchObject({ success: false, cancelled: true, exit_code: 0 })
    expect(e.properties).not.toHaveProperty('error_type')
  })
})

describe('readState', () => {
  it('mints an anonymous id once and reuses it', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'insta-telemetry-')), 'nested', 'telemetry.json')
    const { anonymousId: first } = await readState(file)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readState(file)).toEqual({ anonymousId: first })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ anonymousId: first })
  })
})

describe('sendBatch', () => {
  it('posts a PostHog batch and swallows transport failures', async () => {
    const { fetchImpl, calls } = fakeFetch()
    expect(await sendBatch('phc_k', [{ event: 'e' }], fetchImpl)).toBe(true)
    expect(calls[0]!.url).toBe(`${POSTHOG_HOST}/batch/`)
    expect(calls[0]!.body).toEqual({ api_key: 'phc_k', batch: [{ event: 'e' }] })
    expect(await sendBatch('phc_k', [], fakeFetch(500).fetchImpl)).toBe(false)
    const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await sendBatch('phc_k', [], boom)).toBe(false)
  })
})

describe('trackCommand', () => {
  const deps = async (config: GlobalConfig) => ({
    ...fakeFetch(),
    env: {} as NodeJS.ProcessEnv,
    loadConfig: async () => config,
    loadProject: async () => null,
    idFile: join(await mkdtemp(join(tmpdir(), 'insta-telemetry-')), 'telemetry.json'),
    channel: 'source',
    tty: false,
  })

  it('sends one cli_command event for a finished command', async () => {
    const d = await deps(loggedIn)
    const { leaf } = tree()
    await trackCommand(leaf, ['DB_PASSWORD', 's3cret'], { durationMs: 10, exitCode: 0 }, '1.0.0', d)
    expect(d.calls).toHaveLength(1)
    const [ev] = d.calls[0]!.body.batch
    expect(ev.event).toBe('cli_command')
    expect(ev.distinct_id).toBe('user_1')
    expect(ev.properties.command).toBe('secrets set')
    expect(ev.properties.args).toEqual(['[REDACTED]', '[REDACTED]'])
    expect(JSON.stringify(d.calls[0]!.body)).not.toContain('s3cret')
  })

  it('stays silent when opted out, on custom hosts, and for internal commands', async () => {
    const { leaf } = tree()
    const off = { ...(await deps(loggedIn)), env: { DO_NOT_TRACK: '1' } }
    await trackCommand(leaf, [], { durationMs: 1, exitCode: 0 }, '1.0.0', off)
    expect(off.calls).toHaveLength(0)

    const custom = await deps({ apiUrl: CUSTOM })
    await trackCommand(leaf, [], { durationMs: 1, exitCode: 0 }, '1.0.0', custom)
    expect(custom.calls).toHaveLength(0)

    const hidden = await deps(loggedIn)
    await trackCommand(new Command('insta').command('__update-check'), [], { durationMs: 1, exitCode: 0 }, '1.0.0', hidden)
    expect(hidden.calls).toHaveLength(0)

    // The ssh renewal hook, by the name the config block ACTUALLY invokes --
    // taken from the constant rather than retyped, so renaming the command
    // without keeping the `__` prefix fails here instead of silently putting a
    // PostHog request back on the critical path of every ssh, scp and `ssh -G`.
    const sshHook = await deps(loggedIn)
    const hookLeaf = ENSURE_CERT_COMMAND.split(/\s+/).find((t) => t.startsWith('__'))!
    await trackCommand(new Command('insta').command(hookLeaf), [], { durationMs: 1, exitCode: 0 }, '1.0.0', sshHook)
    expect(sshHook.calls, 'the ssh renewal hook sent telemetry').toHaveLength(0)
  })

  it('routes a login by the deployment it targeted, not by the previous configuration', async () => {
    const login = () => new Command('insta').command('login').option('--env <name>').option('--api-url <url>')
    const staging = await deps(loggedIn)
    const toStaging = login(); toStaging.setOptionValue('env', 'STAGING')
    await trackCommand(toStaging, [], { durationMs: 1, exitCode: 1, error: new ApiError(401, 'bad password') }, '1.0.0', staging)
    expect(staging.calls[0]!.body.api_key).toBe(telemetryKey(STAGING))
    expect(staging.calls[0]!.body.batch[0].distinct_id).not.toBe('user_1')

    const custom = await deps(loggedIn)
    const toCustom = login(); toCustom.setOptionValue('apiUrl', CUSTOM)
    await trackCommand(toCustom, [], { durationMs: 1, exitCode: 1, error: new ApiError(401, 'bad password') }, '1.0.0', custom)
    expect(custom.calls).toHaveLength(0)

    const same = await deps(loggedIn)
    const toProd = login(); toProd.setOptionValue('env', 'prod')
    await trackCommand(toProd, [], { durationMs: 1, exitCode: 0 }, '1.0.0', same)
    expect(same.calls[0]!.body.batch[0].distinct_id).toBe('user_1')
  })

  it('merges the anonymous id into whichever session appears, once, and retires it when the session goes', async () => {
    const idFile = join(await mkdtemp(join(tmpdir(), 'insta-telemetry-')), 'telemetry.json')
    const run = async (config: GlobalConfig, name: string, status = 200) => {
      const d = { ...(await deps(config)), ...fakeFetch(status), idFile }
      await trackCommand(new Command('insta').command(name), [], { durationMs: 1, exitCode: 0 }, '1.0.0', d)
      return d.calls[0]!.body.batch as Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }>
    }
    const { anonymousId: first } = await readState(idFile)
    expect((await run(anon, 'org list')).map((e) => e.event)).toEqual(['cli_command'])

    // PostHog never got the merge: keep offering it until it lands.
    expect((await run(loggedIn, 'setup agent', 500)).map((e) => e.event)).toEqual(['cli_command', '$identify'])
    expect(await readState(idFile)).toEqual({ anonymousId: first })
    const merged = await run(loggedIn, 'status')
    expect(merged[1]).toMatchObject({ event: '$identify', distinct_id: 'user_1', properties: { $anon_distinct_id: first } })
    expect(await readState(idFile)).toEqual({ anonymousId: first, identifiedAs: 'user_1' })
    expect((await run(loggedIn, 'org list')).map((e) => e.event)).toEqual(['cli_command'])

    // another account signs in over this one: a fresh id is merged, never the one user_1 already owns
    const switched = await run({ ...loggedIn, user: { id: 'user_2', email: null, name: null } }, 'login')
    expect(switched[1]!.properties.$anon_distinct_id).not.toBe(first)
    expect(await readState(idFile)).toEqual({ anonymousId: switched[1]!.properties.$anon_distinct_id, identifiedAs: 'user_2' })

    // logout or `env use`: the next command runs under a fresh id
    const [after] = await run({ apiUrl: PROD }, 'env use')
    expect(after!.distinct_id).not.toBe(switched[1]!.properties.$anon_distinct_id)
    expect(await readState(idFile)).toEqual({ anonymousId: after!.distinct_id })
  })

  it('never throws, even when the config cannot be read', async () => {
    const d = { ...(await deps(loggedIn)), loadConfig: async () => { throw new Error('unknown INSTA_ENV') } }
    const { leaf } = tree()
    await expect(trackCommand(leaf, [], { durationMs: 1, exitCode: 0 }, '1.0.0', d)).resolves.toBeUndefined()
    expect(d.calls).toHaveLength(0)
  })
})
