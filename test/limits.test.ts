// `insta compute limits` / `insta db limits` — the ceiling controls that replace spec picking.
// The parsing seam is what these pin: a user types "1gb", the API takes MB, and getting that
// conversion wrong sets a ceiling an order of magnitude off in either direction.
import { describe, it, expect } from 'vitest'
import { parseMemoryMb } from '../src/commands/compute.js'

describe('parseMemoryMb', () => {
  it('treats a bare number as MB', () => {
    expect(parseMemoryMb('512')).toBe(512)
    expect(parseMemoryMb('256')).toBe(256)
  })

  it('accepts MB units in the forms people actually type', () => {
    for (const raw of ['512mb', '512MB', '512m', '512 MB', ' 512mib ']) {
      expect(parseMemoryMb(raw), raw).toBe(512)
    }
  })

  it('converts GB to MB', () => {
    expect(parseMemoryMb('1gb')).toBe(1024)
    expect(parseMemoryMb('2G')).toBe(2048)
    expect(parseMemoryMb('1.5gb')).toBe(1536)
    expect(parseMemoryMb('8Gi')).toBe(8192)
  })

  it('rejects nonsense rather than guessing', () => {
    for (const raw of ['', 'lots', '1tb', '-1gb', '0', 'gb', '1 2gb']) {
      expect(() => parseMemoryMb(raw), raw).toThrow()
    }
  })

  // The error names an example, because the failure mode without one is a user retrying the same
  // invalid string in a different case.
  it('suggests a valid form in the error', () => {
    expect(() => parseMemoryMb('huge')).toThrow(/try 512mb, 1gb, 2gb/)
  })
})

// Review round 2: both jwfing and cubic independently flagged the bare Number() on --cpu (NaN
// serializes to null on the wire) and the unvalidated db strings. These pin the new seams.
import { parseCpu, fmtMb } from '../src/commands/compute.js'
import { fetchDbInstance } from '../src/commands/postgres.js'
import { ApiError } from '../src/api.js'
import { parseDbCpu, parseDbMemory, fmtMib } from '../src/commands/postgres.js'

describe('parseCpu (compute --cpu override)', () => {
  it('accepts exactly the provider grid the help text advertises', () => {
    for (const n of [1, 2, 4, 6, 8]) expect(parseCpu(String(n))).toBe(n)
  })
  it('throws locally on junk AND on off-grid sizes instead of deferring to the server', () => {
    for (const raw of ['abc', '', '-2', '1.5', 'two', '3', '100']) {
      expect(() => parseCpu(raw), raw).toThrow(/invalid cpu/)
    }
  })
})

describe('parseDbCpu / parseDbMemory (provider quantity strings)', () => {
  it('passes valid k8s quantities through untouched', () => {
    expect(parseDbCpu('2')).toBe('2')
    expect(parseDbCpu('2500m')).toBe('2500m')
    expect(parseDbMemory('4Gi')).toBe('4Gi')
    expect(parseDbMemory('2048Mi')).toBe('2048Mi')
  })
  it('rejects junk locally with an example', () => {
    expect(() => parseDbCpu('huge')).toThrow(/try 2, 4, or 2500m/)
    expect(() => parseDbMemory('lots')).toThrow(/try 4Gi or 8Gi/)
    expect(() => parseDbMemory('8')).toThrow() // unit required — a bare number is ambiguous here
  })
})

describe('fmtMib (display must not claim a ceiling the API did not set)', () => {
  it('collapses whole and half GiB', () => {
    expect(fmtMib(2048)).toBe('2 GiB')
    expect(fmtMib(1536)).toBe('1.5 GiB') // the review example: was shown as "2 GiB"
  })
  it('keeps everything else exact in MiB', () => {
    expect(fmtMib(1300)).toBe('1300 MiB')
    expect(fmtMib(512)).toBe('512 MiB')
  })
})

// The round-3 Critical: rawRequest THROWS on >=400, so the no-instance soft-path must live in a
// catch — status-branching on its return value was unreachable dead code and the read crashed with
// a raw ApiError. These drive the seam with a stub client, which is exactly the test that would
// have caught it (the 502 branch was never taken by any test). That soft path is the legacy Neon
// path: Neon is no longer used by any environment, so these stay as retained coverage for code
// that is not live.
describe('fetchDbInstance (the read seam)', () => {
  const stub = (fn: () => Promise<any>) => ({ rawRequest: fn }) as any

  it('returns the body on success', async () => {
    const read = await fetchDbInstance(stub(async () => ({ status: 200, body: { cpuMilli: 4000 } })), 'p1', '')
    expect(read).toEqual({ kind: 'ok', body: { cpuMilli: 4000 } })
  })

  // Legacy Neon path — Neon is no longer used by any environment; this test is retained coverage.
  it('maps the provider-shaped 502 (legacy Neon-backed) to the soft no-instance case', async () => {
    const read = await fetchDbInstance(stub(async () => { throw new ApiError(502, 'provider request failed') }), 'p1', '')
    expect(read).toEqual({ kind: 'no-instance' })
  })

  it('wraps other API errors instead of rendering them as "no ceiling"', async () => {
    await expect(fetchDbInstance(stub(async () => { throw new ApiError(401, 'unauthorized') }), 'p1', ''))
      .rejects.toThrow(/reading the instance failed \(401\): unauthorized/)
  })

  it('lets non-API errors (network, bugs) propagate untouched', async () => {
    const boom = new TypeError('fetch failed')
    await expect(fetchDbInstance(stub(async () => { throw boom }), 'p1', '')).rejects.toBe(boom)
  })
})

// fmtMb had no tests while its twin fmtMib did — same must-not-lie property.
describe('fmtMb (compute display)', () => {
  it('collapses whole and half GB', () => {
    expect(fmtMb(2048)).toBe('2 GB')
    expect(fmtMb(1536)).toBe('1.5 GB')
  })
  it('keeps everything else exact in MB', () => {
    expect(fmtMb(768)).toBe('768 MB')
    expect(fmtMb(256)).toBe('256 MB')
  })
})

// Case-exactness (round-3 suggestion): k8s quantities are case-sensitive, so local validation
// must reject what the server would.
describe('parseDbMemory case-exactness', () => {
  it('rejects lowercase unit variants the backend refuses', () => {
    for (const raw of ['4gi', '4GI', '8m', '2048mi']) {
      expect(() => parseDbMemory(raw), raw).toThrow(/invalid memory/)
    }
  })
})
