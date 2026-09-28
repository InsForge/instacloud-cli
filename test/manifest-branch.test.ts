import { describe, it, expect } from 'vitest'
import { branchResources } from '../src/commands/manifest.js'

describe('branchResources', () => {
  const rows = [
    { kind: 'insta-db', name: 'db', branchId: null, status: 'active' },
    { kind: 's3', name: 'db', branchId: null, status: 'active' },
    { kind: 'insta-db', name: 'db', branchId: 'b-main', status: 'active' },
    { kind: 'insta-db', name: 'db', branchId: 'b-dev', status: 'active' },
  ]
  it('lists an origin postgres once on the default branch, keeping root-only rows', () => {
    expect(branchResources(rows, { id: 'b-main', is_default: true }).map((r) => `${r.kind}:${r.branchId}`))
      .toEqual(['s3:null', 'insta-db:b-main'])
  })
  it('gives a non-default branch only its own rows', () => {
    expect(branchResources(rows, { id: 'b-dev' })).toEqual([rows[3]])
  })
})
