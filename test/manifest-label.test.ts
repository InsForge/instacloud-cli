// `insta agent manifest` resource labels — the prefix names WHERE a service runs, and `insta agent manifest`
// is explicitly the agent-legible view of the project, so a wrong prefix misinforms agents too.
//
// The bug this locks down: the platform's resource `kind` is 'fly' for EVERY compute row ('fly' is
// the compute seat, occupied by the microvm plane wherever the cutover happened), and manifest
// printed that kind verbatim. Staging 2026-08-25, project 'gapcheck': a service serving 200 from
// https://staging-main-api-9ee693-1a050.staging.instacloud.tech, whose pod
// (`insta compute exec api -- hostname`) is insta-warm-00178a-16 -- a microvm warm pod -- printed
// as `fly(api)`. Prod still runs Fly-backed rows (INSTA_COMPUTE_PROVIDER unset there), so the fix
// is per-ROW, not a swapped constant.
import { describe, it, expect } from 'vitest'
import { resourceLabel, resourceLine } from '../src/commands/manifest.js'

describe('resourceLabel', () => {
  it('labels a microvm-backed compute row microvm, never fly', () => {
    const label = resourceLabel({ kind: 'fly', provider: 'microvm', name: 'api' })
    expect(label).toBe('microvm(api)')
    expect(label).not.toContain('fly')
  })

  it('still labels a Fly-backed compute row fly', () => {
    expect(resourceLabel({ kind: 'fly', provider: 'fly', name: 'api' })).toBe('fly(api)')
  })

  it('asserts NO provider when the platform sends none (older API, or a row it cannot place)', () => {
    const label = resourceLabel({ kind: 'fly', name: 'api' })
    expect(label).toBe('compute(api)')
    expect(label).not.toContain('fly')
    expect(label).not.toContain('microvm')
  })

  it('asserts no provider for an unrecognised provider value rather than echoing it', () => {
    expect(resourceLabel({ kind: 'fly', provider: 'nomad', name: 'api' })).toBe('compute(api)')
  })

  it('leaves non-compute kinds alone', () => {
    expect(resourceLabel({ kind: 'insta-db', name: 'db' })).toBe('insta-db(db)')
    expect(resourceLabel({ kind: 's3', name: 'files' })).toBe('s3(files)')
    // a provider on a non-compute row is not a thing; it must not hijack the label
    expect(resourceLabel({ kind: 's3', provider: 'microvm', name: 'files' })).toBe('s3(files)')
  })

  it('does not crash on a row with no kind and no name', () => {
    expect(() => resourceLabel({})).not.toThrow()
    expect(resourceLabel({})).toBe('resource')
    expect(resourceLabel({ kind: 'fly' })).toBe('compute')
  })
})

describe('resourceLine', () => {
  it('names the Postgres major on a database row when the platform sends one', () => {
    expect(resourceLine({ kind: 'insta-db', name: 'db', status: 'active', ref: { pgVersion: 16 } })).toBe('    - insta-db(db)    pg 16  [active]')
    expect(resourceLine({ kind: 'insta-db', name: 'db', status: 'active', ref: {} })).toBe('    - insta-db(db)    [active]')
  })
  it('never badges a non-database row, whatever its ref carries', () => {
    expect(resourceLine({ kind: 's3', name: 'assets', status: 'active', ref: { bucket: 'b', pgVersion: 16 } })).toBe('    - s3(assets)  b  [active]')
  })
  it('omits the badge when ref.pgVersion is not a positive integer (untyped API JSON)', () => {
    for (const bad of [true, '16', 16.4, NaN, 0, -1] as unknown[]) {
      expect(resourceLine({ kind: 'insta-db', name: 'db', status: 'active', ref: { pgVersion: bad as number } })).toBe('    - insta-db(db)    [active]')
    }
  })
  it('renders the microvm row exactly as staging should have shown it', () => {
    expect(resourceLine({
      kind: 'fly', provider: 'microvm', name: 'api', status: 'active',
      ref: { url: 'https://staging-main-api-9ee693-1a050.staging.instacloud.tech' },
    })).toBe('    - microvm(api)  https://staging-main-api-9ee693-1a050.staging.instacloud.tech  [active]')
  })

  it('keeps the Fly row rendering byte-for-byte what it always was', () => {
    expect(resourceLine({ kind: 'fly', provider: 'fly', name: 'api', status: 'active', ref: { url: 'https://insta-api-ab12.compute.instacloud.dev' } }))
      .toBe('    - fly(api)  https://insta-api-ab12.compute.instacloud.dev  [active]')
  })

  it('survives a row with no ref at all', () => {
    expect(resourceLine({ kind: 'fly', provider: 'microvm', name: 'worker', status: 'active' }))
      .toBe('    - microvm(worker)    [active]')
  })
})
