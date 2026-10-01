import { ApiClient, ApiError, requireProject } from '../api.js'
import { die, info, openUrl, printJson } from '../util.js'
import { cycleLine, dimensionLines } from './metrics.js'

type OrgOpt = { org?: string }

// Resolve the target org: explicit --org, else the linked project's org.
export async function resolveOrgId(opts: OrgOpt): Promise<string> {
  if (opts.org) return opts.org
  // `ProjectConfig.orgId` is typed string but INSTA_PROJECT_ID resolves a project with no org.
  const orgId = (await requireProject()).orgId
  if (!orgId) die('INSTA_PROJECT_ID names no organization — set INSTA_ORG_ID, or pass --org <id>')
  return orgId
}

export type BillingOverview = {
  window: { from: number; to: number }
  tier: string; billingStatus: string; subscriptionStatus: string | null
  pendingPlanChange?: { changeKind?: 'upgrade' | 'downgrade'; fromTier: string; toTier: string; effectiveAt: string; status: 'awaiting_payment' | 'scheduled'; includedUsd: number } | null
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
  if (s.pendingPlanChange) {
    const pending = s.pendingPlanChange
    const boundary = new Date(pending.effectiveAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    lines.push(pending.status === 'scheduled'
      ? `next plan:       ${pending.toTier} at ${boundary}`
      : `plan change:     preparing ${pending.toTier}; requested boundary ${boundary}`)
    if (pending.changeKind === 'upgrade') {
      lines.push(`full-cycle allowance: $${Number(pending.includedUsd).toFixed(2)} (next renewal)`)
      lines.push('Current cycle: proportional allowance increase; existing usage and renewal date are preserved.')
    } else lines.push(`next allowance:  $${Number(pending.includedUsd).toFixed(2)} (available after cutover)`)
    lines.push(pending.changeKind === 'downgrade'
      ? 'Current paid plan remains active until period end. Withdraw this downgrade in Console Plans before it takes effect.'
      : 'A plan change is pending; contact support for billing changes.')
  }
  if (s.tier === 'enterprise') {
    lines.push('Enterprise billing is managed by staff; payment failure does not change the plan.')
    if (s.billingStatus === 'suspended') lines.push('Contact support for billing or resource recovery.')
  } else if (s.billingStatus === 'suspended' && !s.pendingPlanChange) {
    // Ordinary-plan recovery advice depends on the cause. Tier first: only a
    // free org can spend a prepaid wallet, and waiting for the next cycle genuinely fixes that one.
    // (Tier, not subscriptionStatus, because rows written before non-payment suspended carry
    // `unpaid` beside tier 'free' and survive with no migration.) Then the status splits the paid
    // branch three ways: an invoice to settle, a subscription to replace, or — when it reads
    // healthy — a suspension that outlived its cause, which is what a recovery whose compute failed
    // to restart looks like, and where telling them to pay means re-settling a paid invoice. The
    // Enterprise and pending changes were handled above: neither offers self-serve checkout.
    //
    // EVERY command here carries the caller's --org. `billing` and the command being suggested
    // resolve the target independently, so a hint that drops the flag acts on a different org than
    // the one being read — and two of them take payment.
    const flag = org ? ` --org ${org}` : ''
    const lapsed = s.subscriptionStatus === 'past_due' || s.subscriptionStatus === 'unpaid'
    const ended = s.subscriptionStatus === 'canceled' || s.subscriptionStatus === 'incomplete_expired'
    lines.push(
      s.tier === 'free'
        ? `⚠  org suspended — billing limit reached; resumes next cycle (or \`insta billing subscribe pro${flag}\`)`
        : lapsed
          ? `⚠  org suspended — subscription payment did not go through; settle it in \`insta billing portal${flag}\``
          : ended
            // Their OWN tier, not a hardcoded one: suggesting `subscribe pro` to a Team org
            // resubscribes it onto the wrong plan.
            ? `⚠  org suspended — the subscription ended; resubscribe with \`insta billing subscribe ${s.tier}${flag}\``
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

// insta billing subscribe <tier> — start a Stripe Checkout to subscribe the org to a paid tier.
export async function billingUpgrade(tier: string, opts: OrgOpt & { open?: boolean; json?: boolean }): Promise<void> {
  // pro|team, matching what POST /orgs/:orgId/billing/checkout accepts: `team` is a real
  // self-serve tier, and `enterprise` is per-deal and 400s at the server.
  if (tier !== 'pro' && tier !== 'team') die('tier must be pro|team')
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const { url } = await api.request<{ url: string }>('POST', `/orgs/${orgId}/billing/checkout`, { tier })
  if (opts.json) return printJson({ url })
  presentUrl(url, `Subscribe to ${tier} — complete checkout in your browser:`, opts.open)
}

export type RedeemResult = { amountMicros: number; creditsExpireAt: string | null; orgId: string; orgName: string }

// The platform's contract (RedeemError#reason in billing/service.ts) — four literals, never
// collapsed into one message, because the right next action differs per reason: `not_found` is
// the only one worth retyping; `expired`/`revoked` both mean waiting never helps, but only
// `revoked` has someone to go back to.
//
// `already_redeemed` deliberately does NOT say WHO redeemed it, because this CLI cannot know.
// A sequential retry replays the receipt and never reaches here — but two requests from the same
// org in flight at once both miss the replay read (it sees committed rows only), one wins the
// claim and the other lands exactly here. That is the case a client resending a request it never
// saw an answer to is IN. Telling that person "a different org took it" would be false about
// their own money: the grant is on their wallet. So the message points them at their balance
// instead of at a conclusion this side cannot support.
const REDEEM_ERROR_MESSAGE: Record<string, string> = {
  not_found: 'that code was not recognized — check it for typos and try again',
  expired: 'that code has expired — ask whoever sent it for a new one',
  already_redeemed: 'that code has already been redeemed — if it was your org, the credits are already there (check `insta billing`)',
  revoked: 'that code was revoked — contact whoever sent it to you',
}

// Pure — the human line for a redeem failure. `reason` is the platform's literal (RedeemError's
// four values); anything else (a platform version ahead of this CLI) falls back to relaying it
// as-is rather than a message that would be wrong about which of the four cases this is.
export function redeemErrorMessage(reason: string | undefined, fallback: string): string {
  return (reason && REDEEM_ERROR_MESSAGE[reason]) ?? fallback
}

// Pure — the three facts the spec names, in the order it names them: what landed, when it stops
// being spendable, and which org — by NAME — so someone who belongs to several orgs isn't left
// reading a uuid to find out which one just got the money.
export function redeemLines(r: RedeemResult): string[] {
  return [
    `credited:        $${(r.amountMicros / 1_000_000).toFixed(2)}`,
    `expires:         ${r.creditsExpireAt ? r.creditsExpireAt.slice(0, 10) : 'never'}`,
    `org:             ${r.orgName}`,
  ]
}

// insta billing redeem <code> — apply a one-time credit code to the org's wallet.
export async function billingRedeem(code: string, opts: OrgOpt & { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  let res: RedeemResult
  try {
    res = await api.request<RedeemResult>('POST', `/orgs/${orgId}/billing/redeem`, { code })
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 400) throw e
    // Under --json, stdout stays the one parseable document a script branches on (the platform's
    // own `error` literal); the human line below is the diagnostic and belongs on stderr.
    const reason = e.body?.error
    if (opts.json) printJson({ error: reason ?? e.message })
    die(redeemErrorMessage(reason, e.message))
  }
  if (opts.json) return printJson(res)
  for (const l of redeemLines(res)) info(l)
}

// insta billing portal — manage payment methods. UTC-managed plans cannot change/cancel here.
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
