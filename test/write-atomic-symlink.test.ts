import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync, resolveThroughSymlink } from '../src/util.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insta-atomic-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a symlinked config is written THROUGH, not replaced', () => {
  it('keeps the link and updates its target', () => {
    // The dotfiles setup: the real file lives in a repo, ~/.ssh/config is a
    // link at it. rename(2) over the link would leave the repo holding a stale
    // copy while ssh read a detached regular file -- and the next dotfiles sync
    // would quietly put our block back to whatever the repo still said.
    const repo = join(dir, 'dotfiles'); mkdirSync(repo)
    const real = join(repo, 'ssh_config')
    const link = join(dir, 'config')
    writeFileSync(real, 'old\n')
    symlinkSync(real, link)

    writeFileAtomicSync(link, 'new\n', { mode: 0o600 })

    expect(lstatSync(link).isSymbolicLink(), 'the symlink was replaced with a regular file').toBe(true)
    expect(readFileSync(real, 'utf8'), 'the dotfiles copy was left stale').toBe('new\n')
    expect(readFileSync(link, 'utf8')).toBe('new\n')
  })

  it('follows a chain of links all the way to the real file', () => {
    const real = join(dir, 'real'); writeFileSync(real, 'old\n')
    const mid = join(dir, 'mid'); symlinkSync(real, mid)
    const top = join(dir, 'top'); symlinkSync(mid, top)

    writeFileAtomicSync(top, 'new\n')

    expect(lstatSync(top).isSymbolicLink()).toBe(true)
    expect(lstatSync(mid).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('new\n')
  })

  it('writes an ordinary file exactly as before', () => {
    const p = join(dir, 'plain')
    writeFileAtomicSync(p, 'hello\n')
    expect(readFileSync(p, 'utf8')).toBe('hello\n')
    expect(lstatSync(p).isFile()).toBe(true)
  })

  it('creates a file that does not exist yet', () => {
    const p = join(dir, 'absent')
    writeFileAtomicSync(p, 'fresh\n')
    expect(readFileSync(p, 'utf8')).toBe('fresh\n')
  })

  it('refuses to write when the link cannot be resolved, rather than severing it', () => {
    // ELOOP, not ENOENT. A blanket catch returned the LINK path and the caller
    // then renamed over it -- destroying a dotfiles symlink because we could
    // not read it, which is the exact harm resolving exists to prevent. Only a
    // missing target licenses replacement; every other failure is
    // "cannot confirm", and cannot-confirm is not a licence to write.
    const a = join(dir, 'loop-a')
    const b = join(dir, 'loop-b')
    symlinkSync(b, a)
    symlinkSync(a, b)
    expect(() => resolveThroughSymlink(a), 'a symlink cycle was silently treated as a plain path').toThrow()
    expect(() => writeFileAtomicSync(a, 'x\n')).toThrow()
    expect(lstatSync(a).isSymbolicLink(), 'the link was severed anyway').toBe(true)
  })

  it('writes THROUGH a dangling link, creating the target it names', () => {
    // A dangling link is not an unknown destination: `readlink` still says
    // exactly where the user wired the file. Replacing it with a regular file
    // -- which is what rename(2) over the link does -- destroys that wiring
    // silently, and a dotfiles repo that has not been populated yet is the
    // ordinary way to arrive here, not a corrupt state.
    const target = join(dir, 'gone')
    const link = join(dir, 'dangling')
    symlinkSync(target, link)

    writeFileAtomicSync(link, 'body\n')

    expect(lstatSync(link).isSymbolicLink(), 'the dangling link was severed').toBe(true)
    expect(readFileSync(target, 'utf8'), 'the target the link names was not created').toBe('body\n')
    expect(readFileSync(link, 'utf8')).toBe('body\n')
  })

  it('follows a RELATIVE dangling link the way the kernel would', () => {
    // readlink returns the link text verbatim, which is resolved against the
    // directory holding the LINK -- not the process cwd. Getting that wrong
    // writes a stray file into wherever the CLI happened to be run from.
    const sub = join(dir, 'repo'); mkdirSync(sub)
    const link = join(sub, 'config')
    symlinkSync('../real_config', link)

    writeFileAtomicSync(link, 'body\n')

    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, 'real_config'), 'utf8')).toBe('body\n')
  })

  it('walks a chain that dangles only at its end', () => {
    const top = join(dir, 'top')
    const mid = join(dir, 'mid')
    const end = join(dir, 'end')
    symlinkSync(mid, top)
    symlinkSync(end, mid)

    writeFileAtomicSync(top, 'body\n')

    expect(lstatSync(top).isSymbolicLink()).toBe(true)
    expect(lstatSync(mid).isSymbolicLink()).toBe(true)
    expect(readFileSync(end, 'utf8')).toBe('body\n')
  })

  it('fails without touching the link when the target directory is missing', () => {
    // Nothing safe is left to do: the intended target cannot be created and the
    // link is the only record of where it belongs. Failing loudly keeps the
    // wiring; severing it to produce a writable path does not.
    const link = join(dir, 'into-nowhere')
    symlinkSync(join(dir, 'no', 'such', 'dir', 'config'), link)

    expect(() => writeFileAtomicSync(link, 'body\n')).toThrow()
    expect(lstatSync(link).isSymbolicLink(), 'the link was severed to make the write succeed').toBe(true)
  })

  it('backs up the dangling link’s target, not the link', () => {
    const target = join(dir, 'target'); writeFileSync(target, 'old\n')
    const link = join(dir, 'link'); symlinkSync(target, link)
    rmSync(target)
    // The target is gone, so there is nothing to back up -- and the write must
    // still land on the target rather than on the link.
    writeFileAtomicSync(link, 'new\n', { backup: true })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('new\n')
  })

  it('leaves no temporary file behind on success', () => {
    const p = join(dir, 'cfg')
    writeFileAtomicSync(p, 'x\n')
    expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('puts the backup beside the REAL file, where the target actually lives', () => {
    const repo = join(dir, 'dotfiles'); mkdirSync(repo)
    const real = join(repo, 'ssh_config'); writeFileSync(real, 'old\n')
    const link = join(dir, 'config'); symlinkSync(real, link)

    writeFileAtomicSync(link, 'new\n', { backup: true })

    expect(readFileSync(real + '.insta-bak', 'utf8'), 'the backup was written for the wrong file').toBe('old\n')
  })

  describe('resolveThroughSymlink', () => {
    it('returns a plain path unchanged', () => {
      const p = join(dir, 'f'); writeFileSync(p, '')
      expect(resolveThroughSymlink(p)).toBe(p)
    })
    it('returns a missing path unchanged', () => {
      expect(resolveThroughSymlink(join(dir, 'nope'))).toBe(join(dir, 'nope'))
    })
    it('resolves a link to its target', () => {
      const real = join(dir, 'real'); writeFileSync(real, '')
      const link = join(dir, 'link'); symlinkSync(real, link)
      // macOS resolves /var -> /private/var, so compare against the same
      // resolution rather than the path we happened to construct.
      expect(resolveThroughSymlink(link)).toBe(realpathSync(real))
    })
    it('resolves a dangling link to the target it names', () => {
      // Not realpathSync(dir) here, unlike the live-link case above: there is
      // no target to call realpath on, so the answer is the LINK TEXT resolved
      // against the link's directory, verbatim.
      const link = join(dir, 'dangling'); symlinkSync(join(dir, 'gone'), link)
      expect(resolveThroughSymlink(link), 'a dangling link resolved to itself, so a write would replace it')
        .toBe(join(dir, 'gone'))
    })
  })
})
