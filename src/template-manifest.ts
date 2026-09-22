// Local insta.template.yaml parsing + validation for `insta template deploy ./dir` — the CLI
// twin of the platform's src/provisioning/templateManifest.ts (THE authority; the executor
// revalidates every manifest). Local checks exist to fail fast with a file the author can act
// on, before anything travels, so the rules here mirror the server's exactly — plus two
// authoring lints the server does not enforce: images must be pinned, and required variables
// need a description unless a generator answers for the user. Everything here is pure over the
// parsed document (unit-tested); only loadTemplateManifest touches disk.
import { join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import YAML from 'yaml'

export const MANIFEST_FILE = 'insta.template.yaml'

// A variable spec as authored: full object, or a bare string shorthand for the description.
export type VarSpec = { description?: string; default?: string; generate?: string; editable?: boolean }

export type ManifestEnv = {
  fixed?: Record<string, unknown>
  generated?: Record<string, unknown> // ENV_NAME → "${<declared generator>}"
  platform?: Record<string, unknown> // ENV_NAME → "${{services.<name>.<KEY>}}"
  required?: Record<string, VarSpec | string>
  optional?: Record<string, VarSpec | string>
}

export type ManifestService = {
  type?: string // web | worker | postgres | redis | mysql | mongodb (the four managed types are declared bare: no image, port, volume or env)
  image?: string
  build?: string
  port?: number
  healthcheck?: string
  volume?: boolean // needs a /data disk; the platform owns the size
  alwaysOn?: boolean // idle mode; undeclared = the platform default (always-on for compute)
  env?: ManifestEnv
}

export type TemplateManifest = {
  code?: string
  version?: string | number
  maintainer?: string
  sourceRepo?: string
  upstream?: Record<string, unknown>
  generated?: Record<string, unknown> // declare-once generators: name → spec (secret:N)
  services?: Record<string, ManifestService>
  constraints?: Array<{ oneOf?: string[]; allOf?: string[] }>
  meta?: { name?: string; tagline?: string; category?: string; tags?: string[] }
}

// One template variable, flattened out of the manifest (or the registry info endpoint) into the
// shape the deploy prompt/--set resolution works over.
export type TemplateVar = {
  name: string
  description?: string
  required: boolean
  default?: string
  generate?: string
}

// The platform's own shapes (templateManifest.ts): codes and service names become branch/service
// names; env vars are user-secret names; the one generator family is secret:N.
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const GENERATOR_RE = /^secret:([1-9]\d{0,2})$/

// The platform provisions these and owns everything about them (platform templateManifest.ts).
const MANAGED_TYPES = ['postgres', 'redis', 'mysql', 'mongodb']
const MANIFEST_TYPES = ['web', 'worker', ...MANAGED_TYPES]

// What counts as a digest is the PLATFORM's call, not ours: registry.ts's DIGEST regex, verbatim.
const DIGEST = /^sha256:[a-f0-9]{64}$/

// Why an image must carry a pin: a template is a reproducible deploy, and a tagless ref (implicit
// :latest) or an explicit :latest re-resolves on every deploy — two runs of the same template
// version would ship different bytes. Digest-pinned refs (…@sha256:…) are the strongest pin.
//
// The reference grammar mirrors the platform's parseImageRef (src/provisioning/registry.ts, THE
// authority): everything after the LAST `@` is the reference, and `@` wins over `:` — so a `@`
// reference is a pin only when it is a real digest, and a malformed one is never re-read as a tag.
export function imageTagIssue(image: string): string | null {
  const at = image.lastIndexOf('@')
  if (at !== -1) {
    if (DIGEST.test(image.slice(at + 1))) return null // digest-pinned, the strongest pin
    return `image ${image} carries an @ reference that is not a sha256 digest — use @sha256:<64 hex> (or a version tag)`
  }
  const lastSegment = image.split('/').pop() ?? ''
  const tag = lastSegment.includes(':') ? lastSegment.split(':').pop() : undefined
  if (!tag) return `image ${image} has no tag — pin a version (or a @sha256 digest)`
  if (tag === 'latest') return `image ${image} is pinned to :latest, which is not a pin — use a version tag (or a @sha256 digest)`
  return null
}

// The platform runs every scalar manifest field through scalarString
// (src/provisioning/templateManifest.ts): a string passes, a number/boolean coerces, anything else
// is a manifest error naming the field. Same verdict here, so a YAML typo is reported rather than
// crashing a lint that assumed a string.
function scalarString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function asVarSpec(v: VarSpec | string | null | undefined): VarSpec {
  if (typeof v === 'string') return { description: v }
  return v ?? {}
}

/** All local validation problems, empty when the manifest is deployable. */
export function validateManifest(m: TemplateManifest): string[] {
  const problems: string[] = []
  if (!m || typeof m !== 'object') return ['manifest is not a YAML mapping']
  if (!m.code || typeof m.code !== 'string') problems.push('code is required')
  else if (!CODE_RE.test(m.code)) problems.push(`code must be lower-kebab (a-z, 0-9, -, max 39 chars), got: ${m.code}`)
  if (m.version === undefined || m.version === null || m.version === '') problems.push('version is required')

  const generators = new Set<string>()
  for (const [name, spec] of Object.entries(m.generated ?? {})) {
    if (!GENERATOR_RE.test(String(spec))) problems.push(`generated.${name}: unknown generator '${spec}' (the platform knows secret:N, N 1-999)`)
    generators.add(name)
  }

  const services = m.services ?? {}
  const names = Object.keys(services)
  if (names.length === 0) problems.push('services: at least one service is required')
  for (const name of names) {
    const svc = services[name] ?? {}
    const where = `services.${name}`
    // typeof, not String(): a YAML array like [redis] would otherwise stringify to its lone element.
    const type = typeof svc.type === 'string' ? svc.type : undefined
    if (!type || !MANIFEST_TYPES.includes(type)) {
      problems.push(`${where}.type must be one of ${MANIFEST_TYPES.join(', ')}`)
    }
    // A managed datastore is BARE: the platform owns its image, port, sizing, credentials and env,
    // so every other rule below would be asking about fields it must not carry. Mirrors the
    // platform's own check (provisioning/templateManifest.ts) so an author hears it here.
    if (type && MANAGED_TYPES.includes(type)) {
      const bare = svc as Record<string, unknown>
      for (const field of ['image', 'build', 'port', 'healthcheck', 'volume', 'volumeGib', 'spec', 'alwaysOn']) {
        if (bare[field] !== undefined) {
          problems.push(`${where}.${field}: a ${type} service is platform-managed and carries no ${field} — declare it bare ({ type: ${type} })`)
        }
      }
      const groups = ['fixed', 'generated', 'platform', 'required', 'optional']
      const envShell = bare.env
      if (envShell !== undefined) {
        const emptyShell = !!envShell && typeof envShell === 'object' && !Array.isArray(envShell)
          && Object.entries(envShell as Record<string, unknown>).every(([g, v]) =>
            groups.includes(g) && !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
        if (!emptyShell) {
          problems.push(`${where}.env: a ${type} service is platform-managed and carries no env — declare it bare ({ type: ${type} })`)
        }
      }
      continue
    }
    if (svc.image && svc.build) problems.push(`${where}: image and build are mutually exclusive`)
    if (!svc.image && !svc.build) problems.push(`${where}: one of image or build is required`)
    // A parsed YAML document holds whatever the author typed, so both scalars are type-checked the
    // platform's way BEFORE any rule reads them as strings.
    const image = svc.image !== undefined ? scalarString(svc.image) : undefined
    if (svc.image !== undefined && image === null) problems.push(`${where}.image must be a string`)
    if (svc.build !== undefined && scalarString(svc.build) === null) problems.push(`${where}.build must be a string`)
    if (image) {
      const issue = imageTagIssue(image)
      if (issue) problems.push(`${where}: ${issue}`)
    }
    if (svc.port !== undefined && (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535)) {
      problems.push(`${where}: port must be an integer between 1 and 65535, got: ${svc.port}`)
    }
    // A worker is PORTLESS: the platform deploys it as its own port-0 service, so nothing is routed
    // to it and nothing probes it. The server's three refusals, said here before the upload.
    if (svc.type === 'worker') {
      if (svc.port !== undefined) problems.push(`${where}.port: a worker has no routed port — remove it (a worker is portless; declare type: web to serve HTTP)`)
      if (svc.healthcheck !== undefined) problems.push(`${where}.healthcheck: a worker has no HTTP endpoint to probe — its health is the machine's state; remove it (or declare type: web)`)
      if (svc.alwaysOn === false) problems.push(`${where}.alwaysOn: a worker cannot scale to zero — nothing is routed to it, so nothing would wake it; remove alwaysOn or set it true`)
    }
    if (svc.type === 'web' && !svc.healthcheck) problems.push(`${where}: web services must declare a healthcheck path`)
    if (svc.healthcheck && !String(svc.healthcheck).startsWith('/')) problems.push(`${where}: healthcheck must be an absolute path (start with /)`)
    // Sizing is the platform's, capped for the org's plan. Same answers the
    // publish endpoint gives, said here so an author does not upload to find out. Read as unknown:
    // the type above admits only what is SUPPORTED, and the document is a cast over YAML.parse, so
    // a refused shape arrives as a value that type does not describe.
    const authored = svc as { volume?: unknown; spec?: unknown }
    if (authored.volume !== undefined && authored.volume !== true) {
      problems.push(`${where}: the volume size is the platform's to choose — declare 'volume: true'`)
    }
    if (authored.spec !== undefined) {
      problems.push(`${where}: compute size is the platform's to choose — remove spec`)
    }
    const env = svc.env ?? {}
    for (const group of ['fixed', 'generated', 'required', 'optional'] as const) {
      for (const varName of Object.keys(env[group] ?? {})) {
        if (!ENV_NAME_RE.test(varName)) problems.push(`${where}.env.${group}.${varName}: env names must match ^[A-Z][A-Z0-9_]{0,63}$`)
      }
    }
    for (const [varName, ref] of Object.entries(env.generated ?? {})) {
      const match = /^\$\{([a-zA-Z0-9_-]+)\}$/.exec(String(ref))
      if (!match) problems.push(`${where}.env.generated.${varName} must reference a declared generator like \${name}`)
      else if (!generators.has(match[1]!)) problems.push(`${where}.env.generated.${varName} references undeclared generator '${match[1]}'`)
    }
    // The generator rule is the server's, so it holds wherever a var declares one — an invalid
    // generate on an OPTIONAL var is just as fatal at deploy time as on a required one.
    for (const group of ['required', 'optional'] as const) {
      for (const [varName, raw] of Object.entries(env[group] ?? {})) {
        const spec = asVarSpec(raw)
        if (spec.generate && !GENERATOR_RE.test(spec.generate)) problems.push(`${where}.env.${group}.${varName}: generate must be secret:N (1-999), got: ${spec.generate}`)
        // A required var is a question put to the deployer — without a description (or a generator
        // that answers it for them) there is nothing to ask with. Authoring lint, CLI-only.
        if (group === 'required' && !spec.description && !spec.generate) problems.push(`${where}.env.required.${varName}: a description is required (unless generate is set)`)
      }
    }
  }
  // A managed datastore has no url or host to address, mirroring the platform's env.fixed check.
  for (const name of names) {
    const svc = services[name] ?? {}
    for (const [varName, raw] of Object.entries(svc.env?.fixed ?? {})) {
      for (const m of String(raw).matchAll(/\$\{([^}]+)\}/g)) {
        const ref = m[1]!.trim()
        const svcRef = /^services\.([a-z0-9-]+)\.(url|host)$/.exec(ref)
        if (!svcRef) continue
        const target = services[svcRef[1]!]
        const targetType = target && typeof target.type === 'string' ? target.type : undefined
        if (targetType && MANAGED_TYPES.includes(targetType)) {
          problems.push(`services.${name}.env.fixed.${varName}: '${svcRef[1]}' is a managed ${targetType}, so it has no url or host. Use its platform credentials instead: \${{services.${svcRef[1]}.<KEY>}} under env.platform`)
        }
      }
    }
  }
  return problems
}

/**
 * Flatten the manifest's prompt-relevant variables: every service's env.required and env.optional
 * merged into the global variable namespace the POST's `variables` map addresses — the same name
 * declared by two services is ONE variable, required if required anywhere, later mentions
 * backfilling fields earlier ones left unset (the platform's collectVariables merge). env.fixed /
 * env.generated (and top-level `generated`) are filled in by the executor, so they are not
 * deploy-time questions.
 */
export function collectManifestVariables(m: TemplateManifest): TemplateVar[] {
  const byName = new Map<string, TemplateVar>()
  const add = (name: string, raw: VarSpec | string | null | undefined, required: boolean) => {
    const spec = asVarSpec(raw)
    const prev = byName.get(name)
    byName.set(name, {
      name,
      description: prev?.description ?? spec.description,
      required: (prev?.required ?? false) || required,
      default: prev?.default ?? spec.default,
      generate: prev?.generate ?? spec.generate,
    })
  }
  for (const svc of Object.values(m.services ?? {})) {
    for (const [name, spec] of Object.entries(svc.env?.required ?? {})) add(name, spec, true)
    for (const [name, spec] of Object.entries(svc.env?.optional ?? {})) add(name, spec, false)
  }
  return [...byName.values()]
}

/** Parse manifest YAML text. Throws with every validation problem listed, not just the first. */
export function parseManifestYaml(text: string, source = MANIFEST_FILE): TemplateManifest {
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch (e) {
    throw new Error(`${source}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const manifest = (doc ?? {}) as TemplateManifest
  const problems = validateManifest(manifest)
  if (problems.length) throw new Error(`${source} is not deployable:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  return manifest
}

/** Read + validate <dir>/insta.template.yaml. */
export function loadTemplateManifest(dir: string): TemplateManifest {
  const path = join(resolve(process.cwd(), dir), MANIFEST_FILE)
  if (!existsSync(path)) throw new Error(`no ${MANIFEST_FILE} at ${path}`)
  return parseManifestYaml(readFileSync(path, 'utf8'), path)
}
