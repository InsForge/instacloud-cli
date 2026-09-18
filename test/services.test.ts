import { describe, it, expect } from 'vitest'
import {
  assertType, assertServiceName, parseCount, parsePort, parseAccess, resolveServiceId, resolveComputeServiceId, SERVICE_TYPES,
  servicesAddRequestBody, servicesAdd, serviceListLine, serviceAddedLine,
} from '../src/commands/services.js'

describe('assertType', () => {
  it('accepts valid service types', () => {
    for (const t of SERVICE_TYPES) expect(() => assertType(t)).not.toThrow()
  })
  it('rejects unknown types', () => {
    expect(() => assertType('lambda')).toThrow(/postgres\|storage\|compute/)
  })
  it('honors a restricted allowed set (scale = compute only)', () => {
    expect(() => assertType('compute', ['compute'])).not.toThrow()
    expect(() => assertType('postgres', ['compute'])).toThrow(/must be compute/)
    expect(() => assertType('storage', ['compute', 'postgres'])).toThrow(/compute\|postgres/)
  })
})

describe('parseCount', () => {
  it('parses integers inside the replica range', () => {
    expect(parseCount('1')).toBe(1)
    expect(parseCount('10')).toBe(10)
  })
  it('rejects values outside 1–10 and non-integers', () => {
    expect(() => parseCount('0')).toThrow(/between 1 and 10/)
    expect(() => parseCount('11')).toThrow(/between 1 and 10/)
    expect(() => parseCount('-2')).toThrow(/between 1 and 10/)
    expect(() => parseCount('2.5')).toThrow(/between 1 and 10/)
    expect(() => parseCount('abc')).toThrow(/between 1 and 10/)
  })
})

describe('parsePort', () => {
  it('parses ports in range', () => {
    expect(parsePort('8080')).toBe(8080)
    expect(parsePort('1')).toBe(1)
    expect(parsePort('65535')).toBe(65535)
  })
  // Junk used to reach the API as NaN, which serializes to null.
  it('rejects out-of-range and non-integer ports', () => {
    expect(() => parsePort('0')).toThrow(/between 1 and 65535/)
    expect(() => parsePort('65536')).toThrow(/between 1 and 65535/)
    expect(() => parsePort('8080.5')).toThrow(/between 1 and 65535/)
    expect(() => parsePort('abc')).toThrow(/between 1 and 65535/)
  })
  // Number() would read these as 8080 and 1000 — a port in hex is a typo, not a port.
  it('rejects non-decimal spellings Number() would have accepted', () => {
    expect(() => parsePort('0x1f90')).toThrow(/between 1 and 65535/)
    expect(() => parsePort('1e3')).toThrow(/between 1 and 65535/)
    expect(() => parsePort('0o17620')).toThrow(/between 1 and 65535/)
    expect(() => parsePort('')).toThrow(/between 1 and 65535/)
  })
  // Surrounding whitespace is shell noise, not a typo — parseVolumeGib tolerates it too.
  it('tolerates surrounding whitespace', () => {
    expect(parsePort('  8080  ')).toBe(8080)
  })
})

describe('assertServiceName', () => {
  it('accepts lower-kebab service names', () => {
    expect(() => assertServiceName('primary-db')).not.toThrow()
  })
  it('rejects names outside the platform service-name rule', () => {
    expect(() => assertServiceName('Primary')).toThrow(/lower-kebab/)
    expect(() => assertServiceName('-db')).toThrow(/lower-kebab/)
  })
})

describe('parseAccess', () => {
  it('maps public/private to a boolean', () => {
    expect(parseAccess('public')).toBe(true)
    expect(parseAccess('private')).toBe(false)
  })
  it('rejects anything else', () => {
    expect(() => parseAccess('open')).toThrow(/public\|private/)
    expect(() => parseAccess('')).toThrow(/public\|private/)
    expect(() => parseAccess('Public')).toThrow(/public\|private/)
  })
})

describe('resolveServiceId', () => {
  const services = [
    { id: 'a', type: 'postgres', name: 'db' },
    { id: 'b', type: 'compute', name: 'api' },
    { id: 'c', type: 'compute', name: 'worker' },
  ]
  it('resolves by (type, name)', () => {
    expect(resolveServiceId(services, 'compute', 'worker')).toBe('c')
    expect(resolveServiceId(services, 'postgres', 'db')).toBe('a')
  })
  it('throws when not found', () => {
    expect(() => resolveServiceId(services, 'compute', 'nope')).toThrow(/service not found/)
    expect(() => resolveServiceId(services, 'storage', 'db')).toThrow(/service not found/)
  })
})

describe('resolveComputeServiceId', () => {
  const one = [{ id: 'a', type: 'postgres', name: 'db' }, { id: 'b', type: 'compute', name: 'api' }]
  const two = [...one, { id: 'c', type: 'compute', name: 'worker' }]
  it('returns the sole compute service when name is omitted', () => {
    expect(resolveComputeServiceId(one)).toBe('b')
  })
  it('resolves by name', () => {
    expect(resolveComputeServiceId(two, 'worker')).toBe('c')
  })
  it('errors when the named compute service is missing', () => {
    expect(() => resolveComputeServiceId(two, 'nope')).toThrow(/compute service not found/)
  })
  it('errors on ambiguity when name omitted', () => {
    expect(() => resolveComputeServiceId(two)).toThrow(/multiple compute services/)
  })
  it('errors when there is no compute service', () => {
    expect(() => resolveComputeServiceId([{ id: 'a', type: 'postgres', name: 'db' }])).toThrow(/no compute service/)
  })
})

describe('servicesAddRequestBody', () => {
  it('omits image/port when not passed', () => {
    const b = servicesAddRequestBody('compute', 'api', 'main', {})
    expect(b).toEqual({ type: 'compute', name: 'api', branch: 'main', public: false })
  })
  it('sends image and port (as a number) when passed', () => {
    const b = servicesAddRequestBody('compute', 'api', 'main', { image: 'ghcr.io/acme/api:latest', port: '3000' })
    expect(b).toMatchObject({ image: 'ghcr.io/acme/api:latest', port: 3000 })
    expect(b.port).toBe(3000) // Number, not the raw string
  })
  it('omits branch when undefined', () => {
    expect(servicesAddRequestBody('postgres', 'db', undefined, {})).toEqual({ type: 'postgres', name: 'db', public: false })
  })
  it('carries --public through unchanged', () => {
    expect(servicesAddRequestBody('storage', 'bkt', 'main', { public: true })).toMatchObject({ public: true })
  })
  it('sends region when passed, omits it when absent', () => {
    expect(servicesAddRequestBody('postgres', 'db', 'main', { region: 'us-east' })).toMatchObject({ region: 'us-east' })
    expect(servicesAddRequestBody('postgres', 'db', 'main', {})).not.toHaveProperty('region')
  })
  it('sends alwaysOn in BOTH states when the flag is given, omits it when absent (absent = the platform default, always-on for compute)', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', { alwaysOn: true })).toMatchObject({ alwaysOn: true })
    // --no-always-on must reach the API as an explicit false: an omitted key is reinterpreted as
    // the always-on default by the platform (insta-platform #385), so dropping false would create
    // exactly the always-on, idle-billed service the user opted out of.
    expect(servicesAddRequestBody('compute', 'api', 'main', { alwaysOn: false })).toMatchObject({ alwaysOn: false })
    expect(servicesAddRequestBody('compute', 'api', 'main', {})).not.toHaveProperty('alwaysOn')
  })
})

describe('servicesAdd validation (throws before any network/config access)', () => {
  it('rejects --image for a non-compute type', async () => {
    await expect(servicesAdd('storage', 'bkt', { image: 'ghcr.io/acme/api:latest' })).rejects.toThrow(/--image is only valid for compute services/)
  })
  it('rejects --port for a non-compute type', async () => {
    await expect(servicesAdd('postgres', 'db', { port: '3000' })).rejects.toThrow(/--port is only valid for compute services/)
  })
  it('rejects --always-on for a non-compute type, pointing at that type\'s own command', async () => {
    await expect(servicesAdd('postgres', 'db', { alwaysOn: true })).rejects.toThrow(/--always-on \/ --no-always-on is only valid for compute services/)
    // Each managed database has its own always-on verb; naming postgres' would send a redis user
    // at a different service type.
    for (const type of ['postgres', 'redis', 'mysql', 'mongodb']) {
      await expect(servicesAdd(type, 'db', { alwaysOn: true })).rejects.toThrow(new RegExp(`insta ${type} always-on on\\|off`))
    }
    // Storage owns no always-on verb: the bare rule, with no command to run.
    await expect(servicesAdd('storage', 'bkt', { alwaysOn: true })).rejects.toThrow(/only valid for compute services$/)
  })
  it('rejects --no-always-on for a non-compute type too: an explicit false is just as compute-only', async () => {
    // Presence check, not truthiness: a truthiness check would let `postgres db --no-always-on`
    // reach the platform with alwaysOn:false instead of failing before config/network access.
    await expect(servicesAdd('postgres', 'db', { alwaysOn: false })).rejects.toThrow(/--always-on \/ --no-always-on is only valid for compute services/)
  })
  it('rejects --public for a non-storage type', async () => {
    await expect(servicesAdd('compute', 'api', { public: true })).rejects.toThrow(/--public is only valid for storage services/)
  })
  it('rejects --region for a storage type', async () => {
    await expect(servicesAdd('storage', 'bkt', { region: 'us-east' })).rejects.toThrow(/--region is not valid for storage services/)
  })
  it('rejects an unknown service type before any option checks', async () => {
    await expect(servicesAdd('lambda', 'x', {})).rejects.toThrow(/postgres\|storage\|compute/)
  })
})

describe('serviceAddedLine', () => {
  it('carries the Postgres major next to the connect hint for a postgres service', () => {
    expect(serviceAddedLine('postgres', 'db', 'main', { id: 'svc_pg', type: 'postgres', region: 'us-east', domain: 'db.example.test', pg_version: 16 }))
      .toBe('added postgres service db on main (svc_pg)  us-east  pg 16 — db.example.test')
  })
  it('never badges a non-postgres service, and omits the badge when the platform sent no major', () => {
    expect(serviceAddedLine('storage', 'assets', undefined, { id: 'svc_s3', type: 'storage', public: false, pg_version: 16 }))
      .toBe('added storage service assets on default (svc_s3)  [private]')
    expect(serviceAddedLine('postgres', 'db', 'main', { id: 'svc_pg', type: 'postgres', pg_version: null })).not.toContain('pg ')
  })
})

describe('serviceListLine', () => {
  it('shows the Postgres major on a postgres row, so the reader picks matching client tooling', () => {
    const line = serviceListLine({ type: 'postgres', name: 'db', status: 'active', id: 'svc_pg', domain: 'db.example.test', pg_version: 16 })
    expect(line).toContain('pg 16')
    expect(line).toContain('db.example.test')
  })
  it('omits the badge when the platform sent no pg_version (older platform, legacy row)', () => {
    expect(serviceListLine({ type: 'postgres', name: 'db', status: 'active', id: 'svc_pg', pg_version: null })).not.toContain('pg ')
    expect(serviceListLine({ type: 'storage', name: 'assets', status: 'active', id: 'svc_s3', pg_version: 16 })).not.toContain('pg 16')
  })
  it('omits the badge when pg_version is not a positive integer (the API JSON is untyped on the wire)', () => {
    for (const bad of [true, '16', 16.4, NaN, {}, 0, -1] as unknown[]) {
      expect(serviceListLine({ type: 'postgres', name: 'db', status: 'active', id: 'svc_pg', pg_version: bad as number })).not.toContain('pg ')
    }
  })
  it('renders a compute row with the running image when present', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 1, image: 'ghcr.io/acme/api:latest', port: 8080 })
    expect(line).toBe('compute/api  [active]  x1  running ghcr.io/acme/api:latest:8080  svc_1')
  })
  it('renders a compute row without a port suffix when port is absent', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 1, image: 'ghcr.io/acme/api:latest' })
    expect(line).toBe('compute/api  [active]  x1  running ghcr.io/acme/api:latest  svc_1')
  })
  it('renders a compute row unchanged when no image is reported', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 2 })
    expect(line).toBe('compute/api  [active]  x2  svc_1')
  })
  it('renders a storage row with access, unaffected by the image change', () => {
    const line = serviceListLine({ type: 'storage', name: 'bkt', status: 'active', id: 'svc_2', public: true })
    expect(line).toBe('storage/bkt  [active]  public  svc_2')
  })
  it('renders a postgres row with domain', () => {
    const line = serviceListLine({ type: 'postgres', name: 'db', status: 'active', id: 'svc_3', domain: 'db.example.com' })
    expect(line).toBe('postgres/db  [active]  db.example.com  svc_3')
  })
  it.each([
    ['redis', 'cache', 6379],
    ['mysql', 'mysql-db', 3306],
    ['mongodb', 'mongo-db', 27017],
  ])('renders a managed %s row with its default TCP port', (type, name, port) => {
    const line = serviceListLine({ type, name, status: 'active', id: 'svc_4', volume_gib: 1 })
    expect(line).toBe(`${type}/${name}  [active]  tcp/${port}  vol 1Gi  svc_4`)
  })
})
