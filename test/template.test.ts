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
  parseSetFlags, resolveVariables, missingVariablesFrom, looksLikePath, deployMode, templateDeploy,
  stepIndexFor, deploymentUrls, serviceStateLines, partialMessage, watchDeployment, DEPLOY_STEPS,
} from '../src/commands/template.js'

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
  // The platform's service model (templateManifest.ts): type is web|worker, image XOR build.
  it('requires a known type and exactly one of image/build', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'redis' as any, image: 'a:1', build: 'b' }, b: {} } }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a.type must be web, worker or postgres')
    expect(problems).toContain('services.a: image and build are mutually exclusive')
    expect(problems).toContain('services.b: one of image or build is required')
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

  // Bare means bare: the platform owns the image, port, sizing, credentials and env, and silently
  // ignores anything a manifest sets. Naming the field here beats being ignored server-side.
  it('refuses a postgres service that tries to configure itself', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres', image: 'postgres:16', port: 5432, volume: true } },
    }
    const problems = validateManifest(m).join('\n')
    expect(problems).toMatch(/services\.db\.image: a postgres service is platform-managed and carries no image/)
    expect(problems).toMatch(/services\.db\.port: .* carries no port/)
    expect(problems).toMatch(/services\.db\.volume: .* carries no volume/)
    // The bare branch returns before the image/build rules, so it must not also demand an image.
    expect(problems).not.toMatch(/one of image or build is required/)
  })

  it('refuses env on a postgres service, but tolerates an empty shell', () => {
    const withEnv: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres', env: { fixed: { A: '1' } } } },
    }
    expect(validateManifest(withEnv).join('\n')).toMatch(/services\.db\.env: a postgres service is platform-managed and carries no env/)

    // A normalized manifest round-trips through the platform carrying empty groups; accepting the
    // shell means a published manifest can be re-validated locally without edits.
    const shell: TemplateManifest = {
      code: 'x', version: '1',
      services: { db: { type: 'postgres', env: { fixed: {}, generated: {}, required: {}, optional: {} } } },
    }
    expect(validateManifest(shell)).toEqual([])
  })
  it('requires web services to declare an absolute healthcheck path', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'web', image: 'a:1' }, b: { type: 'web', image: 'b:1', healthcheck: 'health' } } }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a: web services must declare a healthcheck path')
    expect(problems).toContain('services.b: healthcheck must be an absolute path (start with /)')
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
})

describe('parseManifestYaml', () => {
  it('parses and validates YAML text', () => {
    const m = parseManifestYaml(['code: demo', 'version: "1.0"', 'services:', '  app:', '    type: worker', '    image: nginx:1.27'].join('\n'))
    expect(m.code).toBe('demo')
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
      { name: 'app', type: 'web', port: 8000 },
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
    expect(templateInfoLines(boolTpl)).toContain('services (1): agent (web, port 7681, persistent /data)')
    const sizedTpl = { ...tpl, services: [{ name: 'agent', type: 'web', port: 7681, volumeGib: 10 }] }
    expect(templateInfoLines(sizedTpl)).toContain('services (1): agent (web, port 7681, 10Gi volume)')
  })

  it('renders header fields, a services summary, and grouped variables', () => {
    const lines = templateInfoLines(tpl)
    expect(lines[0]).toBe('plausible — Plausible')
    expect(lines).toContain('  version     2.1.1')
    expect(lines).toContain('  source      github.com/plausible/community-edition')
    expect(lines).toContain('  upstream    ghcr.io/plausible/community-edition:v2.1.1')
    expect(lines).toContain('services (2): app (web, port 8000), worker (worker, 10Gi volume)')
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
    })).toEqual([
      { name: 'app', type: 'web', port: 80, volumeGib: undefined, volume: false },
      { name: 'bool', type: 'worker', port: undefined, volumeGib: undefined, volume: true },
      { name: 'worker', type: 'worker', port: undefined, volumeGib: 5, volume: true },
      { name: 'norm', type: undefined, port: undefined, volumeGib: 3, volume: true },
    ])
  })
  it('accepts flat variable arrays too', () => {
    const vars = normalizeInfoVariables([{ name: 'A', required: true, description: 'a' }, { name: 'B' }])
    expect(vars).toMatchObject([{ name: 'A', required: true }, { name: 'B', required: false }])
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
) {
  const posts: any[] = []
  const polls: string[] = []
  const pollScopes: unknown[] = []
  const api = {
    request: async (_m: string, path: string, _body?: unknown, opts?: unknown) => {
      if (path.startsWith('/templates/')) return { template: { code: 'plausible', variables: templateVars } }
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
    expect(stderr.join('')).toMatch(/approval required for template\.deploy — run: insta approvals approve appr_1/)
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
