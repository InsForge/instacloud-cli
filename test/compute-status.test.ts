// `insta compute status` rendering: `live=none` must come with the reason the newest deploy
// attempt failed, and the build-logs command when it was a build (insta-platform #646).
import { describe, it, expect } from 'vitest'
import { statusLines } from '../src/commands/compute.js'

describe('statusLines', () => {
  it('prints only desired vs live when the platform sends no failure', () => {
    expect(statusLines('api', { desiredState: 'running', state: 'running' })).toEqual(['compute api: desired=running  live=running'])
  })

  it('prints the failure reason and the build-logs command for a repo build', () => {
    expect(statusLines('api', {
      desiredState: 'running', state: 'none',
      lastFailure: { kind: 'deploy', at: '2026-10-08T09:34:03.123Z', reason: 'app on the vm not ready (listening on :8080) within 2m0s', buildId: '6a20f7bb-0000-4000-8000-000000000000', buildSource: 'github' },
    })).toEqual([
      'compute api: desired=running  live=none',
      'last deploy failed 2026-10-08 09:34 UTC: app on the vm not ready (listening on :8080) within 2m0s',
      '  → insta build logs 6a20f7bb-0000-4000-8000-000000000000 --source github',
    ])
  })

  it('names an archive build source and a build-phase failure', () => {
    const lines = statusLines('api', { desiredState: 'running', state: 'none', lastFailure: { kind: 'build', at: '2026-10-08T09:34:03Z', reason: 'no Dockerfile', buildId: 'op-1', buildSource: 'archive' } })
    expect(lines[1]).toBe('last build failed 2026-10-08 09:34 UTC: no Dockerfile')
    expect(lines[2]).toBe('  → insta build logs op-1 --source archive')
  })

  it('an image deploy has no build to point at', () => {
    expect(statusLines('api', { desiredState: 'running', state: 'stopped', lastFailure: { kind: 'deploy', at: '2026-10-08T09:34:03Z', reason: 'nothing on 8080' } }))
      .toEqual(['compute api: desired=running  live=stopped', 'last deploy failed 2026-10-08 09:34 UTC: nothing on 8080'])
  })
})
