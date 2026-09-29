// Rule 6 of developing-insta-cli/SKILL.md, as a check. A pull request that adds a leaf command has
// to say in its body whether an agent can reach it.

// Free text is not accepted. "no MCP tool: later" would turn an open question into a closed record
// with a reason attached, which is harder to reopen than an unanswered one. A real "not now" has
// an issue to point at, which is what the fourth form is for.
const FORMS = [
  { name: 'a pull request in the MCP repository', re: /InsForge\/instacloud-mcp#\d+/ },
  { name: 'no MCP tool: credential minting', re: /no MCP tool:\s*credential minting/i },
  { name: 'no MCP tool: needs this machine', re: /no MCP tool:\s*needs this machine/i },
  { name: 'no MCP tool: platform denies agents', re: /no MCP tool:\s*platform denies agents/i },
  // For a decision that is neither of the three and is not a yes. The reason lives in the issue,
  // where it can be argued with, rather than in a pull request body nobody reads again.
  { name: 'no MCP tool: product decision, <issue>', re: /no MCP tool:\s*product decision,\s*InsForge\/instacloud-mcp#\d+/i },
]

export type Verdict = { ok: true } | { ok: false; message: string }

export function checkDeclaration(added: string[], body: string | null | undefined): Verdict {
  if (!added.length) return { ok: true }
  const section = sectionOf(body ?? '')
  if (section !== null && FORMS.some((f) => f.re.test(section))) return { ok: true }
  return { ok: false, message: failure(added, section === null) }
}

// Only the MCP section counts. A mention anywhere else in the body is prose, not a declaration.
function sectionOf(body: string): string | null {
  const m = /^##+\s*MCP\s*$/im.exec(body)
  if (!m) return null
  const rest = body.slice(m.index + m[0].length)
  const next = /^##+\s/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

const failure = (added: string[], missing: boolean): string => [
  `This pull request adds ${added.length} leaf command${added.length > 1 ? 's' : ''}: ${added.join(', ')}`,
  '',
  missing ? 'The pull request body has no "## MCP" section.' : 'The "## MCP" section says none of the accepted things.',
  '',
  'Add one of these to it:',
  ...FORMS.map((f) => `  ${f.name}`),
  '',
  'See rule 6 in .claude/skills/developing-insta-cli/SKILL.md.',
].join('\n')
