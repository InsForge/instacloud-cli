// `insta service add` used to answer a missing type with commander's "missing required argument",
// which never says what the types are. Resolution: both args given → untouched (no prompt anywhere
// near the fast path); TTY → the dashboard's Add Service kinds, then a name (and for Docker Image,
// the ref first and the port after); no TTY → the kind list as an error, because nothing was
// created; a bad type → straight through, so assertType keeps owning that wording.
import { test, expect } from 'vitest'
import {
  DEFAULT_IMAGE_PORT,
  SERVICE_KINDS,
  missingArgsMessage,
  normalizeImageRef,
  resolveServiceArgs,
  serviceArgsDeps,
  serviceKindLines,
  suggestServiceName,
  type ServiceArgsDeps,
  type ServiceKind,
} from '../src/resolve-service.js'
import { SERVICE_TYPES, assertServiceName } from '../src/commands/services.js'

const kind = (id: string): ServiceKind => SERVICE_KINDS.find((k) => k.id === id)!

const deps = (over: Partial<ServiceArgsDeps> = {}): ServiceArgsDeps => ({
  selectKind: async () => { throw new Error('selectKind must not be called') },
  askImage: async () => { throw new Error('askImage must not be called') },
  askName: async () => { throw new Error('askName must not be called') },
  askPort: async () => { throw new Error('askPort must not be called') },
  tty: true,
  ...over,
})

test('every service type is reachable from some kind', () => {
  for (const t of SERVICE_TYPES) expect(SERVICE_KINDS.some((k) => k.type === t)).toBe(true)
})

// The dashboard's Add Service lists Docker Image beside Empty Service, not under it.
test('Docker Image is its own kind, at the same level as Empty Service', () => {
  expect(SERVICE_KINDS.map((k) => k.label)).toEqual(['Docker Image', 'Postgres', 'Redis', 'MySQL', 'MongoDB', 'Storage', 'Empty Service'])
  expect(kind('image').needsImage).toBe(true)
  expect(kind('image').type).toBe('compute')
  expect(kind('compute').needsImage).toBeUndefined()
})

// Default names are the dashboard dialog's placeholders — they must not drift apart.
test('default names match the Add Service placeholders', () => {
  expect(kind('postgres').defaultName).toBe('main-db')
  expect(kind('redis').defaultName).toBe('cache')
  expect(kind('mysql').defaultName).toBe('mysql-db')
  expect(kind('mongodb').defaultName).toBe('mongo-db')
  expect(kind('storage').defaultName).toBe('assets')
  expect(kind('compute').defaultName).toBe('compute')
  expect(kind('image').defaultName).toBeUndefined()
})

test('both arguments given: returned as-is, nothing is asked', async () => {
  const r = await resolveServiceArgs('postgres', 'main-db', deps())
  expect(r).toEqual({ type: 'postgres', name: 'main-db' })
})

test('no arguments + TTY: asks what, then the name for that kind', async () => {
  const asked: string[] = []
  const r = await resolveServiceArgs(undefined, undefined, deps({
    selectKind: async (kinds) => { asked.push('kind'); return kinds.find((k) => k.id === 'storage')! },
    askName: async (k, suggested) => { asked.push(`name:${k.id}`); return suggested },
  }))
  expect(r).toEqual({ type: 'storage', name: 'assets' })
  expect(asked).toEqual(['kind', 'name:storage'])
})

test('Docker Image: asks for the ref, suggests a name from it, then the port', async () => {
  const asked: string[] = []
  const r = await resolveServiceArgs(undefined, undefined, deps({
    selectKind: async () => { asked.push('kind'); return kind('image') },
    askImage: async () => { asked.push('image'); return 'ghcr.io/insforge/postgres:v15.13.4' },
    askName: async (_k, suggested) => { asked.push('name'); return suggested },
    askPort: async (fallback) => { asked.push('port'); return fallback },
  }))
  expect(r).toEqual({ type: 'compute', name: 'postgres', image: 'ghcr.io/insforge/postgres:v15.13.4', port: DEFAULT_IMAGE_PORT })
  expect(asked).toEqual(['kind', 'image', 'name', 'port'])
})

// A flag already on the command line is an answer — asking for it again would be a regression.
test('Docker Image: --image and --port already given are not asked for', async () => {
  const r = await resolveServiceArgs(undefined, undefined, deps({
    selectKind: async () => kind('image'),
    askName: async (_k, suggested) => suggested,
  }), { image: 'https://nginx:1.27', port: '3000' })
  expect(r).toEqual({ type: 'compute', name: 'nginx', image: 'nginx:1.27', port: '3000' })
})

test('a bare compute type means Empty Service, never the image flow', async () => {
  const r = await resolveServiceArgs('compute', undefined, deps({ askName: async (_k, s) => s }))
  expect(r).toEqual({ type: 'compute', name: 'compute' })
})

test('no TTY: throws, and the message lists every kind with its command', async () => {
  await expect(resolveServiceArgs(undefined, undefined, deps({ tty: false }))).rejects.toThrow(/what to add/)
  const msg = missingArgsMessage()
  for (const k of SERVICE_KINDS) expect(msg).toContain(k.label)
  expect(msg).toContain('insta service add postgres main-db')
  expect(msg).toContain('insta service add redis cache')
  expect(msg).toContain('insta service add mysql mysql-db')
  expect(msg).toContain('insta service add mongodb mongo-db')
  expect(msg).toContain('--image <ref>')
})

test('no TTY with a type: asks for the missing half, not the whole list', () => {
  expect(missingArgsMessage('storage')).toBe('name the service:  insta service add storage assets')
})

test('unknown type: passed through for assertType to report, prompts untouched', async () => {
  const r = await resolveServiceArgs('lambda', undefined, deps({ tty: false }))
  expect(r).toEqual({ type: 'lambda', name: '' })
})

test('kind lines stay one per kind and carry a runnable command', () => {
  const lines = serviceKindLines()
  expect(lines).toHaveLength(SERVICE_KINDS.length)
  expect(lines.join('\n')).toContain('insta service add storage assets')
  expect(lines.join('\n')).toContain('insta service add redis cache')
  expect(lines.join('\n')).toContain('insta service add mysql mysql-db')
  expect(lines.join('\n')).toContain('insta service add mongodb mongo-db')
})

// Same rules as the dashboard's helpers, so a ref names the service identically in both.
test('image refs normalize and suggest the dashboard name', () => {
  expect(normalizeImageRef('  https://ghcr.io/insforge/app:v2  ')).toBe('ghcr.io/insforge/app:v2')
  expect(suggestServiceName('nginx:latest')).toBe('nginx')
  expect(suggestServiceName('ghcr.io/insforge/postgres-all:latest')).toBe('postgres-all')
  expect(suggestServiceName('registry.io/team/My_App@sha256:abc')).toBe('my-app')
})

// A suggestion the name rule would reject is worse than none — it can't be accepted unchanged.
test('a long repo segment is capped at what assertServiceName accepts', () => {
  const suggested = suggestServiceName(`ghcr.io/org/${'a'.repeat(50)}:latest`)
  expect(suggested).toHaveLength(39)
  expect(() => assertServiceName(suggested)).not.toThrow()
  // Truncation must not leave a trailing hyphen, which the rule also rejects.
  expect(suggestServiceName(`ghcr.io/org/${'ab-'.repeat(20)}:latest`)).not.toMatch(/-$/)
})

// --image that normalizes away would otherwise be dropped from the body and quietly build an
// empty compute service instead of the image the user asked for.
test('an --image that normalizes to nothing is rejected, not silently dropped', async () => {
  await expect(resolveServiceArgs(undefined, undefined, deps({
    selectKind: async () => kind('image'),
  }), { image: 'https://' })).rejects.toThrow(/image reference is required/)
})

// A bad --port is a typo in the command; answering three questions first would be wasted work.
test('an invalid --port fails before any prompt', async () => {
  await expect(resolveServiceArgs(undefined, undefined, deps(), { port: '70000' }))
    .rejects.toThrow(/between 1 and 65535/)
  await expect(resolveServiceArgs(undefined, undefined, deps(), { port: 'abc' }))
    .rejects.toThrow(/between 1 and 65535/)
})

// --json promises parseable stdout; a prompt would corrupt it and hang an agent that owns a TTY.
test('--json opts out of the prompts even on a terminal', () => {
  const io = [process.stdin, process.stdout] as Array<{ isTTY?: boolean }>
  const saved = io.map((s) => s.isTTY)
  for (const s of io) s.isTTY = true
  try {
    expect(serviceArgsDeps().tty).toBe(true)
    expect(serviceArgsDeps(true).tty).toBe(false)
  } finally {
    io.forEach((s, i) => { s.isTTY = saved[i] })
  }
})
