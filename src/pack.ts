import { readdirSync, readFileSync, lstatSync, readlinkSync, existsSync, openSync, closeSync, fstatSync, constants } from 'node:fs'
import { join, sep } from 'node:path'
import { createHash } from 'node:crypto'
// Not node:zlib. The digest of this archive IS its identity: the id the object is stored under,
// the dedup key, and part of the approval-bound deploy body. The runtime's zlib is native and its
// output differs between the runtimes this CLI ships on -- the same tree packs to 360 bytes under
// Node 25 and 353 under Bun -- so with it the identity of a tree changed with the install channel.
// fflate is pure JS: same algorithm, same bytes, everywhere.
//
// PINNED EXACTLY in package.json, not caret-ranged, and that is load-bearing rather than tidy.
// A compiled binary bundles whatever the lockfile resolved, while `npx insta` resolves the range
// afresh against the registry. A patch release is free to emit different valid gzip for the same
// input, so a caret would let the two channels produce different digests for one tree -- exactly
// the property this dependency was taken on to guarantee.
import { gzipSync } from 'fflate'
import { compileIgnore, type Ignore, type IgnoreFile, type Flavour } from './pack-ignore.js'

// Packs a source directory into the tar.gz the build gateway fetches as source.archive.

// What the build worker enforces; discovery returns the server's own figures, which override these.
export type ArchiveLimits = { maxArchiveBytes: number; maxExtractedBytes: number; maxFiles: number }

export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxExtractedBytes: 1024 * 1024 * 1024,
  maxFiles: 10000,
}

export type PackResult = {
  archive: Buffer
  // Over the COMPRESSED bytes, which are the bytes that get uploaded, so this is both the id the
  // object is stored under and what the build worker verifies its download against. Canonical
  // because the compressor is pure JS rather than the runtime's native zlib: one tree has one
  // identity on every machine, whichever way the CLI was installed.
  sha256: string
  files: number
  // Total entries incl. directories: the worker counts every header, so the cap applies to this.
  entries: number
  extractedBytes: number
  // Selects the build type: the gateway does not fall back to nixpacks when it finds no Dockerfile.
  hasDockerfile: boolean
}

const BLOCK = 512
const PAD = Buffer.alloc(BLOCK, 0)

// Only the exec bit matters: normalising to 0644 breaks entrypoints, raw mode leaks the umask.
const fileMode = (mode: number): number => (mode & 0o111 ? 0o755 : 0o644)

const octal = (n: number, width: number): string => n.toString(8).padStart(width - 1, '0') + '\0'

// ustar splits a long path across prefix(155) + name(100); refuse by name rather than truncate.
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`path too long for a tar archive: ${path}`)
}

function header(path: string, mode: number, size: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(BLOCK, 0)
  const { name, prefix } = splitName(path)
  h.write(name, 0, 100, 'utf8')
  h.write(octal(mode, 8), 100, 8, 'ascii')
  h.write(octal(0, 8), 108, 8, 'ascii') // uid, pinned
  h.write(octal(0, 8), 116, 8, 'ascii') // gid, pinned
  h.write(octal(size, 12), 124, 12, 'ascii')
  h.write(octal(0, 12), 136, 12, 'ascii') // mtime, pinned
  h.write('        ', 148, 8, 'ascii') // checksum is summed as spaces, then overwritten
  h.write(type, 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  h.write(prefix, 345, 155, 'utf8')

  let sum = 0
  for (const b of h) sum += b
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii')
  return h
}

// ino/dev ride along from the walk's own lstat so the read can prove it opened the SAME file.
export type Found = { path: string; mode: number; size: number; dir: boolean; ino?: bigint | number; dev?: bigint | number }

// The builder fails the whole build on a symlink entry; hardlinks are fine, we only write type '0'.
function linkError(links: { path: string; target: string }[]): Error {
  const shown = links.slice(0, 5).map((l) => `  ${l.path} -> ${l.target}`)
  const more = links.length > shown.length ? [`  … and ${links.length - shown.length} more`] : []
  return new Error(
    [
      'a deploy archive cannot contain symlinks — the build gateway rejects them:',
      ...shown,
      ...more,
      'replace them with real files, or exclude them (.dockerignore, or .gitignore when there is no .dockerignore)',
    ].join('\n'),
  )
}

// .git blows the 10k entry cap on its own; .insta is CLI state. A deliberate departure from docker.
const ALWAYS_SKIP = new Set(['.git', '.insta'])

// docker keeps these whatever the ignore file says; avoids a remote-only "Dockerfile not found".
const KEPT_AT_ROOT = new Set(['Dockerfile', '.dockerignore'])

// One global sort emits a parent before its children, since a dir name prefixes everything inside.
function walk(
  root: string,
  rel: string,
  out: Found[],
  links: { path: string; target: string }[],
  ig: Ignore,
  files: IgnoreFile[],
  flavour: Flavour,
): void {
  const dirAbs = join(root, rel === '' ? '.' : rel.split('/').join(sep))
  const names = readdirSync(dirAbs).sort()

  // A nested .gitignore extends its own subtree; recompiled only where one exists. docker has none.
  if (flavour === 'git' && rel !== '' && names.includes('.gitignore')) {
    files = [...files, { base: rel, text: readFileSync(join(dirAbs, '.gitignore'), 'utf8') }]
    ig = compileIgnore(files, 'git')
  }

  for (const name of names) {
    if (ALWAYS_SKIP.has(name)) continue
    const relPath = rel === '' ? name : `${rel}/${name}`
    const keep = rel === '' && KEPT_AT_ROOT.has(name)
    const abs = join(root, relPath.split('/').join(sep))
    const st = lstatSync(abs)

    if (st.isSymbolicLink()) {
      // An ignored symlink is not the user's problem to solve.
      if (!keep && ig.excludes(relPath, false)) continue
      links.push({ path: relPath, target: readlinkSync(abs) })
    } else if (st.isDirectory()) {
      if (ig.excludes(relPath, true) && ig.canPrune(relPath)) continue
      // Emitted whenever we descend, so a re-included child has its parent.
      out.push({ path: `${relPath}/`, mode: 0o755, size: 0, dir: true })
      walk(root, relPath, out, links, ig, files, flavour)
    } else if (st.isFile()) {
      if (!keep && ig.excludes(relPath, false)) continue
      out.push({ path: relPath, mode: fileMode(st.mode), size: st.size, dir: false, ino: st.ino, dev: st.dev })
    }
  }
}

// The walk classifies with lstat and the read happens later, so a plain readFileSync would
// FOLLOW a symlink that replaced the file in between and put a file from outside the directory
// into an archive that promises none. Two guards, and neither is a full one on its own:
//
//   O_NOFOLLOW refuses when the final component is a symlink AT OPEN TIME, closing the swap the
//   walk cannot see. Undefined on Windows, where it degrades to the check below.
//
//   fstat on the OPEN HANDLE must still describe the file the walk measured: same inode, same
//   device, same size. Its job is the tar's own consistency -- a file rewritten to a different
//   length mid-pack would otherwise produce a header whose count disagrees with its payload.
//
// Two things neither closes, and both are stated rather than implied away:
//
//   An ANCESTOR directory swapped for a symlink. Node exposes no openat, so resolving each
//   component against a directory handle is not available here.
//
//   A same-size plain file deleted and recreated. Measured on linux rather than assumed: the
//   inode is REUSED and mtimeNs/ctimeNs are byte-identical for a delete+create inside one
//   timestamp tick, so no stat-based identity can see it. It is also the least interesting case
//   -- the symlink promise still holds, the tar stays well formed because the length did not
//   move, and the archive simply carries a slightly newer copy of a file the caller owns.
//
// The residual on both is narrow: someone able to rewrite files and directories inside the tree
// being packed can already put any bytes they like into it by writing them.
export function readEntry(abs: string, e: Found): Buffer {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  let fd: number
  try {
    fd = openSync(abs, constants.O_RDONLY | noFollow)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${e.path} became a symlink while packing — re-run the deploy`)
    }
    throw err
  }
  try {
    const st = fstatSync(fd)
    const same = st.isFile() && st.size === e.size
      && (e.ino === undefined || st.ino === e.ino) && (e.dev === undefined || st.dev === e.dev)
    if (!same) throw new Error(`${e.path} changed while packing — re-run the deploy`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

// A root .dockerignore wins outright; merging would drop artefacts the image needs.
function rootIgnore(absDir: string): { ig: Ignore; files: IgnoreFile[]; flavour: Flavour } {
  const read = (name: string) => readFileSync(join(absDir, name), 'utf8')
  if (existsSync(join(absDir, '.dockerignore'))) {
    const files = [{ base: '', text: read('.dockerignore') }]
    return { ig: compileIgnore(files, 'docker'), files, flavour: 'docker' }
  }
  const files = existsSync(join(absDir, '.gitignore')) ? [{ base: '', text: read('.gitignore') }] : []
  return { ig: compileIgnore(files, 'git'), files, flavour: 'git' }
}

const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`

// Windows has no POSIX exec bit for lstat to report, so a script packs as 0644 and the image
// cannot run it. Same as `docker build` from Windows; say so rather than let it fail at start-up.
export function windowsModeCaveat(platform: string = process.platform): string | null {
  if (platform !== 'win32') return null
  return 'packing on Windows: file permissions are not preserved, so an executable script arrives as 0644 — add `RUN chmod +x <path>` to your Dockerfile if the image runs one'
}

export function packDirectory(absDir: string, limits: Partial<ArchiveLimits> = {}): PackResult {
  const cap = { ...ARCHIVE_LIMITS, ...limits }
  const found: Found[] = []
  const links: { path: string; target: string }[] = []
  const { ig, files, flavour } = rootIgnore(absDir)
  walk(absDir, '', found, links, ig, files, flavour)
  if (links.length) throw linkError(links)
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // Known from the walk alone, so both fail before a byte is read or compressed.
  const extractedBytes = found.reduce((n, e) => n + e.size, 0)
  if (found.length > cap.maxFiles) {
    throw new Error(
      `archive has too many files: ${found.length} > ${cap.maxFiles} (directories count) — exclude what the build does not need`,
    )
  }
  if (extractedBytes > cap.maxExtractedBytes) {
    throw new Error(
      `archive would extract to ${mib(extractedBytes)}, over the ${mib(cap.maxExtractedBytes)} limit — exclude what the build does not need`,
    )
  }

  const chunks: Buffer[] = []
  for (const e of found) {
    if (e.dir) {
      chunks.push(header(e.path, e.mode, 0, '5'))
      continue
    }
    const data = readEntry(join(absDir, e.path.split('/').join(sep)), e)
    chunks.push(header(e.path, e.mode, data.length, '0'), data)
    const rem = data.length % BLOCK
    if (rem) chunks.push(PAD.subarray(0, BLOCK - rem))
  }
  chunks.push(PAD, PAD) // two zero blocks close a tar

  const tar = Buffer.concat(chunks)
  // Drop the per-file buffers before the compressor allocates: concat has copied every byte, so
  // holding the originals through gzip is a third full copy of the tree for nothing. This does
  // not make the packer streaming -- the peak is still two copies plus the compressor's own
  // working set -- but it is the part that costs nothing to give back.
  chunks.length = 0
  const archive = Buffer.from(gzipSync(tar, { level: 9, mtime: 0 }))
  // Pinned here as well as asked of the library: gzip carries its own mtime (4-7) and OS byte (9),
  // and a header the packer writes itself cannot drift with a dependency's defaults.
  archive.writeUInt32LE(0, 4)
  archive[9] = 255

  if (archive.length > cap.maxArchiveBytes) {
    throw new Error(`archive is too large: ${mib(archive.length)} > ${mib(cap.maxArchiveBytes)} — exclude what the build does not need`)
  }

  return {
    archive,
    sha256: createHash('sha256').update(archive).digest('hex'),
    files: found.filter((e) => !e.dir).length,
    entries: found.length,
    extractedBytes,
    hasDockerfile: found.some((e) => e.path === 'Dockerfile'),
  }
}
