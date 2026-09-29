// Rule 6 of developing-insta-cli/SKILL.md, as a check. A pull request that adds a leaf command has
// to say in its body whether an agent can reach it.

// Anchored at the start of the line, and only the section's first non-empty line is read. An
// unanchored search matches its own negation: "this is not no MCP tool: needs this machine" and
// "InsForge/instacloud-mcp#123, but no matching tool exists" both contain an accepted form.
//
// Free text is not accepted either. "no MCP tool: later" would turn an open question into a closed
// record with a reason attached, which is harder to reopen than an unanswered one. A real "not now"
// has an issue to point at, which is what the last form is for.
const FORMS = [
  // Anything after the link is for a reader, not for this check: whether that pull request really
  // adds the tool is a question only a reviewer can answer.
  { name: 'InsForge/instacloud-mcp#<n> at the start of the line', re: /^InsForge\/instacloud-mcp#\d+\b/ },
  { name: 'no MCP tool: credential minting', re: /^no MCP tool:\s*credential minting$/i },
  { name: 'no MCP tool: needs this machine', re: /^no MCP tool:\s*needs this machine$/i },
  { name: 'no MCP tool: platform denies agents', re: /^no MCP tool:\s*platform denies agents$/i },
  // For a decision that is none of the three and is not a yes. The reason lives in the issue, where
  // it can be argued with, rather than in a pull request body nobody reads again.
  { name: 'no MCP tool: product decision, InsForge/instacloud-mcp#<n>', re: /^no MCP tool:\s*product decision,\s*InsForge\/instacloud-mcp#\d+$/i },
]

export type Verdict = { ok: true } | { ok: false; message: string }

export function checkDeclaration(added: string[], body: string | null | undefined): Verdict {
  if (!added.length) return { ok: true }
  const line = declarationLine(body ?? '')
  if (line !== null && FORMS.some((f) => f.re.test(line))) return { ok: true }
  return { ok: false, message: failure(added, line) }
}

// A heading inside a comment or a code fence is not a section. A pull request template carrying a
// commented-out example would otherwise declare on every author's behalf.
//
// The closing fence follows CommonMark: same character, no shorter than the opening run, nothing
// after it but whitespace. A line reading ```not a closing fence does not close anything, and
// treating it as a close would expose the headings below it while a reader still sees code.
const stripInvisible = (body: string): string =>
  body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/^[ \t]*((`|~)\2{2,})[\s\S]*?(?:^[ \t]*\1\2*[ \t]*$|$(?![\s\S]))/gm, '')

// Exactly two hashes. A deeper heading is a subsection of something else, and accepting it would
// let a "### MCP" under "## Notes" stand in for the declaration.
function declarationLine(raw: string): string | null {
  const body = stripInvisible(raw)
  const m = /^##[ \t]*MCP[ \t]*$/m.exec(body)
  if (!m) return null
  for (const raw of body.slice(m.index + m[0].length).split('\n')) {
    const line = raw.trim()
    if (line.startsWith('##')) return ''
    if (line) return line
  }
  return ''
}

const failure = (added: string[], line: string | null): string => [
  `This pull request adds ${added.length} leaf command${added.length > 1 ? 's' : ''}: ${added.join(', ')}`,
  '',
  line === null
    ? 'The pull request body has no "## MCP" section.'
    : line === ''
      ? 'The "## MCP" section is empty.'
      : `The first line of the "## MCP" section is not a declaration:\n  ${line}`,
  '',
  'Its first line must be one of:',
  ...FORMS.map((f) => `  ${f.name}`),
  '',
  'See rule 6 in .claude/skills/developing-insta-cli/SKILL.md.',
].join('\n')
