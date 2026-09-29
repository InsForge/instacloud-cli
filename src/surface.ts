// The leaf command surface, as data. Written to surface.json and diffed in CI: a pull request that
// adds a leaf has to say whether an agent can reach it (developing-insta-cli/SKILL.md rule 6).
import { execFileSync } from 'node:child_process'
import type { Command } from 'commander'

// A command with no subcommands is a leaf. Hidden ones are included: they are still commands, and
// leaving them out would let a new one arrive unnoticed.
export function leafPaths(root: Command): string[] {
  const out: string[] = []
  const visit = (cmd: Command, path: string[]): void => {
    if (!cmd.commands.length) { if (path.length) out.push(path.join(' ')); return }
    for (const child of cmd.commands) visit(child, [...path, child.name()])
  }
  visit(root, [])
  return out.sort()
}

export const renderSurface = (leaves: string[]): string => JSON.stringify({ leaves }, null, 2) + '\n'

// Throws rather than returning a default: a snapshot this function cannot read is a broken gate,
// and a broken gate that reports no drift is worse than one that fails.
export function parseSurface(raw: string, where: string): string[] {
  let value: unknown
  try { value = JSON.parse(raw) } catch (e) { throw new Error(`${where} is not JSON: ${(e as Error).message}`) }
  const leaves = (value as { leaves?: unknown })?.leaves
  if (!Array.isArray(leaves) || leaves.some((l) => typeof l !== 'string')) {
    throw new Error(`${where} has no "leaves" array of strings`)
  }
  return leaves as string[]
}

/** Reads the base's snapshot. An absent path is not an error; every other failure is. */
export type BaseReader = { present: () => boolean; read: () => string }

// ls-tree separates the two cases git show conflates: empty output means the path is absent on a
// reachable ref, while a bad ref exits non-zero. Only the first is "this commit introduces the
// snapshot". Lives here rather than in the CI script so a test can point it at a real repository.
export function gitBaseReader(ref: string, cwd?: string): BaseReader {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
  return {
    present: () => git('ls-tree', ref, '--', 'surface.json').trim().length > 0,
    read: () => git('show', `${ref}:surface.json`),
  }
}

// Only an absent path is treated as "nothing was added". A bad ref, an unreadable blob or a
// malformed snapshot all reach the caller, because each of them would otherwise pass the gate.
export function addedLeaves(base: BaseReader, current: string[]): string[] {
  if (!base.present()) return []
  const before = new Set(parseSurface(base.read(), 'the base surface.json'))
  return current.filter((l) => !before.has(l)).sort()
}
