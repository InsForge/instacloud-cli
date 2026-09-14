// Per-service env means several compute services can each define the SAME name
// (hermes / claude-code / codex each holding their own ADMIN_PASSWORD). The flat
// `{ secrets }` bundle cannot hold three values for one name, so the old read let the
// newest row win silently — a hand-set hermes password read back as codex's.
//
// The platform now WITHHOLDS a colliding name and reports it in `collisions`. These tests pin
// the client half: ask for withholding, report every collision on stderr only, and — the one
// that matters — REFUSE to spawn, because `env: { ...process.env, ...bundle }` means a withheld
// name falls through to whatever the developer once exported.
import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
import {
  assertServiceRef, branchHint, bundleQuery, collisionLines, fetchSecretBundle, secrets, secretsSet, secretsUnset, type Collision,
} from '../src/commands/secrets.js'
import { bundleFetcher, childEnv, refusalLines, runWithSecrets } from '../src/commands/run.js'
import { CliExit } from '../src/util.js'

const COLLISION: Collision[] = [
  { name: 'ADMIN_PASSWORD', services: ['compute/hermes', 'compute/claude-code', 'compute/codex'] },
]

/** Records every request the command makes, and answers with one canned body. */
function stubApi(body: unknown, status = 200) {
  const calls: string[] = []
  return {
    calls,
    rawRequest: async (m: string, p: string) => { calls.push(`${m} ${p}`); return { status, body } },
  }
}

/** Run `fn` with both streams captured — so "stderr, never stdout" is directly assertable. */
async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const so = process.stdout.write.bind(process.stdout)
  const se = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((s: string) => { out.push(String(s)); return true }) as typeof so
  process.stderr.write = ((s: string) => { err.push(String(s)); return true }) as typeof se
  try { await fn() } finally { process.stdout.write = so; process.stderr.write = se }
  return { out: out.join(''), err: err.join('') }
}

describe('bundleQuery', () => {
  it('asks the platform to withhold collisions on every general read', () => {
    expect(bundleQuery({ branch: 'dev' })).toBe('?branch=dev&on_collision=withhold')
  })

  it('scopes to one service instead — that env is unambiguous, so nothing is withheld', () => {
    expect(bundleQuery({ branch: 'dev', service: 'compute/hermes' }))
      .toBe('?branch=dev&service=compute%2Fhermes')
  })

  it('still withholds when no branch is known', () => {
    expect(bundleQuery({})).toBe('?on_collision=withhold')
  })
})

describe('assertServiceRef', () => {
  // The platform 400s an empty service; falling back to the branch-wide read would quietly answer
  // a different question (`--service "$SVC"` with SVC unset is the way this happens for real).
  it('rejects an empty or blank --service instead of reading the whole branch', async () => {
    try {
      const { err } = await capture(async () => {
        for (const raw of ['', '   ']) expect(() => assertServiceRef(raw), JSON.stringify(raw)).toThrow(CliExit)
      })
      expect(err).toContain('--service requires <type>/<name>')
    } finally { process.exitCode = 0 }
  })

  // The WRITE path guards it too, and the stakes there are higher: falling through would have put
  // the secret PROJECT-WIDE, visible to every service on the branch, when the caller asked to
  // narrow it to one service. Asserted through secretsSet, not the helper, so the wiring is pinned.
  it('guards the write path, where falling through would widen the scope', async () => {
    try {
      for (const raw of ['', '   ']) {
        await expect(secretsSet('K', 'v', { service: raw }), JSON.stringify(raw)).rejects.toThrow(CliExit)
      }
    } finally { process.exitCode = 0 }
  })

  it('accepts a service ref, and no flag at all', () => {
    expect(() => assertServiceRef('compute/hermes')).not.toThrow()
    expect(() => assertServiceRef(undefined)).not.toThrow()
  })
})

describe('collisionLines', () => {
  it('names the secret, every service that defines it, and the command that reads one', () => {
    expect(collisionLines(COLLISION)).toEqual([
      'ADMIN_PASSWORD omitted — 3 services define it:',
      '  compute/hermes, compute/claude-code, compute/codex',
      '  read one with: insta secrets --service compute/hermes',
    ])
  })

  // Following a hint that dropped an explicit --branch reads the LINKED branch — different
  // secrets, and nothing on screen saying the scope changed.
  it('carries an explicit branch into the suggested command', () => {
    expect(collisionLines(COLLISION, 'feat-x')[2])
      .toBe('  read one with: insta secrets --service compute/hermes --branch feat-x')
  })

  it('renders every entry, and nothing at all when there are none', () => {
    const two = [...COLLISION, { name: 'ADMIN_USERNAME', services: ['compute/hermes', 'compute/codex'] }]
    expect(collisionLines(two)).toHaveLength(6)
    expect(collisionLines(two)[3]).toBe('ADMIN_USERNAME omitted — 2 services define it:')
    expect(collisionLines([])).toEqual([])
  })
})

describe('branchHint', () => {
  it('names the branch only when it is not the linked one', () => {
    expect(branchHint('feat-x', 'main')).toBe('feat-x')
    expect(branchHint('main', 'main')).toBeUndefined()
    expect(branchHint(undefined, 'main')).toBeUndefined()
  })
})

describe('fetchSecretBundle', () => {
  it('requests the service-scoped URL for --service', async () => {
    const api = stubApi({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
    const b = await fetchSecretBundle(api, 'p1', { branch: 'dev', service: 'compute/hermes' })
    expect(api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&service=compute%2Fhermes'])
    expect(b).toEqual({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
  })

  it('requests withholding for a general read and surfaces the collisions', async () => {
    const api = stubApi({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION })
    const b = await fetchSecretBundle(api, 'p1', { branch: 'dev' })
    expect(api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&on_collision=withhold'])
    expect(b?.collisions).toEqual(COLLISION)
  })

  // An older platform answers without the field; absent means "none reported", not a crash.
  it('treats a missing collisions field as none', async () => {
    const api = stubApi({ secrets: { A: '1' } })
    expect((await fetchSecretBundle(api, 'p1', { branch: 'dev' }))?.collisions).toEqual([])
  })

  it('parks on a 202 approval instead of returning a bundle', async () => {
    const api = stubApi({ status: 'approval_required', action: 'secrets.read', approvalId: 'ap1' }, 202)
    try {
      const { err } = await capture(async () => {
        expect(await fetchSecretBundle(api, 'p1', { branch: 'dev' })).toBeNull()
      })
      expect(err).toContain('approval required')
      expect(process.exitCode).toBe(2)
    } finally { process.exitCode = 0 }
  })
})

describe('secrets', () => {
  const deps = (body: unknown) => ({ api: stubApi(body), projectId: 'p1', linkedBranch: 'dev' })
  const BODY = { secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION }

  it('--print puts the env on stdout and the collision on stderr, never the other way round', async () => {
    const d = deps(BODY)
    const { out, err } = await capture(() => secrets({ print: true }, d))
    expect(out).toBe('DATABASE_URL="pg://x"\n')
    expect(out).not.toContain('ADMIN_PASSWORD')
    expect(out).not.toContain('omitted')
    expect(err).toContain('ADMIN_PASSWORD omitted — 3 services define it:')
    expect(err).toContain('read one with: insta secrets --service compute/hermes')
    expect(err).not.toContain('--branch') // the read WAS the linked branch: no flag to repeat
  })

  it('repeats an explicit --branch in the hint, so following it reads the same branch', async () => {
    const d = deps(BODY)
    const { err } = await capture(() => secrets({ print: true, branch: 'feat-x' }, d))
    expect(d.api.calls).toEqual(['GET /projects/p1/secrets?branch=feat-x&on_collision=withhold'])
    expect(err).toContain('read one with: insta secrets --service compute/hermes --branch feat-x')
  })

  // --json's stdout is a documented agent-facing surface: the BARE map. Collisions must not
  // wrap it in an envelope — a consumer passing none of the new flags parses what it always did.
  it('--json keeps stdout the bare map, with no envelope keys on top', async () => {
    const d = deps(BODY)
    const { out } = await capture(() => secrets({ json: true }, d))
    const doc = JSON.parse(out)
    expect(doc).toEqual({ DATABASE_URL: 'pg://x' })
    expect(Object.keys(doc)).not.toContain('secrets')
    expect(Object.keys(doc)).not.toContain('collisions')
  })

  it('--json reports collisions as one parseable JSON line on stderr', async () => {
    const d = deps(BODY)
    const { out, err } = await capture(() => secrets({ json: true }, d))
    expect(JSON.parse(err)).toEqual({ collisions: COLLISION })
    expect(JSON.parse(out)).toEqual({ DATABASE_URL: 'pg://x' }) // stdout still parses alone
  })

  // A quiet stream is the signal that there was nothing to choose between; `[]` would make every
  // caller inspect a field that says nothing.
  it('--json says nothing at all on stderr when there are no collisions', async () => {
    const d = deps({ secrets: { DATABASE_URL: 'pg://x' }, collisions: [] })
    const { out, err } = await capture(() => secrets({ json: true }, d))
    expect(err).toBe('')
    expect(JSON.parse(out)).toEqual({ DATABASE_URL: 'pg://x' })
  })

  it('--service scopes the read to that one service', async () => {
    const d = deps({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
    const { out } = await capture(() => secrets({ print: true, service: 'compute/hermes' }, d))
    expect(d.api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&service=compute%2Fhermes'])
    expect(out).toBe('ADMIN_PASSWORD="hermes-pw"\n')
  })
})

describe('secrets unset --service', () => {
  it('sends the service query param, so only that service’s copy is deleted', async () => {
    const api = stubApi({ ok: true })
    await capture(() => secretsUnset('ADMIN_PASSWORD', { branch: 'dev', service: 'compute/hermes' }, { api, projectId: 'p1' }))
    expect(api.calls).toEqual(['DELETE /projects/p1/secrets/ADMIN_PASSWORD?branch=dev&service=compute%2Fhermes'])
  })

  // A service exists ON a branch, so the platform rejects service+no-branch. `secrets set` has
  // always defaulted to the linked branch here; unset sent no branch at all and 400d.
  it('defaults to the linked branch, and says which scope it deleted', async () => {
    const api = stubApi({ ok: true })
    const { out } = await capture(() =>
      secretsUnset('ADMIN_PASSWORD', { service: 'compute/hermes' }, { api, projectId: 'p1', linkedBranch: 'dev' }))
    expect(api.calls).toEqual(['DELETE /projects/p1/secrets/ADMIN_PASSWORD?branch=dev&service=compute%2Fhermes'])
    expect(out).toBe('unset ADMIN_PASSWORD (compute/hermes, branch dev)\n')
  })

  it('reports the effective branch under --json too', async () => {
    const api = stubApi({ ok: true })
    const { out } = await capture(() =>
      secretsUnset('ADMIN_PASSWORD', { service: 'compute/hermes', json: true }, { api, projectId: 'p1', linkedBranch: 'dev' }))
    expect(JSON.parse(out)).toEqual({ ok: true, name: 'ADMIN_PASSWORD', branch: 'dev', service: 'compute/hermes' })
  })

  it('still deletes project-wide with no flags — no branch invented without --service', async () => {
    const api = stubApi({ ok: true })
    await capture(() => secretsUnset('X', {}, { api, projectId: 'p1', linkedBranch: 'dev' }))
    expect(api.calls).toEqual(['DELETE /projects/p1/secrets/X'])
  })
})

class FakeChild extends EventEmitter {}

/** A spawn that records its calls and exits 0 — so "was it called at all" is assertable. */
function recordingSpawn(): { calls: Array<{ cmd: string; env: NodeJS.ProcessEnv }>; impl: any } {
  const calls: Array<{ cmd: string; env: NodeJS.ProcessEnv }> = []
  const impl = (cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, env: opts.env })
    const child = new FakeChild()
    queueMicrotask(() => child.emit('close', 0))
    return child
  }
  return { calls, impl }
}

describe('childEnv', () => {
  it('drops every colliding name so the parent’s stale export cannot stand in for it', () => {
    const env = childEnv({ ADMIN_PASSWORD: 'stale-codex-value', PATH: '/bin' }, { DATABASE_URL: 'pg://x' }, COLLISION, 'linux')
    expect(env.ADMIN_PASSWORD).toBeUndefined()
    expect(env.DATABASE_URL).toBe('pg://x')
    expect(env.PATH).toBe('/bin')
  })

  // Windows env names are case-insensitive, but the spread that builds this object is not: an
  // exact-key delete leaves `Admin_Password` for the child to read under ADMIN_PASSWORD, which is
  // the inheritance hole all over again. The platform is a PARAMETER so both branches run on every
  // CI host — a test that only executes on Windows is a test that mostly does not run.
  it('deletes case-insensitively on win32, where a differently cased export is the same variable', () => {
    const parent = { Admin_Password: 'stale-codex-value', admin_password: 'also-stale', Path: 'C:\\bin' }
    const env = childEnv(parent, { DATABASE_URL: 'pg://x' }, COLLISION, 'win32')
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'admin_password')).toEqual([])
    expect(env.DATABASE_URL).toBe('pg://x')
    expect(env.Path).toBe('C:\\bin') // untouched: only the names this run decides are removed
  })

  // The mirror image: on POSIX, Admin_Password is a DIFFERENT variable and deleting it would be
  // us clobbering something that was never withheld.
  it('leaves a differently cased variable alone off win32', () => {
    const env = childEnv({ Admin_Password: 'mine', ADMIN_PASSWORD: 'stale' }, {}, COLLISION, 'linux')
    expect(env.Admin_Password).toBe('mine')
    expect(env.ADMIN_PASSWORD).toBeUndefined()
  })

  // The other half, and the more consequential one: injecting credentials is what `insta run` is
  // FOR, so a stale `Database_Url` in the shell winning over the bundle's `DATABASE_URL` would make
  // the command unreliable for every variable, not just a colliding one.
  it('lets an injected name win over every parent casing on win32', () => {
    const parent = { Database_Url: 'pg://stale', DATABASE_url: 'pg://also-stale', Path: 'C:\\bin' }
    const env = childEnv(parent, { DATABASE_URL: 'pg://fresh' }, [], 'win32')
    // Exactly one key for that variable, in OUR casing, with OUR value — no second key for
    // CreateProcess to choose between.
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'database_url')).toEqual(['DATABASE_URL'])
    expect(env.DATABASE_URL).toBe('pg://fresh')
    expect(env.Path).toBe('C:\\bin') // the deletion loop must not over-reach past claimed names
  })

  it('keeps both casings as separate variables off win32', () => {
    const parent = { Database_Url: 'pg://stale', Path: '/bin' }
    const env = childEnv(parent, { DATABASE_URL: 'pg://fresh' }, [], 'linux')
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'database_url').sort())
      .toEqual(['DATABASE_URL', 'Database_Url'])
    expect(env.Database_Url).toBe('pg://stale')
    expect(env.DATABASE_URL).toBe('pg://fresh')
  })

  // A platform that reports a collision while still merging its value: the name is withheld, so it
  // must not be written back from the bundle either — in any casing.
  // A key of `__proto__` would set the prototype rather than create an entry with `env[k] = v`,
  // and the secret would vanish with no error. The platform's name rule makes it unreachable, but
  // this CLI points at whatever INSTA_API_URL names, so it does not rely on that.
  it('injects a name that would otherwise hit Object.prototype', () => {
    for (const platform of ['win32', 'linux'] as const) {
      // JSON.parse, not a literal: `{ __proto__: 'v' }` is the prototype-setting syntax and would
      // not create a key at all (and with a string value the spec ignores it outright), so the
      // literal form silently tests nothing.
      const bundle = JSON.parse('{"__proto__":"v"}') as Record<string, string>
      const env = childEnv({ PATH: '/bin' }, bundle, [], platform)
      expect(Object.prototype.hasOwnProperty.call(env, '__proto__'), platform).toBe(true)
      expect(Object.getOwnPropertyDescriptor(env, '__proto__')?.value, platform).toBe('v')
      expect(Object.getPrototypeOf(env), platform).toBe(Object.prototype)
    }
  })

  it('never re-adds a withheld name on win32, even one the bundle carried', () => {
    const env = childEnv({ Admin_Password: 'stale' }, { ADMIN_PASSWORD: 'merged-value', OK: '1' }, COLLISION, 'win32')
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'admin_password')).toEqual([])
    expect(env.OK).toBe('1')
  })
})

describe('run with a collision', () => {
  it('refuses: nothing is spawned, and the exit code is the gate code 2', async () => {
    const { calls, impl } = recordingSpawn()
    try {
      const { out, err } = await capture(async () => {
        await expect(runWithSecrets('echo', ['hi'], {
          fetchBundle: async () => ({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION }),
          spawnImpl: impl,
        })).rejects.toBeInstanceOf(CliExit)
      })
      expect(calls).toEqual([]) // the whole point: no child ran
      expect(process.exitCode).toBe(2)
      expect(err).toContain('ADMIN_PASSWORD omitted — 3 services define it:')
      expect(err).toContain('--ignore-collisions')
      expect(out).toBe('') // run's stdout belongs to the child; there is no child
    } finally { process.exitCode = 0 }
  })

  it('refusalLines say how to proceed both ways', () => {
    const lines = refusalLines(COLLISION).join('\n')
    expect(lines).toContain('insta run --service compute/hermes -- <cmd>')
    expect(lines).toContain('insta run --ignore-collisions -- <cmd>')
    expect(lines).not.toContain('--branch')
  })

  // Both ways forward have to stay on the branch that was actually read.
  it('refusalLines repeat an explicit branch in both suggestions', () => {
    const lines = refusalLines(COLLISION, 'feat-x').join('\n')
    expect(lines).toContain('insta run --service compute/hermes --branch feat-x -- <cmd>')
    expect(lines).toContain('insta run --ignore-collisions --branch feat-x -- <cmd>')
    expect(lines).toContain('insta secrets --service compute/hermes --branch feat-x')
  })

  it('the refusal printed by run carries the branch hint it was given', async () => {
    const { calls, impl } = recordingSpawn()
    try {
      const { err } = await capture(async () => {
        await expect(runWithSecrets('echo', ['hi'], {
          fetchBundle: async () => ({ secrets: {}, collisions: COLLISION }),
          spawnImpl: impl,
          branchHint: 'feat-x',
        })).rejects.toBeInstanceOf(CliExit)
      })
      expect(calls).toEqual([])
      expect(err).toContain('--branch feat-x')
    } finally { process.exitCode = 0 }
  })

  // The regression that motivated the refusal: a withheld name is simply MISSING from the
  // bundle, and `{ ...process.env, ...bundle }` then hands the child whatever the developer
  // once exported — hermes' command running against codex's password.
  it('--ignore-collisions runs but strips the name, even when process.env holds a value for it', async () => {
    process.env.ADMIN_PASSWORD = 'stale-codex-value'
    try {
      const { err } = await capture(async () => {
        const code = await runWithSecrets(
          process.execPath,
          ['-e', 'process.exit(process.env.ADMIN_PASSWORD === undefined && process.env.DATABASE_URL === "pg://x" ? 7 : 1)'],
          {
            fetchBundle: async () => ({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION }),
            ignoreCollisions: true,
          },
        )
        expect(code).toBe(7) // 7 only if ADMIN_PASSWORD reached the child as absent
      })
      expect(err).toContain('ADMIN_PASSWORD')
    } finally { delete process.env.ADMIN_PASSWORD }
  })
})

describe('run --service', () => {
  it('fetches that service’s own env and spawns normally', async () => {
    const api = stubApi({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
    const { calls, impl } = recordingSpawn()
    const code = await runWithSecrets('hermes-cmd', [], {
      fetchBundle: bundleFetcher(api, 'p1', { branch: 'dev', service: 'compute/hermes' }),
      spawnImpl: impl,
    })
    expect(code).toBe(0)
    expect(api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&service=compute%2Fhermes'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.env.ADMIN_PASSWORD).toBe('hermes-pw')
  })
})
