import { ApiClient, requireProject } from '../api.js'
import { die, info, openUrl, printJson } from '../util.js'
import { cycleLine, dimensionLines } from './metrics.js'

type OrgOpt = { org?: string }

// Resolve the target org: explicit --org, else the linked project's org.
export async function resolveOrgId(opts: OrgOpt): Promise<string> {
  if (opts.org) return opts.org
  return (await requireProject()).orgId
}

export type BillingOverview = {
  window: { from: number; to: number }
  tier: string; billingStatus: string; subscriptionStatus: string | null
  // `creditBalanceUsd` is the wallet, and nothing else. The API also returns a legacy `creditsUsd`
  // that adds the remaining plan allowance to the wallet balance — a single number that means
  // neither thing. It is deliberately NOT read here: included usage and credits feed different
  // calculations (usage vs amount payable) and must never be summed.
  totals: { usedUsd: number; includedUsd: number; overageUsd: number; creditBalanceUsd: number; forecastUsd: number }
  byDimension: Array<{ dimension: string; quantity: number; unit: string; costUsd?: number }>
  byProject: Array<{ name: string; totalCostUsd: number }>
}

// Format the billing overview into printable lines (pure, so it's unit-testable).
// `org` is the caller's --org, echoed into the portal hint: `billing` and `billing portal` resolve
// the target independently, so a hint that drops the flag sends someone reading org A's overview to
// org B's portal.
export function billingLines(s: BillingOverview, org?: string): string[] {
  const t = s.totals
  const lines = [
    `tier:            ${s.tier}`,
    `status:          ${s.billingStatus}`,
    cycleLine(s.window),
    // Two separate figures, never added together: the plan's allowance for this cycle, and the
    // org's wallet. "included usage" is the name the console and the pricing page use for the
    // former; "credits" now means the wallet alone.
    `included usage:  $${Number(t.includedUsd).toFixed(2)}`,
    `used:            $${Number(t.usedUsd).toFixed(4)}`,
    `overage:         $${Number(t.overageUsd).toFixed(4)}`,
    `credits:         $${Number(t.creditBalanceUsd).toFixed(2)}`,
    `forecast:        $${Number(t.forecastUsd).toFixed(4)}  (predicted full cycle)`,
  ]
  if (s.subscriptionStatus) lines.push(`subscription:    ${s.subscriptionStatus}`)
  if (s.billingStatus === 'suspended') {
    // Four causes, five messages, and every one is a dead end for the others. Tier first: only a
    // free org can spend a prepaid wallet, and waiting for the next cycle genuinely fixes that one.
    // (Tier, not subscriptionStatus, because rows written before non-payment suspended carry
    // `unpaid` beside tier 'free' and survive with no migration.) Then the status splits the paid
    // branch three ways: an invoice to settle, a subscription to replace, or — when it reads
    // healthy — a suspension that outlived its cause, which is what a recovery whose compute failed
    // to restart looks like, and where telling them to pay means re-settling a paid invoice. The
    // replace case is the one that splits again, because enterprise has no self-serve checkout.
    //
    // EVERY command here carries the caller's --org. `billing` and the command being suggested
    // resolve the target independently, so a hint that drops the flag acts on a different org than
    // the one being read — and two of them take payment.
    const flag = org ? ` --org ${org}` : ''
    const lapsed = s.subscriptionStatus === 'past_due' || s.subscriptionStatus === 'unpaid'
    const ended = s.subscriptionStatus === 'canceled' || s.subscriptionStatus === 'incomplete_expired'
    lines.push(
      s.tier === 'free'
        ? `⚠  org suspended — billing limit reached; resumes next cycle (or \`insta billing upgrade pro${flag}\`)`
        : lapsed
          ? `⚠  org suspended — subscription payment did not go through; settle it in \`insta billing portal${flag}\``
          : ended
            ? s.tier === 'enterprise'
              // Per-deal, and `billing upgrade` cannot create one: naming a self-serve tier here
              // would move them off the plan they negotiated.
              ? '⚠  org suspended — the subscription ended; contact support to restore this plan'
              // Their OWN tier, not a hardcoded one: suggesting `upgrade pro` to a Team org
              // resubscribes it onto the wrong plan.
              : `⚠  org suspended — the subscription ended; resubscribe with \`insta billing upgrade ${s.tier}${flag}\``
            // Deliberately claims nothing about the subscription: `incomplete` reaches here too,
            // and that one is neither current nor failed. All this branch knows is that the
            // suspension has no billing cause it can name.
            : '⚠  org suspended — no failed payment on file; contact support',
    )
  }
  if (s.byDimension?.length) {
    lines.push('by dimension:')
    for (const l of dimensionLines(s.byDimension)) lines.push(`  ${l}`)
  }
  if (s.byProject?.length) {
    lines.push('by project:')
    for (const pr of s.byProject) lines.push(`  ${pr.name}: $${Number(pr.totalCostUsd ?? 0).toFixed(4)}`)
  }
  return lines
}

// insta billing — current cycle overview for the org (totals, credits, forecast, breakdowns).
export async function billing(opts: OrgOpt & { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const s = await api.request<BillingOverview>('GET', `/orgs/${orgId}/billing/overview`)
  if (opts.json) return printJson(s)
  for (const l of billingLines(s, opts.org)) info(l)
}

// insta billing upgrade <tier> — start a Stripe Checkout to subscribe the org to a paid tier.
export async function billingUpgrade(tier: string, opts: OrgOpt & { open?: boolean; json?: boolean }): Promise<void> {
  // pro|team, matching what POST /orgs/:orgId/billing/checkout actually accepts. This said
  // pro|enterprise, which was wrong both ways: `team` is a real self-serve tier and was refused
  // here, and `enterprise` is per-deal and 400s at the server. The suspension hint above now names
  // the org's own tier, so a Team org was being sent to a command that rejected it.
  if (tier !== 'pro' && tier !== 'team') die('tier must be pro|team')
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const { url } = await api.request<{ url: string }>('POST', `/orgs/${orgId}/billing/checkout`, { tier })
  if (opts.json) return printJson({ url })
  presentUrl(url, `Subscribe to ${tier} — complete checkout in your browser:`, opts.open)
}

// insta billing portal — open the Stripe Customer Portal (change plan / card / cancel).
export async function billingPortal(opts: OrgOpt & { open?: boolean; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const { url } = await api.request<{ url: string }>('POST', `/orgs/${orgId}/billing/portal`)
  if (opts.json) return printJson({ url })
  presentUrl(url, 'Manage billing in your browser:', opts.open)
}

// Print the URL and, unless --no-open, try to open it in the browser. The message says
// "opening", not "opened": a launcher that starts and then fails reports it asynchronously,
// so openUrl's true return is an attempt, not a confirmation (see util.ts) — and the URL is
// already printed above for exactly that case.
export function presentUrl(url: string, label: string, open?: boolean): void {
  info(label)
  info(`  ${url}`)
  if (open !== false && openUrl(url)) info('(opening in your default browser…)')
}
