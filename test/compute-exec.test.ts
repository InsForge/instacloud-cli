// `insta compute exec` — the argv-splitting seam (the only place in the CLI a bare `--` has special
// meaning), the --timeout bounds, and the exec request-body mapping. Mirrors the pure-function test
// pattern used throughout this suite (parseCpu/parseMemoryMb in limits.test.ts, parseVolumeGib in
// volume.test.ts): the network-touching orchestration itself is untested here, same as
// computeStart/computeVolume/computeLimits.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { splitExecArgs, resolveExecFallback, parseTimeoutSec, execRequestBody, computeExec, applyExecResult } from '../src/commands/compute.js'

const A = (...tokens: string[]) => ['node', 'insta', 'compute', 'exec', ...tokens]

describe('splitExecArgs', () => {
  // ---- the separator survived (every platform, and Windows through cmd.exe / the .exe) ----

  it('splits at the literal -- and keeps CLI options on the CLI side', () => {
    // Options sit on EITHER side of the service name, so a `--` after them is still the separator.
    // Asserted on both platforms: reading this as a Windows fallback would swallow the separator.
    // (Caught by the windows-latest CI lane, which runs this file with process.platform = win32.)
    for (const platform of ['linux', 'win32'] as const) {
      expect(splitExecArgs(A('myservice', '--branch', 'prod', '--', 'echo', 'hi', '--flag'), platform)).toEqual({
        argv: A('myservice', '--branch', 'prod'), command: ['echo', 'hi', '--flag'],
      })
    }
    expect(splitExecArgs(A('--', 'echo', 'hi'))).toEqual({ argv: A(), command: ['echo', 'hi'] })
    expect(splitExecArgs(A('--', '--help'))).toEqual({ argv: A(), command: ['--help'] })
    expect(splitExecArgs(A('myservice', '--'))).toEqual({ argv: A('myservice'), command: [] })
  })

  it('leaves anything that is not `compute exec` alone', () => {
    const other = ['node', 'insta', 'compute', 'start', 'myservice']
    expect(splitExecArgs(other)).toEqual({ argv: other })
    expect(splitExecArgs(A('myservice'), 'linux')).toEqual({ argv: A('myservice') })
    // `compute exec` as DATA for another command: `insta run` hands this argv to a local child,
    // so rewriting it would eat the child's last argument.
    for (const payload of [
      ['node', 'insta', 'run', '--', 'compute', 'exec', 'app', 'echo'],
      ['node', 'insta', 'run', '--', 'compute', 'exec', 'app', '--', 'echo'],
      ['node', 'insta', 'run', 'compute', 'exec', 'app', 'echo'],
    ]) expect(splitExecArgs(payload, 'win32')).toEqual({ argv: payload })
  })

  it('never infers a missing separator outside Windows', () => {
    expect(splitExecArgs(A('app', 'echo', 'hi'), 'linux')).toEqual({ argv: A('app', 'echo', 'hi') })
  })

  it('finds `compute exec` behind a root --api-url (with a value, or =value)', () => {
    expect(splitExecArgs(['node', 'insta', '--api-url', 'http://x', 'compute', 'exec', 'api', '--', 'ls'], 'linux'))
      .toEqual({ argv: ['node', 'insta', '--api-url', 'http://x', 'compute', 'exec', 'api'], command: ['ls'] })
    expect(splitExecArgs(['node', 'insta', '--api-url=http://x', '--agent', 'compute', 'exec', '--', 'ls'], 'linux'))
      .toEqual({ argv: ['node', 'insta', '--api-url=http://x', '--agent', 'compute', 'exec'], command: ['ls'] })
  })

  // ---- the shim ate the separator (win32 only) ----
  //
  // Everything from the first non-option token is PAYLOAD and is never interpreted, so the remote
  // command keeps its own flags and its own `--`. Only the service list splits it (below).

  it('hands the whole payload over when the separator is gone', () => {
    expect(splitExecArgs(A('app', 'printenv', 'PORT'), 'win32')).toEqual({
      argv: A(), command: ['app', 'printenv', 'PORT'], windowsFallback: true,
    })
    // The remote command's own flags must survive — `sh -c …` is the idiom this command's help
    // prescribes for shell features, and it arrives with the separator already eaten.
    expect(splitExecArgs(A('ls', '-la'), 'win32')).toEqual({
      argv: A(), command: ['ls', '-la'], windowsFallback: true,
    })
    expect(splitExecArgs(A('sh', '-c', 'echo hi'), 'win32')).toEqual({
      argv: A(), command: ['sh', '-c', 'echo hi'], windowsFallback: true,
    })
  })

  it('keeps the CLI options ahead of the payload for commander', () => {
    expect(splitExecArgs(A('--branch', 'prod', '--timeout=60', 'app', 'echo'), 'win32')).toEqual({
      argv: A('--branch', 'prod', '--timeout=60'), command: ['app', 'echo'], windowsFallback: true,
    })
    // …including a spaced value, which must not be mistaken for the payload's first token.
    expect(splitExecArgs(A('--timeout', '60', 'app', 'echo'), 'win32')).toEqual({
      argv: A('--timeout', '60'), command: ['app', 'echo'], windowsFallback: true,
    })
  })

  // The shim strips only the FIRST `--`, so a surviving one deeper than the payload's second
  // token is the remote command's own. Splitting there would drop the real first command token.
  it('treats a deeper -- as the remote command\'s own', () => {
    expect(splitExecArgs(A('app', 'echo', '--'), 'win32')).toEqual({
      argv: A(), command: ['app', 'echo', '--'], windowsFallback: true,
    })
    expect(splitExecArgs(A('app', 'sh', '-c', '--', 'echo hi'), 'win32')).toEqual({
      argv: A(), command: ['app', 'sh', '-c', '--', 'echo hi'], windowsFallback: true,
    })
  })

  // The contract that matters is end-to-end, so it is asserted end-to-end: splitExecArgs alone
  // does NOT converge (the eaten path still carries `app`), resolveExecFallback is what strips it.
  it('reaches the same remote argv whether the shim kept the separator or ate it', () => {
    const services = [{ id: 'svc_1', type: 'compute', name: 'app' }]
    const remote = ['echo', '--', 'hi']
    const settle = (tokens: string[]) => {
      const split = splitExecArgs(A(...tokens), 'win32')
      return split.windowsFallback ? resolveExecFallback(services, split.command ?? [], () => {}).command : split.command
    }
    expect(settle(['app', '--', ...remote])).toEqual(remote) // insta.cmd keeps `--`
    expect(settle(['app', ...remote])).toEqual(remote) // insta.ps1 ate it
  })

  // Help is settled by the service list like every other flag — otherwise `insta compute exec --
  // npm -h` prints the CLI's own help and exits 0 having run nothing. Only a help flag with NO
  // operand ahead of it is unambiguously ours, and that one still short-circuits to commander.
  it('sends a help flag to commander only when nothing precedes it', () => {
    for (const flag of ['--help', '-h']) {
      expect(splitExecArgs(A(flag), 'win32')).toEqual({ argv: A(flag) })
      expect(splitExecArgs(A('npm', flag), 'win32')).toEqual({
        argv: A(), command: ['npm', flag], windowsFallback: true,
      })
    }
  })

  // Regression, caught by the windows-latest lane and then by review: the payload's INTERIOR must
  // never be inspected. `insta compute exec app -- echo --json` arrives as `app echo --json`, and
  // treating that `--json` as ours drops a remote argument and turns on local JSON output;
  // `--branch`/`--timeout` would silently retarget the request.
  it('leaves declared options alone once they are inside the command', () => {
    for (const tail of [['--json'], ['--branch', 'x'], ['--timeout', '5']]) {
      expect(splitExecArgs(A('app', 'echo', ...tail), 'win32')).toEqual({
        argv: A(), command: ['app', 'echo', ...tail], windowsFallback: true,
      })
    }
  })
})

// Every regression in this file's history was the same mistake: a change to WHICH TOKENS the code
// is allowed to interpret, validated against the cases in the review comment rather than against
// every position a flag can occupy. There are only four, and this table walks all of them end to
// end (splitExecArgs → resolveExecFallback) so the next such change has to face the whole matrix.
//
// It also pins the property that hid one of those regressions for a whole CI cycle: with the
// separator INTACT, win32 and POSIX must agree exactly. A test that omits the platform argument
// silently checks linux locally and win32 on the windows-latest lane — never both.
describe('flag position matrix', () => {
  const services = [{ id: 'svc_1', type: 'compute', name: 'app' }]
  const settle = (tokens: string[], platform: NodeJS.Platform) => {
    const split = splitExecArgs(A(...tokens), platform)
    if (!split.windowsFallback) return { service: '(commander)', command: split.command }
    const t = resolveExecFallback(services, split.command ?? [], () => {})
    return { service: t.serviceName ?? '(sole)', command: t.command }
  }

  // The separator survived (cmd.exe, the released .exe, and every non-Windows shell).
  it.each([
    ['ahead of the service', ['--branch', 'prod', 'app', '--', 'echo'], ['echo']],
    ['between service and separator', ['app', '--branch', 'prod', '--', 'echo'], ['echo']],
    ['as the command, service omitted', ['--', 'ls', '-la'], ['ls', '-la']],
    ['inside the command', ['app', '--', 'echo', '--json'], ['echo', '--json']],
    ['inside the command, as a bare --', ['app', '--', 'echo', '--'], ['echo', '--']],
  ])('separator kept, flag %s — identical on both platforms', (_what, tokens, command) => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(settle(tokens, platform)).toEqual({ service: '(commander)', command })
    }
  })

  // The shim ate the separator. win32 only: POSIX never reaches the fallback.
  it.each([
    ['ahead of the service', ['--branch', 'prod', 'app', 'echo'], 'app', ['echo']],
    ['as the command, service omitted', ['ls', '-la'], '(sole)', ['ls', '-la']],
    ['as the command, a help flag', ['npm', '-h'], '(sole)', ['npm', '-h']],
    ['inside the command', ['app', 'echo', '--json'], 'app', ['echo', '--json']],
    ['inside the command, value-taking', ['app', 'echo', '--branch', 'x'], 'app', ['echo', '--branch', 'x']],
    ['inside the command, a bare --', ['app', 'echo', '--'], 'app', ['echo', '--']],
  ])('separator eaten, flag %s', (_what, tokens, service, command) => {
    expect(settle(tokens as string[], 'win32')).toEqual({ service, command })
    // POSIX never loses a separator, so it never guesses: with no `--` present there is nothing to
    // split and the argv is left for commander. (A row that DOES carry a `--` is excluded — there
    // the dash really is a separator on POSIX, which is exactly why only win32 needs recovery.)
    if (!(tokens as string[]).includes('--')) {
      expect(splitExecArgs(A(...(tokens as string[])), 'linux')).toEqual({ argv: A(...(tokens as string[])) })
    }
  })

  // The cells that must NOT run anything: a CLI option cannot be honoured once the service list is
  // what revealed it (--branch and --timeout are already spent), and help is not a remote command.
  it.each([
    ['a CLI option stranded behind the service', ['app', '--branch', 'prod', 'echo'], /before `--branch`/],
    ['an unrecognised option behind the service', ['app', '--brnach', 'prod', '--', 'echo'], /before `--brnach`/],
    ['a help flag behind the service', ['app', '--help'], /insta compute exec --help/],
  ])('separator eaten, %s — reports instead of running', (_what, tokens, message) => {
    expect(() => settle(tokens as string[], 'win32')).toThrow(message as RegExp)
  })
})

describe('resolveExecFallback', () => {
  const services = [{ id: 'svc_1', type: 'compute', name: 'app' }]
  const notes: string[] = []
  const note = (m: string) => { notes.push(m) }
  beforeEach(() => { notes.length = 0 })

  it('splits the payload on service-list membership', () => {
    expect(resolveExecFallback(services, ['app', 'printenv', 'PORT'], note))
      .toEqual({ serviceName: 'app', command: ['printenv', 'PORT'] })
    // Not a service → the whole payload is the command, flags and all.
    expect(resolveExecFallback(services, ['ls', '-la'], note))
      .toEqual({ serviceName: undefined, command: ['ls', '-la'] })
    expect(resolveExecFallback(services, [], note)).toEqual({ serviceName: undefined, command: [] })
  })

  // The guess is irreducible — `insta compute exec -- printenv PORT` and `insta compute exec
  // printenv PORT` are byte-identical here — so it must at least be VISIBLE: a service named
  // `echo` swallows the executable, and a mistyped service name is demoted and run remotely.
  it('states which reading it took, and how to force the other one', () => {
    resolveExecFallback([{ id: 's', type: 'compute', name: 'echo' }], ['echo', 'hello'], note)
    expect(notes.at(-1)).toMatch(/read `echo` as the compute service/)
    // The escape hatch must survive the shim: a plain `--` pasted back into the same PowerShell
    // session is eaten exactly as the first one was, so the remedy names insta.cmd.
    expect(notes.at(-1)).toContain('insta.cmd')

    resolveExecFallback(services, ['db', 'psql'], note)
    expect(notes.at(-1)).toMatch(/`db` is not a compute service/)

    // The command itself is never echoed — remote argv can carry tokens and passwords.
    resolveExecFallback(services, ['app', 'psql', 'postgres://u:hunter2@h/db'], note)
    expect(notes.at(-1)).not.toContain('hunter2')
  })

  it('points a help flag behind the service at the CLI\'s own help', () => {
    for (const flag of ['--help', '-h']) {
      expect(() => resolveExecFallback(services, ['app', flag], note)).toThrow(/insta compute exec --help/)
    }
    // But a help flag belonging to the remote command runs, rather than silently printing help.
    expect(resolveExecFallback(services, ['npm', '-h'], note))
      .toEqual({ serviceName: undefined, command: ['npm', '-h'] })
  })

  it('says nothing when there was nothing to guess about', () => {
    resolveExecFallback(services, ['app'], note) // no command at all — the usage error is the answer
    expect(notes).toEqual([])
  })

  // `app` really is a service, so a flag right behind it cannot be the command — it is a CLI
  // option on the wrong side of a separator that is not there. Reporting it beats waking a
  // machine to run `--brnach` as a program.
  it('reports a CLI option stranded behind the service', () => {
    for (const flag of ['--brnach', '-b', '--json']) {
      expect(() => resolveExecFallback(services, ['app', flag, 'x'], note))
        .toThrow(new RegExp(`no \\\`--\\\` separator was found before \\\`\\${flag}\\\``))
    }
    // Neither PowerShell nor `insta.cmd` may be named: cmd.exe and the released .exe reach this
    // too, with no shim involved and no `insta.cmd` on disk.
    expect(() => resolveExecFallback(services, ['app', '--json'], note)).toThrow(/^(?!.*(PowerShell|insta\.cmd))/)
  })
})

describe('parseTimeoutSec', () => {
  it('accepts the documented bounds', () => {
    expect(parseTimeoutSec('1')).toBe(1)
    expect(parseTimeoutSec('180')).toBe(180)
    expect(parseTimeoutSec('30')).toBe(30)
  })
  it('rejects out-of-range and non-integer values locally', () => {
    for (const raw of ['0', '181', '301', '-1', '1.5', 'abc', '']) {
      expect(() => parseTimeoutSec(raw), raw).toThrow(/invalid timeout/)
    }
  })
})

describe('execRequestBody', () => {
  it('omits timeoutSec when not given, so the server applies its own default', () => {
    expect(execRequestBody(['echo', 'hi'])).toEqual({ command: ['echo', 'hi'] })
  })
  it('sends timeoutSec when given', () => {
    expect(execRequestBody(['echo', 'hi'], 60)).toEqual({ command: ['echo', 'hi'], timeoutSec: 60 })
  })
})

describe('computeExec validation (throws before any network/config access)', () => {
  it('rejects an undefined or empty command with a usage message', async () => {
    await expect(computeExec('svc', undefined, {})).rejects.toThrow(/usage: insta compute exec/)
    await expect(computeExec('svc', [], {})).rejects.toThrow(/usage: insta compute exec/)
  })
  it('rejects an invalid --timeout', async () => {
    await expect(computeExec('svc', ['echo'], { timeout: '9999' })).rejects.toThrow(/invalid timeout/)
  })
  // Deliberately NOT a pre-network check any more: whether a trailing option is a misplaced CLI
  // option or the omitted-service command's own flag is only knowable from the service list, so
  // the verdict moved after the GET /services that resolveExecTarget already needed.
  it('still rejects a command that recovered to nothing', async () => {
    await expect(computeExec('svc', [], {}, { windowsFallback: false }))
      .rejects.toThrow(/usage: insta compute exec/)
  })
})

// applyExecResult takes a plain {status, body} — the same shape handleApproval already takes — so
// it's unit-testable without a network mock, same pattern as execRequestBody above.
describe('applyExecResult', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })

  it('202: exits 2 with the human approval hint on stderr, stdout untouched (non-json)', () => {
    applyExecResult({ status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'appr_1' } })
    expect(process.exitCode).toBe(2)
    expect(stderr.join('')).toMatch(/approval required for deploy — run: insta approvals approve appr_1/)
    expect(stdout.join('')).toBe('')
  })

  it('202: exits 2 and prints the raw envelope with --json (hint on stderr, never stdout)', () => {
    const body = { status: 'approval_required', action: 'deploy', approvalId: 'appr_1', message: 'needs review' }
    applyExecResult({ status: 202, body }, true)
    expect(process.exitCode).toBe(2)
    expect(JSON.parse(stdout.join(''))).toEqual(body)
    expect(stdout.join('')).not.toMatch(/approval required for/)
    expect(stderr.join('')).toMatch(/approval required for deploy/)
  })

  it('200: passes a normal exit code through untouched', () => {
    applyExecResult({ status: 200, body: { exitCode: 0, stdout: 'hi\n', stderr: '' } })
    expect(process.exitCode).toBe(0)
    expect(stdout.join('')).toBe('hi\n')
  })

  it('200: passes exit code through with --json too', () => {
    applyExecResult({ status: 200, body: { exitCode: 7, stdout: '', stderr: 'boom\n' } }, true)
    expect(process.exitCode).toBe(7)
  })

  it('200: clamps the -1 unknown-exit sentinel to 1 with a stderr note', () => {
    applyExecResult({ status: 200, body: { exitCode: -1, stdout: '', stderr: '' } })
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/note: remote exit code -1 out of range — exiting 1/)
  })

  it('200: clamps an out-of-range positive exit code (256) to 1 with a stderr note', () => {
    applyExecResult({ status: 200, body: { exitCode: 256, stdout: '', stderr: '' } })
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/note: remote exit code 256 out of range — exiting 1/)
  })

  it('200: 255 is the top of the valid range and passes through untouched', () => {
    applyExecResult({ status: 200, body: { exitCode: 255, stdout: '', stderr: '' } })
    expect(process.exitCode).toBe(255)
  })
})
