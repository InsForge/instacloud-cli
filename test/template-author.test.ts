// Template authoring (spec 2026-10-06 §3): a real ApiClient over a fake fetch.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { configureAgent } from '../src/agent.js'
import { ApiClient, ApiError } from '../src/api.js'
import type { ProjectConfig } from '../src/config.js'
import {
  templateEditorUrl, templateStatusWord, draftListLines, requirementLines, readinessLines, regenerateChangeLines, draftLines,
  parsePatch, readAllStdin, templateDrafts, templateDraft, templateCreate, templateEdit, templateRegenerate, templatePublish, templateUnpublish,
  templateDelete, BLANK_NOT_YET, type TemplateDraft,
} from '../src/commands/template-author.js'

const API = 'https://api.instacloud.com'
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-000000000002'
const PROJECT = 'cccccccc-0000-4000-8000-000000000003'
const UPDATED = '2026-10-06T10:00:00.000Z'
const EDITOR = `https://console.instacloud.com/orgs/${ORG}/templates/my-app`

// The platform's CommunityTemplate view of a draft fresh from a project.
const view = (over: Partial<TemplateDraft> & Record<string, unknown> = {}): TemplateDraft => ({
  id: '11111111-0000-4000-8000-000000000001', code: 'my-app', orgId: ORG, sourceProjectId: PROJECT,
  status: 'draft', publishedVersion: null, hasUnpublishedChanges: false,
  name: 'My App', tagline: null, category: null, readme: null, defaultReadme: '# My App\n', logoUrl: null,
  services: [
    {
      name: 'app', type: 'web', image: 'ghcr.io/acme/app:1.2', port: 8080, healthcheck: '/health', volume: true, mountPath: null,
      command: null, alwaysOn: false, removed: false,
      variables: [
        { name: 'BASE_URL', kind: 'required' },
        { name: 'DATABASE_URL', kind: 'reference', value: '${{services.db.DATABASE_URL}}' },
        { name: 'SESSION_SECRET', kind: 'generated' },
      ],
    },
    { name: 'db', type: 'postgres', image: null, port: null, healthcheck: null, volume: false, mountPath: null, command: null, alwaysOn: null, pgVersion: 16, removed: false, variables: [] },
  ],
  referenceOptions: [],
  publishRequirements: [
    { code: 'has_service', ok: true, items: [] },
    { code: 'no_blocked', ok: true, items: [] },
    { code: 'has_tagline', ok: false, items: [] },
    { code: 'has_category', ok: true, items: [] },
    { code: 'has_readme', ok: true, items: [] },
    { code: 'required_descriptions', ok: false, items: ['app.BASE_URL'] },
  ],
  report: { skipped: [], blocked: [], notices: [] }, updatedAt: UPDATED, takenDown: false, deployCount: 0, totalProjects: 0,
  ...over,
} as TemplateDraft)

type Call = { method: string; path: string; body: unknown }
type Answer = { status?: number; body: unknown }

// A route the fake does not list gets Fastify's own 404, as a platform without it answers.
function platform(routes: Record<string, (body: any) => Answer>, apiUrl = API) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.slice(apiUrl.length)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: String(init.method), path, body })
    const route = routes[`${init.method} ${path}`]
    if (!route) return new Response(JSON.stringify({ message: `Route ${init.method}:${path} not found`, error: 'Not Found', statusCode: 404 }), { status: 404 })
    const r = route(body)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { api: new ApiClient({ apiUrl, accessToken: 'user' }, fetchImpl), calls }
}

const linked = () => vi.fn(async (): Promise<ProjectConfig> => ({ projectId: PROJECT, orgId: ORG, branch: 'main' }))
const DRAFT_PATH = `/orgs/${ORG}/templates/my-app`

const stdout: string[] = []
const stderr: string[] = []
const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined })
afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })
const printed = () => stdout.join('')
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure') }, (e: Error) => e)

describe('templateEditorUrl', () => {
  it('reads the api host as the console host, for production and staging', () => {
    expect(templateEditorUrl(API, ORG, 'my-app')).toBe(EDITOR)
    expect(templateEditorUrl('https://api.staging.instacloud.com/', ORG, 'my-app'))
      .toBe(`https://console.staging.instacloud.com/orgs/${ORG}/templates/my-app`)
  })
  it('keeps the scheme and the port', () => {
    expect(templateEditorUrl('http://api.localhost:4000', ORG, 'my-app')).toBe(`http://console.localhost:4000/orgs/${ORG}/templates/my-app`)
  })
  it('gives no link for any other host', () => {
    for (const url of ['http://localhost:7070', 'https://insta.example.com', 'https://myapi.example.com', 'https://api', 'not a url']) {
      expect(templateEditorUrl(url, ORG, 'my-app'), url).toBeNull()
    }
  })
})

describe('draft rendering', () => {
  it('names a published draft with edits and a taken-down one', () => {
    expect(templateStatusWord(view())).toBe('draft')
    expect(templateStatusWord(view({ status: 'published', hasUnpublishedChanges: true }))).toBe('published, with unpublished edits')
    expect(templateStatusWord(view({ status: 'published', takenDown: true }))).toBe('taken down')
  })
  it('lists the org in aligned columns, and says so when there is nothing', () => {
    expect(draftListLines([view(), view({ code: 'n8n-fork', name: 'n8n fork', status: 'published', publishedVersion: '1.0.2' })])).toEqual([
      'CODE      STATUS     VERSION  NAME',
      'my-app    draft      -        My App',
      'n8n-fork  published  1.0.2    n8n fork',
    ])
    expect(draftListLines([])).toEqual(['no templates in this org yet, create one with: insta template create'])
  })
  it('marks each requirement and lists what an unmet one still needs', () => {
    expect(requirementLines(view().publishRequirements)).toEqual([
      '  ✓ has_service', '  ✓ no_blocked', '  ✗ has_tagline', '  ✓ has_category', '  ✓ has_readme', '  ✗ required_descriptions: app.BASE_URL',
    ])
  })
  it('prints a requirement code it does not know, as a newer platform may send one', () => {
    expect(requirementLines([{ code: 'no_conflicts', ok: false, items: ['web is both a service you added and a service in the project.'] }]))
      .toEqual(['  ✗ no_conflicts: web is both a service you added and a service in the project.'])
  })
  it('shows the services, every variable with its choice, the requirements and the editor link', () => {
    const t = view({ tagline: 'Self-hosted app', readme: 'é', services: [
      ...view().services,
      { name: 'files', type: 'storage', image: null, port: null, volume: false, mountPath: null, public: true, removed: true, variables: [] },
      {
        name: 'worker', type: 'worker', image: 'ghcr.io/acme/worker:1.2', port: null, volume: true, mountPath: '/srv', removed: false,
        variables: [
          { name: 'API_URL', kind: 'required', description: 'where the API lives', brokenReference: '${{services.api.url}}' },
          { name: 'QUEUE', kind: 'default', value: 'jobs', originalName: 'QUEUE_NAME' },
        ],
      },
    ] })
    expect(draftLines(t, EDITOR)).toEqual([
      'my-app: My App (draft)',
      '  tagline   Self-hosted app',
      '  readme    2 bytes',
      `  updated   ${UPDATED}`,
      'services (4):',
      '  app (web, port 8080, health check /health, image ghcr.io/acme/app:1.2, volume at /data)',
      '    BASE_URL        required',
      '    DATABASE_URL    reference ${{services.db.DATABASE_URL}}',
      '    SESSION_SECRET  generated',
      '  db (postgres 16)',
      '  files (storage, public, removed)',
      '  worker (worker, image ghcr.io/acme/worker:1.2, volume at /srv)',
      '    API_URL  required: where the API lives (broken reference ${{services.api.url}})',
      '    QUEUE    default jobs (renamed from QUEUE_NAME)',
      'publish requirements:',
      '  ✓ has_service', '  ✓ no_blocked', '  ✗ has_tagline', '  ✓ has_category', '  ✓ has_readme', '  ✗ required_descriptions: app.BASE_URL',
      `editor: ${EDITOR}`,
    ])
    expect(draftLines(t, null)).not.toContainEqual(expect.stringMatching(/^editor:/))
  })
})

describe('template drafts', () => {
  it("lists the linked project's org", async () => {
    const project = linked()
    const { api, calls } = platform({ [`GET /orgs/${ORG}/templates`]: () => ({ body: { templates: [view()] } }) })
    await templateDrafts({}, { api, project })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /orgs/${ORG}/templates`])
    expect(printed()).toBe('CODE    STATUS  VERSION  NAME\nmy-app  draft   -        My App\n')
  })
  it('takes --org without reading the link', async () => {
    const project = linked()
    const { api, calls } = platform({ [`GET /orgs/${OTHER_ORG}/templates`]: () => ({ body: { templates: [] } }) })
    await templateDrafts({ org: OTHER_ORG }, { api, project })
    expect(project).not.toHaveBeenCalled()
    expect(calls[0]!.path).toBe(`/orgs/${OTHER_ORG}/templates`)
  })
  it('prints the platform list as served under --json', async () => {
    const templates = [view()]
    const { api } = platform({ [`GET /orgs/${ORG}/templates`]: () => ({ body: { templates } }) })
    await templateDrafts({ json: true }, { api, project: linked() })
    expect(JSON.parse(printed())).toEqual(templates)
  })
})

describe('template draft', () => {
  it('prints the draft and its editor link', async () => {
    const { api, calls } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }) })
    await templateDraft('my-app', {}, { api, project: linked() })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${DRAFT_PATH}`])
    expect(printed().split('\n')).toContain(`editor: ${EDITOR}`)
  })
  it('prints the view and the link as one JSON document', async () => {
    const template = view()
    const { api } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template } }) })
    await templateDraft('my-app', { json: true }, { api, project: linked() })
    expect(JSON.parse(printed())).toEqual({ template, editorUrl: EDITOR })
  })
  it('says each web service health check, or that it has none, and nothing for a worker or a datastore', async () => {
    const svc = (over: Record<string, unknown>) => ({ image: null, port: null, volume: false, mountPath: null, removed: false, variables: [], ...over })
    const template = view({ services: [
      svc({ name: 'site', type: 'web', port: 80, healthcheck: '/healthz' }),
      svc({ name: 'root', type: 'web', port: 81, healthcheck: '/' }),
      svc({ name: 'bare', type: 'web', port: 82, healthcheck: null }),
      svc({ name: 'old', type: 'web', port: 83 }),
      svc({ name: 'queue', type: 'worker', healthcheck: '/ignored' }),
      svc({ name: 'db', type: 'postgres', pgVersion: 16, healthcheck: null }),
    ] })
    const { api } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template } }) })
    await templateDraft('my-app', {}, { api, project: linked() })
    const lines = printed().split('\n')
    expect(lines).toContain('  site (web, port 80, health check /healthz)')
    expect(lines).toContain('  root (web, port 81, health check /)')
    expect(lines).toContain('  bare (web, port 82, no health check)')
    expect(lines).toContain('  old (web, port 83)')
    expect(lines).toContain('  queue (worker)')
    expect(lines).toContain('  db (postgres 16)')
  })
  it('gives no link on a host without the api label', async () => {
    const { api } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }) }, 'http://localhost:7070')
    await templateDraft('my-app', { json: true }, { api, project: linked() })
    expect(JSON.parse(printed()).editorUrl).toBeNull()
    stdout.length = 0
    await templateDraft('my-app', {}, { api, project: linked() })
    expect(printed()).not.toContain('editor:')
    expect(printed()).toContain('my-app: My App (draft)')
  })
  it('leaves a missing draft to the platform', async () => {
    const { api } = platform({ [`GET /orgs/${ORG}/templates/nope`]: () => ({ status: 404, body: { error: 'template not found' } }) })
    const e = await failure(templateDraft('nope', {}, { api, project: linked() }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message).toBe('template not found')
  })
})

describe('readinessLines', () => {
  it('lists only what still stands between the draft and a publish', () => {
    expect(readinessLines(view().publishRequirements)).toEqual(['not ready to publish yet:', '  ✗ has_tagline', '  ✗ required_descriptions: app.BASE_URL'])
    expect(readinessLines([{ code: 'has_service', ok: true, items: [] }])).toEqual(['ready to publish'])
  })
})

describe('template create', () => {
  const CREATED = () => ({ status: 201, body: { template: view() } })

  it('generates a draft from the linked project and prints its code, name, status and editor link', async () => {
    const { api, calls } = platform({ [`POST /projects/${PROJECT}/template-drafts`]: CREATED })
    await templateCreate({}, { api, project: linked() })
    expect(calls).toEqual([{ method: 'POST', path: `/projects/${PROJECT}/template-drafts`, body: undefined }])
    expect(printed()).toBe(`created my-app: My App (draft)\neditor: ${EDITOR}\n`)
  })
  it('takes --project and --name without reading the link', async () => {
    const project = linked()
    const { api, calls } = platform({ ['POST /projects/p-2/template-drafts']: CREATED })
    await templateCreate({ project: 'p-2', name: 'Coral River' }, { api, project })
    expect(project).not.toHaveBeenCalled()
    expect(calls[0]!.body).toEqual({ name: 'Coral River' })
  })
  it('prints the view and the link under --json', async () => {
    const { api } = platform({ [`POST /projects/${PROJECT}/template-drafts`]: CREATED })
    await templateCreate({ json: true }, { api, project: linked() })
    expect(JSON.parse(printed())).toEqual({ template: view(), editorUrl: EDITOR })
  })
  it('creates a blank draft in the org with its name', async () => {
    const { api, calls } = platform({ [`POST /orgs/${ORG}/templates`]: CREATED })
    await templateCreate({ blank: true, name: 'Coral River' }, { api, project: linked() })
    expect(calls).toEqual([{ method: 'POST', path: `/orgs/${ORG}/templates`, body: { name: 'Coral River' } }])
    expect(printed()).toContain('created my-app: My App (draft)')
  })
  it('creates a blank draft in --org with no body when no name is given', async () => {
    const project = linked()
    const { api, calls } = platform({ [`POST /orgs/${OTHER_ORG}/templates`]: CREATED })
    await templateCreate({ blank: true, org: OTHER_ORG }, { api, project })
    expect(project).not.toHaveBeenCalled()
    expect(calls).toEqual([{ method: 'POST', path: `/orgs/${OTHER_ORG}/templates`, body: undefined }])
  })
  it('says this platform does not create blank templates yet when the route is not there', async () => {
    const { api } = platform({})
    const e = await failure(templateCreate({ blank: true }, { api, project: linked() }))
    expect(e).not.toBeInstanceOf(ApiError)
    expect(e.message).toBe(BLANK_NOT_YET)
    expect(printed()).toBe('')
  })
  it('says the same to an agent, whom the governance hook refuses on a route it cannot classify', async () => {
    const { api } = platform({ [`POST /orgs/${ORG}/templates`]: () => ({ status: 403, body: { error: 'unclassified_agent_action' } }) })
    expect((await failure(templateCreate({ blank: true }, { api, project: linked() }))).message).toBe(BLANK_NOT_YET)
  })
  it("passes the route's own 404 through", async () => {
    const { api } = platform({ [`POST /orgs/${OTHER_ORG}/templates`]: () => ({ status: 404, body: { error: 'org not found' } }) })
    const e = await failure(templateCreate({ blank: true, org: OTHER_ORG }, { api, project: linked() }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message).toBe('org not found')
  })
  it('refuses --blank with --project, and --org without --blank, before any request', async () => {
    const { api, calls } = platform({})
    expect((await failure(templateCreate({ blank: true, project: 'p-2' }, { api, project: linked() }))).message)
      .toBe('--blank starts a template with no project, so it does not take --project')
    expect((await failure(templateCreate({ org: OTHER_ORG }, { api, project: linked() }))).message)
      .toBe("--org goes with --blank: a draft generated from a project belongs to that project's org")
    expect(calls).toEqual([])
  })
})

describe('template edit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-template-edit-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p }
  const PATCH = { tagline: 'Self-hosted app', variables: [{ service: 'app', name: 'BASE_URL', choice: { kind: 'required', description: 'public URL' } }] }
  const saved = (body: any) => ({ body: { template: view({ tagline: body.tagline, updatedAt: '2026-10-06T10:05:00.000Z' }) } })

  it('fills expectedUpdatedAt from a fresh read when the file has none', async () => {
    const { api, calls } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }), [`PATCH ${DRAFT_PATH}`]: saved })
    await templateEdit('my-app', { patch: file('edits.json', JSON.stringify(PATCH)) }, { api, project: linked() })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${DRAFT_PATH}`, `PATCH ${DRAFT_PATH}`])
    expect(calls[1]!.body).toEqual({ ...PATCH, expectedUpdatedAt: UPDATED })
    expect(printed()).toBe([
      'saved my-app: My App (draft)', 'not ready to publish yet:', '  ✗ has_tagline', '  ✗ required_descriptions: app.BASE_URL', '',
    ].join('\n'))
  })
  it('reads a file that starts with a UTF-8 BOM', async () => {
    const { api, calls } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }), [`PATCH ${DRAFT_PATH}`]: saved })
    await templateEdit('my-app', { patch: file('bom.json', '﻿' + JSON.stringify(PATCH)) }, { api, project: linked() })
    expect(calls[1]!.body).toEqual({ ...PATCH, expectedUpdatedAt: UPDATED })
  })
  it('sends the file as it is when it carries expectedUpdatedAt', async () => {
    const own = { ...PATCH, expectedUpdatedAt: '2026-10-06T09:00:00.000Z' }
    const { api, calls } = platform({ [`PATCH ${DRAFT_PATH}`]: saved })
    await templateEdit('my-app', { patch: file('own.json', JSON.stringify(own)) }, { api, project: linked() })
    expect(calls).toEqual([{ method: 'PATCH', path: DRAFT_PATH, body: own }])
  })
  it('reads the patch from stdin for -', async () => {
    const { api, calls } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }), [`PATCH ${DRAFT_PATH}`]: saved })
    await templateEdit('my-app', { patch: '-', org: ORG }, { api, readStdin: async () => JSON.stringify(PATCH) })
    expect(calls[1]!.body).toEqual({ ...PATCH, expectedUpdatedAt: UPDATED })
  })
  it('prints the saved view and the link under --json', async () => {
    const { api } = platform({ [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }), [`PATCH ${DRAFT_PATH}`]: saved })
    await templateEdit('my-app', { patch: file('json.json', JSON.stringify(PATCH)), json: true }, { api, project: linked() })
    expect(JSON.parse(printed())).toEqual({ template: saved(PATCH).body.template, editorUrl: EDITOR })
  })
  it('refuses a file that is not one JSON object before any request', async () => {
    const { api, calls } = platform({})
    expect((await failure(templateEdit('my-app', { patch: file('bad.json', '{"tagline": ') }, { api, project: linked() }))).message)
      .toMatch(/^the patch from .*bad\.json is not valid JSON: /)
    expect((await failure(templateEdit('my-app', { patch: file('list.json', '[]') }, { api, project: linked() }))).message)
      .toMatch(/^the patch from .*list\.json must be one JSON object, the body the console editor sends/)
    expect((await failure(templateEdit('my-app', { patch: join(dir, 'absent.json') }, { api, project: linked() }))).message)
      .toMatch(/^cannot read the patch from .*absent\.json: /)
    expect(calls).toEqual([])
  })
  it("prints the platform's sentence when the draft changed meanwhile", async () => {
    const sentence = 'This draft changed since you opened it. Review the latest version, then save your changes again.'
    const { api } = platform({
      [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }),
      [`PATCH ${DRAFT_PATH}`]: () => ({ status: 409, body: { error: sentence, code: 'template_draft_changed' } }),
    })
    const e = await failure(templateEdit('my-app', { patch: file('race.json', JSON.stringify(PATCH)) }, { api, project: linked() }))
    expect(e).not.toBeInstanceOf(ApiError)
    expect(e.message).toBe(sentence)
    expect(printed()).toBe('')
  })
  it('leaves an uncoded refusal to the platform', async () => {
    const { api } = platform({
      [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }),
      [`PATCH ${DRAFT_PATH}`]: () => ({ status: 400, body: { error: 'category must be one of ai, analytics' } }),
    })
    const e = await failure(templateEdit('my-app', { patch: file('cat.json', '{"category":"x"}') }, { api, project: linked() }))
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(400)
  })
})

describe('template regenerate', () => {
  const CHANGES = { addedServices: ['cache'], removedServices: [], addedVariables: ['REDIS_URL'], removedVariables: ['OLD_KEY'] }
  const rebuilt = (changes = CHANGES) => () => ({ body: { template: view(), changes } })

  it('rebuilds the draft from its project and says what the project changed', async () => {
    const { api, calls } = platform({ [`POST ${DRAFT_PATH}/regenerate`]: rebuilt() })
    await templateRegenerate('my-app', {}, { api, project: linked() })
    expect(calls).toEqual([{ method: 'POST', path: `${DRAFT_PATH}/regenerate`, body: undefined }])
    expect(printed()).toBe([
      'regenerated my-app: My App (draft)',
      '  services added: cache',
      '  variables added: REDIS_URL',
      '  variables removed: OLD_KEY',
      'not ready to publish yet:', '  ✗ has_tagline', '  ✗ required_descriptions: app.BASE_URL', '',
    ].join('\n'))
  })
  it('says when the project changed nothing', () => {
    expect(regenerateChangeLines({ addedServices: [], removedServices: [], addedVariables: [], removedVariables: [] }))
      .toEqual(['  no service or variable was added to or removed from the project'])
  })
  it('prints the view, the changes and the link under --json', async () => {
    const { api } = platform({ [`POST ${DRAFT_PATH}/regenerate`]: rebuilt() })
    await templateRegenerate('my-app', { json: true }, { api, project: linked() })
    expect(JSON.parse(printed())).toEqual({ template: view(), changes: CHANGES, editorUrl: EDITOR })
  })
  it.each([
    'a blank template has no project to regenerate from',
    'the source project was deleted: only the name, description, category, README and logo can still change',
  ])("prints the platform's sentence: %s", async (sentence) => {
    const { api } = platform({ [`POST ${DRAFT_PATH}/regenerate`]: () => ({ status: 400, body: { error: sentence } }) })
    const e = await failure(templateRegenerate('my-app', {}, { api, project: linked() }))
    expect(e).not.toBeInstanceOf(ApiError)
    expect(e.message).toBe(sentence)
    expect(printed()).toBe('')
  })
  it('leaves a missing draft to the platform', async () => {
    const { api } = platform({ [`POST ${DRAFT_PATH}/regenerate`]: () => ({ status: 404, body: { error: 'template not found' } }) })
    expect(await failure(templateRegenerate('my-app', {}, { api, project: linked() }))).toBeInstanceOf(ApiError)
  })
})

describe('readAllStdin', () => {
  it('decodes a multi-byte character split across two chunks once', async () => {
    const bytes = Buffer.from('{"tagline":"你好"}', 'utf8')
    const cut = bytes.indexOf(0xe4) + 1
    expect(await readAllStdin(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]))).toBe('{"tagline":"你好"}')
  })
})

describe('parsePatch', () => {
  it('keeps every key of the object as written', () => {
    expect(parsePatch('{"tagline":"x","services":[{"name":"app","removed":true}]}', 'f')).toEqual({ tagline: 'x', services: [{ name: 'app', removed: true }] })
  })
  it('refuses null and a bare value', () => {
    expect(() => parsePatch('null', 'f')).toThrow(/must be one JSON object/)
    expect(() => parsePatch('"x"', 'f')).toThrow(/must be one JSON object/)
  })
})

describe('template publish', () => {
  const PUBLISHED = view({ status: 'published', publishedVersion: '1.0.0' })
  const routes = (publish: (body: any) => Answer = () => ({ body: { template: PUBLISHED } })) => ({
    [`GET ${DRAFT_PATH}`]: () => ({ body: { template: view() } }),
    [`POST ${DRAFT_PATH}/publish`]: publish,
  })

  it('says the template goes public at once, asks, and publishes the draft it read', async () => {
    const confirm = vi.fn(async () => true)
    const { api, calls } = platform(routes())
    await templatePublish('my-app', {}, { api, project: linked(), tty: true, confirm })
    expect(confirm).toHaveBeenCalledWith('Publish my-app now?')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${DRAFT_PATH}`, `POST ${DRAFT_PATH}/publish`])
    expect(calls[1]!.body).toEqual({ expectedUpdatedAt: UPDATED })
    expect(printed()).toBe([
      'my-app becomes public in the community gallery at once, with no review. Anyone can find it and deploy it.',
      'published my-app version 1.0.0 to the community gallery',
      'take it out again with: insta template unpublish my-app',
      '',
    ].join('\n'))
  })
  it('publishes nothing when the person says no', async () => {
    const { api, calls } = platform(routes())
    await templatePublish('my-app', {}, { api, project: linked(), tty: true, confirm: async () => false })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
    expect(printed()).toContain('nothing was published')
  })
  it('refuses without --yes when nobody can answer, before any request', async () => {
    const { api, calls } = platform(routes())
    await expect(templatePublish('my-app', { org: ORG }, { api, tty: false })).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(2)
    expect(calls).toEqual([])
    expect(stderr.join('')).toBe([
      'refusing to publish my-app without --yes: there is no terminal to confirm on.',
      `Publishing lists the template in the community gallery at once, with no review. Ask the person first, then run: insta template publish my-app --org ${ORG} --yes`,
      '',
    ].join('\n'))
  })
  it('refuses under --json without --yes even on a terminal', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes())
    await expect(templatePublish('my-app', { json: true }, { api, project: linked(), tty: true, confirm })).rejects.toThrow('exit 1')
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it('refuses for an agent without --yes even on a terminal, before any request', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes())
    await expect(templatePublish('my-app', { org: ORG }, { api, tty: true, agent: true, confirm })).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(2)
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(stderr.join('')).toBe([
      'refusing to publish my-app without --yes: an agent passes --yes only after the person has said yes.',
      `Publishing lists the template in the community gallery at once, with no review. Ask the person first, then run: insta template publish my-app --org ${ORG} --yes`,
      '',
    ].join('\n'))
  })
  it('reads agent mode when the deps do not say', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes())
    configureAgent({ source: 'cli-explicit', client: 'unknown' })
    try {
      await expect(templatePublish('my-app', {}, { api, project: linked(), tty: true, confirm })).rejects.toThrow('exit 1')
    } finally {
      configureAgent(null)
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it('publishes for an agent that passes --yes, without asking', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes())
    await templatePublish('my-app', { yes: true }, { api, project: linked(), tty: true, agent: true, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(calls[1]!.body).toEqual({ expectedUpdatedAt: UPDATED })
  })
  it('publishes with --yes and no terminal, without asking', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes())
    await templatePublish('my-app', { yes: true, json: true }, { api, project: linked(), tty: false, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(calls[1]!.body).toEqual({ expectedUpdatedAt: UPDATED })
    expect(JSON.parse(printed())).toEqual({ template: PUBLISHED, editorUrl: EDITOR })
  })
  it.each([
    ['template_not_ready', 400, 'Add a description before publishing.'],
    ['template_draft_changed', 409, 'This draft changed since you opened it. Review the latest version, then publish again.'],
    ['template_taken_down', 409, 'This template was taken down by InstaCloud. Contact support to restore it.'],
  ])("prints the platform's sentence for %s", async (code, status, sentence) => {
    const { api } = platform(routes(() => ({ status, body: { error: sentence, code } })))
    const e = await failure(templatePublish('my-app', { yes: true }, { api, project: linked(), tty: false }))
    expect(e).not.toBeInstanceOf(ApiError)
    expect(e.message).toBe(sentence)
    expect(printed()).toBe('')
  })
})

describe('template unpublish', () => {
  it('takes the template out of the gallery', async () => {
    const { api, calls } = platform({ [`POST ${DRAFT_PATH}/unpublish`]: () => ({ body: { template: view({ status: 'unpublished', publishedVersion: '1.0.0' }) } }) })
    await templateUnpublish('my-app', {}, { api, project: linked() })
    expect(calls).toEqual([{ method: 'POST', path: `${DRAFT_PATH}/unpublish`, body: undefined }])
    expect(printed()).toBe('unpublished my-app: it is out of the community gallery, and deployed copies keep running\n')
  })
  it('prints the view and the link under --json', async () => {
    const template = view({ status: 'unpublished', publishedVersion: '1.0.0' })
    const { api } = platform({ [`POST ${DRAFT_PATH}/unpublish`]: () => ({ body: { template } }) })
    await templateUnpublish('my-app', { json: true }, { api, project: linked() })
    expect(JSON.parse(printed())).toEqual({ template, editorUrl: EDITOR })
  })
})

describe('template delete', () => {
  const routes = { [`DELETE ${DRAFT_PATH}`]: () => ({ body: { ok: true } }) }

  it('asks on a terminal, then deletes', async () => {
    const confirm = vi.fn(async () => true)
    const { api, calls } = platform(routes)
    await templateDelete('my-app', {}, { api, project: linked(), tty: true, confirm })
    expect(confirm).toHaveBeenCalledWith('Delete the draft my-app? This cannot be undone.')
    expect(calls).toEqual([{ method: 'DELETE', path: DRAFT_PATH, body: undefined }])
    expect(printed()).toBe('deleted the draft my-app\n')
  })
  it('deletes nothing when the person says no', async () => {
    const { api, calls } = platform(routes)
    await templateDelete('my-app', {}, { api, project: linked(), tty: true, confirm: async () => false })
    expect(calls).toEqual([])
    expect(printed()).toBe('nothing was deleted\n')
  })
  it('refuses without --yes when nobody can answer, before any request', async () => {
    const { api, calls } = platform(routes)
    const project = linked()
    await expect(templateDelete('my-app', {}, { api, project, tty: false })).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(2)
    expect(calls).toEqual([])
    expect(project).not.toHaveBeenCalled()
    expect(stderr.join('')).toBe([
      'refusing to delete the draft my-app without --yes: there is no terminal to confirm on.',
      'Deleting cannot be undone. To go ahead, run: insta template delete my-app --yes',
      '',
    ].join('\n'))
  })
  it('refuses for an agent without --yes even on a terminal, before any request', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes)
    const project = linked()
    await expect(templateDelete('my-app', {}, { api, project, tty: true, agent: true, confirm })).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(2)
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(project).not.toHaveBeenCalled()
    expect(stderr.join('')).toBe([
      'refusing to delete the draft my-app without --yes: an agent passes --yes only after the person has said yes.',
      'Deleting cannot be undone. To go ahead, run: insta template delete my-app --yes',
      '',
    ].join('\n'))
  })
  it('refuses under --json without --yes even on a terminal', async () => {
    const confirm = vi.fn()
    const { api, calls } = platform(routes)
    await expect(templateDelete('my-app', { json: true }, { api, project: linked(), tty: true, confirm })).rejects.toThrow('exit 1')
    expect(process.exitCode).toBe(2)
    expect(confirm).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it('deletes with --yes and prints what it deleted under --json', async () => {
    const { api } = platform(routes)
    await templateDelete('my-app', { yes: true, json: true }, { api, project: linked(), tty: false })
    expect(JSON.parse(printed())).toEqual({ ok: true, orgId: ORG, code: 'my-app' })
  })
  it('leaves a published template to the platform', async () => {
    const { api } = platform({ [`DELETE ${DRAFT_PATH}`]: () => ({ status: 409, body: { error: 'a published template cannot be deleted, unpublish it instead' } }) })
    const e = await failure(templateDelete('my-app', { yes: true }, { api, project: linked(), tty: false }))
    expect(e).toBeInstanceOf(ApiError)
    expect(e.message).toBe('a published template cannot be deleted, unpublish it instead')
  })
})
