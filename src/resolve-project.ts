// "One command, just works": when a command needs a project and the directory isn't linked
// (and no INSTA_PROJECT_ID is set), resolve it instead of lecturing about `project link` —
// one project auto-selects silently, several get a one-keystroke picker, and either way the
// choice is SAVED so this happens at most once per directory, and the committed link file shares
// it with the team.
import { createInterface } from 'node:readline/promises'
import type { ProjectConfig } from './config.js'

export type ProjectItem = { id: string; name: string }
export type ResolveDeps = {
  listProjects: () => Promise<ProjectItem[]>
  promptChoice: (items: ProjectItem[]) => Promise<ProjectItem>
  save: (c: ProjectConfig) => Promise<void>
  tty: boolean
}

export async function autoResolveProject(orgId: string, deps: ResolveDeps): Promise<ProjectConfig> {
  const projects = await deps.listProjects()
  if (projects.length === 0) {
    throw new Error('no projects yet — start one with `insta project create <name>`')
  }
  let picked: ProjectItem
  if (projects.length === 1) {
    picked = projects[0]!
  } else if (deps.tty) {
    picked = await deps.promptChoice(projects)
  } else {
    const list = projects.map((p) => `  ${p.id}  ${p.name}`).join('\n')
    throw new Error(`several projects and no terminal to pick — set INSTA_PROJECT_ID or run \`insta project link <id>\`:\n${list}`)
  }
  const cfg: ProjectConfig = { projectId: picked.id, orgId, branch: 'main' }
  await deps.save(cfg)
  return cfg
}

/** Real picker: numbered list on stderr, one line of input. Dependency-free. */
export async function promptChoice(items: ProjectItem[]): Promise<ProjectItem> {
  process.stderr.write('pick a project:\n')
  items.forEach((p, i) => process.stderr.write(`  ${i + 1}) ${p.name}  (${p.id})\n`))
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    for (;;) {
      const answer = (await rl.question(`1-${items.length} > `)).trim()
      const idx = Number(answer) - 1
      const hit = items[idx]
      if (hit) return hit
    }
  } finally {
    rl.close()
  }
}
