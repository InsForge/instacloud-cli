import { createHash } from 'node:crypto'

export type ToolEvent = {
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  [k: string]: unknown
}

export type Finding = {
  kind: 'touch' | 'exposure'
  severity: 'info' | 'warn' | 'high'
  detector: string
  surface: string
  sink: string
  fingerprint: string
  snippet: string
  note: string
}

// (name, regex, group) — group:true ⇒ the secret is capture group 1, else the whole match.
// Specific detectors first; on an equal span the earlier one wins (stable sort + overlap drop).
type Detector = { name: string; rx: RegExp; group: boolean }
const DETECTORS: Detector[] = [
  { name: 'aws_access_key_id', rx: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/gd, group: false },
  { name: 'aws_secret_access_key', rx: /aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+]{40})/gid, group: true },
  { name: 'github_token', rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gd, group: false },
  { name: 'github_pat', rx: /\bgithub_pat_[A-Za-z0-9_]{82}\b/gd, group: false },
  { name: 'slack_token', rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gd, group: false },
  { name: 'stripe_secret_key', rx: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gd, group: false },
  { name: 'llm_api_key', rx: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/gd, group: false },
  { name: 'google_api_key', rx: /\bAIza[0-9A-Za-z_-]{35}\b/gd, group: false },
  { name: 'private_key_block', rx: /-----BEGIN ((?:[A-Z ]+ )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gd, group: false },
  { name: 'jwt', rx: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gd, group: false },
  { name: 'db_conn_string', rx: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:[^@\s/]+@[^\s'"]+/gd, group: false },
  { name: 'bearer_token', rx: /\bbearer\s+([A-Za-z0-9._-]{20,})/gid, group: true },
  { name: 'generic_secret_assignment', rx: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"]?([^\s'"]{8,})/gid, group: true },
]

const PLACEHOLDER = /^(?:your[_-]|example|changeme|placeholder|dummy|sample|redacted|secret|x{4,}|<.+>|\.\.\.|0{6,}|1234567|test[_-]?(?:key|token|secret))/i
const REFERENCE = /(process\.env|os\.environ|getenv|import\.meta|\$\{|\$[A-Za-z_]|config\.|settings\.|^env\.|^[A-Z][A-Z0-9_]{3,}$)/
// A captured value that is a code expression — a bare identifier followed by ≥1 member access,
// call, or index (authPassword.value, req.body.password, getSecret()) — is a reference, not a
// literal secret. A bare identifier with no suffix (e.g. hunter2pass) is NOT excused, so real
// unquoted/quoted literals still fire.
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\([^)]*\)|\[[^\]]*\])+$/

const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.[A-Za-z0-9_]+)?|\.aws\/credentials|\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.kube\/config|kubeconfig|\.docker(?:cfg|\/config\.json)|credentials\.json|service-account[^/]*\.json|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/i
const SECRET_FILE_SAFE = /\.(?:example|sample|template|dist)$|\.pub$/i

// apply_patch envelope markers (Codex). Format-based, so extraction is field-name-independent.
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete|Move) File: (.+?)\s*$/gim

const NETWORK = /\b(?:curl|wget|httpie|http|nc|ncat|netcat|scp|sftp|ssh|telnet|rsync)\b/i
const PRINT = /\b(?:echo|printf|cat|print|less|more|head|tail|xxd|base64|env|printenv|set)\b/i
const GIT_WRITE = /\bgit\s+(?:add|commit|push|stash)\b/i

export function isSecretFile(path?: string): boolean {
  if (!path) return false
  if (SECRET_FILE_SAFE.test(path)) return false
  return SECRET_FILE.test(path)
}

function fingerprint(secret: string, detector: string): string {
  const h = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8)
  const last4 = secret.length >= 8 ? secret.slice(-4) : ''
  const tail = last4 ? '••••' + last4 : '••••'
  return `${detector}:${tail}:#${h}`
}

function snippet(text: string, offset: number, fp: string): string {
  const start = Math.max(0, offset - 36)
  const end = Math.min(text.length, offset + fp.length + 2 + 36)
  let out = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) out = '…' + out
  if (end < text.length) out = out + '…'
  return out.slice(0, 160)
}

function leaves(obj: unknown, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (o: unknown, p: string): void => {
    if (typeof o === 'string') out.push([p, o])
    else if (Array.isArray(o)) o.forEach((v, idx) => walk(v, `${p}[${idx}]`))
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`)
  }
  walk(obj, prefix)
  return out
}

function applyPatchPaths(ti: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const [, text] of leaves(ti, 'input')) {
    PATCH_FILE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PATCH_FILE.exec(text)) !== null) { if (m[1]) paths.push(m[1]) }
  }
  return paths
}

function scanText(text: string): Array<[number, number, string, string]> {
  const hits: Array<[number, number, string, string]> = []
  for (const { name, rx, group } of DETECTORS) {
    rx.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rx.exec(text)) !== null) {
      if (m.index === rx.lastIndex) rx.lastIndex++ // zero-width guard
      const gi = group ? 1 : 0
      const secret = m[gi]
      const span = (m as RegExpExecArray & { indices?: Array<[number, number]> }).indices?.[gi]
      if (!secret || !span) continue
      if (PLACEHOLDER.test(secret)) continue
      if (name === 'generic_secret_assignment' && (REFERENCE.test(secret) || CODE_REFERENCE.test(secret))) continue
      hits.push([span[0], span[1], name, secret])
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]) // stable: earlier detector wins an equal span
  const kept: Array<[number, number, string, string]> = []
  for (const r of hits) {
    const previous = kept.at(-1)
    if (previous && r[0] < previous[1]) {
      previous[1] = Math.max(previous[1], r[1])
      previous[3] = text.slice(previous[0], previous[1])
      continue
    }
    kept.push(r)
  }
  return kept
}

function classify(
  tool: string, side: 'input' | 'output', command: string, filePath: string, secretFileTarget: boolean,
): [Finding['kind'], Finding['severity'], string, string] {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(tool) && side === 'input') {
    if (secretFileTarget) return ['touch', 'info', 'write_secret_file', `secret written to secret file ${filePath}`]
    return ['exposure', 'high', 'nonsecret_file', `secret written into ${filePath || 'a non-secret file'}`]
  }
  if (tool === 'Bash' && side === 'input') {
    if (NETWORK.test(command)) return ['exposure', 'high', 'network', 'secret in an outbound network command']
    if (GIT_WRITE.test(command)) return ['exposure', 'high', 'git', 'secret in a git write command']
    if (PRINT.test(command)) return ['exposure', 'warn', 'stdout', 'secret printed to stdout']
    return ['touch', 'info', 'shell', 'secret present in a shell command']
  }
  if (side === 'output') {
    if (tool === 'Bash') return ['exposure', 'warn', 'stdout', 'secret appeared in command output']
    return ['touch', 'info', 'read', 'secret visible in tool output']
  }
  return ['touch', 'info', 'other', 'secret handled by agent']
}

export function scanEvent(event: ToolEvent, opts: { ignorePath?: (p: string) => boolean } = {}): Finding[] {
  const tool = event.tool_name || '?'
  const ti = (event.tool_input as Record<string, unknown>) || {}
  const tr = event.tool_response ?? {}
  const filePath = (ti.file_path as string) || ''
  const command = (ti.command as string) || ''

  if (opts.ignorePath && filePath && opts.ignorePath(filePath)) return []

  const findings: Finding[] = []
  const seen = new Set<string>()
  const add = (
    kind: Finding['kind'], sev: Finding['severity'], detector: string,
    surface: string, sink: string, fp: string, snip: string, note: string,
  ): void => {
    const key = [kind, detector, surface, fp, sink].join('|')
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ kind, severity: sev, detector, surface, sink, fingerprint: fp, snippet: snip, note })
  }

  // Path-based rules (fire even without a value match).
  if (isSecretFile(filePath)) {
    const base = filePath.split('/').pop() ?? filePath
    if (tool === 'Read') add('touch', 'info', 'secret_file', `${tool}.file_path`, 'read', `file:${base}`, filePath, `agent read secret file ${filePath}`)
    else if (['Write', 'Edit', 'MultiEdit'].includes(tool)) add('touch', 'info', 'secret_file', `${tool}.file_path`, 'write_secret_file', `file:${base}`, filePath, `agent wrote secret file ${filePath}`)
  }
  if (command && GIT_WRITE.test(command)) {
    for (const tok of command.match(/[^\s'"]+/g) ?? []) {
      if (isSecretFile(tok)) {
        const base = tok.split('/').pop() ?? tok
        add('exposure', 'high', 'secret_file', 'Bash.command', 'git', `file:${base}`, `git ... ${tok}`, `secret file ${tok} staged/committed via git`)
      }
    }
  }

  // Value-based rules: scan every string surface of input and output.
  const patchPaths = tool === 'apply_patch' ? applyPatchPaths(ti) : []
  const secretFileTarget = isSecretFile(filePath) || patchPaths.some((p) => isSecretFile(p))
  for (const p of patchPaths) {
    if (isSecretFile(p)) {
      const base = p.split('/').pop() ?? p
      add('touch', 'info', 'secret_file', 'apply_patch.input', 'write_secret_file', `file:${base}`, p, `agent wrote secret file ${p} via apply_patch`)
    }
  }
  for (const [surface, text] of [...leaves(ti, 'input'), ...leaves(tr, 'output')]) {
    if (!text || text.length > 1_000_000) continue
    const side: 'input' | 'output' = surface.startsWith('input') ? 'input' : 'output'
    let redacted = ''
    let cursor = 0
    const hits = scanText(text).map(([start, end, detector, secret]) => {
      const fp = fingerprint(secret, detector)
      redacted += text.slice(cursor, start)
      const offset = redacted.length
      redacted += `«${fp}»`
      cursor = end
      return { detector, fp, offset }
    })
    redacted += text.slice(cursor)
    for (const { detector, fp, offset } of hits) {
      const [kind, sev, sink, note] = classify(tool, side, command, filePath, secretFileTarget)
      add(kind, sev, detector, `${tool}:${surface}`, sink, fp, snippet(redacted, offset, fp), note)
    }
  }
  return findings
}
