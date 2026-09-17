// `insta domain attach / check` — region-aware, and never guessing. A compute service
// lives in ONE region (fixed at creation) and a custom hostname routes in that region's router, so:
// the target service is resolved from the project (sole compute service → bind; several → refuse
// with the list, regions shown, --group required; workers unbindable), the guidance after attach
// is the platform's records VERBATIM (never a template), and check renders every stage plus
// where the hostname resolves. Pure-function tests, same pattern as compute-exec.test.ts.
import { describe, it, expect } from 'vitest'
import {
  resolveDomainTarget, computeChoiceLine, domainGuidanceLines, domainStatusLines, domainResolveLine,
  domainConflictMessage, withRow, type ComputeRow, type DomainView,
} from '../src/commands/compute.js'
import { ApiError } from '../src/api.js'

const api: ComputeRow = { id: 's1', type: 'compute', name: 'api', status: 'running', region: 'us-east', domain: 'insta-main-api-1a2b.compute.instacloud.com', port: 8080 }
const web: ComputeRow = { id: 's2', type: 'compute', name: 'web', status: 'running', region: 'us-west', domain: 'insta-main-web-3c4d.compute.instacloud.com', port: 3000 }
const worker: ComputeRow = { id: 's3', type: 'compute', name: 'worker', status: 'running', region: 'eu-central', domain: null, port: 0 }
const pg: ComputeRow = { id: 's4', type: 'postgres', name: 'db', status: 'running', region: 'us-east' }

describe('resolveDomainTarget (selection only where genuinely ambiguous)', () => {
  it('a project with exactly one compute service binds to it without --group', () => {
    expect(resolveDomainTarget([pg, api], 'app.customer.com')).toBe(api)
  })

  it('several compute services: refuses, lists each with its REGION and default URL, requires --group', () => {
    let msg = ''
    try { resolveDomainTarget([pg, api, web, worker], 'app.customer.com') } catch (e) { msg = (e as Error).message }
    const lines = msg.split('\n')
    expect(lines[0]).toBe('this project has 3 compute services; pass --group to choose which one serves app.customer.com:')
    // Columns align to the widest name/region in the list (worker / eu-central here).
    expect(lines[1]).toBe('  api    us-east    https://insta-main-api-1a2b.compute.instacloud.com  (running)')
    expect(lines[2]).toBe('  web    us-west    https://insta-main-web-3c4d.compute.instacloud.com  (running)')
    // The worker is SHOWN (so the user knows it exists) but marked unbindable.
    expect(lines[3]).toBe('  worker eu-central (no HTTP endpoint — worker, cannot serve a domain)')
    expect(lines).toHaveLength(4) // the postgres service is not a candidate
  })

  it('--group picks by name; a worker is refused even when named', () => {
    expect(resolveDomainTarget([api, web, worker], 'app.customer.com', 'web')).toBe(web)
    expect(() => resolveDomainTarget([api, web, worker], 'app.customer.com', 'worker'))
      .toThrow('worker is a worker (port 0) — it has no HTTP endpoint, so app.customer.com cannot serve from it')
    expect(() => resolveDomainTarget([api, web], 'app.customer.com', 'nope')).toThrow('compute service not found: nope (have: api, web)')
  })

  it('the sole compute service being a worker is refused, not bound', () => {
    expect(() => resolveDomainTarget([worker], 'app.customer.com')).toThrow(/worker is a worker \(port 0\)/)
  })

  it('no compute service at all', () => {
    expect(() => resolveDomainTarget([pg], 'app.customer.com')).toThrow(/no compute service in this project/)
  })

  it('computeChoiceLine: a service with no default URL yet says so instead of printing https://null', () => {
    expect(computeChoiceLine({ ...api, domain: null })).toBe('  api      us-east      (no default URL yet)  (running)')
  })
})

const bound: DomainView = {
  hostname: 'app.customer.com', flyApp: 'api-main-1a2b', configured: false, status: 'pending_dns',
  service: 'api', region: 'us-east',
  dns: [
    { type: 'CNAME', name: 'app.customer.com', value: 'cname.instacloud-dns.com', note: 'routes to the service', status: 'missing' },
    { type: 'TXT', name: '_insta-verify.app.customer.com', value: 'insta-verify=tok123', note: 'proves domain ownership', status: 'missing' },
  ],
  ssl: 'initializing',
}

describe('domainGuidanceLines (after attach: what to do next, from the platform records)', () => {
  it('renders the adapter records verbatim, region named, then the check step', () => {
    expect(domainGuidanceLines(bound)).toEqual([
      'app.customer.com -> api (us-east)',
      'add these DNS records at your DNS provider:',
      '  CNAME  app.customer.com               -> cname.instacloud-dns.com',
      '  TXT    _insta-verify.app.customer.com -> insta-verify=tok123',
      'then: insta domain check app.customer.com',
    ])
  })

  it('NO records from the platform → says so explicitly; never prints a template value', () => {
    const lines = domainGuidanceLines({ ...bound, dns: [] })
    expect(lines[0]).toBe('app.customer.com -> api (us-east)')
    expect(lines.join('\n')).toMatch(/returned NO DNS records/)
    expect(lines.join('\n')).toMatch(/nothing to publish yet/)
    expect(lines.join('\n')).not.toMatch(/cname\.instacloud-dns\.com|_insta-verify|CNAME {2}|TXT {4}/)
  })

  // The printed follow-up must reach the same service on the same branch: without --group it dies
  // on the very ambiguity error this feature raises, and without --branch it checks the linked
  // branch instead (cubic P2).
  it('the follow-up check command carries the resolved group and the invoked branch', () => {
    expect(domainGuidanceLines(bound, { group: 'api' }).at(-1)).toBe('then: insta domain check app.customer.com --group api')
    expect(domainGuidanceLines(bound, { group: 'api', branch: 'preview' }).at(-1))
      .toBe('then: insta domain check app.customer.com --group api --branch preview')
  })

  it('an older platform without service/region: withRow fills them from the resolved row', () => {
    const { service: _s, region: _r, ...legacy } = bound
    expect(domainGuidanceLines(withRow(legacy as DomainView, api))[0]).toBe('app.customer.com -> api (us-east)')
    // ...but the platform's own answer wins when present.
    expect(withRow(bound, web).region).toBe('us-east')
  })
})

describe('domainStatusLines (check: every stage + where it routes)', () => {
  const active: DomainView = {
    ...bound, configured: true, status: 'active', ssl: 'active',
    dns: bound.dns.map((d) => ({ ...d, status: 'ok' })),
    origin: 'prod-use1-origin.instacloud-dns.com', edgeOrigin: 'prod-use1-origin.instacloud-dns.com', originOk: true,
  }

  it('active: ownership verified, cname ok, certificate active, resolves to the region origin, serving', () => {
    expect(domainStatusLines(active)).toEqual([
      'app.customer.com -> api (us-east)',
      '  ownership   verified    (TXT found)',
      '  cname       ok          (points at cname.instacloud-dns.com)',
      '  certificate active      (edge TLS issued)',
      '  resolves to prod-use1-origin.instacloud-dns.com   (us-east router)   ok',
      '  serving     https://app.customer.com',
    ])
  })

  it('pending: each missing stage says what the user must still do', () => {
    const lines = domainStatusLines(bound)
    expect(lines[1]).toBe('  ownership   pending     add TXT _insta-verify.app.customer.com -> insta-verify=tok123')
    expect(lines[2]).toBe('  cname       pending     add CNAME app.customer.com -> cname.instacloud-dns.com')
    expect(lines[3]).toBe('  certificate pending     (initializing — issues once ownership is verified)')
    expect(lines[4]).toBe("  resolves to UNCONFIRMED — us-east's daemon does not report the edge routing target, so where app.customer.com lands cannot be verified from here (update the region's daemon)")
    expect(lines[5]).toBe('  serving     not yet     (add the ownership TXT, add the CNAME, certificate, confirm the routing target above)')
  })

  it('mismatch: names the value the record must have', () => {
    const v = { ...bound, dns: bound.dns.map((d) => ({ ...d, status: 'mismatch' })) }
    const lines = domainStatusLines(v)
    expect(lines[1]).toBe('  ownership   mismatch    TXT _insta-verify.app.customer.com has a different value — set it to insta-verify=tok123')
    expect(lines[2]).toBe('  cname       mismatch    CNAME app.customer.com must point at cname.instacloud-dns.com')
  })

  it('failure shape 1 — region has NO edge origin configured (origin ""): NOT READY, operator action named', () => {
    const v = { ...active, origin: '', edgeOrigin: '', originOk: false }
    const lines = domainStatusLines(v)
    expect(lines[4]).toBe('  resolves to NOT READY — us-east has no edge origin configured; app.customer.com would fall to the zone default. Ask an operator to set cf-custom-origin for us-east')
    expect(lines[5]).toBe('  serving     not yet     (confirm the routing target above)')
    expect(lines.join('\n')).not.toContain('https://app.customer.com') // active-but-misrouted is not "serving"
  })

  it('failure shape 2 — Cloudflare routes the hostname to ANOTHER region\'s origin: attached elsewhere, remove it there', () => {
    const v = { ...active, edgeOrigin: 'prod-usw2-origin.instacloud-dns.com', originOk: false }
    const lines = domainStatusLines(v)
    expect(lines[4]).toBe('  resolves to prod-usw2-origin.instacloud-dns.com — Cloudflare routes app.customer.com to prod-usw2-origin.instacloud-dns.com, but this service is in us-east (prod-use1-origin.instacloud-dns.com); it is attached elsewhere — remove it there first')
    expect(lines[5]).toBe('  serving     not yet     (confirm the routing target above)')
  })

  // A PLANE answer always carries `ssl`, so a plane answer with no `origin` is a daemon too old to
  // say where the hostname lands: routing is UNCONFIRMED and must not be reported as serving —
  // "the plane said active" is not evidence that traffic reaches this region (r2d2 round 1 Critical).
  it('failure shape 3 — a plane daemon reports no routing target: UNCONFIRMED, never serving', () => {
    const { origin: _o, edgeOrigin: _e, originOk: _k, ...noReport } = active
    const lines = domainStatusLines(noReport as DomainView)
    expect(lines[4]).toBe("  resolves to UNCONFIRMED — us-east's daemon does not report the edge routing target, so where app.customer.com lands cannot be verified from here (update the region's daemon)")
    expect(lines[5]).toBe('  serving     not yet     (confirm the routing target above)')
    expect(lines.join('\n')).not.toContain('https://app.customer.com')
  })

  // A FLY answer carries no `ssl` and has no per-hostname origin concept at all — there is nothing
  // to confirm, so its own verdict stands rather than being downgraded forever.
  it('a provider with no origin concept (Fly) is not downgraded: it says so, and serving stands', () => {
    const fly: DomainView = {
      hostname: 'app.customer.com', flyApp: 'insta-main-api-ab12', configured: true, status: 'Ready', service: 'api', region: 'us-east',
      dns: [{ type: 'CNAME', name: 'app.customer.com', value: 'insta-main-api-ab12.fly.dev', note: 'routes to the Fly app' }],
    }
    const lines = domainStatusLines(fly)
    expect(lines).toContain('  resolves to (this provider does not report an edge routing target)')
    expect(lines.at(-1)).toBe('  serving     https://app.customer.com')
    expect(domainResolveLine(fly).ready).toBe(true)
  })

  it('Cloudflare does not hold the hostname yet (edge empty, originOk false): pending, not misrouted', () => {
    expect(domainResolveLine({ ...active, edgeOrigin: '', originOk: false })).toEqual({
      line: '  resolves to prod-use1-origin.instacloud-dns.com   (us-east router)   pending — Cloudflare does not hold this hostname yet',
      ready: false,
    })
  })

  it('error state: the plane\'s reason is shown and the hostname is not reported as serving', () => {
    const lines = domainStatusLines({ ...active, status: 'error', errorReason: 'ownership token changed' })
    expect(lines).toContain('  error       error       ownership token changed')
    expect(lines.at(-1)).toBe('  serving     not yet     (the plane reports an error state)')
  })

  // An error STATE with no reason attached is still an error state — a row that says `error` has
  // not been observed serving, and printing a URL beside it is the blackhole lie (cubic P2).
  it('error state with NO reason: still blocked, and the missing reason is said out loud', () => {
    const lines = domainStatusLines({ ...active, status: 'error' })
    expect(lines).toContain('  error       error       (the plane reported an error state with no reason)')
    expect(lines.at(-1)).toBe('  serving     not yet     (the plane reports an error state)')
  })

  // configured: true alongside an outstanding record blocker means the verdict and the record set
  // disagree — report the disagreement rather than papering over it with a URL (cubic P1).
  it('configured but a record is still missing: the disagreement wins, not the verdict', () => {
    const lines = domainStatusLines({ ...active, dns: active.dns.map((d) => (d.type === 'TXT' ? { ...d, status: 'missing' } : d)) })
    expect(lines.at(-1)).toBe('  serving     not yet     (add the ownership TXT)')
    expect(lines.join('\n')).not.toContain('  serving     https://app.customer.com')
  })

  // An unchecked TXT (no per-record status on a not-yet-configured answer) blocks too: "we have not
  // looked" is not "it is there" (cubic P3 — this branch was previously untested).
  it('ownership unchecked: rendered as unchecked AND counted as a blocker', () => {
    const noStatus = { ...bound, dns: bound.dns.map(({ status: _s, ...d }) => d) }
    const lines = domainStatusLines(noStatus)
    expect(lines[1]).toBe('  ownership   unchecked   TXT _insta-verify.app.customer.com -> insta-verify=tok123 (the plane has not checked it yet — re-run insta domain check)')
    expect(lines.at(-1)).toContain('ownership unchecked')
  })

  // No records at all: the stages are still drawn. An omitted stage reads as "not required", when
  // the truth is the platform told us nothing to publish (cubic P2).
  it('no records from the platform: ownership and cname stages are still drawn, as unknown blockers', () => {
    const lines = domainStatusLines({ ...bound, dns: [] })
    expect(lines[1]).toBe('  ownership   unknown     the platform returned no ownership TXT for this domain — nothing to publish yet; ask an operator')
    expect(lines[2]).toBe('  cname       unknown     the platform returned no routing record for this domain — nothing to publish yet; ask an operator')
    expect(lines.at(-1)).toContain('no ownership TXT from the platform')
  })

  // The PARTIAL case (r2d2 round 2 Critical): records came back, but not the routing one. Keying
  // the "no routing record" stage on an entirely empty set let a payload carrying only the
  // ownership TXT skip the stage and add no blocker — so a configured answer with a live cert and
  // a confirmed origin printed a URL for a hostname with nothing pointing at us.
  it('records present but NO routing record: the stage is still drawn, blocks, and never says serving', () => {
    const txtOnly: DomainView = {
      ...bound, configured: true, status: 'active', ssl: 'active',
      dns: [{ type: 'TXT', name: '_insta-verify.app.customer.com', value: 'insta-verify=tok123', status: 'ok' }],
      origin: 'prod-use1-origin.instacloud-dns.com', edgeOrigin: 'prod-use1-origin.instacloud-dns.com', originOk: true,
    }
    const lines = domainStatusLines(txtOnly)
    expect(lines[1]).toBe('  ownership   verified    (TXT found)')
    expect(lines[2]).toBe('  cname       unknown     the platform returned no routing record for this domain — nothing to publish yet; ask an operator')
    expect(lines.at(-1)).toBe('  serving     not yet     (no routing record from the platform)')
    expect(lines.join('\n')).not.toContain('serving     https://')
  })

  // ...and the mirror: an APEX domain's routing record is an A, not a CNAME. Now that a missing
  // routing record blocks, matching only CNAME would report a correct apex as having none.
  it('an apex A record counts as the routing record, and is named as an A', () => {
    const apex: DomainView = {
      hostname: 'customer.com', flyApp: 'insta-main-api-ab12', configured: false, status: 'Awaiting configuration',
      service: 'api', region: 'us-east',
      dns: [{ type: 'A', name: 'customer.com', value: '66.66.66.66', note: 'apex → the Fly app' }],
    }
    const lines = domainStatusLines(apex)
    expect(lines[2]).toBe('  a           unchecked   A customer.com -> 66.66.66.66 (not checked yet — re-run insta domain check)')
    expect(lines.join('\n')).not.toContain('no routing record from the platform')
    expect(lines.join('\n')).not.toContain('add CNAME customer.com')
  })

  // r2d2 round 3 Critical: the blocker rule reached only the ownership TXT and the FIRST routing
  // record. Every other record rendered from `configured` alone and blocked nothing, so a payload
  // whose SECOND apex record was bad still ended in `serving https://…`.
  it('apex A/AAAA pair with the AAAA missing: both routing records are judged, and it does not serve', () => {
    const apex: DomainView = {
      // Fly-shaped (an apex is Fly's A/AAAA path): no ownership TXT, no plane ssl/origin fields.
      hostname: 'customer.com', flyApp: 'insta-main-api-ab12', configured: true, status: 'active',
      service: 'api', region: 'us-east',
      dns: [
        { type: 'A', name: 'customer.com', value: '66.66.66.66', status: 'ok' },
        { type: 'AAAA', name: 'customer.com', value: '2a09:8280::1', status: 'missing' },
      ],
    }
    const lines = domainStatusLines(apex)
    expect(lines[2]).toBe('  a           ok          (points at 66.66.66.66)')
    expect(lines[3]).toBe('  aaaa        pending     add AAAA customer.com -> 2a09:8280::1')
    expect(lines.at(-1)).toBe('  serving     not yet     (add the AAAA)')
    expect(lines.join('\n')).not.toContain('serving     https://')
  })

  it('a mismatched second apex record blocks too', () => {
    const apex: DomainView = {
      hostname: 'customer.com', flyApp: 'x', configured: true, status: 'active', service: 'api', region: 'us-east',
      dns: [
        { type: 'A', name: 'customer.com', value: '66.66.66.66', status: 'ok' },
        { type: 'AAAA', name: 'customer.com', value: '2a09:8280::1', status: 'mismatch' },
      ],
    }
    expect(domainStatusLines(apex).at(-1)).toBe('  serving     not yet     (fix the AAAA)')
  })

  // An EXTRA record (a validation CNAME, not the routing one) that is still outstanding blocks as
  // well — it is a record the platform told the user to publish.
  it('an extra validation record still pending blocks serving', () => {
    const withValidation: DomainView = {
      ...active,
      dns: [
        ...active.dns,
        { type: 'CNAME', name: '_acme-challenge.app.customer.com', value: 'app.customer.com.abc.flydns.net', note: "Let's Encrypt validation", status: 'missing' },
      ],
    }
    const lines = domainStatusLines(withValidation)
    expect(lines.join('\n')).toContain('add _acme-challenge.app.customer.com -> app.customer.com.abc.flydns.net')
    expect(lines.at(-1)).toBe('  serving     not yet     (add the CNAME _acme-challenge.app.customer.com)')
    expect(lines.join('\n')).not.toContain('serving     https://')
  })

  // An UNCHECKED routing status is not a pass: "we have not looked" is not "it is there".
  it('a routing record the plane has not checked blocks, even with cert and origin ready', () => {
    const unchecked: DomainView = {
      ...active,
      configured: false,
      dns: active.dns.map((d) => (d.type === 'TXT' ? { ...d, status: 'ok' as const } : { ...d, status: undefined })),
    }
    const lines = domainStatusLines(unchecked)
    expect(lines.join('\n')).toContain('unchecked')
    expect(lines.at(-1)).toContain('CNAME unchecked')
    expect(lines.join('\n')).not.toContain('serving     https://')
  })

  // An older platform may omit `dns` entirely — that is "no records", not a crash.
  it('a platform answer with no dns field at all is read as no records', () => {
    const { dns: _d, ...noDns } = bound
    expect(() => domainStatusLines(noDns as DomainView)).not.toThrow()
    expect(domainGuidanceLines(noDns as DomainView).join('\n')).toContain('returned NO DNS records')
  })

  it('pre-Cloudflare plane (ssl external): certificate stage says no edge cert is managed', () => {
    expect(domainStatusLines({ ...active, ssl: 'external' })[3]).toBe('  certificate external    (this plane manages no edge certificate for custom domains)')
  })

  it('Fly-backed row (no per-record status, no ssl): stages derive from `configured` and the provider status', () => {
    const fly: DomainView = {
      hostname: 'app.customer.com', flyApp: 'insta-main-api-ab12', configured: false, status: 'Awaiting configuration', service: 'api', region: 'us-east',
      dns: [
        { type: 'CNAME', name: 'app.customer.com', value: 'insta-main-api-ab12.fly.dev', note: 'routes to the Fly app' },
        { type: 'CNAME', name: '_acme-challenge.app.customer.com', value: 'app.customer.com.abc.flydns.net', note: "Let's Encrypt validation" },
      ],
    }
    const lines = domainStatusLines(fly)
    // Fly issues no ownership TXT, so that stage is drawn as unknown rather than silently dropped.
    expect(lines[1]).toBe('  ownership   n/a         (this provider does not use an ownership TXT)')
    expect(lines[2]).toBe('  cname       unchecked   CNAME app.customer.com -> insta-main-api-ab12.fly.dev (not checked yet — re-run insta domain check)')
    expect(lines[3]).toBe("  cname       unchecked   _acme-challenge.app.customer.com -> app.customer.com.abc.flydns.net  (Let's Encrypt validation) (not checked yet — re-run insta domain check)")
    expect(lines[4]).toBe('  certificate pending     (provider status: Awaiting configuration)')
  })

  it('not added: one line pointing at attach, region still named, group + branch carried', () => {
    expect(domainStatusLines({ ...bound, status: 'not added', dns: [] })).toEqual([
      'app.customer.com is not attached to api (us-east) — attach it with: insta domain attach app.customer.com',
    ])
    expect(domainStatusLines({ ...bound, status: 'not added', dns: [] }, { group: 'api', branch: 'preview' })[0])
      .toBe('app.customer.com is not attached to api (us-east) — attach it with: insta domain attach app.customer.com --group api --branch preview')
  })
})

describe('domainConflictMessage (bound elsewhere — domains are released, never moved)', () => {
  const conflict = (msg: string) => new ApiError(409, msg, { error: msg })

  it('owner named and in this project: the exact detach command', () => {
    expect(domainConflictMessage('app.customer.com', conflict('app.customer.com is already attached to web in us-west; remove it there first'), [api, web]))
      .toBe('app.customer.com is already attached to web (us-west) — domains are not moved; release it first: insta domain detach app.customer.com --group web, then re-run insta domain attach')
  })

  it('owner named but not a service here: held by a deleted service → operator must release', () => {
    expect(domainConflictMessage('app.customer.com', conflict('app.customer.com is already attached to old-api in us-east; remove it there first'), [api]))
      .toBe('app.customer.com is already attached to old-api in us-east, which is not a service in this project — it is held by a deleted service (or one in another project); ask an operator to release the hostname before re-binding it')
  })

  it('the release command carries the branch the user was working on', () => {
    const e = conflict('app.customer.com is already attached to web in us-west; remove it there first')
    expect(domainConflictMessage('app.customer.com', e, [api, web], { group: 'api', branch: 'preview' }))
      .toContain('insta domain detach app.customer.com --group web --branch preview')
  })

  it("owner not named (today's plane): generic release instruction, still no 'move'", () => {
    const msg = domainConflictMessage('app.customer.com', conflict('app.customer.com is already attached to another compute service; remove it there first'), [api, web])
    expect(msg).toBe('app.customer.com is already attached to another compute service — domains are not moved; release it there first (insta domain detach app.customer.com --group <that service>) or, if that service was deleted, ask an operator to release the hostname')
    expect(msg).not.toMatch(/move it|transfer/)
  })
})
