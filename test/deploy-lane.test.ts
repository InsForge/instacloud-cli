import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { prepareSource } from '../src/commands/deploy.js'
import { ApiError } from '../src/api.js'
import type { BuildRunner } from '../src/flyctl-build.js'

function srcDir(withDockerfile = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'insta-lane-'))
  if (withDockerfile) writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\nEXPOSE 3000\n')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
  return dir
}

const noRun: BuildRunner = async () => ({ code: 0, output: '' })

// A platform that answers `lane` on discovery and records every path and body it was asked for.
// `objectStates` scripts the archive status reads in order; the default says the object is
// already there, so a test that is not about the upload never needs an uploader.
function fakeApi(lane: unknown, extra: Record<string, unknown> = {}, objectStates: string[] = ['valid']) {
  const paths: string[] = []
  const bodies: Record<string, any> = {}
  const api = {
    rawRequest: async (method: string, path: string, body?: unknown) => {
      const key = `${method} ${path.split('?')[0]}`
      paths.push(key)
      bodies[key] = body
      // Overrides win: a test that wants a different answer for one path says so, and the
      // defaults below are only what the happy path needs.
      const override = extra[key]
      if (override) return override
      if (path.includes('/source-build')) {
        if (lane === '404') throw new ApiError(404, 'Route not found')
        if (lane === '404-target') throw new ApiError(404, 'compute group not found: default')
        return { status: 200, body: lane }
      }
      if (path.includes('/build-uploads/')) return { status: 200, body: { state: objectStates.length > 1 ? objectStates.shift() : objectStates[0] } }
      if (key === 'POST /projects/p1/build-uploads') return { status: 200, body: { uploadUrl: 'https://bucket.example/o?put=1', expiresAt: '2026-09-09T00:15:00Z' } }
      // The deploy is accepted as an operation; the poll answers a finished one, so the loop runs once.
      if (key === 'POST /projects/p1/archive-deploys') return { status: 202, body: { status: 'accepted', operationId: 'op_1', state: 'queued' } }
      if (path.includes('/archive-deploys/')) return { status: 200, body: { state: 'live', imageRef: 'ecr.example/app@sha256:aa', url: 'https://app.example', branch: 'main', group: 'api' } }
      throw new ApiError(501, 'deploy tokens (remote builders) is cloud-only')
    },
  }
  return { api, paths, bodies }
}

afterEach(() => { process.exitCode = undefined })

describe('prepareSource — lane dispatch', () => {
  // 404 must mean "old server", for a human AND an agent, which is why discovery is a GET.
  it('falls back to the unchanged deploy-token path when discovery 404s', async () => {
    const { api, paths } = fakeApi('404')

    const out = await prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)

    expect(out).toHaveProperty('image')
    expect(paths).toContain('POST /projects/p1/deploy-token')
  })

  // The same 404 from a platform that HAS the route: the branch has no compute service, or has several and
  // none was named. Not an old server, and the flyctl fallback would only report a missing Dockerfile.
  it('names both ways out when discovery 404s for the target, not the route', async () => {
    const { api, paths } = fakeApi('404-target')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(prepareSource(api, 'p1', srcDir(false), 'main', {}, noRun)).rejects.toThrow()
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/compute group not found: default.*--group <name>.*insta services add compute/)
      expect(paths).not.toContain('POST /projects/p1/deploy-token')
    } finally { stderr.mockRestore() }
  })

  it('takes the flyctl path when the platform names that lane', async () => {
    const { api, paths } = fakeApi({ lane: 'flyctl' })

    await prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)

    expect(paths).toContain('POST /projects/p1/deploy-token')
  })

  // insta-oss names this lane: the token mint answers 501 and the directory is built by the same
  // docker the daemon runs, so the image is a local tag and nothing archive-shaped is asked for.
  it('takes the local-docker path when the platform names that lane', async () => {
    const { api, paths } = fakeApi({ lane: 'local-docker' })

    const out = await prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)

    expect(out).toMatchObject({ image: expect.stringMatching(/^insta-src-p1-default:/) })
    expect(paths).toContain('POST /projects/p1/deploy-token')
    expect(paths.some((p) => p.includes('archive') || p.includes('build-uploads'))).toBe(false)
  })

  // The archive lane never mints a Fly token, a directory with no Dockerfile is legitimate, and
  // it is different in KIND from the other lanes: its one gated call enqueues build+deploy, so
  // by the time it returns the deploy has happened and it hands back the outcome, not an image
  // for a `/deploy` call that no longer exists on this path.
  it('packs, uploads, and resolves to a finished deploy, minting no deploy token', async () => {
    // The object is missing on the first read, so this run really mints and really uploads; a
    // fake that said "valid" up front let the title claim an upload that never happened.
    const { api, paths, bodies } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } }, {}, ['missing', 'valid'])
    const puts: Array<{ url: string; bytes: number }> = []

    const out = await prepareSource(api, 'p1', srcDir(false), 'main', { group: 'api' }, noRun, async (url, body) => { puts.push({ url, bytes: body.length }) })

    expect(out).toEqual({ deployed: { image: 'ecr.example/app@sha256:aa', url: 'https://app.example', branch: 'main', group: 'api', machineId: undefined } })
    expect(bodies['POST /projects/p1/archive-deploys'].archive.build).toEqual({ type: 'nixpacks' })
    expect(paths).not.toContain('POST /projects/p1/deploy-token')
    expect(paths).not.toContain('POST /projects/p1/deploy')
    // One PUT, of the bytes the mint was told about, and the deploy names the same digest.
    expect(puts).toEqual([{ url: 'https://bucket.example/o?put=1', bytes: bodies['POST /projects/p1/build-uploads'].size }])
    expect(bodies['POST /projects/p1/archive-deploys'].archive.archiveSha256).toBe(bodies['POST /projects/p1/build-uploads'].sha256)
    // Order matters: the object has to exist before a deploy is asked for it.
    expect(paths.indexOf('POST /projects/p1/build-uploads')).toBeGreaterThan(-1)
    expect(paths.indexOf('POST /projects/p1/build-uploads')).toBeLessThan(paths.indexOf('POST /projects/p1/archive-deploys'))
  })

  it('selects a dockerfile build when the packed tree has one', async () => {
    const { api, bodies } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } })

    await prepareSource(api, 'p1', srcDir(true), 'main', {}, noRun)

    expect(bodies['POST /projects/p1/archive-deploys'].archive.build).toEqual({ type: 'dockerfile' })
  })

  // A failed build is an ANSWER the gateway gave, not a transport error, and its sentence is the
  // only thing telling the user why their tree did not build. `die` carries it on stderr, not on
  // the thrown CliExit, so that is where it has to be asserted.
  it('dies with the gateway’s own sentence when the build fails', async () => {
    const { api } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } }, {
      'GET /projects/p1/archive-deploys/op_1': { status: 200, body: { state: 'failed', error: 'build bld_1 failed: no Dockerfile at ./api' } },
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(prepareSource(api, 'p1', srcDir(false), 'main', {}, noRun)).rejects.toThrow()
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/no Dockerfile at \.\/api/)
    } finally {
      err.mockRestore()
    }
  })

  // `--json` promises one parseable document on stdout, and this lane added two progress lines
  // (packing, building) plus a poll loop to the path that has to keep that promise.
  it('writes no progress to stdout in --json mode', async () => {
    const { api } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } })
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await prepareSource(api, 'p1', srcDir(false), 'main', { json: true }, noRun)
      expect(out.mock.calls.map((c) => String(c[0])).join('')).toBe('')
    } finally {
      out.mockRestore()
    }
  })

  // The platform already worded the refusal; repeating it in the CLI would let the two drift.
  it('refuses with the platform’s own reason when no lane serves the target', async () => {
    const { api } = fakeApi({ lane: 'none', reason: 'source builds are not supported on the insta-compute provider yet' })

    await expect(prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)).rejects.toThrow()
  })

  // On the archive lane the server enforces the caps; the client only names which one was hit.
  it('enforces the caps discovery reported', async () => {
    const { api } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 1 } })

    await expect(prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)).rejects.toThrow(/too many files/)
  })
})
