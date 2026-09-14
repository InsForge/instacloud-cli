// ssh_config and known_hosts editing. Pure string functions, deliberately: the
// traps here are all about WHERE text lands in a file the user also owns, and
// none of them is observable from a function that does its own I/O.

/** The fenced block this CLI owns. Everything between the markers is ours. */
export const BLOCK_BEGIN = '# BEGIN insta compute ssh'
export const BLOCK_END = '# END insta compute ssh'

/** Trailing marker on every known_hosts line we own, so rotation can replace
 *  our anchors without touching anchors the user added themselves. */
export const CA_MARKER = '# insta compute ssh'

/** The suffix that makes an alias ours: `api` -> `api.insta`. */
export const ALIAS_SUFFIX = '.insta'

// An alias is written verbatim into ssh_config AND into the argument of a
// shell-backed `Match exec` directive, so the set of legal characters has to be
// narrow enough that no quoting question can arise. This is the same charset
// SERVICE_NAME_RE allows in services.ts, plus the suffix.
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,38}\.insta$/

export function isSafeAlias(alias: string): boolean {
  return ALIAS_RE.test(alias)
}

/** A HostName/User value that cannot break out of its own directive.
 *
 *  ssh_config is line-oriented and whitespace-separated, so a value carrying a
 *  space silently becomes a directive plus arguments, and one carrying a
 *  newline becomes an ENTIRELY NEW directive under our `Host` stanza. These
 *  come from an API response and from a store the reader deliberately tolerates
 *  being hand-edited, so neither is trusted input.
 *
 *  A BACKSLASH is rejected for the same reason paths normalise it away:
 *  OpenSSH treats it as an escape introducer inside a config argument, so
 *  `HostName evil\.example` is not the host it appears to be. A value that is
 *  accepted here must survive to ssh as exactly one literal directive value. */
export function isSafeConfigValue(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && !/[\s\u0000-\u001f\u007f"'\\]/.test(v)
}

/** ssh_config's own quoting for a path.
 *
 *  Paths are the one field a user does not choose and cannot avoid: a home
 *  directory with a space in it -- ordinary on Windows and not rare on macOS --
 *  turns `IdentityFile /Users/First Last/.insta/...` into a directive with two
 *  arguments, and OpenSSH then rejects the WHOLE FILE. Every alias the user has
 *  stops working, not just ours.
 *
 *  A literal double quote is refused rather than escaped, because ssh_config
 *  has no escape for one inside a quoted argument -- there is no correct string
 *  to emit, so emitting nothing and saying why is the only honest answer.
 *
 *  BACKSLASHES are normalised to forward slashes, which is not cosmetic. A
 *  Windows path reaches us as `C:\Users\...`, and OpenSSH treats a backslash in
 *  a config argument as an escape introducer -- so `\U` is consumed and the
 *  path silently becomes a different one. Windows OpenSSH accepts forward
 *  slashes everywhere, so rewriting is both safe and the only unambiguous
 *  form. */
export function quoteConfigPath(path: string): string {
  if (path.includes('"')) throw new Error(`cannot write an ssh_config path containing a double quote: ${JSON.stringify(path)}`)
  if (/[\n\r]/.test(path)) throw new Error(`cannot write an ssh_config path containing a newline: ${JSON.stringify(path)}`)
  return `"${path.replace(/\\/g, '/')}"`
}

/**
 * The ssh alias for a compute service.
 *
 * Throws rather than sanitising: a silently rewritten alias would point `ssh
 * api.insta` at a stanza that is not the service the user named.
 */
export function aliasFor(serviceName: string): string {
  const alias = serviceName + ALIAS_SUFFIX
  if (!isSafeAlias(alias)) throw new Error(`cannot build an ssh alias for service name ${JSON.stringify(serviceName)}`)
  return alias
}

/** One service reachable as `ssh <alias>`. */
export type HostEntry = {
  /** Alias typed on the command line, e.g. `api.insta`. */
  alias: string
  /** Real host the alias resolves to, e.g. `ssh.us-west-1.compute.example`. */
  hostName: string
  /** Remote user the certificate is issued for. */
  user: string
  /** Absolute path to this alias's certificate. One per alias: a cert is issued
   *  for ONE service, so a shared cert file cannot serve two of them. */
  certificateFile: string
}

export type ConfigBlockOpts = {
  entries: HostEntry[]
  /** Absolute path to the private key whose certificates we mint. */
  identityFile: string
  /** Renewal-hook command PREFIX. The alias is appended here, by this function,
   *  after validation — see renderEnsureCertMatch. Omit to skip the hook. */
  ensureCertCommand?: string
  /** Defaults to the running platform. Injected so the Windows shape is
   *  testable from any host — the effective-config tests need a real `ssh` and
   *  skip on Windows, so nothing else would ever exercise that branch. */
  platform?: NodeJS.Platform
}

/**
 * The `Match` line that renews a certificate while OpenSSH parses the config.
 *
 * The alias is baked in as a literal and validated first; it is never `%h`.
 * OpenSSH expands its tokens BEFORE handing the string to the user's shell, and
 * ssh_config(5) warns that expansions used by shell-backed directives must be
 * safely handled — with `%h` a crafted hostname is shell syntax in our command.
 * A literal from ALIAS_RE cannot contain any.
 *
 * `originalhost`, not `host`: `host` matches AFTER HostName substitution, so it
 * would see the real hostname rather than the alias and never fire.
 */
export function renderEnsureCertMatch(alias: string, command: string): string {
  if (!isSafeAlias(alias)) throw new Error(`refusing to write an unsafe ssh alias into ssh_config: ${JSON.stringify(alias)}`)
  return `Match originalhost ${alias} exec "${command} ${alias}"`
}

export function renderConfigBlock(o: ConfigBlockOpts): string {
  const lines = [BLOCK_BEGIN]
  for (const e of o.entries) {
    if (!isSafeAlias(e.alias)) throw new Error(`refusing to write an unsafe ssh alias into ssh_config: ${JSON.stringify(e.alias)}`)
    // The alias was already checked; these two were not, and they reach this
    // file verbatim from an API response.
    if (!isSafeConfigValue(e.hostName)) throw new Error(`refusing to write an unsafe ssh HostName into ssh_config: ${JSON.stringify(e.hostName)}`)
    if (!isSafeConfigValue(e.user)) throw new Error(`refusing to write an unsafe ssh User into ssh_config: ${JSON.stringify(e.user)}`)
    lines.push(
      `Host ${e.alias}`,
      // Without HostName and User the alias is not routing at all: ssh resolves
      // `api.insta` in DNS and logs in as the local OS username.
      `  HostName ${e.hostName}`,
      `  User ${e.user}`,
      `  IdentityFile ${quoteConfigPath(o.identityFile)}`,
      `  CertificateFile ${quoteConfigPath(e.certificateFile)}`,
      // IdentitiesOnly is not tidiness. SSH offers public keys ONE AT A TIME,
      // so a user with several keys is identified non-deterministically -- the
      // server sees whichever key happened to be offered first, which may not be
      // the one carrying our certificate. exe.dev calls this heisen-connect.
      // Without this line a developer with a full ssh-agent gets intermittent,
      // unexplainable auth failures.
      '  IdentitiesOnly yes',
    )
    // Connection multiplexing collapses scp, an IDE's several connections and a
    // second terminal onto ONE connection; without it a single developer can
    // reach the per-service session cap in an afternoon.
    //
    // OMITTED ON WINDOWS, where it is not an optimisation but a broken config.
    // Win32-OpenSSH does not implement ControlMaster (PowerShell/Win32-OpenSSH
    // #1328, #405) and fails the connection rather than ignoring the directive,
    // and the ControlPath itself contains a `:` before %p, which is not a legal
    // character in a Windows filename. Every alias would be unusable on a
    // platform this repo runs CI for. The effective-config tests need a real
    // `ssh` and skip on Windows, so this branch is asserted on the rendered
    // text instead.
    if ((o.platform ?? process.platform) !== 'win32') {
      lines.push(
        '  ControlMaster auto',
        '  ControlPath ~/.insta/ssh/cm-%r@%h:%p',
        '  ControlPersist 10m',
      )
    }
    if (o.ensureCertCommand) {
      // Renewal happens while OpenSSH PARSES the config, before it connects, so
      // a certificate that expired since the last login is replaced silently
      // rather than surfacing as a refused login. Without it, "after setup it is
      // just ssh" stops being true the moment the first certificate expires.
      lines.push(renderEnsureCertMatch(e.alias, o.ensureCertCommand))
    }
  }
  // Closes our last stanza. Without it everything the user wrote at the top of
  // their own config -- which we insert ABOVE -- stops being unconditional and
  // silently becomes part of our final `Host`/`Match` block instead.
  lines.push('Match all', BLOCK_END)
  return lines.join('\n') + '\n'
}

/**
 * Insert or replace our block in an ssh_config.
 *
 * AT THE TOP, never appended, and this is the whole reason the function
 * exists. OpenSSH takes the FIRST obtained value for each keyword, and
 * ssh_config(5) says outright that host-specific declarations belong near the
 * beginning of the file. A block appended at the end loses every keyword to an
 * earlier `Host *` -- silently, with no error and no warning, producing a
 * connection that ignores the IdentityFile we just wrote.
 *
 * Idempotent: an existing block is replaced in place rather than duplicated.
 */
export function upsertConfigBlock(existing: string, block: string): string {
  // The old block is CUT from wherever it sits and the new one is PREPENDED --
  // it is never replaced where it stands. Replacing in place looks equivalent
  // and is not: a block that ended up below an earlier `Host *` (an older
  // version of this CLI appended it, or the user moved it) would keep that
  // offset forever, and first-wins means every keyword in it is ignored. The
  // symptom is the worst kind: ssh connects, silently using the wrong identity,
  // with no error to search for. Re-running --setup has to be able to FIX that
  // file, which means the position is part of what we upsert.
  // Leading blank lines are stripped from what remains: cutting the block out
  // of the top of a file leaves the separator behind, and re-prepending would
  // then add one MORE every run, growing the user's config forever.
  const rest = removeOwnedBlock(existing).replace(/^\n+/, '')
  if (rest.trim() === '') return block
  return block + '\n' + rest
}

/** `existing` with our fenced block cut out, wherever it was. */
function removeOwnedBlock(existing: string): string {
  const begin = existing.indexOf(BLOCK_BEGIN)
  if (begin === -1) return existing
  const end = existing.indexOf(BLOCK_END, begin)
  // A begin marker with no end is a file someone edited by hand. Leave it
  // alone rather than guessing where our block stopped; the fresh block goes
  // on top, and first-wins means it takes effect either way.
  if (end === -1) return existing
  const after = end + BLOCK_END.length
  // Swallow the newline that followed the end marker, so repeated runs do not
  // accumulate blank lines.
  return existing.slice(0, begin) + existing.slice(after).replace(/^\n/, '')
}

/** A hostname we are willing to derive a trust anchor from.
 *
 *  Stricter than isSafeConfigValue, and for a different file: known_hosts is
 *  newline-delimited with no fencing, so an unvalidated value does not corrupt
 *  ONE line, it appends whatever it likes -- including a broader
 *  `@cert-authority *` that would make the attacker's CA trusted for every host
 *  the user ever ssh's to. This value arrives in an HTTP response body, so it
 *  is checked before it reaches the file, not after. */
const SSH_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

export function isSafeSSHHost(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && SSH_HOSTNAME_RE.test(v)
}

/** Exactly ONE OpenSSH public-key record: `<type> <base64>` with an optional
 *  comment, and nothing else -- no second line, no leading directive.
 *
 *  `renderCertAuthority` only trimmed, so an embedded newline in the CA value
 *  smuggled additional known_hosts lines past it. Parsing to the three fields
 *  we will actually write, and rebuilding the line from THOSE, means a value
 *  either is one key record or is refused; there is no third outcome where
 *  part of it is honoured. */
const CA_KEY_TYPES = new Set([
  'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
])

export function parseCAPublicKey(value: unknown): { type: string; blob: string } {
  if (typeof value !== 'string') throw new Error('the platform returned no ssh certificate authority key')
  const line = value.trim()
  if (/[\n\r]/.test(line)) throw new Error('refusing a certificate authority key spanning multiple lines')
  const parts = line.split(/[ \t]+/)
  if (parts.length < 2) throw new Error(`refusing a malformed certificate authority key: ${JSON.stringify(line.slice(0, 64))}`)
  const type = parts[0]!, blob = parts[1]!
  if (!CA_KEY_TYPES.has(type)) throw new Error(`refusing a certificate authority key of unsupported type ${JSON.stringify(type.slice(0, 32))}`)
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(blob) || blob.length < 32) {
    throw new Error('refusing a certificate authority key whose body is not base64')
  }
  // The blob's OWN type must agree with the text field. Base64-shaped is not
  // the same as "is a key": an anchor built from a mislabelled or arbitrary
  // blob installs silently and then fails at connect time, where the message
  // points at known_hosts rather than at the response that produced it.
  // The WHOLE blob, not just its first field. A first-field check rejects
  // arbitrary base64 and still accepts a correct type name followed by noise --
  // and an anchor built from that installs silently, then fails at connect
  // time, where the message points at known_hosts rather than at the response
  // that produced it.
  const fields = sshBlobFields(blob)
  if (!fields || fields.length < 2 || fields[0]!.toString('utf8') !== type) {
    throw new Error(`refusing a certificate authority key whose body does not match its type ${JSON.stringify(type.slice(0, 32))}`)
  }
  // ed25519 is the one we issue, and its key field has exactly one legal size.
  if (type === 'ssh-ed25519' && (fields.length !== 2 || fields[1]!.length !== 32)) {
    throw new Error('refusing an ed25519 certificate authority key whose body is not a 32-byte key')
  }
  return { type, blob }
}

/** Exactly ONE OpenSSH CERTIFICATE record.
 *
 *  A certificate is not a key: it is `<keytype>-cert-v01@openssh.com <base64>`.
 *  Accepting any non-empty string meant a response of `"new-cert"` replaced a
 *  working alias's live credential and only failed later, inside OpenSSH, with
 *  a message pointing at the file rather than at the plane that sent it.
 *
 *  Checked structurally rather than by shelling out to `ssh-keygen -L`: this
 *  runs on the renewal path OpenSSH invokes while parsing its config, and
 *  adding a subprocess there trades one hazard for a slower one. The structure
 *  is what decides whether the file can be parsed at all, which is the property
 *  worth having before overwriting a working credential. */
const CERT_TYPE_RE = /^[a-z0-9@.-]+-cert-v01@openssh\.com$/i

export function isSSHCertificateRecord(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const line = v.trim()
  if (line === '' || /[\n\r]/.test(line)) return false
  const parts = line.split(/[ \t]+/)
  if (parts.length < 2) return false
  const type = parts[0]!, blob = parts[1]!
  if (!CERT_TYPE_RE.test(type)) return false
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(blob) || blob.length < 64) return false
  // DECODED, not just shape-checked. `<valid type> AAAA...` of the right length
  // is trivially constructible and passed every textual test while still being
  // unusable -- and the cost of accepting it is that a working alias's live
  // credential has already been replaced by the time ssh says so.
  //
  // An OpenSSH certificate blob begins with an SSH `string`: a 4-byte
  // big-endian length followed by that many bytes, holding the certificate's
  // own type name. It must agree with the type in the text field; a blob that
  // does not even carry a well-formed first field is not a certificate at all.
  // Decoding it here keeps the check dependency-free and off the subprocess
  // path, which matters because this runs during OpenSSH's own config parse.
  return sshBlobTypeName(blob) === type
}

/** The type name an SSH key/certificate blob declares about ITSELF.
 *
 *  Every OpenSSH blob begins with an SSH `string`: a 4-byte big-endian length
 *  followed by that many bytes, holding the algorithm name. Reading it is what
 *  separates "base64 of the right length" -- which anyone can construct -- from
 *  a blob that is at least the kind of thing it claims to be. Returns undefined
 *  when the blob does not even carry a well-formed first field. */
export function sshBlobTypeName(blob: string): string | undefined {
  const fields = sshBlobFields(blob, 1)
  return fields?.[0]?.toString('utf8')
}

/** Every SSH `string` field in a blob, or undefined if it is not well-formed.
 *
 *  The wire format is a sequence of 4-byte big-endian lengths each followed by
 *  that many bytes. Requiring the walk to land EXACTLY on the end is what makes
 *  this a structural check rather than a prefix check: trailing noise, a length
 *  that overruns the buffer, and a truncated final field are all rejected.
 *
 *  `limit` stops after that many fields, for callers that only need the head. */
export function sshBlobFields(blob: string, limit = Infinity): Buffer[] | undefined {
  let raw: Buffer
  try {
    raw = Buffer.from(blob, 'base64')
  } catch {
    return undefined
  }
  const out: Buffer[] = []
  let at = 0
  while (at < raw.length && out.length < limit) {
    if (raw.length - at < 4) return undefined
    const len = raw.readUInt32BE(at)
    // Bounds-checked BEFORE being used as an offset, and capped so a hostile
    // length cannot drive a huge allocation.
    if (len > 65_536 || raw.length - at - 4 < len) return undefined
    out.push(raw.subarray(at + 4, at + 4 + len))
    at += 4 + len
  }
  if (out.length === 0) return undefined
  // No trailing-bytes check here on purpose: `at` only ever advances by a whole
  // consumed field, and the two guards inside the loop reject every partial
  // tail, so on a full walk the loop can only exit with at === raw.length. A
  // final `at === raw.length ? ... : undefined` reads like a safety net and is
  // a condition that can never be false -- worse than no check, because the
  // next reader trusts it.
  return out
}

/** An SSH principal safe to place in a command line.
 *
 *  Chiefly: NEVER a leading `-`. Shell quoting does not help here, because the
 *  hazard is not the shell -- `ssh` parses its own argv, so a destination of
 *  `-oProxyCommand=id` is read as an OPTION however carefully it was quoted,
 *  and the user pasting the advertised command runs it. */
export function isSafeSSHUsername(v: unknown): v is string {
  return isSafeConfigValue(v) && /^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(v) && v.length <= 64
}

/** A timestamp we are willing to print to a terminal. Rejects the control
 *  characters and escape sequences that would let a response repaint the
 *  screen or hide what it actually said. */
export function isSafeTimestamp(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64
    && !/[\u0000-\u001f\u007f]/.test(v) && !Number.isNaN(Date.parse(v))
}

/** The trust anchor line for known_hosts, tagged as ours. */
export function renderCertAuthority(hostPattern: string, caKey: string): string {
  // Rebuilt from the PARSED fields rather than interpolating what we were
  // handed: that is what makes "exactly one key record" a property of the
  // output instead of a hope about the input.
  const { type, blob } = parseCAPublicKey(caKey)
  if (!isSafeCAHostPattern(hostPattern)) {
    throw new Error(`refusing a certificate authority host pattern: ${JSON.stringify(String(hostPattern).slice(0, 64))}`)
  }
  return `@cert-authority ${hostPattern} ${type} ${blob} ${CA_MARKER}\n`
}

/** A host pattern narrow enough to anchor a CA to.
 *
 *  A `@cert-authority` line tells ssh "this CA may vouch for any host matching
 *  this pattern", so the pattern is the blast radius. Three rules, and the
 *  third is the one that matters:
 *
 *   1. No bare `*`, and at most one wildcard label -- `@cert-authority *` makes
 *      the platform's CA authoritative for github.com and everything else.
 *   2. The wildcard is never the FIRST label: `*.com` is the same hole.
 *   3. At least TWO fixed labels must follow the wildcard. This is what keeps
 *      the pattern inside a domain the gateway actually occupies. Counting
 *      total labels is not enough: `ssh.*.com` has three labels and is a
 *      catastrophe -- it makes the CA authoritative for ssh.vendor.com,
 *      ssh.google.com and every other `ssh.<anything>.com`. Requiring two
 *      labels after the wildcard means the wildcard can only ever range over a
 *      sub-label of a specific registered domain.
 *
 *  A pattern with NO wildcard is an exact host and needs only to be a hostname. */
/** Gateway domains whose region label may be collapsed to a wildcard.
 *
 *  An allowlist, because the alternative is guessing where the registrable
 *  domain ends, and that guess has no safe default. Requiring two labels after
 *  the wildcard is NOT enough: `ssh.*.co.uk` has two and still ranges across
 *  every co.uk registrant, because `co.uk` is a public suffix rather than
 *  somebody's domain. Distinguishing those needs the public-suffix list, which
 *  is a dependency and a moving target.
 *
 *  So we widen only under suffixes we know we own, and every other deployment
 *  -- self-hosted, staging, a name we have not seen -- gets an EXACT anchor per
 *  region. That costs one known_hosts line per region and is never wrong, which
 *  is the right side to err on for a trust anchor. */
export const CA_WIDENABLE_SUFFIXES = [
  'compute.instacloud.tech',
  'compute.insforge.dev',
] as const

/** Whether `host`'s region label may be replaced by a wildcard.
 *
 *  `suffixes` is a parameter so the RULE can be tested apart from the LIST:
 *  the list is deployment configuration that will change, the rule is the
 *  security property and must not. */
export function mayWidenCAHost(host: string, suffixes: readonly string[] = CA_WIDENABLE_SUFFIXES): boolean {
  const under = suffixes.find((suffix) => host.endsWith(`.${suffix}`))
  if (!under) return false
  // The shape the wildcard assumes -- <gateway>.<region>.<suffix> -- so the
  // label being widened is genuinely the region and not part of the suffix.
  const head = host.slice(0, host.length - under.length - 1).split('.')
  if (head.length !== 2) return false
  // And the first label must be the SSH GATEWAY, which is the scope this
  // anchor was always meant to have. Tenant service hostnames live under the
  // same suffix, so widening `api.us-west-1.<suffix>` to `api.*.<suffix>`
  // would let the CA vouch for an unrelated platform host that merely shares
  // the shape -- the exact over-scoping the wildcard was introduced to avoid.
  return head[0] === SSH_GATEWAY_LABEL
}

/** The first label of every SSH gateway name, and the only first label a
 *  wildcard anchor may carry. */
export const SSH_GATEWAY_LABEL = 'ssh'

export function isSafeCAHostPattern(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 253) return false
  const labels = v.split('.')
  if (labels.length < 2) return false
  if (!labels.every((l) => l === '*' || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(l))) return false
  const star = labels.indexOf('*')
  if (star === -1) return true
  if (labels.filter((l) => l === '*').length > 1) return false
  if (star === 0) return false
  return labels.length - star - 1 >= 2
}

/**
 * Install the trust anchor in known_hosts, replacing the one we installed before.
 *
 * Appended rather than inserted, unlike the config block: known_hosts has no
 * first-wins rule -- every line is considered -- so position carries no meaning
 * here.
 *
 * Rotation policy: we own at most ONE anchor per host pattern. A line of OURS
 * (it carries CA_MARKER) is dropped when it covers the same host pattern -- so
 * a rotated CA replaces the retired one instead of leaving it trusted forever
 * -- or when it carries the same key, so a changed host pattern moves the
 * anchor rather than duplicating it. Anchors the user added themselves have no
 * marker and are never touched.
 */
export function upsertCertAuthority(existing: string, hostPattern: string, caKey: string): string {
  const key = caKey.trim()
  const kept = existing
    .split('\n')
    .filter((l) => !isSupersededAnchor(l, hostPattern, key))
    .join('\n')
  const base = kept === '' ? '' : kept.endsWith('\n') ? kept : kept + '\n'
  return base + renderCertAuthority(hostPattern, key)
}

function isSupersededAnchor(line: string, hostPattern: string, key: string): boolean {
  if (!line.startsWith('@cert-authority') || !line.includes(CA_MARKER)) return false
  // Compared FIELD BY FIELD, never with `includes`. A base64 key is an
  // unanchored substring of any longer key sharing its prefix, so a substring
  // test would delete a DIFFERENT region's anchor that happened to extend ours
  // -- and a deleted anchor is not a visible failure, it is a host-key prompt
  // on every connection to a region that used to be trusted.
  const [, pattern, keyType, keyBlob] = line.split(/\s+/)
  const [wantType, wantBlob] = key.split(/\s+/)
  return pattern === hostPattern || (keyType === wantType && keyBlob === wantBlob)
}
