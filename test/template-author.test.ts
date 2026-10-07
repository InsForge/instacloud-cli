// Template authoring (spec 2026-10-06 §3): a real ApiClient over a fake fetch.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from '../src/api.js'
import type { ProjectConfig } from '../src/config.js'
import {
  templateEditorUrl, templateStatusWord, draftListLines, requirementLines, draftLines,
  templateDrafts, templateDraft, type TemplateDraft,
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
      '  app (web, port 8080, image ghcr.io/acme/app:1.2, volume at /data)',
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
