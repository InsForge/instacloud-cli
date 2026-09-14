// Whether this machine lets the test process create symlinks at all.
//
// On Windows that is a PRIVILEGE (SeCreateSymbolicLinkPrivilege, or Developer
// Mode), and a runner without it fails `symlinkSync` with EPERM. GitHub's
// Windows images run as an administrator and have it, so CI exercises every
// symlink case; a developer's box without it should SKIP those cases with the
// reason named rather than fail them, because the limitation is the machine's,
// not the code's -- unlike a missing loader, which is a broken checkout.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-symlink-probe-'))
  try {
    writeFileSync(join(dir, 'target'), '')
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
