// `login()` picks the flow from the flags; the injectable device runner (repo pattern: DI fakes,
// no global mocks) lets these tests pin the PUBLIC default — bare login = device grant + local
// browser opener — and the guard branches, without touching config or network. die() prints the
// reason to stderr and throws CliExit('exit 1'), so rejections assert 'exit 1' and the message
// is read from a captured stderr where it matters.
import { afterEach, describe, expect, it } from 'vitest'
import { login, loginClaim, loginDevice } from '../src/commands/auth.js'
import { openUrl } from '../src/util.js'
import { configureAgent } from '../src/agent.js'

type DeviceRunner = typeof loginDevice

function fakeDevice() {
  const calls: Array<{ opts: unknown; open: unknown }> = []
  const run: DeviceRunner = async (opts, open) => { calls.push({ opts, open }) }
  return { run, calls }
}

const mustNotRun: DeviceRunner = async () => { throw new Error('flow must not start') }

type ClaimRunner = typeof loginClaim
function fakeClaim() {
  const calls: Array<{ email: string; open: unknown }> = []
  const run: ClaimRunner = async (email, _opts, open) => { calls.push({ email, open }) }
  return { run, calls }
}
const claimMustNotRun: ClaimRunner = async () => { throw new Error('claim must not start') }

async function stderrOf(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as typeof process.stderr.write
  try { await fn() } finally { process.stderr.write = write }
  return lines.join('')
}

describe('login dispatch', () => {
  it('bare login rides the device grant with the local browser opener', async () => {
    const prev = process.env.INSTA_PASSWORD
    delete process.env.INSTA_PASSWORD // an ambient CI password must not divert the bare flow
    try {
      const { run, calls } = fakeDevice()
      await login({}, run)
      expect(calls).toHaveLength(1)
      expect(calls[0].open).toBe(openUrl)
    } finally {
      if (prev !== undefined) process.env.INSTA_PASSWORD = prev
    }
  })

  it('--device is the same grant, print-only (no opener)', async () => {
    const { run, calls } = fakeDevice()
    await login({ device: true }, run)
    expect(calls).toHaveLength(1)
    expect(calls[0].open).toBeUndefined()
  })

  it('a password without --email is rejected before any flow starts', async () => {
    const err = await stderrOf(() => expect(login({ password: 'x' }, mustNotRun)).rejects.toThrow('exit 1'))
    expect(err).toContain('only used with --email')
  })

  it('$INSTA_PASSWORD without --email is rejected too', async () => {
    const prev = process.env.INSTA_PASSWORD
    process.env.INSTA_PASSWORD = 'hunter2'
    try {
      const err = await stderrOf(() => expect(login({}, mustNotRun)).rejects.toThrow('exit 1'))
      expect(err).toContain('only used with --email')
    } finally {
      if (prev === undefined) delete process.env.INSTA_PASSWORD
      else process.env.INSTA_PASSWORD = prev
    }
  })

  it('an explicitly empty --email is an error, not a bare browser login', async () => {
    const err = await stderrOf(() => expect(login({ email: '' }, mustNotRun)).rejects.toThrow('exit 1'))
    expect(err).toContain('--email must not be empty')
  })

  it('--claim <email> runs the claim ceremony with the local browser opener outside agent mode', async () => {
    const { run, calls } = fakeClaim()
    await login({ claim: 'me@example.com' }, mustNotRun, run)
    expect(calls).toEqual([{ email: 'me@example.com', open: openUrl }])
  })

  it('--claim refuses to combine with another mode and needs an email', async () => {
    await expect(login({ claim: 'me@example.com', device: true }, mustNotRun, claimMustNotRun)).rejects.toThrow('exit 1')
    expect(await stderrOf(() => login({ claim: 'me@example.com', apiKey: 'insta_x' }, mustNotRun, claimMustNotRun).catch(() => {}))).toMatch(/choose one login mode/)
    expect(await stderrOf(() => login({ claim: '' }, mustNotRun, claimMustNotRun).catch(() => {}))).toMatch(/--claim needs an email/)
    expect(await stderrOf(() => login({ claim: 'not-an-email' }, mustNotRun, claimMustNotRun).catch(() => {}))).toMatch(/--claim needs an email/)
  })

  it('--claim refuses a password (that belongs to --email)', async () => {
    const err = await stderrOf(() => expect(login({ claim: 'me@example.com', password: 'x' }, mustNotRun, claimMustNotRun)).rejects.toThrow('exit 1'))
    expect(err).toMatch(/choose one login mode/)
  })

  it('--claim refuses $INSTA_PASSWORD too (the documented --password fallback)', async () => {
    const prev = process.env.INSTA_PASSWORD
    process.env.INSTA_PASSWORD = 'hunter2'
    try {
      const err = await stderrOf(() => expect(login({ claim: 'me@example.com' }, mustNotRun, claimMustNotRun)).rejects.toThrow('exit 1'))
      expect(err).toMatch(/choose one login mode/)
    } finally {
      if (prev === undefined) delete process.env.INSTA_PASSWORD
      else process.env.INSTA_PASSWORD = prev
    }
  })

  it('--api-key refuses a password too', async () => {
    const err = await stderrOf(() => expect(login({ apiKey: 'insta_x', password: 'p' }, mustNotRun, claimMustNotRun)).rejects.toThrow('exit 1'))
    expect(err).toMatch(/choose one login mode/)
  })

  it('--claim refuses an explicitly empty --email too', async () => {
    const err = await stderrOf(() => expect(login({ claim: 'me@example.com', email: '' }, mustNotRun, claimMustNotRun)).rejects.toThrow('exit 1'))
    expect(err).toMatch(/choose one login mode/)
  })

  describe('--claim in agent mode', () => {
    afterEach(() => configureAgent(null))
    it('passes no browser opener — the human is not at this machine', async () => {
      configureAgent({ source: 'cli-explicit', client: 'codex' })
      const { run, calls } = fakeClaim()
      await login({ claim: 'me@example.com' }, mustNotRun, run)
      expect(calls).toEqual([{ email: 'me@example.com', open: undefined }])
    })
  })
})
