// per-resource `metrics` series rendering. The seam exists because compute's egress/ingress series arrive
// as raw bytes per second: printed unscaled, real traffic reads as an 8-digit number nobody can
// size at a glance.
import { describe, it, expect } from 'vitest'
import { metricLine } from '../src/commands/metrics.js'

const pts = (...values: number[]): [number, number][] => values.map((v, i) => [i * 60, v])

describe('metricLine', () => {
  it('scales a byte rate and keeps the /s', () => {
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(1024, 20_480_031) }))
      .toBe('egress_bytes_rate: 20.5 MB/s  [2 points]')
  })

  it('scales plain bytes without a /s', () => {
    expect(metricLine({ name: 'db_storage_bytes', unit: 'bytes', points: pts(2048) }))
      .toBe('db_storage_bytes: 2.0 KB  [1 points]')
  })

  it('leaves already-human units alone, keeping the unit in the label', () => {
    expect(metricLine({ name: 'cpu_cores', unit: 'vCPU', points: pts(0.82) }))
      .toBe('cpu_cores (vCPU): 0.82  [1 points]')
  })

  it('reports n/a for an empty series', () => {
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: [] }))
      .toBe('egress_bytes_rate: n/a  [0 points]')
  })

  it('reports n/a rather than NaN/Infinity for a non-finite sample', () => {
    for (const v of [NaN, Infinity]) {
      expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(v) }), String(v))
        .toBe('egress_bytes_rate: n/a  [1 points]')
    }
  })

  it('still scales when the platform spells the unit differently', () => {
    // an unrecognised unit fails silently back to a raw 8-digit number, so casing/spacing must not
    // be load-bearing
    for (const unit of ['bytes/s', 'Bytes/S', ' bytes/sec ', 'B/s']) {
      expect(metricLine({ name: 'egress_bytes_rate', unit, points: pts(20_480_031) }), unit)
        .toBe('egress_bytes_rate: 20.5 MB/s  [1 points]')
    }
    expect(metricLine({ name: 'memory_used_bytes', unit: 'BYTES', points: pts(1.2e9) }))
      .toBe('memory_used_bytes: 1.1 GB  [1 points]')
  })

  it('stays in bytes below the scale boundary, without a false decimal', () => {
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(512) }))
      .toBe('egress_bytes_rate: 512 B/s  [1 points]')
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(1000) }))
      .toBe('egress_bytes_rate: 1.0 KB/s  [1 points]')
  })

  it('rounds a fractional sub-KB rate instead of printing it in full', () => {
    // rate() of a byte counter is fractional, and a real idle service sits in this range
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(342.857142) }))
      .toBe('egress_bytes_rate: 342.9 B/s  [1 points]')
  })

  it('scales traffic decimally and memory binarily, matching the console and the invoice', () => {
    // egress is billed per decimal GB (bytes / 1e9), so 1024-based here would read ~7% low
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(1e9) }))
      .toBe('egress_bytes_rate: 1.0 GB/s  [1 points]')
    // provisioned ceilings are GiB, so plain bytes stay binary
    expect(metricLine({ name: 'memory_used_bytes', unit: 'bytes', points: pts(1.2e9) }))
      .toBe('memory_used_bytes: 1.1 GB  [1 points]')
  })
})
