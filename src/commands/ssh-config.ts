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
 *  form.
 *
 *  QUOTING DOES NOT MAKE A PATH LITERAL. OpenSSH expands tokens inside the
 *  quotes for IdentityFile and CertificateFile, on the connect path rather than
 *  at parse time -- which is why `ssh -G` shows nothing wrong. So a `%` in an
 *  ordinary home directory is not a character, it is syntax: `/home/dev%team`
 *  makes ssh abort the whole connection on an unknown token, and `/home/%d/...`
 *  quietly resolves to somewhere else entirely. `%%` is the escape, and it is
 *  applied to the path we were handed -- never to the ControlPath tokens, which
 *  we write ourselves and do not route through here.
 *
 *  `${...}` gets no such treatment because ssh_config has no escape for it:
 *  a defined variable rewrites the filename and an undefined one aborts, and
 *  there is no third spelling that means "a dollar sign followed by a brace".
 *  Refusing is the only honest answer, as with the double quote above. A lone
 *  `$` is not expansion syntax and stays a filename. */
export function quoteConfigPath(path: string): string {
  if (path.includes('"')) throw new Error(`cannot write an ssh_config path containing a double quote: ${JSON.stringify(path)}`)
  if (/[\n\r]/.test(path)) throw new Error(`cannot write an ssh_config path containing a newline: ${JSON.stringify(path)}`)
  if (path.includes('${')) throw new Error(`cannot write an ssh_config path containing an environment-variable expansion: ${JSON.stringify(path)}`)
  return `"${path.replace(/\\/g, '/').replace(/%/g, '%%')}"`
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
  /** The gateway's public port. WRITTEN, never left to ssh's default of 22:
   *  the lane listens on :2222 (:22 waits for a compliance exception), and an
   *  alias without a Port line dialled a closed port with a valid certificate. */
  port: number
  /** Absolute path to this alias's certificate. One per alias: a cert is issued
   *  for ONE service, so a shared cert file cannot serve two of them. */
  certificateFile: string
}

export type ConfigBlockOpts = {
  entries: HostEntry[]
  /** Absolute path to the private key whose certificates we mint. */
  identityFile: string
  /** Absolute path to the known_hosts file the trust anchor is installed in.
   *
   *  REQUIRED rather than defaulted, because the whole point is that this is the
   *  file installCertAuthority actually wrote to — a default here would be a
   *  second opinion about that, and the two disagreeing is the failure this
   *  closes. See the UserKnownHostsFile line in renderConfigBlock. */
  knownHostsFile: string
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
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error(`refusing to write an unusable ssh Port into ssh_config: ${JSON.stringify(e.port)}`)
    lines.push(
      `Host ${e.alias}`,
      // Without HostName and User the alias is not routing at all: ssh resolves
      // `api.insta` in DNS and logs in as the local OS username.
      `  HostName ${e.hostName}`,
      `  User ${e.user}`,
      `  Port ${e.port}`,
      `  IdentityFile ${quoteConfigPath(o.identityFile)}`,
      `  CertificateFile ${quoteConfigPath(e.certificateFile)}`,
      // WRITTEN, not left to the default, and this is the one keyword where
      // being first in the file does not save us. First-wins settles a keyword
      // two blocks both set; a keyword we never set at all goes on being filled
      // in by later matching blocks. So a `Host *` further down carrying
      // `UserKnownHostsFile none` -- ordinary in a hardened config -- or a
      // custom path takes effect for OUR alias, and the CA that setup installed
      // in known_hosts is then never consulted. The user gets a host-key prompt
      // or a flat refusal on the one connection they were told needs no
      // host-key management.
      //
      // Naming one file deliberately drops OpenSSH's second default,
      // ~/.ssh/known_hosts2 -- a v1-era legacy path we never write to. Pinning
      // the file the anchor is really in is the property; inheriting a list we
      // do not control is what we are getting away from.
      `  UserKnownHostsFile ${quoteConfigPath(o.knownHostsFile)}`,
      // IdentitiesOnly is not tidiness. SSH offers public keys ONE AT A TIME,
      // so a user with several keys is identified non-deterministically -- the
      // server sees whichever key happened to be offered first, which may not be
      // the one carrying our certificate. Without this line a developer with a
      // full ssh-agent gets intermittent, unexplainable auth failures.
      '  IdentitiesOnly yes',
    )
    // Connection multiplexing collapses scp, an IDE's several connections and a
    // second terminal onto ONE connection; without it a single developer can
    // reach the per-service session cap in an afternoon.
    //
    // The socket is keyed on %C -- a hash of (local host, remote host, port,
    // user) -- not %r@%h:%p. A ControlPath is a Unix-domain socket, whose path
    // is capped at 104 bytes on macOS (108 on Linux), and the route-key user
    // plus the regional gateway hostname exceed that on a real prod alias.
    // %C is a fixed 40 hex chars however long the host and user grow, so the
    // path cannot overflow, and it carries no `:`.
    //
    // OMITTED ON WINDOWS, where it is not an optimisation but a broken config:
    // Win32-OpenSSH does not implement ControlMaster (PowerShell/Win32-OpenSSH
    // #1328, #405) and FAILS the connection rather than ignoring the directive,
    // so every alias would be unusable on a platform this repo runs CI for. The
    // effective-config tests need a real `ssh` and skip on Windows, so this
    // branch is asserted on the rendered text instead.
    if ((o.platform ?? process.platform) !== 'win32') {
      lines.push(
        '  ControlMaster auto',
        '  ControlPath ~/.insta/ssh/cm-%C',
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

/** Is our block live in this ssh_config?
 *
 *  The block is rendered from the WHOLE alias store and replaced wholesale, so
 *  its presence is what makes the store the thing `ssh <alias>` actually reads.
 *  That is the signal a plain (non-`--setup`) issuance needs: once the block is
 *  there, changing the store without re-rendering it leaves the two disagreeing
 *  about where an alias points. The BEGIN marker alone is enough -- a file
 *  edited down to half a block is still a file we own a block in. */
export function hasOwnedBlock(existing: string): boolean {
  return existing.split('\n').some(isMarkerLine(BLOCK_BEGIN))
}

/** Whether nothing that OpenSSH would read precedes the owned block. OpenSSH
 *  takes the FIRST obtained value for each keyword, so a `Host *` stanza -- or a
 *  bare global `Port 22` -- above our block silently overrides the block's
 *  Port, HostName, User and credential; that is why upsertConfigBlock writes
 *  the block at the top. Comments and blank lines above it are harmless and do
 *  not count. false when there is no owned block at all. */
export function ownedBlockIsFirst(existing: string): boolean {
  const lines = existing.split('\n')
  const begin = lines.findIndex(isMarkerLine(BLOCK_BEGIN))
  if (begin === -1) return false
  return lines.slice(0, begin).every((l) => /^\s*(#.*)?$/.test(l))
}

/** The installed owned block, BEGIN through END marker inclusive, exactly as it
 *  sits in the file; undefined when there is none (or an unterminated one). It
 *  exists so a writer can compare what IS installed with what it WOULD render
 *  and touch the file only when the two differ -- a stanza written before a
 *  keyword existed (the Port line) is the case, and "nothing changed in the
 *  response" is not the same question as "nothing would change in the file". */
export function ownedBlock(existing: string): string | undefined {
  const lines = existing.split('\n')
  const begin = lines.findIndex(isMarkerLine(BLOCK_BEGIN))
  if (begin === -1) return undefined
  const end = lines.findIndex((l, n) => n > begin && isMarkerLine(BLOCK_END)(l))
  if (end === -1) return undefined
  return lines.slice(begin, end + 1).join('\n')
}

/** A marker is a WHOLE LINE, never a substring of one.
 *
 *  Matching the marker text wherever it occurred made a user's comment that
 *  merely mentioned it -- documentation of this very block, one line above
 *  it -- the start of "our" block: everything from the middle of that line to
 *  the real end marker was cut, the user's stanzas in between included. The
 *  same substring made a plain issuance believe a block was installed. A line
 *  that IS the marker is ours; a line that contains it is theirs. */
const isMarkerLine = (marker: string) => (line: string) => line.trim() === marker

/** `existing` with our fenced block cut out, wherever it was -- every
 *  well-formed one, so a file that somehow holds two comes back with one. */
function removeOwnedBlock(existing: string): string {
  const lines = existing.split('\n')
  const isBegin = isMarkerLine(BLOCK_BEGIN), isEnd = isMarkerLine(BLOCK_END)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isBegin(lines[i]!)) {
      const end = lines.findIndex((l, n) => n > i && isEnd(l))
      // The end marker's own line goes with the block, newline included, so
      // repeated runs do not accumulate blank lines.
      if (end !== -1) { i = end; continue }
      // A begin marker with no end is a file someone edited by hand. Leave it
      // -- and everything after it -- alone rather than guessing where our
      // block stopped; the fresh block goes on top, and first-wins means it
      // takes effect either way.
      out.push(...lines.slice(i))
      break
    }
    out.push(lines[i]!)
  }
  return out.join('\n')
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

/** The wire shape of each supported key type's public blob, after the type
 *  name that opens every blob. Walking the fields proves the blob is a
 *  sequence of well-formed fields; it does not prove they are the fields of
 *  the type on the label, and a correct type name followed by the wrong
 *  number of fields, a curve that disagrees with the name or a point of the
 *  wrong size installs an anchor ssh then refuses at connect time -- where the
 *  message points at known_hosts rather than at the response that produced it.
 *  ed25519 is the type we issue; the rest are what OpenSSH accepts as a CA,
 *  each held to what its own format requires:
 *
 *   - ssh-ed25519: one 32-byte key.
 *   - ssh-rsa: mpint e, mpint n; OpenSSH refuses a modulus under 1024 bits.
 *   - ecdsa-sha2-nistpN: the curve name, which must be the one in the type,
 *     then an uncompressed point (0x04, then two coordinates of the curve's
 *     size).
 *   - sk-*@openssh.com (FIDO): the same key material as the plain type, then
 *     the application string.
 *
 *  Field lengths, not field contents: the check is that the blob has the
 *  structure ssh will parse, not that it is a strong key. */
//
//  A Map, not an object: the type is a string from an HTTP response, and on a
//  plain object `shapes['constructor']` is Object -- a function, which called
//  on the fields returns them, truthy -- so a key typed `constructor` passed as
//  supported. A Map has no inherited entries to find.
const CA_KEY_SHAPES = new Map<string, (fields: Buffer[]) => boolean>([
  ['ssh-ed25519', (f) => f.length === 2 && f[1]!.length === 32],
  ['ssh-rsa', (f) => f.length === 3 && f[1]!.length > 0 && f[2]!.length >= 128],
  ['ecdsa-sha2-nistp256', (f) => f.length === 3 && isEcdsaBody(f[1]!, f[2]!, 'nistp256', 65)],
  ['ecdsa-sha2-nistp384', (f) => f.length === 3 && isEcdsaBody(f[1]!, f[2]!, 'nistp384', 97)],
  ['ecdsa-sha2-nistp521', (f) => f.length === 3 && isEcdsaBody(f[1]!, f[2]!, 'nistp521', 133)],
  ['sk-ssh-ed25519@openssh.com', (f) => f.length === 3 && f[1]!.length === 32 && f[2]!.length > 0],
  ['sk-ecdsa-sha2-nistp256@openssh.com', (f) => f.length === 4 && isEcdsaBody(f[1]!, f[2]!, 'nistp256', 65) && f[3]!.length > 0],
])

function isEcdsaBody(curve: Buffer, point: Buffer, wantCurve: string, pointLen: number): boolean {
  return curve.toString('utf8') === wantCurve && point.length === pointLen && point[0] === 0x04
}

/** Exactly ONE OpenSSH public-key record: `<type> <base64>` with an optional
 *  comment, and nothing else -- no second line, no leading directive.
 *
 *  Parsing to the three fields we will actually write, and rebuilding the line
 *  from THOSE, means a value either is one key record or is refused; there is
 *  no third outcome where part of it is honoured (an embedded newline would
 *  otherwise smuggle additional known_hosts lines through). */
export function parseCAPublicKey(value: unknown): { type: string; blob: string } {
  if (typeof value !== 'string') throw new Error('the platform returned no ssh certificate authority key')
  const line = value.trim()
  if (/[\n\r]/.test(line)) throw new Error('refusing a certificate authority key spanning multiple lines')
  const parts = line.split(/[ \t]+/)
  if (parts.length < 2) throw new Error(`refusing a malformed certificate authority key: ${JSON.stringify(line.slice(0, 64))}`)
  const type = parts[0]!, blob = parts[1]!
  const shape = CA_KEY_SHAPES.get(type)
  if (!shape) throw new Error(`refusing a certificate authority key of unsupported type ${JSON.stringify(type.slice(0, 32))}`)
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(blob) || blob.length < 32) {
    throw new Error('refusing a certificate authority key whose body is not base64')
  }
  // The blob's OWN type must agree with the text field, and the WHOLE blob is
  // checked, not just its first field: a first-field check rejects arbitrary
  // base64 and still accepts a correct type name followed by noise -- and an
  // anchor built from that installs silently, then fails at connect time,
  // where the message points at known_hosts rather than at the response that
  // produced it.
  const fields = sshBlobFields(blob)
  if (!fields || fields.length < 2 || fields[0]!.toString('utf8') !== type) {
    throw new Error(`refusing a certificate authority key whose body does not match its type ${JSON.stringify(type.slice(0, 32))}`)
  }
  // And the fields must be the ones THIS type has (see CA_KEY_SHAPES): a
  // correct RSA or ECDSA type name followed by any well-formed fields must not pass.
  if (!shape(fields)) {
    throw new Error(`refusing a certificate authority key whose body is not the shape of ${JSON.stringify(type.slice(0, 32))}`)
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

/** The ed25519 certificate type, and the only one we ever ask to be issued:
 *  ensureKeyPair generates ed25519 and nothing else, so a certificate of any
 *  other type cannot be a certificate for our key. */
const ED25519_CERT_TYPE = 'ssh-ed25519-cert-v01@openssh.com'
const ED25519_KEY_TYPE = 'ssh-ed25519'

/**
 * Whether `certRecord` certifies exactly the key in `publicKeyRecord`.
 *
 * `ssh-keygen -L` proves a response is a parseable certificate; it does not
 * prove it is OURS. A valid certificate for somebody else's key passes every
 * other gate, replaces the working credential at `<alias>-cert.pub`, and then
 * fails at authentication time -- where the message points at the file rather
 * than at the response that produced it. Comparing the certified key material
 * against ~/.insta/ssh/id_ed25519.pub is what closes that.
 *
 * Compared as KEY MATERIAL rather than as an ssh-keygen fingerprint: `-L`
 * prints the fingerprint of the certificate blob, not of the key inside it, so
 * there is nothing there to compare against a plain public key.
 *
 * An OpenSSH ed25519 certificate is `string type, string nonce, string pk, ...`
 * and a plain ed25519 key is `string type, string pk`, so the comparison is
 * field 2 against field 1. Only the first three fields are walked, because the
 * uint64 serial that follows is not an SSH `string` and a full walk would
 * misparse it.
 */
export function certifiesPublicKey(certRecord: unknown, publicKeyRecord: unknown): boolean {
  if (typeof certRecord !== 'string' || typeof publicKeyRecord !== 'string') return false
  const cert = certRecord.trim().split(/[ \t]+/)
  const pub = publicKeyRecord.trim().split(/[ \t]+/)
  if (cert[0] !== ED25519_CERT_TYPE || pub[0] !== ED25519_KEY_TYPE) return false
  if (cert.length < 2 || pub.length < 2) return false
  const certFields = sshBlobFields(cert[1]!, 3)
  const pubFields = sshBlobFields(pub[1]!)
  if (!certFields || certFields.length !== 3 || !pubFields || pubFields.length !== 2) return false
  // The blobs' OWN type names, for the same reason parseCAPublicKey reads them:
  // the text field is a label anyone can write.
  if (certFields[0]!.toString('utf8') !== cert[0] || pubFields[0]!.toString('utf8') !== pub[0]) return false
  const certified = certFields[2]!, key = pubFields[1]!
  return key.length === 32 && certified.equals(key)
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
 * -- or when it carries the same key AND the two patterns cover the same hosts,
 * so a pattern that merely widened or narrowed moves the anchor rather than
 * duplicating it. Anchors the user added themselves have no marker and are
 * never touched.
 */
export function upsertCertAuthority(existing: string, hostPattern: string, caKey: string): string {
  return planCertAuthority(existing, hostPattern, caKey).next
}

/**
 * What an anchor install would write, and what it would retire to do it.
 *
 * Split out from upsertCertAuthority because a rotation is only half of a
 * larger change -- the certificate signed by the new CA still has to be
 * committed -- and the second half can fail. Retiring the old anchor is the
 * step that BREAKS an alias which worked a moment ago: the old certificate is
 * still installed and the CA that vouches for it is gone. So the caller is
 * handed the retired lines and can put them back; see revertCertAuthority.
 */
export function planCertAuthority(existing: string, hostPattern: string, caKey: string): CertAuthorityPlan {
  const key = caKey.trim()
  const lines = existing.split('\n')
  const removed: string[] = [], removedAt: number[] = []
  lines.forEach((l, i) => {
    if (isSupersededAnchor(l, hostPattern, key)) { removed.push(l); removedAt.push(i) }
  })
  const kept = lines.filter((l) => !isSupersededAnchor(l, hostPattern, key)).join('\n')
  const base = kept === '' ? '' : kept.endsWith('\n') ? kept : kept + '\n'
  const line = renderCertAuthority(hostPattern, key)
  return { next: base + line, line: line.trimEnd(), removed, removedAt }
}

export type CertAuthorityPlan = {
  next: string
  /** The anchor line the plan installs, without its newline. */
  line: string
  /** The anchor lines it retires to make room, verbatim. */
  removed: string[]
  /** Where each retired line sat in the file, so the undo can put it back
   *  THERE rather than at the end -- a rollback that reorders the user's
   *  entries around ours has not restored the file. */
  removedAt: number[]
}

/**
 * Undo a plan against known_hosts AS IT STANDS NOW, not by restoring a snapshot.
 *
 * `ssh` appends host keys to this file without taking any lock and cannot be
 * made to take one, so writing back the bytes we read would discard whatever
 * landed in between. Removing exactly the line we added and putting back
 * exactly the lines we retired touches nothing else.
 */
export function revertCertAuthority(current: string, plan: CertAuthorityPlan): string {
  const kept = current.split('\n').filter((l) => l.trimEnd() !== plan.line)
  // Only the ONE trailing blank the split leaves behind a final newline. A
  // blank line before that is the user's -- trailing blanks included.
  if (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  // Only the anchors that are genuinely gone: a concurrent install may already
  // have re-added one, and a duplicate anchor is not a failure mode. Each goes
  // back at the index it was retired from, in ascending order, so a file
  // nothing else touched comes back byte for byte -- and a file `ssh` appended
  // to meanwhile comes back with the user's lines in their original order and
  // the new ones after. The index is clamped, because the file may be shorter
  // than it was.
  plan.removed.forEach((l, i) => {
    if (kept.some((k) => k.trimEnd() === l.trimEnd())) return
    kept.splice(Math.min(plan.removedAt[i] ?? kept.length, kept.length), 0, l)
  })
  return kept.length === 0 ? '' : kept.join('\n') + '\n'
}

/** A known_hosts line this CLI wrote: `@cert-authority <pattern> <type> <blob>`
 *  followed by CA_MARKER as the WHOLE comment. The marker is matched as the
 *  exact trailing fields, not as a substring: a user's own anchor whose
 *  comment happens to mention us is theirs, and rotation must not retire it. */
export function isOurAnchor(line: string): boolean {
  const f = line.trim().split(/\s+/)
  return f[0] === '@cert-authority' && f.length === 4 + CA_MARKER_FIELDS && f.slice(4).join(' ') === CA_MARKER
}
const CA_MARKER_FIELDS = CA_MARKER.split(' ').length

function isSupersededAnchor(line: string, hostPattern: string, key: string): boolean {
  if (!isOurAnchor(line)) return false
  // Compared FIELD BY FIELD, never with `includes`. A base64 key is an
  // unanchored substring of any longer key sharing its prefix, so a substring
  // test would delete a DIFFERENT region's anchor that happened to extend ours
  // -- and a deleted anchor is not a visible failure, it is a host-key prompt
  // on every connection to a region that used to be trusted.
  const [, pattern = '', keyType, keyBlob] = line.trim().split(/\s+/)
  // Rotation: the platform issued a new CA for a pattern we already anchor.
  if (pattern === hostPattern) return true
  const [wantType, wantBlob] = key.split(/\s+/)
  if (keyType !== wantType || keyBlob !== wantBlob) return false
  // Same key, DIFFERENT pattern, and which of the two things that is decides
  // whether the old line may go. One CA signs every region, so "same key" alone
  // proves nothing: outside CA_WIDENABLE_SUFFIXES each region gets its own exact
  // anchor, and CA_WIDENABLE_SUFFIXES itself holds two gateway domains. Treating
  // every same-key line as the old position of THIS anchor deleted an anchor
  // another alias still depends on -- again a silent host-key prompt.
  //
  // What separates the two is containment. hostPatternFor derives the pattern
  // from the host, so the only pattern change a single anchor can make on its
  // own is over the region label: widening when the suffix becomes widenable,
  // narrowing when it stops being. Either way one pattern covers the other, and
  // dropping the covered line loses no trust the new line does not restore.
  // Patterns that cover nothing of each other are different deployments, and
  // both are kept.
  return caPatternCovers(hostPattern, pattern) || caPatternCovers(pattern, hostPattern)
}

/** Whether every host matching `inner` also matches `outer`.
 *
 *  Both patterns come from hostPatternFor, so each is either an exact hostname
 *  or a single `*` standing for one label -- which makes containment a
 *  label-by-label comparison rather than a question about pattern algebra. */
function caPatternCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true
  const o = outer.split('.'), i = inner.split('.')
  // `*` never spans a dot in a known_hosts pattern, so a wider pattern has
  // exactly as many labels as what it covers.
  if (o.length !== i.length) return false
  const star = o.indexOf('*')
  if (star === -1) return false
  return o.every((label, n) => n === star || label === i[n])
}
