import { describe, expect, it } from 'vitest'

import { dbStatsLines, fmtBytes } from '../src/commands/postgres.js'

describe('dbStatsLines', () => {
  it('renders the measured block: x / y with active count, cache hit percent, size', () => {
    const lines = dbStatsLines('default', {
      state: 'running',
      serverVersion: '16.14',
      connections: { active: 2, idle: 3, total: 5, max: 100 },
      cacheHitRatio: 0.992,
      dbSizeBytes: 8_000_000,
    })
    expect(lines[0]).toBe('postgres default (running · PG 16.14)')
    expect(lines[1]).toBe('  connections  5 / 100 (2 active)')
    expect(lines[2]).toBe('  cache hit    99.2%')
    expect(lines[3]).toBe('  size         7.6 MiB')
  })

  it('labels a suspended instance and never fakes a ratio', () => {
    const lines = dbStatsLines('default', {
      state: 'suspended',
      connections: { active: 0, idle: 0, total: 0, max: 100 },
      dbSizeBytes: 2048,
    })
    expect(lines[0]).toBe('postgres default (suspended)')
    expect(lines[1]).toBe('  connections  0 / 100 (0 active)')
    expect(lines[2]).toBe('  cache hit    —')
  })

  it('degrades to the legacy shape when the platform sends no max/ratio (old daemon)', () => {
    const lines = dbStatsLines('default', {
      connections: { active: 0, idle: 0, total: 4, max: 0 },
      dbSizeBytes: 2048,
    })
    expect(lines[0]).toBe('postgres default')
    expect(lines[1]).toBe('  connections  4')
    expect(lines[2]).toBe('  cache hit    —')
  })

  it('renders an entirely empty body as em-dashes, not zeros', () => {
    const lines = dbStatsLines('default', {})
    expect(lines[1]).toBe('  connections  —')
    expect(lines[2]).toBe('  cache hit    —')
    expect(lines[3]).toBe('  size         —')
  })
})

describe('fmtBytes', () => {
  it('picks sane units', () => {
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(2048)).toBe('2.0 KiB')
    expect(fmtBytes(8_000_000)).toBe('7.6 MiB')
    expect(fmtBytes(3.5 * 1024 ** 3)).toBe('3.5 GiB')
  })
})
