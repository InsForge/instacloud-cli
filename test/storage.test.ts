// `insta storage` seams — all pure or DI'd, so nothing here reaches a backend.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseObjectLimit, objectsPath, objectDownloadPath, objectListLine,
  outputPath, streamPresignedTo, saveObject, nextPageCommand,
} from '../src/commands/storage.js'
import { resolveSoleService } from '../src/commands/services.js'

describe('parseObjectLimit', () => {
  it('accepts the route range', () => {
    expect(parseObjectLimit('1')).toBe(1)
    expect(parseObjectLimit('100')).toBe(100)
    expect(parseObjectLimit('1000')).toBe(1000)
  })
  it('rejects out-of-range and junk locally, before any request', () => {
    for (const raw of ['0', '-1', '1001', '2.5', '', 'lots']) {
      expect(() => parseObjectLimit(raw), raw).toThrow(/1\.\.1000/)
    }
  })
})

describe('objectsPath', () => {
  it('builds the listing query, omitting absent params', () => {
    expect(objectsPath('pr_1', 'svc_1', { branch: 'main', prefix: 'docs/', limit: 50 }))
      .toBe('/projects/pr_1/services/svc_1/objects?branch=main&prefix=docs%2F&limit=50')
    expect(objectsPath('pr_1', 'svc_1', {})).toBe('/projects/pr_1/services/svc_1/objects')
  })
  it('carries the cursor for the next page', () => {
    expect(objectsPath('pr_1', 'svc_1', { cursor: 'tok/en+1' })).toContain('cursor=tok%2Fen%2B1')
  })
  it('is also the DELETE target, with the key in the query — never a path segment', () => {
    const path = objectsPath('pr_1', 'svc_1', { branch: 'main', key: 'a/b/c.txt' })
    expect(path).toBe('/projects/pr_1/services/svc_1/objects?branch=main&key=a%2Fb%2Fc.txt')
  })
  // Keys are arbitrary bytes; an unencoded `&` or `#` would break the query.
  it('encodes awkward keys and prefixes (& # space non-ASCII)', () => {
    expect(objectsPath('pr_1', 'svc_1', { key: 'a&b #1 café.png' }))
      .toBe('/projects/pr_1/services/svc_1/objects?key=a%26b+%231+caf%C3%A9.png')
  })
})

describe('objectDownloadPath', () => {
  it('is a static subpath of the collection, so the listing route cannot shadow it', () => {
    expect(objectDownloadPath('pr_1', 'svc_1', { branch: 'main', key: 'a/b.txt' }))
      .toBe('/projects/pr_1/services/svc_1/objects/download?branch=main&key=a%2Fb.txt')
  })
  it('omits branch when the project default is wanted', () => {
    expect(objectDownloadPath('pr_1', 'svc_1', { key: 'x.txt' }))
      .toBe('/projects/pr_1/services/svc_1/objects/download?key=x.txt')
  })
})

describe('objectListLine', () => {
  it('renders size, modified, key with the fixed-width columns aligned', () => {
    expect(objectListLine({ key: 'docs/a.pdf', size: 8_000_000, lastModified: '2026-08-12T10:00:00.000Z' }))
      .toBe('   7.6 MiB  2026-08-12T10:00:00.000Z  docs/a.pdf')
  })
  it('never fakes a zero for a field the platform omitted', () => {
    expect(objectListLine({ key: 'x' })).toBe('         —  —                         x')
  })
})

describe('outputPath', () => {
  it('defaults to the last segment of the key', () => {
    expect(outputPath('docs/reports/q3.pdf')).toBe('q3.pdf')
    expect(outputPath('flat.txt')).toBe('flat.txt')
  })
  it('-o wins verbatim', () => {
    expect(outputPath('docs/q3.pdf', 'out/other.pdf')).toBe('out/other.pdf')
  })
  // Using only the last segment is what makes a hostile key harmless — nothing escapes cwd.
  it('cannot be steered out of cwd by a traversal key', () => {
    expect(outputPath('../../etc/passwd')).toBe('passwd')
    expect(outputPath('/etc/passwd')).toBe('passwd')
  })
  // A key may hold a backslash, which is also a separator on Windows.
  it('treats a backslash as a separator too', () => {
    expect(outputPath('..\\..\\Windows\\system32\\drivers\\etc\\hosts')).toBe('hosts')
    expect(outputPath('docs\\q3.pdf')).toBe('q3.pdf')
  })
  it('asks for -o when the key has no filename', () => {
    expect(() => outputPath('docs/')).toThrow(/pass -o/)
    expect(() => outputPath('')).toThrow(/pass -o/)
  })
})

describe('nextPageCommand', () => {
  // Following a command that dropped --prefix would page through a different set of objects.
  it('repeats every filter that shaped the page', () => {
    expect(nextPageCommand({ branch: 'feat-x', service: 'files', prefix: 'docs/', limit: 25 }, 'tok-2'))
      .toBe('insta storage list --service files --branch feat-x --prefix docs/ --limit 25 --cursor tok-2')
  })
  it('omits the flags that were never given', () => {
    expect(nextPageCommand({}, 'tok-2')).toBe('insta storage list --cursor tok-2')
  })
  // Quoting rules differ per shell, so a value needing quotes gets prose, not broken syntax.
  it('falls back to an instruction when a value would need quoting', () => {
    expect(nextPageCommand({ prefix: 'my docs/' }, 'tok-2'))
      .toBe('re-run this command with --cursor set to tok-2')
    expect(nextPageCommand({ prefix: "it's" }, 'tok-2'))
      .toBe('re-run this command with --cursor set to tok-2')
    expect(nextPageCommand({ prefix: 'a&b' }, 'tok-2'))
      .toBe('re-run this command with --cursor set to tok-2')
  })
  // Base64 cursors carry + / = which are safe unquoted, so the common case stays copy-pasteable.
  it('still emits a command for a base64 cursor', () => {
    expect(nextPageCommand({ prefix: 'docs/' }, 'dG9rZW4rMi8=')).
      toBe('insta storage list --prefix docs/ --cursor dG9rZW4rMi8=')
  })
})

// A body that hands over some bytes and then dies, as a dropped connection would.
const failingBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.error(new Error('connection reset'))
    },
  })

describe('streamPresignedTo', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insta-storage-')) })
  // mkdtemp leaks a directory per run without this, including every CI pass.
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('streams the provider body to disk and reports the byte count', async () => {
    const out = join(dir, 'q3.pdf')
    const fake = (async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]))) as unknown as typeof fetch
    expect(await streamPresignedTo('https://provider/q3.pdf', out, fake)).toBe(4)
    expect(readFileSync(out).toString('latin1')).toBe('%PDF')
  })

  // The point of streaming: a body larger than memory must still land, chunk by chunk.
  it('never holds the whole object at once', async () => {
    const out = join(dir, 'big.bin')
    const chunk = new Uint8Array(64 * 1024)
    let queued = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (queued++ >= 200) return controller.close()
        controller.enqueue(chunk)
      },
    })
    const fake = (async () => new Response(body)) as unknown as typeof fetch
    expect(await streamPresignedTo('https://provider/big.bin', out, fake)).toBe(200 * chunk.byteLength)
  })

  // A 60s TTL means an expired link is the likely failure, so say what to do about it.
  it('names the expiry as the likely cause when the provider refuses', async () => {
    const fake = (async () => new Response('', { status: 403 })) as unknown as typeof fetch
    await expect(streamPresignedTo('https://provider/x', join(dir, 'x'), fake)).rejects.toThrow(/presigned URL lives ~60s/)
  })

  // A half-written file must not pass for a finished download.
  it('removes the partial file when the stream fails mid-way', async () => {
    const out = join(dir, 'partial.bin')
    const fake = (async () => new Response(failingBody())) as unknown as typeof fetch
    await expect(streamPresignedTo('https://provider/partial.bin', out, fake)).rejects.toThrow(/connection reset/)
    expect(existsSync(out)).toBe(false)
  })

  // Opening `out` directly would truncate it, so a failed download used to destroy the old file.
  it('leaves an existing -o target untouched when the download fails', async () => {
    const out = join(dir, 'important.pdf')
    writeFileSync(out, 'ORIGINAL')
    const fake = (async () => new Response(failingBody())) as unknown as typeof fetch
    await expect(streamPresignedTo('https://provider/x', out, fake)).rejects.toThrow(/connection reset/)
    expect(readFileSync(out).toString()).toBe('ORIGINAL')
    expect(readdirSync(dir)).toEqual(['important.pdf'])
  })

  it('replaces an existing target once the download completes', async () => {
    const out = join(dir, 'report.txt')
    writeFileSync(out, 'OLD')
    const fake = (async () => new Response(new TextEncoder().encode('NEW'))) as unknown as typeof fetch
    expect(await streamPresignedTo('https://provider/report.txt', out, fake)).toBe(3)
    expect(readFileSync(out).toString()).toBe('NEW')
    expect(readdirSync(dir)).toEqual(['report.txt'])
  })

  // The part file is born at the umask default, so replacing a private file would widen it.
  // POSIX-only: Windows chmod just toggles read-only and stat reports 0o666 for any writable file.
  it.skipIf(process.platform === 'win32')('keeps the replaced file as private as it was', async () => {
    const out = join(dir, 'secret.pem')
    writeFileSync(out, 'OLD', { mode: 0o600 })
    const fake = (async () => new Response(new TextEncoder().encode('NEW'))) as unknown as typeof fetch
    await streamPresignedTo('https://provider/secret.pem', out, fake)
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })
})

describe('saveObject', () => {
  it('delegates to the injected streamer and returns its count', async () => {
    const seen: string[] = []
    const n = await saveObject('https://provider/q3.pdf', 'out.pdf', {
      streamTo: async (url, out) => { seen.push(url, out); return 4 },
    })
    expect(n).toBe(4)
    expect(seen).toEqual(['https://provider/q3.pdf', 'out.pdf'])
  })
})

describe('resolveSoleService (storage)', () => {
  const one = [{ id: 'a', type: 'postgres', name: 'db' }, { id: 'b', type: 'storage', name: 'files' }]
  const two = [...one, { id: 'c', type: 'storage', name: 'assets' }]
  it('returns the sole storage service when --service is omitted', () => {
    expect(resolveSoleService(one, 'storage').id).toBe('b')
  })
  it('resolves by name and lists the choices when ambiguous', () => {
    expect(resolveSoleService(two, 'storage', 'assets').id).toBe('c')
    expect(() => resolveSoleService(two, 'storage')).toThrow(/multiple storage services — specify one: files, assets/)
  })
  it('errors when the branch has no storage service, pointing at `services add`', () => {
    expect(() => resolveSoleService([one[0]!], 'storage')).toThrow(/insta service add storage <name>/)
    expect(() => resolveSoleService(two, 'storage', 'nope')).toThrow(/storage service not found: nope/)
  })
})
