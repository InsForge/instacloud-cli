// The per-resource `logs` window flags: --from/--to accept unix seconds or ISO-8601, --since is relative
// sugar, and junk must die locally instead of reaching the platform as NaN. Pure helpers, same
// throwing-parser pattern as parseTimeoutSec / parseCpu.
import { describe, it, expect } from 'vitest'
import { parseLogInstant, parseSinceSeconds, resolveLogWindow } from '../src/commands/metrics.js'

describe('parseLogInstant', () => {
  it('passes unix seconds through', () => {
    expect(parseLogInstant('1755000000', '--from')).toBe(1_755_000_000)
  })
  it('converts ISO-8601 to unix seconds', () => {
    expect(parseLogInstant('2026-08-12T12:00:00Z', '--from')).toBe(Date.parse('2026-08-12T12:00:00Z') / 1000)
  })
  it('rejects junk with the flag named', () => {
    expect(() => parseLogInstant('yesterday-ish', '--to')).toThrow(/invalid --to/)
  })
})

describe('parseSinceSeconds', () => {
  it('reads s/m/h/d units', () => {
    expect(parseSinceSeconds('90s')).toBe(90)
    expect(parseSinceSeconds('30m')).toBe(1800)
    expect(parseSinceSeconds('2h')).toBe(7200)
    expect(parseSinceSeconds('1d')).toBe(86400)
  })
  it('rejects junk, zero, and unknown units', () => {
    for (const raw of ['', '30', 'm30', '1w', '0m', '-5m']) {
      expect(() => parseSinceSeconds(raw), raw).toThrow(/invalid --since/)
    }
  })
})

describe('resolveLogWindow', () => {
  const NOW = 1_755_000_000
  it('maps --since to from = now - dur', () => {
    expect(resolveLogWindow({ since: '30m' }, NOW)).toEqual({ from: NOW - 1800, to: undefined })
  })
  it('passes --from/--to through', () => {
    expect(resolveLogWindow({ from: '100', to: '200' }, NOW)).toEqual({ from: 100, to: 200 })
  })
  it('rejects --since together with --from', () => {
    expect(() => resolveLogWindow({ since: '30m', from: '100' }, NOW)).toThrow(/--since or --from, not both/)
  })
  it('rejects an inverted window', () => {
    expect(() => resolveLogWindow({ from: '200', to: '100' }, NOW)).toThrow(/--to is before --from/)
  })
  it('no flags → no window', () => {
    expect(resolveLogWindow({}, NOW)).toEqual({ from: undefined, to: undefined })
  })
})
