// Volumes — the persistent disk attached to a service (postgres has one by default; compute
// opts in at creation or attaches later via `compute volume --size`). These pin the volume
// seams: the size parser (the only place a user-typed
// Gi becomes a wire integer), the create-body mapping (canonical volumeGib), the free-plan UX rule
// (viewing and attaching-at-default are never pre-blocked client-side — only the backend's 403
// speaks for the paid growth gate), and the db read using the CANONICAL volume* names, not the
// deprecated storage* aliases the platform drops next release.
import { describe, it, expect } from 'vitest'
import { parseVolumeGib, servicesAddRequestBody, servicesAdd, serviceListLine } from '../src/commands/services.js'
import { volumeLines, volumeWriteLine, volumeDeleteLine, volumeDeleteError, computeVolume } from '../src/commands/compute.js'
import { ApiError } from '../src/api.js'
import { dbVolumeLines } from '../src/commands/postgres.js'

describe('parseVolumeGib', () => {
  it('parses whole Gi, with or without a suffix', () => {
    expect(parseVolumeGib('1')).toBe(1)
    expect(parseVolumeGib('10')).toBe(10)
    expect(parseVolumeGib('10Gi')).toBe(10)
    expect(parseVolumeGib(' 10 gi ')).toBe(10)
    expect(parseVolumeGib('10G')).toBe(10)
  })
  it('rejects fractional, Mi, zero, and junk locally with an example', () => {
    for (const raw of ['', '1.5', '500Mi', '0', '-1', 'lots', '10Ti']) {
      expect(() => parseVolumeGib(raw), raw).toThrow(/invalid volume size/)
    }
    expect(() => parseVolumeGib('huge')).toThrow(/try 1 or 10/)
  })
})

describe('servicesAddRequestBody --volume', () => {
  it('sends volumeGib as a wire integer when passed', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', { volume: '10' })).toMatchObject({ volumeGib: 10 })
    expect(servicesAddRequestBody('compute', 'api', 'main', { volume: '1Gi' })).toMatchObject({ volumeGib: 1 })
  })
  it('omits volumeGib when the flag is absent (no volume attached)', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', {})).not.toHaveProperty('volumeGib')
  })
  // The plan rule: any plan may pass a size up to its own plan cap (the platform's sizeless default
  // since insta-platform #438; 10Gi free, 50Gi paid) — and larger values just forward; the backend
  // enforces paid/cap, so no client-side plan check exists to test against.
  it('forwards any whole size unjudged — the backend owns the paid/cap gate', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', { volume: '100' })).toMatchObject({ volumeGib: 100 })
  })
})

describe('servicesAdd --volume validation (throws before any network/config access)', () => {
  // The hint must name the type the user TYPED: `insta postgres volume` resolves a postgres
  // service, so pointing a redis/mysql/mongodb user at it sends them at the wrong service type.
  it('rejects --volume for a non-compute type, pointing at that type\'s own command', async () => {
    await expect(servicesAdd('postgres', 'db', { volume: '10' })).rejects.toThrow(/--volume is only valid for compute services/)
    await expect(servicesAdd('postgres', 'db', { volume: '10' })).rejects.toThrow(/insta postgres volume --size <gi>/)
    for (const type of ['redis', 'mysql', 'mongodb']) {
      await expect(servicesAdd(type, 'db', { volume: '10' })).rejects.toThrow(new RegExp(`insta ${type} volume --size <gi>`))
    }
    // Storage owns no volume verb, so it gets the bare rule and no command to run.
    await expect(servicesAdd('storage', 'bkt', { volume: '10' })).rejects.toThrow(/--volume is only valid for compute services$/)
  })
  it('rejects junk sizes locally instead of deferring to the server', async () => {
    await expect(servicesAdd('compute', 'api', { volume: '1.5' })).rejects.toThrow(/invalid volume size/)
  })
})

describe('serviceListLine with a volume', () => {
  it('shows the volume on compute rows', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 1, volume_gib: 10 })
    expect(line).toBe('compute/api  [active]  x1  vol 10Gi at /data  svc_1')
  })
  it('renders volume-less compute rows unchanged (null and absent alike)', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 2, volume_gib: null })
    expect(line).toBe('compute/api  [active]  x2  svc_1')
  })
})

describe('volumeLines (compute read display)', () => {
  it('shows size, mount path, and the plan cap', () => {
    const lines = volumeLines('api', { sizeGib: 10, mountPath: '/data' }, { volumeGib: 50 })
    expect(lines[0]).toBe('compute api: volume 10Gi at /data  (plan max 50Gi)')
    expect(lines[1]).toMatch(/cap, not a price/)
    // The read is where a user learns the way OFF the volume path exists — and what it costs.
    expect(lines[1]).toMatch(/--delete \(destroys the data\)/)
  })
  it('points a volumeless service at the attach verb (this command with --size)', () => {
    const lines = volumeLines('api', null, { volumeGib: 50 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/no volume attached/)
    expect(lines[0]).toMatch(/insta compute volume api --size <gi>/)
    expect(lines[0]).toMatch(/next deploy/)
  })
  // `--delete` is registered on `compute volume` only (index.ts), so naming it on a managed
  // database's read prints a command that does not exist.
  it('never offers --delete on a managed database, and says what to do instead', () => {
    for (const type of ['redis', 'mysql', 'mongodb'] as const) {
      const lines = volumeLines('cache', { sizeGib: 10, mountPath: '/data' }, { volumeGib: 50 }, type)
      expect(lines[0], type).toBe(`${type} cache: volume 10Gi at /data  (plan max 50Gi)`)
      expect(lines[1], type).not.toMatch(/--delete/)
      expect(lines[1], type).toMatch(/grow with --size \(grow-only\)/)
      expect(lines[1], type).toMatch(/remove the service instead/)
    }
  })
})

describe('volumeWriteLine (compute PUT result display)', () => {
  it('a first attach says so, and that the disk mounts on the next deploy', () => {
    const line = volumeWriteLine('api', { volume: { sizeGib: 3, mountPath: '/data' }, cap: { volumeGib: 10 }, attached: true })
    expect(line).toBe('compute api: volume 3Gi attached — mounts at /data on the next deploy  (plan max 10Gi)')
  })
  it('a grow reads as a grow — attached false and absent alike (older backends omit it)', () => {
    for (const body of [
      { volume: { sizeGib: 5, mountPath: '/data' }, cap: { volumeGib: 10 }, attached: false },
      { volume: { sizeGib: 5, mountPath: '/data' }, cap: { volumeGib: 10 } },
    ]) {
      expect(volumeWriteLine('api', body)).toBe('compute api: volume grown to 5Gi at /data  (plan max 10Gi)')
    }
  })
})

describe('volumeDeleteLine (compute DELETE result display)', () => {
  // The delete line's job is closure: the data is gone (no detach existed, no undo exists), and
  // the two constraints the volume imposed — cold stop/start wake and machineCount 1 — left with
  // it. No cap/size: there is nothing left to size.
  it('says the disk and data are gone and both constraints are back', () => {
    const line = volumeDeleteLine('api')
    expect(line).toBe('compute api: volume deleted — the disk and its data are gone; suspend fast-wake and scale-out are back')
  })
  // Unreachable today (no `--delete` outside compute), but the regained constraints are
  // compute-plane facts: the line must not claim them for a managed database if it ever is.
  it('claims no compute-plane effects for a managed database', () => {
    expect(volumeDeleteLine('cache', 'redis')).toBe('redis cache: volume deleted — the disk and its data are gone')
  })
})

describe('volumeDeleteError (older-backend 404 mapping)', () => {
  // The close-call branch: a bare route-404 (no error body → ApiError falls back to the literal
  // "HTTP 404") means the BACKEND is old; any 404 that carries a message came from a backend that
  // HAS the route and is naming the real problem — verified live against feat/volume-remove
  // (dev:fake): a volumeless service answers `{"error":"this service has no volume"}`.
  it('maps a bare route-404 to the version-skew hint', () => {
    const out = volumeDeleteError(new ApiError(404, 'HTTP 404')) as Error
    expect(out.message).toMatch(/does not support volume delete yet/)
  })
  it('maps the REAL older-platform 404: the Fastify default body parses to "Not Found" (r2d2 round 2)', () => {
    // The exact body an older platform (Fastify, no custom notFound handler) sends for a missing
    // route, pushed through the same extraction rawRequest applies (`body?.error ?? "HTTP 404"`) —
    // the fixture derivation r2d2 asked for, so this test breaks if either side's shape drifts.
    const fastifyDefault404 = { message: 'Route DELETE:/projects/p/services/s/volume not found', error: 'Not Found', statusCode: 404 }
    const e = new ApiError(404, (fastifyDefault404 as { error?: string }).error ?? 'HTTP 404')
    expect((volumeDeleteError(e) as Error).message).toMatch(/does not support volume delete yet/)
  })
  it('passes a 404 WITH a body message through verbatim — that backend has the route', () => {
    const e = new ApiError(404, 'this service has no volume')
    expect(volumeDeleteError(e)).toBe(e)
  })
  it('passes every non-404 through untouched (403 governance, 502 provider, plain errors)', () => {
    for (const e of [new ApiError(403, 'approval required'), new ApiError(502, 'provider failed'), new Error('boom')]) {
      expect(volumeDeleteError(e)).toBe(e)
    }
  })
})

describe('computeVolume --delete validation (throws before any network/config access)', () => {
  it('rejects --delete combined with --size — one changes the volume, the other destroys it', async () => {
    await expect(computeVolume('api', { delete: true, size: '10' })).rejects.toThrow(/--delete cannot be combined with --size/)
  })
})

describe('dbVolumeLines (postgres read display)', () => {
  it('reads the canonical volumeGib + cap, and shows region when the instance reports one', () => {
    const lines = dbVolumeLines('default', { volumeGib: 10, volumeSize: '10Gi', cap: { volumeGib: 50 }, region: 'us-east' })
    expect(lines[0]).toBe('postgres default: volume 10Gi  (plan max 50Gi)  us-east')
  })
  it('falls back to volumeSize when volumeGib is absent, and omits missing cap/region', () => {
    expect(dbVolumeLines('default', { volumeSize: '10Gi' })[0]).toBe('postgres default: volume 10Gi')
  })
  it('never reads the deprecated storage* aliases (dropped next release)', () => {
    const lines = dbVolumeLines('default', { storageSize: '10Gi', storageGiB: 10 })
    expect(lines[0]).toBe('postgres default: provider reported no volume size')
  })
})


describe('custom mount paths', () => {
  it('forwards a creation mount path', () => {
    expect(servicesAddRequestBody('compute', 'web', 'main', { volume: '1', mountPath: '/app/storage' })).toMatchObject({ volumeGib: 1, volumeMountPath: '/app/storage' })
  })
  it('rejects paths without an attachment and conflicting deletion flags before accessing config', async () => {
    await expect(servicesAdd('compute', 'web', { mountPath: '/app/storage' })).rejects.toThrow(/requires --volume/)
    await expect(servicesAdd('postgres', 'db', { mountPath: '/app/storage', volume: '1' })).rejects.toThrow(/compute/)
    await expect(computeVolume('web', { mountPath: '/app/storage' })).rejects.toThrow(/requires --size/)
    await expect(computeVolume('web', { mountPath: '/app/storage', delete: true })).rejects.toThrow(/cannot be combined/)
  })
})
