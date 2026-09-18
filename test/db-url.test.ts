import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { connectWithPsql, psqlEnvFromUrl, resolveDbUrl } from '../src/commands/postgres.js'

function stubApi(services: Array<{ id: string; type: string; name: string }>, credentials: Record<string, string>, status = 200) {
  const paths: string[] = []
  return {
    paths,
    request: async (_m: string, p: string) => { paths.push(p); return { services } },
    rawRequest: async (_m: string, p: string) => {
      paths.push(p)
      return status === 200 ? { status, body: { credentials } } : { status, body: { status: 'approval_required', action: 'secrets.read', approvalId: 'ap1' } }
    },
  }
}

describe('resolveDbUrl', () => {
  const services = [{ id: 's1', type: 'postgres', name: 'db' }, { id: 's2', type: 'compute', name: 'api' }]

  it('resolves the sole postgres service, branch-scoped, and reads its credentials by id', async () => {
    const api = stubApi(services, { DATABASE_URL: 'pg://db' })
    const r = await resolveDbUrl(api, 'p1', 'dev', undefined)
    expect(r).toEqual({ serviceName: 'db', url: 'pg://db' })
    expect(api.paths).toEqual(['/projects/p1/services?branch=dev', '/projects/p1/services/s1/credentials'])
  })

  it('honours --group and fails on an unknown one', async () => {
    const two = [...services, { id: 's3', type: 'postgres', name: 'analytics' }]
    const api = stubApi(two, { DATABASE_URL: 'pg://an' })
    const r = await resolveDbUrl(api, 'p1', undefined, 'analytics')
    expect(r?.url).toBe('pg://an')
    expect(api.paths[1]).toBe('/projects/p1/services/s3/credentials')
    await expect(resolveDbUrl(stubApi(two, {}), 'p1', undefined, 'nope')).rejects.toThrow(/not found/)
  })

  it('demands --group when several postgres services exist', async () => {
    const two = [...services, { id: 's3', type: 'postgres', name: 'analytics' }]
    await expect(resolveDbUrl(stubApi(two, {}), 'p1', undefined, undefined)).rejects.toThrow(/multiple postgres/)
  })

  it('reports a credential-less service as provisioning, not undefined', async () => {
    await expect(resolveDbUrl(stubApi(services, {}), 'p1', undefined, undefined))
      .rejects.toThrow(/no DATABASE_URL credential yet/)
  })

  it('parks on a 202 approval: null result, exit code 2', async () => {
    try {
      expect(await resolveDbUrl(stubApi(services, {}, 202), 'p1', undefined, undefined)).toBeNull()
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = 0
    }
  })
})

class FakeChild extends EventEmitter {}

const DSN = 'postgres://postgres:s3cr%40t@insta-abc.db.example.com:5432/instadb?sslmode=require'

describe('psqlEnvFromUrl', () => {
  it('maps every DSN part to its libpq variable, percent-decoded', () => {
    expect(psqlEnvFromUrl(DSN)).toEqual({
      PGHOST: 'insta-abc.db.example.com',
      PGPORT: '5432',
      PGUSER: 'postgres',
      PGPASSWORD: 's3cr@t',
      PGDATABASE: 'instadb',
      PGSSLMODE: 'require',
    })
  })

  it('omits what the DSN omits instead of setting empties', () => {
    expect(psqlEnvFromUrl('postgres://host/db')).toEqual({ PGHOST: 'host', PGDATABASE: 'db' })
  })
})

describe('connectWithPsql', () => {
  it('keeps the credential out of argv — psql gets PG* env and an empty argv — and returns its exit code', async () => {
    let call: { cmd: string; args: string[]; env: Record<string, string> } | undefined
    const child = new FakeChild()
    const code = connectWithPsql(DSN, ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      call = { cmd, args, env: opts.env }
      queueMicrotask(() => child.emit('close', 3))
      return child
    }) as any)
    expect(await code).toBe(3)
    expect(call?.cmd).toBe('psql')
    expect(call?.args).toEqual([])
    expect(call?.env.PGPASSWORD).toBe('s3cr@t')
    expect(call?.env.PGHOST).toBe('insta-abc.db.example.com')
  })

  it('strips ambient PG* vars so parent env cannot redirect the connection', async () => {
    process.env.PGHOSTADDR = '10.9.9.9'
    process.env.PGSERVICE = 'evil'
    try {
      let env: Record<string, string | undefined> | undefined
      const child = new FakeChild()
      const code = connectWithPsql(DSN, ((_c: string, _a: string[], opts: { env: Record<string, string> }) => {
        env = opts.env
        queueMicrotask(() => child.emit('close', 0))
        return child
      }) as any)
      expect(await code).toBe(0)
      expect(env?.PGHOSTADDR).toBeUndefined()
      expect(env?.PGSERVICE).toBeUndefined()
      expect(env?.PGHOST).toBe('insta-abc.db.example.com')
    } finally {
      delete process.env.PGHOSTADDR
      delete process.env.PGSERVICE
    }
  })

  it('maps signal death to 128+signo instead of a fake exit 1', async () => {
    const child = new FakeChild()
    const code = connectWithPsql(DSN, (() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
      return child
    }) as any)
    expect(await code).toBe(143)
  })

  it('turns a missing psql binary into guidance, not a raw ENOENT', async () => {
    const child = new FakeChild()
    const code = connectWithPsql(DSN, (() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn psql ENOENT'), { code: 'ENOENT' })))
      return child
    }) as any)
    await expect(code).rejects.toThrow(/psql not found on PATH.*insta postgres url/)
  })
})
