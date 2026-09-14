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

  it('materializes a DANGLING link rather than failing', () => {
    // Nothing to write through, so replacing the link is the only remaining
    // move -- but it must not throw and leave the user with no config at all.
    const link = join(dir, 'dangling')
    symlinkSync(join(dir, 'gone'), link)
    writeFileAtomicSync(link, 'body\n')
    expect(readFileSync(link, 'utf8')).toBe('body\n')
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
  })
})
