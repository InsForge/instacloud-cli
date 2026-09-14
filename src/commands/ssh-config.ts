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
 *  being hand-edited, so neither is trusted input. */
export function isSafeConfigValue(v: unknown): v is string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && !/[\s\u0000-\u001f\u007f"']/.test(v)
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
      // Collapses scp, an IDE's several connections and a second terminal onto
      // ONE connection. Without it a single developer can reach the per-service
      // session cap in an afternoon without ever opening a second terminal.
      '  ControlMaster auto',
      '  ControlPath ~/.insta/ssh/cm-%r@%h:%p',
      '  ControlPersist 10m',
    )
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

/** The trust anchor line for known_hosts, tagged as ours. */
export function renderCertAuthority(hostPattern: string, caKey: string): string {
  return `@cert-authority ${hostPattern} ${caKey.trim()} ${CA_MARKER}\n`
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
