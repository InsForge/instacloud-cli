// `insta <redis|mysql|mongodb> query` seams — the pure renderers plus the handler flow through an injected api seam
// (the DomainDeps convention), so nothing here reaches a backend (mirrors db-stats.test.ts /
// compute-domain-flow.test.ts).
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import {
  consoleExecPath, execBody, renderMysqlRows, renderRedisReply, renderMongoResult,
  dbQuery, type DbQueryDeps,
} from '../src/commands/db-query.js'

describe('consoleExecPath', () => {
  it('is the managed-DB console exec route for the service', () => {
    expect(consoleExecPath('pr_1', 'svc_9')).toBe('/projects/pr_1/database/console/svc_9/exec')
  })
})

describe('execBody', () => {
  // mysql/mongodb quote the whole statement, so the tokens rejoin into one command string.
  it('joins mysql args into a single command', () => {
    expect(execBody('mysql', ['select', '*', 'from', 'products', 'limit', '10']))
      .toEqual({ command: 'select * from products limit 10' })
  })

  // redis is pre-tokenized: each arg stays a distinct argv element, verbatim — a value that
  // contains a space (already one shell token) must not be re-split.
  it('keeps redis args as a verbatim argv, never a joined string', () => {
    expect(execBody('redis', ['GET', 'mykey'])).toEqual({ argv: ['GET', 'mykey'] })
    expect(execBody('redis', ['SET', 'greeting', 'hello world']))
      .toEqual({ argv: ['SET', 'greeting', 'hello world'] })
  })

  it('adds database for mongodb only when --database is given', () => {
    expect(execBody('mongodb', ['db.users.find().limit(10).toArray()'], 'shop'))
      .toEqual({ command: 'db.users.find().limit(10).toArray()', database: 'shop' })
    const bare = execBody('mongodb', ['db.users.find()'])
    expect(bare).toEqual({ command: 'db.users.find()' })
    expect('database' in bare).toBe(false)
  })
})

describe('renderMysqlRows', () => {
  it('renders the header and rows as an aligned table with a count footer', () => {
    const lines = renderMysqlRows({
      columns: [{ name: 'id' }, { name: 'name' }, { name: 'price' }],
      rows: [
        ['1', 'apple', '3'],
        ['2', 'banana', null],
      ],
      rowCount: 2,
      truncated: false,
    })
    expect(lines).toEqual([
      'id  name    price',
      '1   apple   3',
      '2   banana  —',
      '(2 rows)',
    ])
  })

  // A null cell is a missing value, rendered as the repo's em-dash — never an empty string or 0.
  it('renders a null cell as an em-dash', () => {
    const lines = renderMysqlRows({ columns: [{ name: 'v' }], rows: [[null]], rowCount: 1 })
    expect(lines[1]).toBe('—')
  })

  // The footer reports the server's rowCount (not rows.length) and flags a truncated page.
  it('uses the returned rowCount and marks truncation', () => {
    const lines = renderMysqlRows({
      columns: [{ name: 'x' }],
      rows: [['a'], ['b']],
      rowCount: 100,
      truncated: true,
    })
    expect(lines).toEqual(['x', 'a', 'b', '(100 rows, truncated)'])
  })
})

describe('renderRedisReply', () => {
  it('prints a scalar reply raw', () => {
    expect(renderRedisReply('OK')).toBe('OK')
    expect(renderRedisReply(42)).toBe('42')
    expect(renderRedisReply(0)).toBe('0')
  })

  it('pretty-prints a structured reply as JSON', () => {
    expect(renderRedisReply(['a', 'b'])).toBe(JSON.stringify(['a', 'b'], null, 2))
    expect(renderRedisReply({ field: 'v' })).toBe(JSON.stringify({ field: 'v' }, null, 2))
    expect(renderRedisReply(null)).toBe('null')
  })
})

describe('renderMongoResult', () => {
  it('pretty-prints the result as JSON', () => {
    const result = [{ _id: 1, name: 'a' }]
    expect(renderMongoResult(result)).toBe(JSON.stringify(result, null, 2))
    expect(renderMongoResult({})).toBe('{}')
  })
})

// ---- handler flow, through an injected api seam so nothing reaches a backend ----
type Svc = { id: string; type: string; name: string }
type Call = { method: string; path: string; body?: unknown }
function deps(services: Svc[], res: { status: number; body: any } = { status: 200, body: {} }) {
  const calls: Call[] = []
  const api = {
    request: async (method: string, path: string) => {
      calls.push({ method, path })
      return { services }
    },
    rawRequest: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return res
    },
  }
  return { deps: { api, project: { projectId: 'p1', branch: 'main' } } as unknown as DbQueryDeps, calls }
}

describe('dbQuery (handler flow, injected api — no network)', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })
  const out = () => stdout.join('')
  const err = () => stderr.join('')

  const mysql = [{ id: 'svc_shop', type: 'mysql', name: 'shop' }, { id: 'svc_an', type: 'mysql', name: 'analytics' }]

  it('resolves the service by NAME (not type/position) and posts to that id, with the branch on the lookup', async () => {
    const { deps: d, calls } = deps(mysql, { status: 200, body: { columns: [{ name: 'id' }], rows: [['1']], rowCount: 1 } })
    await dbQuery('analytics', ['select', '*', 'from', 'products'], {}, d)
    expect(calls[0]).toEqual({ method: 'GET', path: '/projects/p1/services?branch=main' })
    expect(calls[1]).toEqual({ method: 'POST', path: consoleExecPath('p1', 'svc_an'), body: { command: 'select * from products' } })
    expect(out()).toBe('id\n1\n(1 rows)\n')
  })

  it('rejects a postgres/non-managed service BEFORE any exec is posted', async () => {
    const { deps: d, calls } = deps([{ id: 'svc_pg', type: 'postgres', name: 'db' }])
    await expect(dbQuery('db', ['select 1'], {}, d)).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(1)
    expect(err()).toMatch(/managed databases \(mysql\/redis\/mongodb\); postgres uses `insta postgres url\|connect` \/ the SQL editor/)
    expect(calls.map((c) => c.method)).toEqual(['GET']) // never reached the POST
  })

  it('errors when the named service is not on the branch', async () => {
    const { deps: d, calls } = deps(mysql)
    await expect(dbQuery('nope', ['select 1'], {}, d)).rejects.toThrow('exit 1')
    expect(err()).toMatch(/service not found: nope/)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('rejects --database on a non-mongodb engine BEFORE the POST, instead of silently dropping it', async () => {
    const { deps: d, calls } = deps(mysql)
    await expect(dbQuery('shop', ['select 1'], { database: 'other' }, d)).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(1)
    expect(err()).toMatch(/--database is only supported for mongodb services/)
    expect(calls.map((c) => c.method)).toEqual(['GET']) // resolved the engine, then refused
  })

  it('passes --database through to the exec body for a mongodb service', async () => {
    const { deps: d, calls } = deps([{ id: 'svc_m', type: 'mongodb', name: 'docs' }], { status: 200, body: { result: [] } })
    await dbQuery('docs', ['db.users.find()'], { database: 'shop' }, d)
    expect(calls[1]).toEqual({ method: 'POST', path: consoleExecPath('p1', 'svc_m'), body: { command: 'db.users.find()', database: 'shop' } })
  })

  it('rejects empty args BEFORE loading config or making any request', async () => {
    const { deps: d, calls } = deps(mysql)
    await expect(dbQuery('shop', [], {}, d)).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(1)
    expect(err()).toContain('usage: insta <redis|mysql|mongodb> query')
    expect(calls).toEqual([]) // not even the service lookup ran
  })

  it('refuses a service of another engine and names the right group', async () => {
    const { deps: d } = deps([{ id: 'm1', type: 'mysql', name: 'db' }])
    await expect(dbQuery('db', ['PING'], {}, d, 'redis')).rejects.toThrow('exit 1')
    expect(err()).toContain('db is a mysql service — use: insta mysql query db')
  })

  it('relays a 202 approval gate: exit 2, hint on stderr, stdout untouched (non-json)', async () => {
    const body = { status: 'approval_required', action: 'db.query', approvalId: 'appr_1' }
    const { deps: d } = deps(mysql, { status: 202, body })
    await dbQuery('shop', ['select 1'], {}, d) // handleApproval returns, no throw
    expect(process.exitCode).toBe(2)
    expect(err()).toMatch(/approval required for db\.query — run: insta agent approvals approve appr_1/)
    expect(out()).toBe('')
  })

  it('--json prints the platform body verbatim and skips the human table', async () => {
    const body = { columns: [{ name: 'id' }], rows: [['1']], rowCount: 1 }
    const { deps: d } = deps(mysql, { status: 200, body })
    await dbQuery('shop', ['select 1'], { json: true }, d)
    expect(JSON.parse(out())).toEqual(body)
  })
})
