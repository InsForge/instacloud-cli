import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  imageTagIssue, validateManifest, collectManifestVariables, parseManifestYaml,
  type TemplateManifest, type TemplateVar,
} from '../src/template-manifest.js'
import {
  templateListLines, templateInfoLines, normalizeInfoServices, normalizeInfoVariables,
  parseSetFlags, resolveVariables, missingVariablesFrom, unreachableReposFrom, looksLikePath, deployMode, templateDeploy, publicBucketLines,
  stepIndexFor, deploymentUrls, serviceStateLines, partialMessage, watchDeployment, DEPLOY_STEPS,
} from '../src/commands/template.js'
import { ApiError } from '../src/api.js'

const MANIFEST: TemplateManifest = {
  code: 'plausible',
  version: '2.1.1',
  maintainer: 'insforge',
  upstream: { pinned: 'ghcr.io/plausible/community-edition:v2.1.1' },
  generated: { 'db-pass': 'secret:32' },
  services: {
    app: {
      type: 'web',
      image: 'ghcr.io/plausible/community-edition:v2.1.1',
      port: 8000,
      healthcheck: '/api/health',
      env: {
        fixed: { DISABLE_REGISTRATION: 'true' },
        generated: { SECRET_KEY_BASE: '${db-pass}' },
        required: { BASE_URL: { description: 'public URL the app is served at' } },
        optional: { SMTP_HOST: 'SMTP relay host' },
      },
    },
    worker: { type: 'worker', image: 'ghcr.io/plausible/community-edition:v2.1.1', volume: true },
  },
}

describe('imageTagIssue', () => {
  it('accepts version tags and digest pins', () => {
    expect(imageTagIssue('nginx:1.27')).toBeNull()
    expect(imageTagIssue('ghcr.io/a/b:v2')).toBeNull()
    expect(imageTagIssue(`nginx@sha256:${'a'.repeat(64)}`)).toBeNull()
  })
  it('rejects tagless and :latest images', () => {
    expect(imageTagIssue('nginx')).toMatch(/no tag/)
    expect(imageTagIssue('nginx:latest')).toMatch(/not a pin/)
  })
  // The registry host carries a port colon — only the last segment names the tag.
  it('is not fooled by a registry port', () => {
    expect(imageTagIssue('registry.local:5000/app')).toMatch(/no tag/)
    expect(imageTagIssue('registry.local:5000/app:1.0')).toBeNull()
  })
  // Digest-pinned means what the PLATFORM says it means: registry.ts's
  // DIGEST = /^sha256:[a-f0-9]{64}$/ applied to whatever follows the last `@` (parseImageRef).
  const HEX64 = 'a'.repeat(64)
  it('accepts only a real sha256 digest as a digest pin', () => {
    expect(imageTagIssue(`nginx@sha256:${HEX64}`)).toBeNull()
    expect(imageTagIssue(`ghcr.io/a/b@sha256:${HEX64}`)).toBeNull()
  })
  it('rejects an @ reference that is not a digest, instead of reading it as a pin', () => {
    expect(imageTagIssue('nginx@weird')).toMatch(/not a sha256 digest/)
    expect(imageTagIssue('nginx@sha256:abc')).toMatch(/not a sha256 digest/) // too short
    expect(imageTagIssue(`nginx@sha256:${'A'.repeat(64)}`)).toMatch(/not a sha256 digest/) // hex is lower-case
    expect(imageTagIssue('nginx@')).toMatch(/not a sha256 digest/)
  })
  // `@` wins over `:` in the platform's grammar, so a malformed digest is never salvaged as a tag.
  it('does not let a malformed digest pass as a tag', () => {
    expect(imageTagIssue('nginx@sha256:xyz')).not.toBeNull()
  })
})

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(MANIFEST)).toEqual([])
  })
  it('requires code, version and at least one service', () => {
    const problems = validateManifest({} as TemplateManifest)
    expect(problems.join('\n')).toMatch(/code is required/)
    expect(problems.join('\n')).toMatch(/version is required/)
    expect(problems.join('\n')).toMatch(/at least one service/)
  })
  it('rejects unpinned images', () => {
    const m = { ...MANIFEST, services: { app: { type: 'worker', image: 'nginx:latest' } } }
    expect(validateManifest(m).join('\n')).toMatch(/not a pin/)
  })
  // The CLI judges only web and worker. Exactly one of image, build or source is its rule.
  it('requires exactly one of image, build or source on a web or worker service', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'web', image: 'a:1', build: 'b', healthcheck: '/' }, b: { type: 'worker' } } }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a: image, build and source are mutually exclusive')
    expect(problems).toContain('services.b: one of image, build or source is required')
  })
  // Spec 2026-10-08 template GitHub sources: the platform parser's rules, said before the upload.
  it('takes source as the third way, with the platform field rules', () => {
    const svc = (extra: Record<string, unknown>) =>
      ({ code: 'x', version: '1', services: { web: { type: 'web', port: 3000, ...extra } } }) as unknown as TemplateManifest
    const src = (s: Record<string, unknown>) => validateManifest(svc({ source: { owner: 'acme', repo: 'shop', ...s } }))
    expect(src({})).toEqual([])
    expect(src({ branch: 'release/2', rootDir: './apps/web', buildCommand: 'pnpm build' })).toEqual([])
    expect(src({ rootDir: '.', buildCommand: '' })).toEqual([])
    expect(validateManifest({ code: 'x', version: '1', services: { jobs: { type: 'worker', source: { owner: 'acme', repo: 'jobs' } } } })).toEqual([])
    expect(validateManifest(svc({ image: 'a:1', source: { owner: 'acme', repo: 'shop' } }))).toEqual(['services.web: image, build and source are mutually exclusive'])
    expect(validateManifest(svc({ source: 'acme/shop' }))).toEqual(['services.web.source must be a map'])
    expect(validateManifest(svc({ source: null }))).toEqual(['services.web.source must be a map'])
    // An unknown key is the platform's call, as an unknown service key is.
    expect(src({ commit: 'abc' })).toEqual([])
    for (const owner of ['', '-acme', 'a'.repeat(40), 'ac_me', 42]) expect(src({ owner }), String(owner)).toEqual(['services.web.source.owner must be a GitHub user or organization name'])
    for (const repo of ['', '.', '..', 'a b', 'a/b', 'r'.repeat(101)]) expect(src({ repo }), repo).toEqual(['services.web.source.repo must be a GitHub repository name'])
    for (const branch of ['', 'a b', 'a..b', '/main', 'main/', 'b'.repeat(256), 7]) expect(src({ branch }), String(branch)).toEqual(['services.web.source.branch must be a branch name'])
    for (const rootDir of ['/apps/web', '../web', 'apps/../../web', 3]) expect(src({ rootDir }), String(rootDir)).toEqual(['services.web.source.rootDir must be a relative path inside the repository'])
    for (const buildCommand of ['x'.repeat(1001), false]) expect(src({ buildCommand }), String(buildCommand).slice(0, 8)).toEqual(['services.web.source.buildCommand must be a command of at most 1000 characters'])
  })

  // Exclusion counts the keys present, the required sentence counts the usable ones. Same rule as the platform.
  it('refuses an empty image or build beside another way as mutually exclusive', () => {
    const svc = (extra: Record<string, unknown>) =>
      ({ code: 'x', version: '1', services: { web: { type: 'web', port: 3000, ...extra } } }) as unknown as TemplateManifest
    const exclusive = ['services.web: image, build and source are mutually exclusive']
    const src = { owner: 'acme', repo: 'shop' }
    expect(validateManifest(svc({ image: '', source: src }))).toEqual(exclusive)
    expect(validateManifest(svc({ build: '', source: src }))).toEqual(exclusive)
    expect(validateManifest(svc({ image: '', build: 'b' }))).toEqual(exclusive)
    expect(validateManifest(svc({ image: 'a:1', build: '' }))).toEqual(exclusive)
  })
  it('keeps the required sentence for an empty image or build on its own', () => {
    const svc = (extra: Record<string, unknown>) =>
      ({ code: 'x', version: '1', services: { web: { type: 'web', port: 3000, ...extra } } }) as unknown as TemplateManifest
    const required = ['services.web: one of image, build or source is required']
    expect(validateManifest(svc({ image: '' }))).toEqual(required)
    expect(validateManifest(svc({ build: '' }))).toEqual(required)
    // Nothing usable, so the required check fails first and exclusion is never asked.
    expect(validateManifest(svc({ image: '', build: '' }))).toEqual(required)
  })

  // The platform accepts a managed postgres (provisioning/templateManifest.ts). This validator
  // used to reject it, so a template pairing an app with a database could not be deployed from a
  // local directory or a GitHub URL at all, though the registry lane took it happily.
  it('accepts a bare managed postgres service', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres' }, web: { type: 'web', image: 'a:1', healthcheck: '/' } },
    }
    expect(validateManifest(m)).toEqual([])
  })

  // Everything but web and worker is the platform's to judge, so the CLI never blocks a type or a
  // field it merely does not know. An old CLI stays usable against a newer platform.
  it('sends a postgres service that tries to configure itself on to the platform to refuse', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres', image: 'postgres:16', port: 5432, volume: true } },
    }
    expect(validateManifest(m)).toEqual([])
  })

  it('leaves env on a postgres service to the platform, and still accepts the empty shell', () => {
    const withEnv: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres', env: { fixed: { A: '1' } } } },
    }
    expect(validateManifest(withEnv)).toEqual([])
    const shell: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres', env: { fixed: {}, generated: {}, required: {}, optional: {} } } },
    }
    expect(validateManifest(shell)).toEqual([])
  })

  it('judges no field of a datastore or a bucket, for every type', () => {
    for (const type of ['postgres', 'redis', 'mysql', 'mongodb', 'storage'] as const) {
      expect(validateManifest({ code: 'x', version: '1', services: { store: { type } } } as unknown as TemplateManifest)).toEqual([])
      for (const field of ['image', 'build', 'port', 'healthcheck', 'volume', 'volumeGib', 'spec', 'alwaysOn', 'command', 'mountPath', 'env']) {
        const value = field === 'mountPath' ? '/x' : field === 'env' ? { fixed: { A: '1' } } : true
        const m = { code: 'x', version: '1', services: { store: { type, [field]: value } } } as unknown as TemplateManifest
        expect(validateManifest(m), `${type}.${field}`).toEqual([])
      }
    }
  })

  it('accepts a postgres with a pgVersion and a public bucket bound into a web service', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: {
        db: { type: 'postgres', pgVersion: 17 },
        files: { type: 'storage', public: true },
        app: {
          type: 'web', image: 'a:1', healthcheck: '/',
          env: { platform: { DATABASE_URL: '${{services.db.DATABASE_URL}}', S3_KEY: '${{services.files.AWS_ACCESS_KEY_ID}}' } },
        },
      },
    }
    expect(validateManifest(m)).toEqual([])
  })

  it('does not judge a type it does not know, an array type included', () => {
    for (const type of ['redys', 'lambda', ['redis']]) {
      const m = { code: 'x', version: '1', services: { a: { type, image: 'a:1' } } } as unknown as TemplateManifest
      expect(validateManifest(m), JSON.stringify(type)).toEqual([])
    }
  })

  // `type: [redis]` stringifies to exactly "redis", so a read through String() would take it for a datastore.
  it('does not read an array type as a datastore when it checks a url ref', () => {
    const m = {
      code: 'x', version: '1',
      services: {
        store: { type: ['redis'] },
        app: { type: 'worker', image: 'a:1', env: { fixed: { TARGET: '${services.store.url}' } } },
      },
    } as unknown as TemplateManifest
    expect(validateManifest(m)).toEqual([])
  })

  // A public bucket may get an address later, so the platform and not this CLI decides on its url or host.
  it('leaves a fixed-value url or host ref to a bucket to the platform', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: {
        files: { type: 'storage', public: true },
        app: { type: 'worker', image: 'a:1', env: { fixed: { TARGET: '${services.files.url}' } } },
      },
    }
    expect(validateManifest(m)).toEqual([])
  })

  // A managed datastore has no url/host: the platform refuses a fixed-value ref to one
  // (provisioning/templateManifest.ts), and this validator must catch it locally too, for every
  // managed type and both address forms.
  it('refuses a fixed-value url/host ref to a managed datastore, for every type', () => {
    for (const type of ['postgres', 'redis', 'mysql', 'mongodb'] as const) {
      for (const key of ['url', 'host'] as const) {
        const m: TemplateManifest = {
          code: 'x', version: '1',
          services: {
            store: { type },
            app: { type: 'worker', image: 'a:1', env: { fixed: { TARGET: `\${services.store.${key}}` } } },
          },
        }
        expect(validateManifest(m).join('\n')).toContain(
          `services.app.env.fixed.TARGET: 'store' is a managed ${type}, so it has no url or host`,
        )
      }
    }
  })
  it('shows the double-brace platform credential form, not the broken single-brace fix', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: {
        store: { type: 'redis' },
        app: { type: 'worker', image: 'a:1', env: { fixed: { TARGET: '${services.store.url}' } } },
      },
    }
    const msg = validateManifest(m).join('\n')
    expect(msg).toContain("'store' is a managed redis, so it has no url or host")
    expect(msg).toContain('${{services.store.<KEY>}}')
    expect(msg).toContain('under env.platform')
    expect(msg).not.toMatch(/instead \(\$\{services\.store\.url\}\)/)
  })

  it('accepts a fixed-value url/host ref to a non-managed service', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: {
        web: { type: 'web', image: 'a:1', healthcheck: '/' },
        app: { type: 'worker', image: 'a:1', env: { fixed: { TARGET: '${services.web.url}' } } },
      },
    }
    expect(validateManifest(m)).toEqual([])
  })
  // The platform made the path optional (#600), so a web service without one is accepted.
  it('accepts a web service without a healthcheck path, and refuses a relative one', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'web', image: 'a:1' }, b: { type: 'web', image: 'b:1', healthcheck: 'health' } } }
    expect(validateManifest(m)).toEqual(['services.b: healthcheck must be an absolute path (start with /)'])
  })
  // The grammar is the platform's HEALTHCHECK_RE: one leading slash, then a path and query charset.
  it('checks a given healthcheck path with the platform grammar', () => {
    const web = (healthcheck: unknown) =>
      ({ code: 'x', version: '1', services: { app: { type: 'web', image: 'a:1', healthcheck } } }) as unknown as TemplateManifest
    for (const ok of ['/', '/healthz', '/api/health?full=1', '/a/b-c_d.e~f%20g']) expect(validateManifest(web(ok)), ok).toEqual([])
    for (const bad of ['//evil.example', '/x\\y', '/a b', '/a#b', '/a\nb']) {
      expect(validateManifest(web(bad)).join('\n'), JSON.stringify(bad)).toMatch(/^services\.app: healthcheck must be a single-slash absolute path/)
    }
    expect(validateManifest(web('http://x/y'))).toEqual(['services.app: healthcheck must be an absolute path (start with /)'])
    expect(validateManifest(web('//evil.example'))).toEqual([
      "services.app: healthcheck must be a single-slash absolute path on the service itself (no '//host', scheme, backslash or control characters), got: //evil.example",
    ])
  })
  // Declared but empty or not a string is not "none", and the platform refuses it.
  it('refuses an empty or non-string healthcheck on a web service', () => {
    const web = (healthcheck: unknown) =>
      ({ code: 'x', version: '1', services: { app: { type: 'web', image: 'a:1', healthcheck } } }) as unknown as TemplateManifest
    expect(validateManifest(web(''))).toEqual(['services.app: healthcheck must be an absolute path (start with /)'])
    for (const odd of [null, {}, ['/']]) expect(validateManifest(web(odd)), JSON.stringify(odd)).toEqual(['services.app.healthcheck must be a string'])
  })
  // A worker is told to remove the path, so it gets no second problem about the path grammar.
  it('refuses a healthcheck on a worker once, whatever the value', () => {
    const worker = (healthcheck: unknown) =>
      ({ code: 'x', version: '1', services: { bg: { type: 'worker', image: 'a:1', healthcheck } } }) as unknown as TemplateManifest
    for (const value of ['/healthz', '//x', '//evil.example', 'health', '', null]) {
      const problems = validateManifest(worker(value))
      expect(problems, JSON.stringify(value)).toHaveLength(1)
      expect(problems[0], JSON.stringify(value)).toMatch(/^services\.bg\.healthcheck: a worker has no HTTP endpoint/)
    }
  })
  it('parses YAML for a web service with no healthcheck path', () => {
    const m = parseManifestYaml(['code: demo', 'version: "1.0"', 'services:', '  app:', '    type: web', '    image: nginx:1.27'].join('\n'))
    expect(m.services?.app?.healthcheck).toBeUndefined()
  })
  it('requires a description on required vars unless a generator answers for the user', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { a: { type: 'worker', image: 'a:1', env: { required: { PLAIN: {}, GEN: { generate: 'secret:16' } } } } },
    }
    expect(validateManifest(m)).toEqual(['services.a.env.required.PLAIN: a description is required (unless generate is set)'])
  })
  it('enforces platform env-name and generator-spec shapes', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', generated: { g: 'uuid' },
      services: { a: { type: 'worker', image: 'a:1', env: { fixed: { lower_case: '1' }, required: { BAD_GEN: { generate: 'secret:0' } } } } },
    }
    const problems = validateManifest(m).join('\n')
    expect(problems).toMatch(/generated\.g: unknown generator 'uuid'/)
    expect(problems).toMatch(/env names must match/)
    expect(problems).toMatch(/BAD_GEN: generate must be secret:N/)
  })
  it('requires env.generated to reference a declared generator', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', generated: { key: 'secret:32' },
      services: { a: { type: 'worker', image: 'a:1', env: { generated: { A_REF: 'plain', B_REF: '${nope}', C_REF: '${key}' } } } },
    }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a.env.generated.A_REF must reference a declared generator like ${name}')
    expect(problems).toContain("services.a.env.generated.B_REF references undeclared generator 'nope'")
    expect(problems).toHaveLength(2)
  })
  // The generator rule is the SERVER's, so it applies wherever a var declares one — an invalid
  // generate on an optional var would otherwise pass locally and fail only on the platform.
  it('checks generate syntax on optional vars too, not just required ones', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { a: { type: 'worker', image: 'a:1', env: { optional: { OPT_GEN: { generate: 'secret:0' } } } } },
    }
    expect(validateManifest(m)).toEqual(['services.a.env.optional.OPT_GEN: generate must be secret:N (1-999), got: secret:0'])
  })
  // The description lint is about a question put to the deployer, so it stays required-only.
  it('does not demand a description on optional vars', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { a: { type: 'worker', image: 'a:1', env: { optional: { PLAIN: {}, GEN: { generate: 'secret:16' } } } } },
    }
    expect(validateManifest(m)).toEqual([])
  })
  // A YAML document holds whatever the author typed. The platform runs these scalars through
  // scalarString (templateManifest.ts): numbers/booleans coerce, anything else is a field error —
  // so a mistyped image must be REPORTED, never crash the pin lint with "includes is not a function".
  it('reports a non-string image/build instead of crashing', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'worker', image: {} as any } } }
    expect(validateManifest(m)).toEqual(['services.a.image must be a string'])
    const b: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'worker', build: [] as any } } }
    expect(validateManifest(b)).toEqual(['services.a.build must be a string'])
  })
  it('coerces a numeric image the way the platform does, then applies the pin lint', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'worker', image: 123 as any } } }
    expect(validateManifest(m)).toEqual(['services.a: image 123 has no tag — pin a version (or a @sha256 digest)'])
  })
  it('rejects out-of-range ports, and any volume that is not `true`', () => {
    // Sizing is the platform's (insta-platform#357), so the CLI refuses an authored size rather
    // than range-checking it — the same answer publish gives, before the upload instead of after.
    const m = { code: 'x', version: '1', services: { a: { type: 'worker', image: 'a:1', port: 70000, volume: { size: 10 } } } } as unknown as TemplateManifest
    const problems = validateManifest(m).join('\n')
    expect(problems).toMatch(/port must be an integer/)
    expect(problems).toMatch(/the volume size is the platform's to choose/)
    // `spec` was never checked here before; it is refused now, for the same reason.
    const withSpec = { code: 'x', version: '1', services: { a: { type: 'worker', image: 'a:1', spec: '1vcpu-1gb' } } } as unknown as TemplateManifest
    expect(validateManifest(withSpec).join('\n')).toMatch(/compute size is the platform's to choose/)
    // The shape a manifest authors today passes.
    expect(validateManifest({ code: 'x', version: '1', services: { a: { type: 'worker', image: 'a:1', volume: true } } })).toEqual([])
  })
  // A worker is PORTLESS (insta-platform#490): the executor deploys it as the platform's port-0
  // service, so a port, a healthcheck or scale-to-zero on one is a contradiction the author hears
  // here, before the upload. Mirrors templateManifest.ts.
  it('a worker is portless: port, healthcheck and alwaysOn:false are refused, the bare shape passes', () => {
    const worker = (extra: Record<string, unknown>) =>
      ({ code: 'x', version: '1', services: { bg: { type: 'worker', image: 'a:1', ...extra } } }) as unknown as TemplateManifest
    expect(validateManifest(worker({}))).toEqual([])
    expect(validateManifest(worker({ alwaysOn: true }))).toEqual([])
    expect(validateManifest(worker({ port: 8080 })).join('\n')).toMatch(/a worker has no routed port/)
    expect(validateManifest(worker({ healthcheck: '/' })).join('\n')).toMatch(/a worker has no HTTP endpoint/)
    expect(validateManifest(worker({ alwaysOn: false })).join('\n')).toMatch(/a worker cannot scale to zero/)
  })

  it('accepts command and mountPath, and refuses the shapes the platform refuses', () => {
    const web = (extra: Record<string, unknown>) =>
      ({ code: 'x', version: '1', services: { app: { type: 'web', image: 'a:1', healthcheck: '/', ...extra } } }) as unknown as TemplateManifest
    expect(validateManifest(web({ command: 'run', volume: true, mountPath: '/app/storage' }))).toEqual([])
    expect(validateManifest(web({ command: ' ' })).join('\n')).toMatch(/services\.app\.command must be a non-empty string/)
    expect(validateManifest(web({ mountPath: '/a' })).join('\n')).toMatch(/services\.app\.mountPath requires volume: true/)
    expect(validateManifest(web({ volume: true, mountPath: 'a' })).join('\n')).toMatch(/services\.app\.mountPath must be an absolute path/)
  })
})

describe('parseManifestYaml', () => {
  it('parses and validates YAML text', () => {
    const m = parseManifestYaml(['code: demo', 'version: "1.0"', 'services:', '  app:', '    type: worker', '    image: nginx:1.27'].join('\n'))
    expect(m.code).toBe('demo')
  })
  it('returns a storage service and a key it does not know exactly as written', () => {
    const m = parseManifestYaml([
      'code: demo', 'version: "1.0"', 'services:',
      '  files:', '    type: storage', '    public: true',
      '  db:', '    type: postgres', '    pgVersion: 17', '    flavour: spicy',
    ].join('\n'))
    expect(m.services).toEqual({
      files: { type: 'storage', public: true },
      db: { type: 'postgres', pgVersion: 17, flavour: 'spicy' },
    })
  })
  it('lists every problem, prefixed with the source file', () => {
    expect(() => parseManifestYaml('code: demo\n', 'x/insta.template.yaml')).toThrow(/x\/insta\.template\.yaml is not deployable:[\s\S]*version is required[\s\S]*at least one service/)
  })
  it('reports YAML syntax errors with the source file', () => {
    expect(() => parseManifestYaml('a: [', 'bad.yaml')).toThrow(/^bad\.yaml:/)
  })
})

describe('collectManifestVariables', () => {
  it('flattens required + optional vars across services (fixed/generated are not questions)', () => {
    const vars = collectManifestVariables(MANIFEST)
    expect(vars).toEqual([
      { name: 'BASE_URL', required: true, description: 'public URL the app is served at', default: undefined, generate: undefined },
      { name: 'SMTP_HOST', required: false, description: 'SMTP relay host', default: undefined, generate: undefined },
    ])
  })
  it('merges duplicates: required anywhere wins, later mentions backfill unset fields', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', services: {
        a: { type: 'worker', image: 'a:1', env: { optional: { K: { default: 'd' } } } },
        b: { type: 'worker', image: 'b:1', env: { required: { K: { description: 'desc' } } } },
      },
    }
    const vars = collectManifestVariables(m)
    expect(vars).toEqual([{ name: 'K', required: true, description: 'desc', default: 'd', generate: undefined }])
  })
})

describe('templateListLines', () => {
  it('renders an aligned table with numeric columns right-aligned', () => {
    const lines = templateListLines([
      { code: 'plausible', version: '2.1.1', name: 'Plausible', tagline: 'web analytics', category: 'analytics', totalProjects: 120, successRate: 79 },
      { code: 'n8n', version: '1.64.0', name: 'n8n', category: 'automation', totalProjects: 7, successRate: null },
    ])
    expect(lines[0]).toMatch(/^CODE\s+VERSION\s+CATEGORY\s+PROJECTS\s+SUCCESS\s+NAME$/)
    expect(lines[1]).toBe('plausible  2.1.1    analytics        120      79%  Plausible — web analytics')
    expect(lines[2]).toBe('n8n        1.64.0   automation         7        -  n8n')
  })
  it('says so when the registry is empty', () => {
    expect(templateListLines([])).toEqual(['(no templates published yet)'])
  })
})

describe('templateInfoLines', () => {
  // The registry detail shape (TemplateDetail): grouped variables, manifest-map services.
  const tpl = {
    code: 'plausible', name: 'Plausible', tagline: 'self-hosted web analytics', version: '2.1.1',
    maintainer: 'insforge', source: 'github.com/plausible/community-edition',
    upstream: { pinned: 'ghcr.io/plausible/community-edition:v2.1.1' },
    services: [
      { name: 'app', type: 'web', port: 8000, healthcheck: '/api/health' },
      { name: 'worker', type: 'worker', volumeGib: 10 },
    ],
    variables: {
      required: [
        { name: 'BASE_URL', required: true, description: 'public URL' },
        { name: 'ADMIN_PWD', required: true, generate: 'secret:32' },
      ],
      optional: [{ name: 'SMTP_HOST', required: false, description: 'SMTP relay', default: 'localhost' }],
    },
  }
  // The rendering layer, not just the normalizer: a manifest names no size, so the summary has to
  // keep SAYING there is a disk. Reading the size out of `volume.size` alone would silently drop
  // that half of the line the moment the catalog is republished.
  it('says a boolean-volume service has a disk, and still prints a size when the registry has one', () => {
    const boolTpl = { ...tpl, services: [{ name: 'agent', type: 'web', port: 7681, volume: true }] }
    expect(templateInfoLines(boolTpl)).toContain('services (1): agent (web, port 7681, no health check, persistent /data)')
    const sizedTpl = { ...tpl, services: [{ name: 'agent', type: 'web', port: 7681, volumeGib: 10 }] }
    expect(templateInfoLines(sizedTpl)).toContain('services (1): agent (web, port 7681, no health check, 10Gi volume)')
    const customMountTpl = { ...tpl, services: [{ name: 'agent', type: 'web', port: 7681, volume: true, mountPath: '/app/storage' }] }
    expect(templateInfoLines(customMountTpl)).toContain('services (1): agent (web, port 7681, no health check, persistent /app/storage)')
  })

  it('says the Postgres version and whether a bucket is public', () => {
    const t = {
      ...tpl,
      services: {
        app: { type: 'web', port: 8000 },
        db: { type: 'postgres', pgVersion: 17 },
        assets: { type: 'storage', public: true },
        scratch: { type: 'storage' },
      },
    }
    expect(templateInfoLines(t)).toContain(
      'services (4): app (web, port 8000, no health check), db (postgres 17), assets (storage, public), scratch (storage, private)',
    )
  })
  it('names a postgres with no version plainly, and ignores pgVersion and public on other types', () => {
    const t = { ...tpl, services: { db: { type: 'postgres' }, app: { type: 'web', port: 80, pgVersion: 17, public: true } } }
    expect(templateInfoLines(t)).toContain('services (2): db (postgres), app (web, port 80, no health check)')
  })
  it('says a web service health check, or that it has none, and nothing for any other type', () => {
    const t = {
      ...tpl,
      services: {
        site: { type: 'web', port: 80, healthcheck: '/healthz' },
        root: { type: 'web', port: 81, healthcheck: '/' },
        bare: { type: 'web', port: 82 },
        queue: { type: 'worker', healthcheck: '/ignored' },
        db: { type: 'postgres', healthcheck: '/ignored' },
      },
    }
    expect(templateInfoLines(t)).toContain(
      'services (5): site (web, port 80, health check /healthz), root (web, port 81, health check /), bare (web, port 82, no health check), queue (worker), db (postgres)',
    )
  })
  it('carries a healthcheck only when it is a string', () => {
    expect(normalizeInfoServices({ a: { type: 'web', healthcheck: '/healthz' }, b: { type: 'web', healthcheck: 5 }, c: { type: 'web' } })).toEqual([
      { name: 'a', type: 'web', healthcheck: '/healthz', volume: false },
      { name: 'b', type: 'web', volume: false },
      { name: 'c', type: 'web', volume: false },
    ])
  })
  it('carries pgVersion and public only when they are the right kind of value', () => {
    expect(normalizeInfoServices({
      db: { type: 'postgres', pgVersion: 17 },
      files: { type: 'storage', public: true },
      odd: { type: 'postgres', pgVersion: '17', public: 'yes' },
    })).toEqual([
      { name: 'db', type: 'postgres', pgVersion: 17, volume: false },
      { name: 'files', type: 'storage', public: true, volume: false },
      { name: 'odd', type: 'postgres', volume: false },
    ])
  })
  it('renders header fields, a services summary, and grouped variables', () => {
    const lines = templateInfoLines(tpl)
    expect(lines[0]).toBe('plausible — Plausible')
    expect(lines).toContain('  version     2.1.1')
    expect(lines).toContain('  source      github.com/plausible/community-edition')
    expect(lines).toContain('  upstream    ghcr.io/plausible/community-edition:v2.1.1')
    expect(lines).toContain('services (2): app (web, port 8000, health check /api/health), worker (worker, 10Gi volume)')
    const text = lines.join('\n')
    expect(text).toMatch(/required:\n\s+BASE_URL\s+public URL\n\s+ADMIN_PWD\s+\(generated: secret:32\)/)
    expect(text).toMatch(/optional:\n\s+SMTP_HOST\s+SMTP relay \(default: localhost\)/)
  })
  it('bolds required variable names with the injected emphasis', () => {
    const lines = templateInfoLines(tpl, (s) => `<b>${s}</b>`)
    expect(lines.join('\n')).toContain('<b>BASE_URL')
    expect(lines.join('\n')).not.toContain('<b>SMTP_HOST')
  })
  it('renders manifest-shaped (map) services too, normalized or not', () => {
    // Three registry vintages at once: the boolean a manifest declares now, and the two sized
    // shapes older rows still carry. All three must read back as "has a disk".
    expect(normalizeInfoServices({
      app: { type: 'web', port: 80 },
      bool: { type: 'worker', volume: true },
      worker: { type: 'worker', volume: { size: 5 } },
      norm: { volumeGib: 3 },
      custom: { type: 'web', port: 7681, volume: true, mountPath: '/app/storage' },
    })).toEqual([
      { name: 'app', type: 'web', port: 80, volumeGib: undefined, volume: false, mountPath: undefined },
      { name: 'bool', type: 'worker', port: undefined, volumeGib: undefined, volume: true, mountPath: undefined },
      { name: 'worker', type: 'worker', port: undefined, volumeGib: 5, volume: true, mountPath: undefined },
      { name: 'norm', type: undefined, port: undefined, volumeGib: 3, volume: true, mountPath: undefined },
      { name: 'custom', type: 'web', port: 7681, volumeGib: undefined, volume: true, mountPath: '/app/storage' },
    ])
  })
  it('accepts flat variable arrays too', () => {
    const vars = normalizeInfoVariables([{ name: 'A', required: true, description: 'a' }, { name: 'B' }])
    expect(vars).toMatchObject([{ name: 'A', required: true }, { name: 'B', required: false }])
  })
})

describe('publicBucketLines', () => {
  it('names each public bucket, whichever shape the services arrive in', () => {
    const line = (name: string) => `${name}: public bucket, anyone can read its files (anonymous public-read)`
    const map = { media: { type: 'storage', public: true }, docs: { type: 'storage', public: true }, quiet: { type: 'storage', public: false }, scratch: { type: 'storage' } }
    expect(publicBucketLines(map)).toEqual([line('media'), line('docs')])
    expect(publicBucketLines(Object.entries(map).map(([name, s]) => ({ name, ...s })))).toEqual([line('media'), line('docs')])
  })

  it('says nothing for a service that is not a bucket, or for no services at all', () => {
    expect(publicBucketLines({ app: { type: 'web', public: true }, db: { type: 'postgres', public: true } })).toEqual([])
    expect(publicBucketLines({ files: { type: 'storage', public: 'yes' } })).toEqual([])
    expect(publicBucketLines(undefined)).toEqual([])
  })
})

describe('parseSetFlags', () => {
  it('parses NAME=value pairs, last occurrence winning; values may contain =', () => {
    expect(parseSetFlags(['A=1', 'B_2=x=y', 'A=2'])).toEqual({ A: '2', B_2: 'x=y' })
  })
  it('rejects pairs without =, and names outside the platform env-name rule', () => {
    expect(() => parseSetFlags(['JUNK'])).toThrow(/--set expects NAME=value/)
    expect(() => parseSetFlags(['1A=2'])).toThrow(/--set expects NAME=value/)
    expect(() => parseSetFlags(['lower=2'])).toThrow(/--set expects NAME=value/)
  })
})

describe('resolveVariables', () => {
  const V = (v: Partial<TemplateVar> & { name: string }): TemplateVar => ({ required: true, ...v })
  it('--set wins over everything, and unknown --set names pass through', async () => {
    const values = await resolveVariables([V({ name: 'A', generate: 'secret:8' })], { A: 'mine', EXTRA: 'x' })
    expect(values).toEqual({ A: 'mine', EXTRA: 'x' })
  })
  // The platform resolves provided → generator → default itself; generated secrets never transit.
  it('leaves generator-backed and defaulted vars off the wire, reporting them', async () => {
    const auto: string[] = []
    const values = await resolveVariables(
      [V({ name: 'KEY', generate: 'secret:8' }), V({ name: 'R', default: 'r' }), V({ name: 'O', required: false, default: 'o' })],
      {},
      { onAutoResolved: (v) => auto.push(v.name) },
    )
    expect(values).toEqual({})
    expect(auto).toEqual(['KEY', 'R', 'O'])
  })
  it('skips optional vars without prompting', async () => {
    expect(await resolveVariables([V({ name: 'O', required: false, description: 'opt' })], {}, {})).toEqual({})
  })
  it('prompts for missing required vars on a TTY', async () => {
    const values = await resolveVariables([V({ name: 'URL', description: 'public URL' })], {}, { tty: true, ask: async (v) => `asked:${v.name}` })
    expect(values).toEqual({ URL: 'asked:URL' })
  })
  it('fails with a machine-readable list when it cannot ask', async () => {
    await expect(resolveVariables([V({ name: 'URL', description: 'public URL' })], {}, {}))
      .rejects.toThrow(/missing required template variables:[\s\S]*URL\s+public URL[\s\S]*--set NAME=value/)
  })
})

describe('missingVariablesFrom', () => {
  it('extracts the platform missing_variables payload', () => {
    expect(missingVariablesFrom({ error: 'missing_variables', missing: [{ name: 'A', key: 'A', description: 'a' }] }))
      .toEqual([{ name: 'A', required: true, description: 'a' }])
    expect(missingVariablesFrom({ error: 'missing_variables', missing: [{ name: 'B', key: 'B' }] }))
      .toEqual([{ name: 'B', required: true, description: undefined }])
  })
  it('leaves other errors alone', () => {
    expect(missingVariablesFrom({ error: 'forbidden' })).toBeNull()
    expect(missingVariablesFrom(undefined)).toBeNull()
  })
})

describe('unreachableReposFrom', () => {
  it('reads the repos of both access codes, each repo once, case-insensitively', () => {
    const repos = [
      { service: 'web', owner: 'acme', repo: 'shop', branch: 'main' },
      { service: 'jobs', owner: 'Acme', repo: 'Shop', branch: 'dev' },
      { service: 'api', owner: 'acme', repo: 'api', branch: 'main' },
    ]
    for (const code of ['github_not_linked', 'github_repo_unreachable']) {
      expect(unreachableReposFrom({ error: 'x', code, repos }), code).toEqual([{ owner: 'acme', repo: 'shop' }, { owner: 'acme', repo: 'api' }])
    }
  })
  it('drops an entry without a string owner and repo', () => {
    expect(unreachableReposFrom({ code: 'github_not_linked', repos: [{ owner: 'acme' }, null, 'acme/shop', { owner: 'acme', repo: 7 }] })).toEqual([])
    expect(unreachableReposFrom({ code: 'github_not_linked' })).toEqual([])
  })
  it('drops control characters from a repo name, as the CLI prints it later', () => {
    const repos = [{ owner: 'ac\u001b[31mme', repo: 'sh\u009bop' }, { owner: 'acme', repo: 'api' }, { owner: 'ac\u001bme', repo: 'a\u009bpi' }]
    expect(unreachableReposFrom({ code: 'github_not_linked', repos })).toEqual([{ owner: 'ac[31mme', repo: 'shop' }, { owner: 'acme', repo: 'api' }])
  })
  it('leaves every other error alone, the publish refusal included', () => {
    const others = [{ error: 'missing_variables', missing: [] }, { code: 'template_source_unreachable', repos: [{ owner: 'acme', repo: 'shop' }] }, { error: 'github_not_linked' }, undefined, null]
    for (const body of others) expect(unreachableReposFrom(body)).toBeNull()
  })
})

describe('looksLikePath', () => {
  it('reads ./dir, absolute and nested paths as paths, bare codes as codes', () => {
    expect(looksLikePath('./tpl')).toBe(true)
    expect(looksLikePath('/abs/tpl')).toBe(true)
    expect(looksLikePath('sub/dir')).toBe(true)
    expect(looksLikePath('plausible')).toBe(false)
  })
})

// Write a valid manifest into <tmp>/<name>/ and return the temp root.
function manifestDir(name: string, code = name): string {
  const root = mkdtempSync(join(tmpdir(), 'insta-tpl-'))
  mkdirSync(join(root, name))
  writeFileSync(
    join(root, name, 'insta.template.yaml'),
    ['code: ' + code, 'version: "1.0"', 'services:', '  app:', '    type: worker', '    image: nginx:1.27', ''].join('\n'),
  )
  return root
}

describe('deployMode', () => {
  // The shadowing regression: a manifest sitting at ./plausible must NOT hijack the registry code.
  it('reads a bare word as a registry code even when a same-named local manifest exists', () => {
    expect(deployMode('plausible', () => true)).toEqual({ kind: 'registry', code: 'plausible' })
  })
  it('reads a path-looking target as a local directory', () => {
    expect(deployMode('./plausible', () => true)).toEqual({ kind: 'local', dir: join(process.cwd(), 'plausible') })
  })
  it('fails a path-looking target with no manifest instead of falling back to the registry', () => {
    expect(() => deployMode('./plausible', () => false)).toThrow(/no insta\.template\.yaml at/)
  })
  it('finds the manifest on disk by default', () => {
    const root = manifestDir('tpl')
    expect(deployMode(join(root, 'tpl'))).toEqual({ kind: 'local', dir: join(root, 'tpl') })
    expect(() => deployMode(join(root, 'absent'))).toThrow(/no insta\.template\.yaml at/)
  })

  // A URL contains `/`, so the GitHub branch must win before looksLikePath claims it as a directory.
  it('reads a GitHub URL as a github target, not a local directory', () => {
    expect(deployMode('https://github.com/acme/tpl/tree/v2/templates/bot', () => false)).toEqual({
      kind: 'github',
      target: { owner: 'acme', repo: 'tpl', refAndPath: 'v2/templates/bot' },
    })
  })
  it('still rejects a malformed github.com URL instead of treating it as a path', () => {
    expect(() => deployMode('https://github.com/acme/tpl/pull/3', () => false)).toThrow(/unsupported template source/)
  })
  // A non-GitHub URL must not end up as "no insta.template.yaml at <cwd>/https:/gitlab.com/a/b".
  it('rejects a non-GitHub URL by name rather than as a missing manifest', () => {
    expect(() => deployMode('https://gitlab.com/a/b', () => false)).toThrow(/unsupported template source/)
  })

  // looksLikePath advertises `~` as a local path, so it has to actually resolve: path.resolve()
  // never expands it, and a quoted target never reaches the shell that would.
  describe('~ expansion', () => {
    const origHome = process.env.HOME
    const origUserProfile = process.env.USERPROFILE
    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome
      if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile
    })

    const setHome = (home: string) => {
      process.env.HOME = home
      process.env.USERPROFILE = home
    }

    it('expands a leading ~/ to the home directory', () => {
      const root = manifestDir('tpl')
      setHome(root)
      expect(deployMode('~/tpl')).toEqual({ kind: 'local', dir: join(root, 'tpl') })
    })
    it('expands a bare ~ to the home directory itself', () => {
      const root = manifestDir('tpl')
      setHome(join(root, 'tpl'))
      expect(deployMode('~')).toEqual({ kind: 'local', dir: join(root, 'tpl') })
    })
    it('still reads a bare word as a registry code, ~ or no ~', () => {
      const root = manifestDir('tpl')
      setHome(root)
      expect(deployMode('tpl')).toEqual({ kind: 'registry', code: 'tpl' })
    })
    // ~user needs a passwd lookup; leaving it literal beats guessing another user's home.
    it('leaves ~user alone', () => {
      expect(() => deployMode('~someone/tpl')).toThrow(/no insta\.template\.yaml at/)
    })
  })
})

// The deploy path itself: api + linked project are injected (the deps pattern), so these cover the
// side-effectful command — which mode a target selects, and what lands on stdout.
function fakeApi(
  deployment: any = { status: 'succeeded', services: [{ name: 'app', state: 'healthy', url: 'https://app.example' }] },
  postResult: { status: number; body: any } = { status: 200, body: { deploymentId: 'dep_1' } },
  templateVars: unknown = { required: [], optional: [] },
  templateServices?: unknown,
) {
  const posts: any[] = []
  const polls: string[] = []
  const pollScopes: unknown[] = []
  const api = {
    request: async (_m: string, path: string, _body?: unknown, opts?: unknown) => {
      if (path.startsWith('/templates/')) return { template: { code: 'plausible', variables: templateVars, ...(templateServices ? { services: templateServices } : {}) } }
      if (path.startsWith('/template-deployments/')) { polls.push(path); pollScopes.push(opts); return deployment }
      throw new Error(`unexpected GET ${path}`)
    },
    rawRequest: async (_m: string, _path: string, body?: unknown) => {
      posts.push(body)
      return postResult
    },
  }
  return { api, posts, polls, pollScopes }
}

const PROJECT = { projectId: 'proj_1', orgId: 'org_1', branch: 'main' }
const NO_WAIT = async () => {}

describe('templateDeploy', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })

  it('sends a bare target as a registry code, not the same-named local manifest', async () => {
    const root = manifestDir('plausible')
    const cwd = process.cwd()
    const { api, posts, polls, pollScopes } = fakeApi()
    try {
      process.chdir(root)
      await templateDeploy('plausible', {}, { api, project: PROJECT, wait: NO_WAIT })
    } finally { process.chdir(cwd) }
    expect(posts).toEqual([{ templateCode: 'plausible', branch: 'main', variables: {} }])
    // The poll route carries no /projects/:id, so the command must name the project it deployed
    // into — in agent mode that is what selects the project-bound session over a bootstrap one.
    expect(polls).toEqual(['/template-deployments/dep_1'])
    expect(pollScopes).toEqual([{ projectId: 'proj_1' }])
    expect(stdout.join('')).not.toMatch(/local template/)
  })

  it('sends the local manifest inline when the target is a path', async () => {
    const root = manifestDir('plausible', 'plausible-fork')
    const cwd = process.cwd()
    const { api, posts } = fakeApi()
    try {
      process.chdir(root)
      await templateDeploy('./plausible', {}, { api, project: PROJECT, wait: NO_WAIT })
    } finally { process.chdir(cwd) }
    expect(posts[0].manifest.code).toBe('plausible-fork')
    expect(posts[0].templateCode).toBeUndefined()
    expect(stdout.join('')).toContain('deploying local template plausible-fork@1.0')
  })

  // The platform is the authority on fields: a storage service, a pgVersion and a key the CLI has
  // never heard of all travel exactly as written, and the platform's answer decides.
  it('sends a public bucket, a pgVersion and an unknown service key verbatim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'insta-tpl-'))
    mkdirSync(join(root, 'bucket'))
    writeFileSync(join(root, 'bucket', 'insta.template.yaml'), [
      'code: bucket', 'version: "1.0"', 'services:',
      '  files:', '    type: storage', '    public: true',
      '  db:', '    type: postgres', '    pgVersion: 17', '    flavour: spicy',
      '  app:', '    type: worker', '    image: nginx:1.27', '',
    ].join('\n'))
    const { api, posts } = fakeApi()
    await templateDeploy(join(root, 'bucket'), {}, { api, project: PROJECT, wait: NO_WAIT })
    expect(posts).toHaveLength(1)
    expect(posts[0].manifest.services).toEqual({
      files: { type: 'storage', public: true },
      db: { type: 'postgres', pgVersion: 17, flavour: 'spicy' },
      app: { type: 'worker', image: 'nginx:1.27' },
    })
  })

  // Only `template info` used to say a bucket is public, so the person deploying never heard it.
  const PUBLIC_LINE = 'files: public bucket, anyone can read its files (anonymous public-read)'
  const BUCKETS = {
    files: { type: 'storage', public: true },
    scratch: { type: 'storage' },
    db: { type: 'postgres', pgVersion: 17 },
    app: { type: 'worker', image: 'nginx:1.27' },
  }

  it('says which buckets are public when a local manifest deploys, and nothing about a private one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'insta-tpl-'))
    mkdirSync(join(root, 'bucket'))
    writeFileSync(join(root, 'bucket', 'insta.template.yaml'), [
      'code: bucket', 'version: "1.0"', 'services:',
      '  files:', '    type: storage', '    public: true',
      '  scratch:', '    type: storage',
      '  app:', '    type: worker', '    image: nginx:1.27', '',
    ].join('\n'))
    const { api } = fakeApi()
    await templateDeploy(join(root, 'bucket'), {}, { api, project: PROJECT, wait: NO_WAIT })
    const out = stdout.join('')
    expect(out.split('\n').filter((l) => l.includes('public bucket'))).toEqual([PUBLIC_LINE])
    expect(out).not.toContain('scratch:')
    // It rides with the accepted deploy, ahead of the progress lines.
    expect(out.indexOf(PUBLIC_LINE)).toBeGreaterThan(out.indexOf('deploying template bucket to branch main'))
    expect(out.indexOf(PUBLIC_LINE)).toBeLessThan(out.indexOf('create services'))
  })

  it('says it for a registry template too, from the detail the command already reads', async () => {
    const { api } = fakeApi(undefined, undefined, undefined, BUCKETS)
    await templateDeploy('plausible', {}, { api, project: PROJECT, wait: NO_WAIT })
    expect(stdout.join('').split('\n').filter((l) => l.includes('public bucket'))).toEqual([PUBLIC_LINE])
  })

  it('says it for a fetched GitHub manifest', async () => {
    const { api } = fakeApi()
    const manifest = { code: 'bot', version: '1.4.0', services: BUCKETS } as TemplateManifest
    await templateDeploy('https://github.com/acme/tpl', {}, {
      api, project: PROJECT, wait: NO_WAIT,
      fetchGitHub: async () => ({ source: { repo: 'acme/tpl', ref: 'main', path: '', commit: '9'.repeat(40) }, manifest }),
    })
    expect(stdout.join('').split('\n').filter((l) => l.includes('public bucket'))).toEqual([PUBLIC_LINE])
  })

  it('keeps the line out of --json output, and out of a deploy that is only gated', async () => {
    const { api } = fakeApi(undefined, undefined, undefined, BUCKETS)
    await templateDeploy('plausible', { json: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(stdout.join('')).not.toContain('public bucket')
    expect(JSON.parse(stdout.join(''))).toMatchObject({ status: 'succeeded' })
    stdout.length = 0
    const gated = fakeApi(undefined, GATED, undefined, BUCKETS)
    await templateDeploy('plausible', {}, { api: gated.api, project: PROJECT, wait: NO_WAIT })
    expect(stdout.join('')).toBe('')
  })

  // --json is a contract: stdout must parse as ONE document, so no progress line may precede it.
  it('--json prints a single parseable JSON document in local mode', async () => {
    const root = manifestDir('tpl')
    const dep = { status: 'succeeded', services: [{ name: 'app', state: 'healthy', url: 'https://app.example' }] }
    const { api } = fakeApi(dep)
    await templateDeploy(join(root, 'tpl'), { json: true }, { api, project: PROJECT, wait: NO_WAIT })
    const text = stdout.join('')
    expect(JSON.parse(text)).toEqual(dep)
    expect(text).not.toMatch(/local template/)
  })

  it('--json prints a single parseable JSON document in registry mode too', async () => {
    const dep = { status: 'succeeded', services: [] }
    const { api } = fakeApi(dep)
    await templateDeploy('plausible', { json: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(JSON.parse(stdout.join(''))).toEqual(dep)
  })

  // A gated deploy is the other way out of this command, and it must honour the same contract:
  // handleApproval's envelope on stdout, hint on stderr, exit 2 (as util.test.ts pins it).
  const GATED = { status: 202, body: { status: 'approval_required', action: 'template.deploy', approvalId: 'appr_1' } }

  it('--json on an approval-gated deploy prints just the raw 202 envelope (exit 2)', async () => {
    const { api, polls } = fakeApi(undefined, GATED)
    await templateDeploy('plausible', { json: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(JSON.parse(stdout.join(''))).toEqual(GATED.body)
    expect(stdout.join('')).not.toMatch(/approval required for/)
    expect(stderr.join('')).toMatch(/approval required for template\.deploy — run: insta agent approvals approve appr_1/)
    expect(process.exitCode).toBe(2)
    expect(polls).toEqual([]) // nothing was deployed, so nothing is polled
  })

  it('an approval-gated deploy keeps stdout empty without --json', async () => {
    const { api } = fakeApi(undefined, GATED)
    await templateDeploy('plausible', {}, { api, project: PROJECT, wait: NO_WAIT })
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toMatch(/approval required for template\.deploy/)
    expect(process.exitCode).toBe(2)
  })

  // --json also turns prompting off, so a missing required variable must fail on stderr (guard() →
  // die(), the repo's error channel) rather than blocking on a prompt or dirtying stdout.
  it('--json never prompts: a missing required variable fails with the --set list, stdout clean', async () => {
    const { api, posts } = fakeApi(undefined, GATED, { required: [{ name: 'BASE_URL', description: 'public URL' }], optional: [] })
    await expect(
      templateDeploy('plausible', { json: true }, { api, project: PROJECT, wait: NO_WAIT, ask: async () => 'prompted!' }),
    ).rejects.toThrow(/missing required template variables:[\s\S]*BASE_URL\s+public URL[\s\S]*--set NAME=value/)
    expect(stdout.join('')).toBe('')
    expect(posts).toEqual([])
  })

  const GH_SOURCE = { repo: 'acme/tpl', ref: 'v2', path: 'templates/bot', commit: '9'.repeat(40) }
  const GH_MANIFEST: TemplateManifest = {
    code: 'bot', version: '1.4.0',
    services: { app: { type: 'worker', image: 'ghcr.io/acme/bot:1.4.0' } },
  }
  const fetchGitHub = async () => ({ source: GH_SOURCE, manifest: GH_MANIFEST })

  it('sends the fetched manifest inline and prints the source with its commit', async () => {
    const { api, posts } = fakeApi()
    await templateDeploy('https://github.com/acme/tpl/tree/v2/templates/bot', {}, {
      api, project: PROJECT, wait: NO_WAIT, fetchGitHub,
    })
    expect(posts[0].manifest.code).toBe('bot')
    expect(posts[0].templateCode).toBeUndefined()
    const out = stdout.join('')
    expect(out).toContain('fetching template bot@1.4.0 from github.com/acme/tpl@v2 (templates/bot) at 9999999')
    // Exactly one line goes in front of today's output, and it must not read as a second copy of
    // the "deploying template bot to branch main" line that follows.
    expect(out.match(/^deploying template /gm) ?? []).toHaveLength(1)
    expect(out).toContain('deploying template bot to branch main')
  })

  it('--json carries the source in front of the deployment document', async () => {
    const dep = { status: 'succeeded', services: [{ name: 'app', state: 'healthy', url: 'https://app.example' }] }
    const { api } = fakeApi(dep)
    await templateDeploy('https://github.com/acme/tpl/tree/v2/templates/bot', { json: true }, {
      api, project: PROJECT, wait: NO_WAIT, fetchGitHub,
    })
    const text = stdout.join('')
    expect(JSON.parse(text)).toEqual({ source: GH_SOURCE, ...dep })
    expect(text).not.toMatch(/fetching template/)
  })

  it('leaves registry and local --json output without a source field', async () => {
    const dep = { status: 'succeeded', services: [] }
    const { api } = fakeApi(dep)
    await templateDeploy('plausible', { json: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(JSON.parse(stdout.join('')).source).toBeUndefined()
  })

  it('fails before any platform call when the fetch fails', async () => {
    const { api, posts } = fakeApi()
    await expect(templateDeploy('https://github.com/acme/tpl', {}, {
      api, project: PROJECT, wait: NO_WAIT,
      fetchGitHub: async () => { throw new Error('could not read https://github.com/acme/tpl: repository not found or not accessible.') },
    })).rejects.toThrow(/could not read/)
    expect(posts).toEqual([])
  })

  // Spec acceptance 9: the fetch has already deleted its clone by the time variables are resolved,
  // so a -y failure cannot strand a temp directory.
  it('-y with an unanswered required variable fails with the --set list, after the clone is gone', async () => {
    const NEEDS_VAR: TemplateManifest = {
      code: 'bot', version: '1.4.0',
      services: {
        app: {
          type: 'worker', image: 'ghcr.io/acme/bot:1.4.0',
          env: { required: { ADMIN_PASSWORD: { description: 'admin login password' } } },
        },
      },
    }
    let fetched = false
    const { api, posts } = fakeApi()
    await expect(templateDeploy('https://github.com/acme/tpl', { yes: true }, {
      api, project: PROJECT, wait: NO_WAIT,
      fetchGitHub: async () => { fetched = true; return { source: GH_SOURCE, manifest: NEEDS_VAR } },
      ask: async () => 'prompted!',
    })).rejects.toThrow(/missing required template variables:[\s\S]*ADMIN_PASSWORD\s+admin login password[\s\S]*--set NAME=value/)
    expect(fetched).toBe(true)
    expect(posts).toEqual([])
  })

  it('--region rides the request body, and the accept line names the RECORDED region, not the typed one', async () => {
    // The two differ on purpose: with both set to the same slug this passes either way, so it could
    // not tell reading res.body from echoing opts.region back.
    const { api, posts } = fakeApi(
      undefined,
      { status: 202, body: { deploymentId: 'dep_1', deployment: { id: 'dep_1', region: 'ap-southeast' } } },
    )
    await templateDeploy('plausible', { region: 'eu-central', yes: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ templateCode: 'plausible', branch: 'main', region: 'eu-central' })
    const out = [...stdout, ...stderr].join('')
    expect(out).toContain('to branch main in ap-southeast (dep_1)')
    expect(out).not.toContain('in eu-central')
  })

  it('a platform that echoes no region leaves the accept line as it was', async () => {
    const { api } = fakeApi(undefined, { status: 202, body: { deploymentId: 'dep_1', deployment: { id: 'dep_1' } } })
    await templateDeploy('plausible', { region: 'eu-central', yes: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect([...stdout, ...stderr].join('')).toContain('to branch main (dep_1)')
  })

  it('without --region the body carries no region key at all', async () => {
    const { api, posts } = fakeApi()
    await templateDeploy('plausible', { yes: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(posts).toHaveLength(1)
    expect(posts[0]).not.toHaveProperty('region')
    expect([...stdout, ...stderr].join('')).toContain('to branch main (dep_1)')
  })

  it("--region '' is SENT, so the platform's 400 decides it, rather than silently deploying to the default", async () => {
    const { api, posts } = fakeApi()
    await templateDeploy('plausible', { region: '', yes: true }, { api, project: PROJECT, wait: NO_WAIT })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toHaveProperty('region', '')
  })

  it('a missing-variable retry re-sends the region on the SECOND body too', async () => {
    // The retry path spreads the original body, so region has to survive it. Reaching that path
    // needs a TTY (resolveVariables only prompts there) and a first POST that 400s.
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY }
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      const posts: any[] = []
      let calls = 0
      const api = {
        request: async (_m: string, path: string) => {
          if (path.startsWith('/templates/')) return { template: { code: 'plausible', variables: { required: [], optional: [] } } }
          return { status: 'succeeded', services: [] }
        },
        rawRequest: async (_m: string, _p: string, body?: unknown) => {
          posts.push(body)
          if (++calls === 1) throw new ApiError(400, 'missing variables', { error: 'missing_variables', missing: [{ name: 'API_KEY', key: 'API_KEY' }] })
          return { status: 202, body: { deploymentId: 'dep_1', deployment: { id: 'dep_1', region: 'eu-central' } } }
        },
      }
      await templateDeploy('plausible', { region: 'eu-central' }, { api: api as any, project: PROJECT, wait: NO_WAIT, ask: async () => 'k-1' })
      expect(posts).toHaveLength(2)
      expect(posts[0]).toMatchObject({ region: 'eu-central' })
      expect(posts[1]).toMatchObject({ region: 'eu-central', variables: { API_KEY: 'k-1' } })
    } finally {
      process.stdin.isTTY = tty.in
      process.stdout.isTTY = tty.out
    }
  })

  // Spec 2026-10-08 template GitHub sources: the platform names the repos, the CLI links GitHub.
  const SHOP = { service: 'web', owner: 'acme', repo: 'shop', branch: 'main' }
  const NOT_LINKED = 'this template builds from GitHub repositories only a linked GitHub account can read (acme/shop@main): connect GitHub from your profile in the InstaCloud console, or run insta template deploy in a terminal, then deploy again'
  const UNREACHABLE = "your linked GitHub accounts cannot read acme/shop@main: ask the template's author for access, or install the InstaCloud GitHub App on that repository, then deploy again"
  const refused = (code: string, message: string, repos: unknown[] = [SHOP]) => new ApiError(400, message, { error: message, code, repos })
  const SHOP_ROW = { id: 42, owner: 'acme', repo: 'shop', installationId: 7 }
  const noAuthorize = async () => { throw new Error('must not authorize') }
  // Refuses the first POSTs with `refusals`, then accepts, and answers /me/github/repos in turn.
  function githubPlatform(refusals: Error[], repoAnswers: unknown[]) {
    const calls: string[] = []
    const posts: any[] = []
    const api = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        if (path.startsWith('/templates/')) return { template: { code: 'shop', variables: { required: [], optional: [] } } }
        if (path.startsWith('/template-deployments/')) return { status: 'succeeded', services: [] }
        if (path === '/me/github/setup') return { installUrl: 'https://github.com/apps/instacloud/installations/new?state=nonce' }
        if (path === '/me/github/repos') {
          const answer = repoAnswers.shift()
          if (!answer) throw new Error('unexpected repos read')
          return answer
        }
        throw new Error(`unexpected ${method} ${path}`)
      },
      rawRequest: async (method: string, path: string, body?: unknown) => {
        calls.push(`${method} ${path}`)
        posts.push(body)
        const refusal = refusals.shift()
        if (refusal) throw refusal
        return { status: 202, body: { deploymentId: 'dep_1' } }
      },
    }
    return { api, calls, posts }
  }
  // canAuthorizeHere reads the stderr terminal (github-connect.test.ts sets it the same way).
  async function withStderrTTY<T>(value: boolean, run: () => Promise<T>): Promise<T> {
    const was = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true })
    try { return await run() } finally { Object.defineProperty(process.stderr, 'isTTY', { value: was, configurable: true }) }
  }
  const DEPLOYED = ['POST /projects/proj_1/template-deployments', 'GET /template-deployments/dep_1']

  it('links GitHub with the device flow on a terminal, then deploys again with the same body', async () => {
    const { api, calls, posts } = githubPlatform([refused('github_not_linked', NOT_LINKED)], [{ linked: false, repos: [], installations: [] }])
    const authorize = vi.fn(async () => [SHOP_ROW])
    const opened: string[] = []
    await withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, authorize, open: (u: string) => { opened.push(u); return true } }))
    expect(authorize).toHaveBeenCalledOnce()
    expect(calls).toEqual(['GET /templates/shop', 'POST /projects/proj_1/template-deployments', 'GET /me/github/repos', ...DEPLOYED])
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    expect(opened).toEqual([])
    expect(stderr.join('')).toContain(NOT_LINKED)
    expect(stdout.join('')).toContain('template shop deployed to branch main')
  })

  it('opens the App install for a repo the linked account cannot reach, waits for it, then deploys again', async () => {
    const linked = { linked: true, repos: [], installations: [] }
    const { api, calls, posts } = githubPlatform([refused('github_repo_unreachable', UNREACHABLE)], [linked, { linked: true, repos: [SHOP_ROW], installations: [] }])
    const opened: string[] = []
    await withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, authorize: noAuthorize, open: (u: string) => { opened.push(u); return true } }))
    expect(opened).toEqual(['https://github.com/apps/instacloud/installations/new?state=cli'])
    expect(calls).toEqual(['GET /templates/shop', 'POST /projects/proj_1/template-deployments', 'GET /me/github/repos', 'POST /me/github/setup', 'GET /me/github/repos', ...DEPLOYED])
    expect(posts).toHaveLength(2)
    expect(stderr.join('')).toContain(UNREACHABLE)
    expect(stderr.join('')).toContain('install the InstaCloud GitHub App on acme and grant access to acme/shop')
  })

  it('asks GitHub once per repo, however many services build from it', async () => {
    const both = [SHOP, { ...SHOP, service: 'jobs', branch: 'dev' }, { service: 'api', owner: 'acme', repo: 'api', branch: 'main' }]
    const listed = { linked: true, repos: [SHOP_ROW, { id: 43, owner: 'acme', repo: 'api', installationId: 7 }], installations: [] }
    const { api, calls, posts } = githubPlatform([refused('github_repo_unreachable', UNREACHABLE, both)], [listed, listed])
    await withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, authorize: noAuthorize, open: () => true }))
    expect(calls.filter((c) => c === 'GET /me/github/repos')).toHaveLength(2)
    expect(posts).toHaveLength(2)
  })

  it('--json prints the platform message and stops, with no GitHub call', async () => {
    const { api, calls } = githubPlatform([refused('github_not_linked', NOT_LINKED)], [])
    await expect(withStderrTTY(true, () => templateDeploy('shop', { json: true }, { api, project: PROJECT, wait: NO_WAIT, authorize: noAuthorize, open: () => true })))
      .rejects.toThrow(NOT_LINKED)
    expect(calls).toEqual(['GET /templates/shop', 'POST /projects/proj_1/template-deployments'])
    expect(stdout.join('')).toBe('')
  })

  it('with no terminal it stops the same way', async () => {
    const { api, calls } = githubPlatform([refused('github_repo_unreachable', UNREACHABLE)], [])
    await expect(withStderrTTY(false, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, authorize: noAuthorize, open: () => true })))
      .rejects.toThrow(UNREACHABLE)
    expect(calls).toEqual(['GET /templates/shop', 'POST /projects/proj_1/template-deployments'])
  })

  it('retries once: a second refusal after linking is the error', async () => {
    const { api, posts } = githubPlatform([refused('github_not_linked', NOT_LINKED), refused('github_not_linked', NOT_LINKED)], [{ linked: false, repos: [], installations: [] }])
    const authorize = vi.fn(async () => [SHOP_ROW])
    await expect(withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, authorize, open: () => true })))
      .rejects.toThrow(NOT_LINKED)
    expect(authorize).toHaveBeenCalledOnce()
    expect(posts).toHaveLength(2)
  })

  it('answers a missing-variables refusal once: a second one is the error, not another prompt', async () => {
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY }
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      const missing = () => new ApiError(400, 'missing_variables', { error: 'missing_variables', missing: [{ name: 'API_KEY', key: 'API_KEY' }] })
      const { api, posts } = githubPlatform([missing(), missing()], [])
      const ask = vi.fn(async () => 'k-1')
      await expect(templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, ask, authorize: noAuthorize, open: () => true })).rejects.toThrow('missing_variables')
      expect(ask).toHaveBeenCalledOnce()
      expect(posts).toHaveLength(2)
    } finally {
      process.stdin.isTTY = tty.in
      process.stdout.isTTY = tty.out
    }
  })

  it('answers a missing-variables refusal that comes after the GitHub one too', async () => {
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY }
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      const missing = new ApiError(400, 'missing_variables', { error: 'missing_variables', missing: [{ name: 'API_KEY', key: 'API_KEY' }] })
      const { api, posts } = githubPlatform([refused('github_not_linked', NOT_LINKED), missing], [{ linked: false, repos: [], installations: [] }])
      await withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, ask: async () => 'k-1', authorize: async () => [SHOP_ROW], open: () => true }))
      expect(posts).toHaveLength(3)
      expect(posts[2]).toMatchObject({ templateCode: 'shop', variables: { API_KEY: 'k-1' } })
    } finally {
      process.stdin.isTTY = tty.in
      process.stdout.isTTY = tty.out
    }
  })

  it('answers a missing-variables refusal first and a GitHub refusal second, once each', async () => {
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY }
    process.stdin.isTTY = true
    process.stdout.isTTY = true
    try {
      const missing = new ApiError(400, 'missing_variables', { error: 'missing_variables', missing: [{ name: 'API_KEY', key: 'API_KEY' }] })
      const { api, calls, posts } = githubPlatform([missing, refused('github_not_linked', NOT_LINKED)], [{ linked: false, repos: [], installations: [] }])
      const ask = vi.fn(async () => 'k-1')
      const authorize = vi.fn(async () => [SHOP_ROW])
      await withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, ask, authorize, open: () => true }))
      expect(ask).toHaveBeenCalledOnce()
      expect(authorize).toHaveBeenCalledOnce()
      expect(calls).toEqual(['GET /templates/shop', 'POST /projects/proj_1/template-deployments', 'POST /projects/proj_1/template-deployments', 'GET /me/github/repos', ...DEPLOYED])
      expect(posts).toHaveLength(3)
      expect(posts[1]).toMatchObject({ variables: { API_KEY: 'k-1' } })
      expect(posts[2]).toEqual(posts[1])
      expect(stdout.join('')).toContain('template shop deployed to branch main')
    } finally {
      process.stdin.isTTY = tty.in
      process.stdout.isTTY = tty.out
    }
  })

  it("prints the platform's message without control characters before it links GitHub", async () => {
    const dirty = `${NOT_LINKED}\u001b]0;pwned\u0007 \u009b31m`
    const { api } = githubPlatform([refused('github_not_linked', dirty)], [{ linked: false, repos: [], installations: [] }])
    await withStderrTTY(true, () => templateDeploy('shop', {}, { api, project: PROJECT, wait: NO_WAIT, authorize: async () => [SHOP_ROW], open: () => true }))
    expect(stderr.join('')).toContain(`${NOT_LINKED}]0;pwned 31m\n`)
    expect(stderr.join('')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  })
})

describe('deployment progress', () => {
  it('maps the step field to an index; anything else holds progress', () => {
    expect(stepIndexFor('create_services')).toBe(0)
    expect(stepIndexFor('write_variables')).toBe(1)
    expect(stepIndexFor('deploy')).toBe(2)
    expect(stepIndexFor('health_check')).toBe(3)
    expect(stepIndexFor(undefined)).toBeNull()
    expect(stepIndexFor('somefuturestep')).toBeNull()
  })
  it('renders each step exactly once across polls', async () => {
    const seq = [
      { status: 'running', step: 'create_services' },
      { status: 'running', step: 'create_services' },
      { status: 'running', step: 'deploy' },
      { status: 'succeeded', services: [{ name: 'app', state: 'healthy', url: 'https://app.example' }] },
    ]
    const out: string[] = []
    const dep = await watchDeployment(async () => seq.shift()!, 'd1', (l) => out.push(l), async () => {})
    expect(out).toEqual([
      '  … create services',
      '  ✓ create services',
      '  ✓ write variables',
      '  … deploy',
      '  ✓ deploy',
      '  ✓ health check',
    ])
    expect(deploymentUrls(dep)).toEqual(['app: https://app.example'])
  })
  it('names the failing step and carries the platform error + log tail', async () => {
    const seq = [
      { status: 'running', step: 'deploy' },
      { status: 'failed', step: 'deploy', error: 'image pull failed', logsTail: 'manifest unknown', services: [{ name: 'app', state: 'failed' }] },
    ]
    await expect(watchDeployment(async () => seq.shift()!, 'd1', () => {}, async () => {}))
      .rejects.toThrow(/failed during deploy: image pull failed[\s\S]*✗ app \[failed\][\s\S]*--- log tail ---\nmanifest unknown/)
  })
  // `partial` is TERMINAL (created resources are kept) — without this branch the watcher would
  // poll a settled run to the timeout.
  it('treats partial as terminal, listing per-service outcomes and the way forward', async () => {
    const seq = [
      { status: 'running', step: 'health_check' },
      {
        status: 'partial', step: 'health_check',
        services: [
          { name: 'app', state: 'healthy', url: 'https://app.example' },
          { name: 'worker', state: 'failed' },
        ],
        logsTail: 'OOM killed',
      },
    ]
    await expect(watchDeployment(async () => seq.shift()!, 'd1', () => {}, async () => {}))
      .rejects.toThrow(/finished partial: 1\/2 services healthy[\s\S]*✓ app — https:\/\/app\.example\n\s+✗ worker \[failed\][\s\S]*--- log tail ---\nOOM killed[\s\S]*created services are kept[\s\S]*re-run the deploy to retry/)
  })
  // The first payload often lands before the executor has claimed a step. Announcing
  // `create services` off it would be a guess — hold until the run says where it is.
  it('says nothing yet when the first running payload carries no step', async () => {
    const seq = [
      { status: 'running' },
      { status: 'running', step: 'unknown_future_step' },
      { status: 'running', step: 'write_variables' },
      { status: 'succeeded' },
    ]
    const out: string[] = []
    await watchDeployment(async () => seq.shift()!, 'd1', (l) => out.push(l), async () => {})
    expect(out).toEqual([
      '  ✓ create services',
      '  … write variables',
      '  ✓ write variables',
      '  ✓ deploy',
      '  ✓ health check',
    ])
  })
  it('holds progress on a missing/unknown step instead of guessing', async () => {
    const seq = [{ status: 'running', step: 'deploy' }, { status: 'running' }, { status: 'succeeded' }]
    const out: string[] = []
    await watchDeployment(async () => seq.shift()!, 'd1', (l) => out.push(l), async () => {})
    expect(out.filter((l) => l.includes('…'))).toEqual(['  … deploy'])
    expect(out.filter((l) => l.includes('✓'))).toHaveLength(DEPLOY_STEPS.length)
  })
  it('times out with a pointer to the audit trail', async () => {
    await expect(watchDeployment(async () => ({ status: 'running', step: 'deploy' }), 'd9', () => {}, async () => {}, 0))
      .rejects.toThrow(/timed out .*template deployment d9/)
  })
  it('marks non-terminal service states neutrally', () => {
    expect(serviceStateLines({ services: [{ name: 'app', state: 'created' }] })).toEqual(['  • app [created]'])
    expect(partialMessage({ services: [] })).toMatch(/0\/0 services healthy/)
  })
})
