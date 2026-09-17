import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CliExit, die, serializeEnv, handleApproval, nextActionsLines, isWebUrl, openUrl, openUrlSpawn } from '../src/util.js'

// The OAuth authorize URL is hostile to BOTH Windows shells: cmd.exe splits an unquoted line at
// every bare `&` (the tester-reported "querystring must have required property 'redirect'"), and
// even inside quotes cmd expands `%…%` sequences — which is all a percent-encoded redirect is.
// So the Windows launch must reach the browser without any shell parsing the URL: PowerShell
// -EncodedCommand, where the whole Start-Process line travels as base64(UTF-16LE).
describe('openUrlSpawn', () => {
  const oauthUrl = 'https://api.instacloud.com/auth/cli/authorize?provider=github&redirect=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&state=abc123'
  const decodePs = (args: string[]): string => Buffer.from(args[args.length - 1]!, 'base64').toString('utf16le')
  // The URL rides as base64 INSIDE the script — pull it back out and decode it.
  const decodeUrl = (args: string[]): string => {
    const script = decodePs(args)
    const m = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)
    return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : script
  }

  it('win32: pinned powershell; the URL survives byte-for-byte (& and %XX intact) with no URL byte in PS source', () => {
    const { cmd, args } = openUrlSpawn(oauthUrl, 'win32', 'C:\\Windows')
    // Absolute pinned path — a bare `powershell` would resolve via the CURRENT DIRECTORY first.
    expect(cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(decodeUrl(args)).toBe(oauthUrl)
    // The whole script is ASCII by construction — no URL byte can appear in PS source.
    expect(decodePs(args)).toMatch(/^[\x20-\x7e]+$/)
  })

  it('win32: quote characters — ASCII or the smart quotes PowerShell also honors — cannot break out', () => {
    // U+2019/U+2018 terminate a single-quoted PS literal just like ASCII ' does, so a URL like
    // this would smuggle `Start-Process calc` into an interpolated script.
    const hostile = 'https://x.test/\u2019; Start-Process calc; \u2018?a=\'b\''
    const { args } = openUrlSpawn(hostile, 'win32')
    expect(decodeUrl(args)).toBe(hostile) // delivered as DATA…
    expect(decodePs(args)).toMatch(/^[\x20-\x7e]+$/) // …never as PS source
  })

  it('darwin/linux: plain single-arg launchers', () => {
    expect(openUrlSpawn(oauthUrl, 'darwin')).toEqual({ cmd: 'open', args: [oauthUrl] })
    expect(openUrlSpawn(oauthUrl, 'linux')).toEqual({ cmd: 'xdg-open', args: [oauthUrl] })
  })
})

// The launchers are ShellExecute-family: they RUN whatever target they are handed (a UNC path is
// an execution) — so openUrl refuses everything that is not a web URL before any spawn happens.
describe('openUrl scheme gate', () => {
  it('accepts real authorize/billing URLs — a broken gate regex must fail HERE, not as a silent no-open', () => {
    // Positive coverage via the exported gate (calling openUrl(true-case) would spawn a browser).
    expect(isWebUrl('https://api.instacloud.com/auth/cli/authorize?provider=github&redirect=x&state=y')).toBe(true)
    expect(isWebUrl('http://localhost:8080/session')).toBe(true)
    expect(isWebUrl('HTTPS://X.TEST/upper-scheme')).toBe(true)
  })

  it('refuses non-http(s) targets without spawning', () => {
    expect(openUrl('file:///etc/passwd')).toBe(false)
    expect(openUrl('\\\\attacker\\share\\evil.exe')).toBe(false)
    expect(openUrl('x.test/no-scheme')).toBe(false)
  })
})

describe('serializeEnv', () => {
  it('quotes and escapes values; ends with newline', () => {
    const out = serializeEnv({ DATABASE_URL: 'postgres://u:p@h/db', A: 'x"y\\z' })
    expect(out).toContain('DATABASE_URL="postgres://u:p@h/db"')
    expect(out).toContain('A="x\\"y\\\\z"')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('empty bundle still ends with a newline', () => {
    expect(serializeEnv({})).toBe('\n')
  })
})

describe('die', () => {
  it('records exit 1 and aborts the command without forcing process.exit()', () => {
    const stderr: string[] = []
    const previousExitCode = process.exitCode
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      expect(() => die('boom')).toThrow(CliExit)
      expect(exitSpy).not.toHaveBeenCalled()
      expect(stderr.join('')).toBe('error: boom\n')
      expect(process.exitCode).toBe(1)
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
      process.exitCode = previousExitCode
    }
  })
})

// A pending gate is a diagnostic, not a result: the hint must go to stderr (stdout may be
// redirected into a creds file or a JSON parser) and the process must exit non-zero — 2, distinct
// from die()'s generic 1, so scripts/agents can branch on "approvable, re-run after approval".
describe('handleApproval', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  let outSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  })
  afterEach(() => {
    stdout.length = 0
    stderr.length = 0
    process.exitCode = undefined
    outSpy.mockRestore()
    errSpy.mockRestore()
  })

  const gated = { status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'a1' } }

  it('202: returns true, hint on stderr, stdout untouched, exit code 2', () => {
    expect(handleApproval(gated)).toBe(true)
    expect(stderr.join('')).toMatch(/approval required for deploy — run: insta agent approvals approve a1/)
    expect(stdout.join('')).toBe('')
    expect(process.exitCode).toBe(2)
  })

  it('202 + json: raw envelope on stdout, hint still on stderr, exit code 2', () => {
    expect(handleApproval(gated, true)).toBe(true)
    expect(JSON.parse(stdout.join(''))).toEqual(gated.body)
    expect(stdout.join('')).not.toMatch(/approval required for/)
    expect(stderr.join('')).toMatch(/approval required for deploy/)
    expect(process.exitCode).toBe(2)
  })

  it('returns false on a normal response and touches neither stream nor exit code', () => {
    expect(handleApproval({ status: 200, body: { ok: true } })).toBe(false)
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toBe('')
    expect(process.exitCode).toBeUndefined()
  })
})

describe('nextActionsLines', () => {
  it('renders a mapped op as an insta command with args, plus its reason', () => {
    const lines = nextActionsLines([{ op: 'service.add', reason: 'Add a service first.', args: { type: 'postgres', name: 'db' } }])
    expect(lines[0]).toBe('Next:')
    expect(lines.join('\n')).toContain('insta service add postgres db')
    expect(lines.join('\n')).toContain('Add a service first.')
  })

  it('degrades to reason-only for an unknown op and never crashes', () => {
    const lines = nextActionsLines([{ op: 'totally.unknown', reason: 'Do the thing.' }])
    expect(lines.join('\n')).toContain('Do the thing.')
  })

  it('marks gated actions', () => {
    const lines = nextActionsLines([{ op: 'deploy', reason: 'Deploy it.', gated: true, args: {} }])
    expect(lines.join('\n')).toContain('needs approval')
  })

  it('returns [] for empty/absent input', () => {
    expect(nextActionsLines(undefined)).toEqual([])
    expect(nextActionsLines([])).toEqual([])
  })

  it('renders metrics/logs hints with the compute target (runnable command)', () => {
    const metricsLines = nextActionsLines([{ op: 'metrics', reason: 'Check metrics.', args: { projectId: 'pr_1' } }])
    expect(metricsLines.join('\n')).toContain('insta compute metrics')

    const logsLines = nextActionsLines([{ op: 'logs', reason: 'Check logs.', args: { projectId: 'pr_1' } }])
    expect(logsLines.join('\n')).toContain('insta compute logs')
  })
})
