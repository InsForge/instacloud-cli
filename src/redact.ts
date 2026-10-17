// Local PII redaction for outbound feedback text. Pattern-based: a safety net, not a license to
// paste credentials. The ingest service re-scrubs server-side with the same patterns
// (insta-feedback repo), so a drift here is caught by the second pass. IPv6 and phone numbers are
// deliberately not matched — the false-positive rate against UUIDs and hashes destroys the
// diagnostic value of error text.

const PATTERNS: Array<[RegExp, string]> = [
  // URL-embedded credentials: scheme://user:pass@host (DATABASE_URLs pasted into error output).
  // Pasted passwords are often not percent-encoded, so the password half may contain `/`.
  [/(\w+:\/\/)[^\s/@:]+:[^\s@]+@/g, '$1[REDACTED]@'],
  // JWTs
  [/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g, '[REDACTED_JWT]'],
  // Bearer tokens
  [/\b[Bb]earer\s+[\w~+/.=-]{8,}/g, 'Bearer [REDACTED]'],
  // insta_ platform tokens are insta_ + a ≥24-char Better Auth apiKey. The tail must stay ≥24:
  // MCP tool names (insta_feedback, insta_storage_download_url, …) share the prefix with tails
  // up to 20 chars, and they are exactly what feedback text quotes most.
  [/\binsta_[\w-]{24,}/g, '[REDACTED_KEY]'],
  // Common third-party key prefixes
  [/\b(?:uak_|sk_live_|sk_test_|whsec_|ghp_|github_pat_|npm_|AIza|xox[a-z]-)[\w-]{6,}/g, '[REDACTED_KEY]'],
  [/\bsk-[\w-]{16,}/g, '[REDACTED_KEY]'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED_KEY]'],
  // Generic assignments: password=..., api_key: "..."
  [/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*)["']?[^\s"'&,;]{4,}["']?/gi, '$1$2[REDACTED]'],
  // Emails
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[REDACTED_EMAIL]'],
  // Home directories carry the username (unix + windows)
  [/\/(?:Users|home)\/[\w.-]+/g, '~'],
  [/[A-Z]:[\\/]Users[\\/][\w.-]+/g, '~'],
]

// Public IPv4 only — private/loopback ranges are kept for their debug value.
// Known asymmetry with the IPv6/phone exemption above: a 4-part version or build string whose
// octets all fit 0–255 (e.g. "25.2.0.100") gets over-scrubbed. Accepted deliberately — dotted
// quads in error text are overwhelmingly real addresses, an over-scrub is recoverable noise,
// and an under-scrub is a leak; anchoring on surrounding context would trade that for misses.
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g

function isPrivateIp(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

export function redactSensitive(text: string): string {
  let out = text
  for (const [re, sub] of PATTERNS) out = out.replace(re, sub)
  out = out.replace(IPV4, (m, a, b, c, d) => {
    const [na, nb, nc, nd] = [Number(a), Number(b), Number(c), Number(d)]
    if (na > 255 || nb > 255 || nc > 255 || nd > 255) return m
    return isPrivateIp(na, nb) ? m : '[REDACTED_IP]'
  })
  return out
}

/** Middle truncation keeping 60% head + 40% tail — the start of an error names the failure, the
 *  end carries the actual cause; the middle is usually a stack. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = `…[${text.length - max} chars truncated]…`
  const head = Math.floor(max * 0.6)
  const tail = max - head
  return text.slice(0, head) + marker + text.slice(text.length - tail)
}

/** Redact BEFORE truncating: truncating first could leave half a token visible at the cut and the
 *  redaction pattern would no longer match it. */
export function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return truncateMiddle(redactSensitive(trimmed), max)
}
