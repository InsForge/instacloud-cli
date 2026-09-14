import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, utimesSync, symlinkSync, linkSync, lstatSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { packDirectory, windowsModeCaveat, readEntry, ARCHIVE_LIMITS } from '../src/pack.js'

const mk = () => mkdtempSync(join(tmpdir(), 'insta-pack-'))

// Making a symlink on Windows needs elevation, which CI's windows runner has not got.
const itLinks = process.platform === 'win32' ? it.skip : it
// Windows has no POSIX exec bit for chmod to set or lstat to report, so anything asserting one is
// asserting the platform, not the packer. The loss itself is real and warned about at pack time.
const itModes = process.platform === 'win32' ? it.skip : it

// Assert on the bytes we ship. ustar: name@0 mode@100 uid@108 gid@116 size@124 mtime@136 type@156.
type TarEntry = { name: string; mode: number; uid: number; gid: number; size: number; mtime: number; type: string }
function readTar(gz: Buffer): TarEntry[] {
  const buf = gunzipSync(gz)
  const out: TarEntry[] = []
  let off = 0
  while (off + 512 <= buf.length) {
    const b = buf.subarray(off, off + 512)
    if (b.every((x) => x === 0)) break
    const str = (s: number, n: number) => b.subarray(s, s + n).toString('utf8').replace(/\0.*$/s, '').trim()
    const oct = (s: number, n: number) => parseInt(str(s, n) || '0', 8)
    const size = oct(124, 12)
    out.push({
      name: str(0, 100),
      mode: oct(100, 8),
      uid: oct(108, 8),
      gid: oct(116, 8),
      size,
      mtime: oct(136, 12),
      type: String.fromCharCode(b[156]),
    })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

// The same tree built two ways: different parent, creation order and mtimes.
function writeTreeA(dir: string): void {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'app.js'), 'console.log(1)\n')
  writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')
  utimesSync(join(dir, 'src', 'app.js'), new Date('2020-01-01'), new Date('2020-01-01'))
}
function writeTreeB(dir: string): void {
  writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'app.js'), 'console.log(1)\n')
  utimesSync(join(dir, 'src', 'app.js'), new Date('2031-06-06'), new Date('2031-06-06'))
}

describe('packDirectory — determinism', () => {
  it('withholds files excluded by a Docker negated class matching a directory separator', () => {
    const dir = mk()
    mkdirSync(join(dir, 'private'))
    writeFileSync(join(dir, '.dockerignore'), 'private[^x]token\n')
    writeFileSync(join(dir, 'private', 'token'), 'test-secret')
    writeFileSync(join(dir, 'private', 'keep.txt'), 'keep')
    const names = readTar(packDirectory(dir).archive).map((entry) => entry.name)
    expect(names).not.toContain('private/token')
    expect(names).toContain('private/keep.txt')
  })

  it('gives identical trees the same digest despite different mtimes and creation order', () => {
    const a = mk()
    const b = mk()
    writeTreeA(a)
    writeTreeB(b)

    expect(packDirectory(a).sha256).toBe(packDirectory(b).sha256)
  })

  it('gives the same digest on repeated runs of the same tree', () => {
    const dir = mk()
    writeTreeA(dir)

    expect(packDirectory(dir).sha256).toBe(packDirectory(dir).sha256)
  })

  it('pins uid, gid and mtime to zero in every header', () => {
    const dir = mk()
    writeTreeA(dir)

    for (const e of readTar(packDirectory(dir).archive)) {
      expect({ name: e.name, uid: e.uid, gid: e.gid, mtime: e.mtime }).toEqual({ name: e.name, uid: 0, gid: 0, mtime: 0 })
    }
  })

  // Measured, not feared: the same fixture packs to 360 bytes under Node 25 and 353 under Bun, and
  // the CLI ships on both (npx runs Node, the compiled binary runs Bun). So the gzip digest cannot
  // ONE digest, and it is over the bytes that get uploaded. Anything else, however canonical,
  // cannot be what an object id is derived from: an id must address the bytes it stores.
  it('digests the archive buffer itself, not the tar inside it', () => {
    const dir = mk()
    writeTreeA(dir)
    const res = packDirectory(dir)

    expect(res.sha256).toBe(createHash('sha256').update(res.archive).digest('hex'))
    expect(res.sha256).not.toBe(createHash('sha256').update(gunzipSync(res.archive)).digest('hex'))
  })

  // Format pin over the TAR bytes. Its .tar.gz counterpart is the test below: both are pinned now
  // that the compressor is ours rather than the runtime's.
  itModes('produces byte-identical tar output for a fixed fixture tree', () => {
    const dir = mk()
    writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')
    chmodSync(join(dir, 'Dockerfile'), 0o644)
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(dir, 'run.sh'), 0o755)
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.js'), "console.log('hi')\n")
    chmodSync(join(dir, 'src', 'app.js'), 0o644)

    const tar = gunzipSync(packDirectory(dir).archive)
    expect(createHash('sha256').update(tar).digest('hex')).toBe(
      '86d57c3d50425ed7c94540b9ded038e074c7a3ec62c8be9a88e624027318b83a',
    )
  })

  // The digest of these bytes is the archive's IDENTITY: the storage id, the dedup key, and part
  // of the approval-bound deploy body. Pinning it is what makes "one tree, one identity, every
  // machine" a property the suite defends rather than a sentence in a PR. Verified out-of-band as
  // well: this fixture packs to the same bytes and the same digest under node:25 and oven/bun,
  // which node:zlib did not (different lengths, different digests).
  itModes('produces a byte-identical .tar.gz, not just a byte-identical tar', () => {
    const dir = mk()
    writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')
    chmodSync(join(dir, 'Dockerfile'), 0o644)
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(dir, 'run.sh'), 0o755)
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.js'), "console.log('hi')\n")
    chmodSync(join(dir, 'src', 'app.js'), 0o644)

    const res = packDirectory(dir)
    expect(res.archive.length).toBe(210)
    expect(res.sha256).toBe('dfd0a923a121af1938e8e8c026f16d03ddbad9f5fd91cd4030a6e1b46ed22117')
  })

  it('normalises the gzip header, which carries its own mtime and OS byte', () => {
    const dir = mk()
    writeTreeA(dir)
    const gz = packDirectory(dir).archive

    expect(Array.from(gz.subarray(4, 8))).toEqual([0, 0, 0, 0]) // MTIME
    expect(gz[9]).toBe(255) // OS = unknown, so a mac and a linux box agree
  })
})

describe('packDirectory — layout and modes', () => {
  it('roots the archive at the directory itself, with no wrapper level', () => {
    const dir = mk()
    writeTreeA(dir)

    const names = readTar(packDirectory(dir).archive).map((e) => e.name)
    expect(names).toContain('Dockerfile')
    expect(names).toContain('src/app.js')
    expect(names.some((n) => n.startsWith('./') || n.startsWith('/'))).toBe(false)
  })

  it('emits entries in a fixed sorted order', () => {
    const dir = mk()
    writeTreeA(dir)

    const names = readTar(packDirectory(dir).archive).map((e) => e.name)
    expect(names).toEqual([...names].sort())
  })

  itModes('preserves the executable bit and leaves plain files at 0644', () => {
    const dir = mk()
    writeFileSync(join(dir, 'entrypoint.sh'), '#!/bin/sh\n')
    chmodSync(join(dir, 'entrypoint.sh'), 0o755)
    writeFileSync(join(dir, 'README'), 'hi\n')
    chmodSync(join(dir, 'README'), 0o644)

    const byName = Object.fromEntries(readTar(packDirectory(dir).archive).map((e) => [e.name, e.mode]))
    expect(byName['entrypoint.sh']).toBe(0o755)
    expect(byName['README']).toBe(0o644)
  })

  itModes('changes the digest when only the executable bit changes', () => {
    const a = mk()
    const b = mk()
    for (const d of [a, b]) writeFileSync(join(d, 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(a, 'run.sh'), 0o644)
    chmodSync(join(b, 'run.sh'), 0o755)

    expect(packDirectory(a).sha256).not.toBe(packDirectory(b).sha256)
  })
})

// The exec bit is genuinely lost on Windows, so the user hears it at pack time rather than as a
// permission-denied container start. Platform is a parameter so both branches run everywhere.
describe('windowsModeCaveat', () => {
  it('warns on win32 and names the workaround', () => {
    expect(windowsModeCaveat('win32')).toMatch(/chmod \+x/)
  })

  it('says nothing where the mode is real', () => {
    expect(windowsModeCaveat('darwin')).toBeNull()
    expect(windowsModeCaveat('linux')).toBeNull()
  })
})

// The builder fails the build on a symlink entry (main.go:872); don't reach it, don't drop it.
describe('packDirectory — links', () => {
  itLinks('refuses a symlinked file and names the path', () => {
    const dir = mk()
    writeFileSync(join(dir, 'real.txt'), 'x\n')
    symlinkSync('real.txt', join(dir, 'alias.txt'))

    expect(() => packDirectory(dir)).toThrow(/alias\.txt/)
  })

  itLinks('refuses a symlinked directory and names the path', () => {
    const dir = mk()
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', 'a.js'), 'a\n')
    symlinkSync('pkg', join(dir, 'node_modules'))

    expect(() => packDirectory(dir)).toThrow(/node_modules/)
  })

  itLinks('refuses a dangling symlink, which no stat-following walk would see', () => {
    const dir = mk()
    symlinkSync('nowhere.txt', join(dir, 'broken.txt'))

    expect(() => packDirectory(dir)).toThrow(/broken\.txt/)
  })

  itLinks('names a nested symlink by its full relative path', () => {
    const dir = mk()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'real.js'), 'x\n')
    symlinkSync('real.js', join(dir, 'src', 'link.js'))

    expect(() => packDirectory(dir)).toThrow(/src\/link\.js/)
  })

  // A hardlink is a second name for one inode, not a tar link type; we always write '0'.
  it('packs a hardlinked file as an ordinary regular entry', () => {
    const dir = mk()
    writeFileSync(join(dir, 'a.txt'), 'shared\n')
    linkSync(join(dir, 'a.txt'), join(dir, 'b.txt'))

    const entries = readTar(packDirectory(dir).archive)
    expect(entries.map((e) => `${e.name}:${e.type}`).sort()).toEqual(['a.txt:0', 'b.txt:0'])
  })
})

const packedNames = (dir: string) => readTar(packDirectory(dir).archive).map((e) => e.name)

// Decided at the FILE level: a root .dockerignore wins outright, .gitignore is not consulted.
describe('packDirectory — ignore files', () => {
  it('uses .dockerignore alone when the root has one', () => {
    const dir = mk()
    writeFileSync(join(dir, '.dockerignore'), 'secrets.txt\n')
    writeFileSync(join(dir, '.gitignore'), 'dist.js\n')
    writeFileSync(join(dir, 'secrets.txt'), 's\n')
    writeFileSync(join(dir, 'dist.js'), 'd\n')

    const names = packedNames(dir)
    expect(names).not.toContain('secrets.txt')
    expect(names).toContain('dist.js') // .gitignore is not consulted at all
  })

  it('falls back to .gitignore when there is no .dockerignore', () => {
    const dir = mk()
    writeFileSync(join(dir, '.gitignore'), 'dist.js\n')
    writeFileSync(join(dir, 'dist.js'), 'd\n')
    writeFileSync(join(dir, 'app.js'), 'a\n')

    const names = packedNames(dir)
    expect(names).not.toContain('dist.js')
    expect(names).toContain('app.js')
  })

  it('applies a nested .gitignore to its own subtree only', () => {
    const dir = mk()
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', '.gitignore'), 'x.txt\n')
    writeFileSync(join(dir, 'sub', 'x.txt'), 'x\n')
    writeFileSync(join(dir, 'x.txt'), 'x\n')

    const names = packedNames(dir)
    expect(names).not.toContain('sub/x.txt')
    expect(names).toContain('x.txt')
  })

  // The rules an author relies on decide the packed list, not a matcher's approximation of them.
  // Both of these shipped a withheld file: `**` read as directory-crossing wherever it stood, and
  // a class ended at its first `]`.
  it('keeps a git ** inside one segment unless it stands alone between separators', () => {
    const dir = mk()
    writeFileSync(join(dir, '.gitignore'), '*.env\n!a**b/keep.env\n')
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'a', 'x'))
    mkdirSync(join(dir, 'a', 'x', 'b'))
    writeFileSync(join(dir, 'a', 'x', 'b', 'keep.env'), 'k\n')
    mkdirSync(join(dir, 'axb'))
    writeFileSync(join(dir, 'axb', 'keep.env'), 'k\n')

    const names = packedNames(dir)
    expect(names).not.toContain('a/x/b/keep.env') // `a**b` is `a*b`: one segment
    expect(names).toContain('axb/keep.env') // ...which this one is
  })

  it('excludes what a POSIX named class names, so [[:digit:]].env withholds 1.env', () => {
    const dir = mk()
    writeFileSync(join(dir, '.gitignore'), '[[:digit:]].env\n')
    writeFileSync(join(dir, '1.env'), 'x\n')
    writeFileSync(join(dir, 'a.env'), 'x\n')

    const names = packedNames(dir)
    expect(names).not.toContain('1.env')
    expect(names).toContain('a.env')
  })

  it('reads a .dockerignore a**/b the way docker does, reaching the root ab and the nested a/x/b', () => {
    const dir = mk()
    writeFileSync(join(dir, '.dockerignore'), 'a**/b\n')
    writeFileSync(join(dir, 'ab'), 'x\n')
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'a', 'x'))
    writeFileSync(join(dir, 'a', 'x', 'b'), 'x\n')
    writeFileSync(join(dir, 'axb'), 'x\n')

    const names = packedNames(dir)
    expect(names).not.toContain('ab')
    expect(names).not.toContain('a/x/b')
    expect(names).toContain('axb')
  })

  it.each([
    ['?.env', '😀.env', '😀😀.env'],
    ['[😀-🙏].env', '😁.env', 'a.env'],
    ['[[:digit:]].env', '1.env', 'a.env'],
    ['[a-c[:digit:]].env', 'b.env', 'z.env'],
    ['[[:^digit:]].env', '😀.env', '1.env'],
  ])('does not upload files excluded by Docker rule %s', (pattern, excluded, kept) => {
    const dir = mk()
    writeFileSync(join(dir, '.dockerignore'), pattern + '\n')
    writeFileSync(join(dir, excluded), 'withheld fixture\n')
    writeFileSync(join(dir, kept), 'included fixture\n')

    const names = packedNames(dir)
    expect(names).not.toContain(excluded)
    expect(names).toContain(kept)
  })

  it('reads a .dockerignore foo**bar as docker does: foobar and foo/x/bar go, fooXbar stays', () => {
    const dir = mk()
    writeFileSync(join(dir, '.dockerignore'), 'foo**bar\n')
    writeFileSync(join(dir, 'foobar'), 'x\n')
    writeFileSync(join(dir, 'fooXbar'), 'x\n')
    mkdirSync(join(dir, 'foo'))
    mkdirSync(join(dir, 'foo', 'x'))
    writeFileSync(join(dir, 'foo', 'x', 'bar'), 'x\n')

    const names = packedNames(dir)
    expect(names).not.toContain('foobar')
    expect(names).not.toContain('foo/x/bar')
    expect(names).toContain('fooXbar')
  })

  it('excludes a file named ] for a []] rule', () => {
    const dir = mk()
    writeFileSync(join(dir, '.gitignore'), '[]]\n')
    writeFileSync(join(dir, ']'), 'x\n')
    writeFileSync(join(dir, 'a'), 'x\n')

    const names = packedNames(dir)
    expect(names).not.toContain(']')
    expect(names).toContain('a')
  })

  it('does not consult a nested .dockerignore', () => {
    const dir = mk()
    writeFileSync(join(dir, '.dockerignore'), 'nothing-here\n')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', '.dockerignore'), 'x.txt\n')
    writeFileSync(join(dir, 'sub', 'x.txt'), 'x\n')

    expect(packedNames(dir)).toContain('sub/x.txt')
  })

  it('always excludes .git, at any depth', () => {
    const dir = mk()
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref\n')
    mkdirSync(join(dir, 'vendor'))
    mkdirSync(join(dir, 'vendor', '.git'))
    writeFileSync(join(dir, 'vendor', '.git', 'HEAD'), 'ref\n')
    writeFileSync(join(dir, 'app.js'), 'a\n')

    expect(packedNames(dir)).toEqual(['app.js', 'vendor/'])
  })

  it('always excludes .insta, which holds CLI state and not build input', () => {
    const dir = mk()
    mkdirSync(join(dir, '.insta'))
    writeFileSync(join(dir, '.insta', 'project.json'), '{}\n')
    writeFileSync(join(dir, 'app.js'), 'a\n')

    expect(packedNames(dir)).toEqual(['app.js'])
  })

  it('keeps the root Dockerfile and .dockerignore under a catch-all exclude, as docker does', () => {
    const dir = mk()
    writeFileSync(join(dir, '.dockerignore'), '*\n!src\n')
    writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.js'), 'a\n')
    writeFileSync(join(dir, 'junk.txt'), 'j\n')

    const names = packedNames(dir)
    expect(names).toContain('Dockerfile')
    expect(names).toContain('.dockerignore')
    expect(names).toContain('src/app.js')
    expect(names).not.toContain('junk.txt')
  })

  itLinks('does not fail on a symlink inside an ignored directory', () => {
    const dir = mk()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'app.js'), 'a\n')
    symlinkSync('../app.js', join(dir, 'node_modules', 'linked.js'))

    expect(packedNames(dir)).toEqual(['.gitignore', 'app.js'])
  })

  it('reports whether a Dockerfile was packed, which is what selects the build type', () => {
    const withIt = mk()
    writeFileSync(join(withIt, 'Dockerfile'), 'FROM alpine\n')
    const without = mk()
    writeFileSync(join(without, 'app.js'), 'a\n')

    expect(packDirectory(withIt).hasDockerfile).toBe(true)
    expect(packDirectory(without).hasDockerfile).toBe(false)
  })
})

// All three caps are knowable before the upload, so the message can name the one that was hit.
describe('packDirectory — limits', () => {
  it('defaults to the figures the build gateway enforces', () => {
    expect(ARCHIVE_LIMITS).toEqual({
      maxArchiveBytes: 256 * 1024 * 1024,
      maxExtractedBytes: 1024 * 1024 * 1024,
      maxFiles: 10000,
    })
  })

  it('names the file-count limit when too many entries are packed', () => {
    const dir = mk()
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), 'x\n')

    expect(() => packDirectory(dir, { maxFiles: 3 })).toThrow(/too many files.*5.*3/s)
  })

  // The worker counts EVERY header before it checks the type (main.go:840), so directories count.
  it('counts directories toward the file-count limit, as the worker does', () => {
    const dir = mk()
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))
    writeFileSync(join(dir, 'a', 'x.txt'), 'x\n')
    writeFileSync(join(dir, 'b', 'y.txt'), 'y\n')

    expect(() => packDirectory(dir, { maxFiles: 3 })).toThrow(/too many files.*4.*3/s)
  })

  it('names the extracted-size limit before compressing anything', () => {
    const dir = mk()
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(500))

    expect(() => packDirectory(dir, { maxExtractedBytes: 100 })).toThrow(/extract/i)
  })

  it('names the archive-size limit once the bytes are known', () => {
    const dir = mk()
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(5000))

    expect(() => packDirectory(dir, { maxArchiveBytes: 10 })).toThrow(/archive is too large/i)
  })

  it('reports the counts a caller needs to show progress', () => {
    const dir = mk()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.js'), 'abc')
    writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')

    const res = packDirectory(dir)
    expect({ files: res.files, entries: res.entries, extractedBytes: res.extractedBytes }).toEqual({
      files: 2,
      entries: 3, // + the src/ directory
      extractedBytes: 3 + 'FROM alpine\n'.length,
    })
  })
})

// The matcher agreeing is not the promise; what ships is. `abc/**` plus a re-inclusion beneath it
// used to lose the kept file entirely, because the trailing globstar matched `abc` itself and the
// walker pruned the directory before any negation could be consulted.
itModes('keeps a file re-included under a trailing globstar', () => {
  const dir = mk()
  writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\n')
  mkdirSync(join(dir, 'abc'))
  writeFileSync(join(dir, 'abc', 'keep.txt'), 'keep\n')
  writeFileSync(join(dir, 'abc', 'drop.txt'), 'drop\n')
  writeFileSync(join(dir, '.gitignore'), 'abc/**\n!abc/keep.txt\n')

  const names = packedNames(dir)
  expect(names).toContain('abc/keep.txt')
  expect(names).not.toContain('abc/drop.txt')
})

// The walk classifies with lstat; the read happens later. A plain readFileSync FOLLOWS a symlink
// that replaced the file in between, so an archive promising "no symlinks" could carry a file
// from outside the directory entirely. The window is real even without an attacker: anything
// rewriting the tree while a deploy packs it hits the same path.
describe('readEntry — the file read cannot be swapped out from under the walk', () => {
  const found = (path: string, st: { size: number; ino?: number | bigint; dev?: number | bigint }) =>
    ({ path, mode: 0o644, size: st.size, dir: false, ino: st.ino, dev: st.dev })

  it('reads a file the walk really measured', () => {
    const dir = mk()
    const abs = join(dir, 'a.txt')
    writeFileSync(abs, 'hello\n')
    const st = lstatSync(abs)
    expect(readEntry(abs, found('a.txt', st)).toString()).toBe('hello\n')
  })

  itModes('refuses a file replaced by a symlink after the walk', () => {
    const dir = mk()
    const abs = join(dir, 'a.txt')
    writeFileSync(abs, 'hello\n')
    const st = lstatSync(abs)
    writeFileSync(join(dir, 'secret.txt'), 'SECRET\n')

    // The swap: same path, now pointing somewhere else.
    unlinkSync(abs)
    symlinkSync(join(dir, 'secret.txt'), abs)

    // The assertion is not merely "it threw" — it is that the secret never came back.
    let out = ''
    try { out = readEntry(abs, found('a.txt', st)).toString() } catch (e) { out = `threw: ${(e as Error).message}` }
    expect(out).not.toContain('SECRET')
    expect(out).toMatch(/threw:.*(symlink|changed)/)
  })

  it('refuses a file rewritten to a different size after the walk', () => {
    const dir = mk()
    const abs = join(dir, 'a.txt')
    writeFileSync(abs, 'hello\n')
    const st = lstatSync(abs)

    // Not an attack, just a build touching its own tree: the tar header would otherwise claim
    // the old length and disagree with the payload that follows it.
    writeFileSync(abs, 'hello, a much longer line\n')

    expect(() => readEntry(abs, found('a.txt', st))).toThrow(/changed while packing/)
  })

  it('refuses a same-size file swapped in by rename after the walk', () => {
    const dir = mk()
    const abs = join(dir, 'a.txt')
    writeFileSync(abs, 'hello\n')
    const st = lstatSync(abs)
    const other = join(dir, 'b.txt')
    writeFileSync(other, 'WORLD\n') // the same length, so only the identity check can tell
    // Both files exist at once, so they cannot share an inode, and a rename keeps b's. Stated as
    // a precondition so a failure here names the fixture and not readEntry.
    expect(lstatSync(other).ino).not.toBe(st.ino)
    renameSync(other, abs)

    let out = ''
    try { out = readEntry(abs, found('a.txt', st)).toString() } catch (e) { out = `threw: ${(e as Error).message}` }
    expect(out).not.toContain('WORLD')
    expect(out).toMatch(/changed while packing/)
  })

  // NOT tested: a same-size DELETE and recreate at the same path. Measured on linux, the inode is
  // reused and mtimeNs/ctimeNs are identical inside one timestamp tick, so no stat-based check can
  // see it. Asserting either way would encode a guess -- the limitation is documented at readEntry.
})
