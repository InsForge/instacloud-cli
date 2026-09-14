// `insta services add` with no type (or no name): the kinds are otherwise only discoverable by
// guessing wrong and reading `type must be postgres|storage|compute|redis|mysql|mongodb`, so missing arguments answer
// "what can I add?" instead. The list mirrors the dashboard's Add Service menu (frontend
// `add-service-button.tsx`) — Docker Image sits BESIDE Empty Service, not under it, because
// picking an image is a different intent rather than a compute flag. An agent gets the same list
// as an error, because nothing was created and a silent exit 0 would read as success.
import * as clack from '@clack/prompts'
import { SERVICE_TYPES, assertServiceName, parsePort, type ServiceType } from './commands/services.js'
import { CliCancel } from './util.js'

export type ServiceKind = {
  id: string
  label: string
  type: ServiceType
  hint: string
  // Docker Image derives its name from the ref, so it carries no fixed default.
  defaultName?: string
  needsImage?: boolean
}

// The CLI connects repos to existing services only; "GitHub Repo" is not a service kind here.
export const SERVICE_KINDS: readonly ServiceKind[] = [
  { id: 'image', label: 'Docker Image', type: 'compute', hint: 'run an existing container image', needsImage: true },
  { id: 'postgres', label: 'Postgres', type: 'postgres', hint: 'relational DB, usable as soon as it is added', defaultName: 'main-db' },
  { id: 'redis', label: 'Redis', type: 'redis', hint: 'private Redis-compatible cache', defaultName: 'cache' },
  { id: 'mysql', label: 'MySQL', type: 'mysql', hint: 'private MySQL database', defaultName: 'mysql-db' },
  { id: 'mongodb', label: 'MongoDB', type: 'mongodb', hint: 'private MongoDB database', defaultName: 'mongo-db' },
  { id: 'storage', label: 'Storage', type: 'storage', hint: 'S3-compatible bucket, private by default', defaultName: 'assets' },
  { id: 'compute', label: 'Empty Service', type: 'compute', hint: 'an app to deploy code to (empty until `insta deploy`)', defaultName: 'compute' },
]

// The platform's own default; the dialog prefills the same number.
export const DEFAULT_IMAGE_PORT = '8080'

export type ResolvedServiceArgs = { type: string; name: string; image?: string; port?: string }

export type ServiceArgsDeps = {
  selectKind: (kinds: readonly ServiceKind[]) => Promise<ServiceKind>
  askImage: () => Promise<string>
  askName: (kind: ServiceKind, suggested: string) => Promise<string>
  askPort: (fallback: string) => Promise<string>
  tty: boolean
}

/** Registry refs aren't URLs — quietly strip a pasted scheme prefix (mirrors the dashboard). */
export function normalizeImageRef(raw: string): string {
  return raw.trim().replace(/^https?:\/\//, '')
}

/**
 * Name from an image ref: last path segment, sans tag/digest, kebab-safe (the dashboard's rule).
 * Also capped at the 39 chars `assertServiceName` allows — a suggestion the user cannot accept
 * unchanged is worse than none.
 */
export function suggestServiceName(ref: string): string {
  const last = ref.split('@')[0]!.split('/').pop() ?? ''
  return last
    .split(':')[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/g, '')
}

/** The non-interactive command for a kind — what an agent should run instead of being asked. */
export function kindCommand(k: ServiceKind): string {
  if (k.needsImage) return `insta services add compute <name> --image <ref> --port <n>`
  return `insta services add ${k.type} ${k.defaultName}`
}

/** The kind list, one line each — what a terminal picks from and an agent reads. */
export function serviceKindLines(): string[] {
  return SERVICE_KINDS.map((k) => `  ${k.label.padEnd(14)} ${kindCommand(k)}`)
}

/** What to say when there is no terminal to ask: the missing half, and how to supply it. */
export function missingArgsMessage(type?: string): string {
  // A bare type names the plain kind, never Docker Image — that one is reached with --image.
  const known = SERVICE_KINDS.find((k) => k.type === type && !k.needsImage)
  if (known) return `name the service:  ${kindCommand(known)}`
  return ['what to add:', ...serviceKindLines()].join('\n')
}

/**
 * Fill in whatever `insta services add` was not given. An unknown type passes straight through so
 * `assertType` — not this — reports it, keeping one wording for a bad type everywhere. Flags that
 * were already supplied are never asked for again.
 */
export async function resolveServiceArgs(
  type: string | undefined,
  name: string | undefined,
  deps: ServiceArgsDeps,
  given: { image?: string; port?: string } = {},
): Promise<ResolvedServiceArgs> {
  if (type && name) return { type, name }
  if (type && !SERVICE_TYPES.includes(type as ServiceType)) return { type, name: name ?? '' }
  if (!deps.tty) throw new Error(missingArgsMessage(type))
  // A bad --port is a typo in the command, not an answer: fail before asking anything.
  if (given.port !== undefined) parsePort(given.port)
  const kind = type
    ? SERVICE_KINDS.find((k) => k.type === type && !k.needsImage)
    : await deps.selectKind(SERVICE_KINDS)
  if (!kind) return { type: type!, name: name ?? '' }
  if (!kind.needsImage) {
    return { type: kind.type, name: name ?? (await deps.askName(kind, kind.defaultName ?? '')) }
  }
  // The prompt validates a typed ref; a --image that normalizes away would slip past it and
  // provision a plain empty compute instead (servicesAddRequestBody drops a falsy image).
  const image = normalizeImageRef(given.image ?? (await deps.askImage()))
  if (!image) throw new Error('an image reference is required')
  return {
    type: kind.type,
    name: name ?? (await deps.askName(kind, suggestServiceName(image))),
    image,
    port: given.port ?? (await deps.askPort(DEFAULT_IMAGE_PORT)),
  }
}

/** Real prompts (clack, as the InsForge CLI's `create`); cancelling exits without provisioning. */
export async function promptServiceKind(kinds: readonly ServiceKind[]): Promise<ServiceKind> {
  const picked = await clack.select({
    message: 'What do you want to add?',
    options: kinds.map((k) => ({ value: k.id, label: k.label, hint: k.hint })),
  })
  if (clack.isCancel(picked)) throw new CliCancel()
  // Resolve against the list that was displayed — a subset must not fall through to the registry.
  return kinds.find((k) => k.id === picked)!
}

export async function promptImageRef(): Promise<string> {
  const answer = await clack.text({
    message: 'Image reference:',
    placeholder: 'nginx:latest',
    validate: (v) => (normalizeImageRef(v) ? undefined : 'an image reference is required'),
  })
  if (clack.isCancel(answer)) throw new CliCancel()
  return answer
}

export async function promptServiceName(kind: ServiceKind, suggested: string): Promise<string> {
  const answer = await clack.text({
    message: `Name this ${kind.type} service:`,
    initialValue: suggested,
    // The same rule the command enforces, reported before Enter rather than after a round trip.
    validate: (v) => {
      try {
        assertServiceName(v.trim())
        return undefined
      } catch (e) {
        return (e as Error).message
      }
    },
  })
  if (clack.isCancel(answer)) throw new CliCancel()
  return answer.trim()
}

export async function promptPort(fallback: string): Promise<string> {
  const answer = await clack.text({
    message: 'Port the image listens on:',
    initialValue: fallback,
    // The rule the command enforces, so the prompt and a --port can never disagree.
    validate: (v) => {
      try {
        parsePort(v.trim())
        return undefined
      } catch (e) {
        return (e as Error).message
      }
    },
  })
  if (clack.isCancel(answer)) throw new CliCancel()
  return answer.trim()
}

/** Prompts on a real terminal only — an agent's stdin is not one, and must never block. */
export function serviceArgsDeps(json?: boolean): ServiceArgsDeps {
  return {
    selectKind: promptServiceKind,
    askImage: promptImageRef,
    askName: promptServiceName,
    askPort: promptPort,
    // --json asked for parseable output, so a caller that happens to own a TTY still gets the error.
    tty: !json && !!process.stdin.isTTY && !!process.stdout.isTTY,
  }
}
