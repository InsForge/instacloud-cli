// The leaf command surface, as data. Written to surface.json and diffed in CI: a pull request that
// adds a leaf has to say whether an agent can reach it (developing-insta-cli/SKILL.md rule 6).
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
