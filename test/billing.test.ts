import { describe, it, expect } from 'vitest'
import { billingLines } from '../src/commands/billing.js'

const base = {
  window: { from: 1_686_787_200, to: 1_689_379_200 }, // 2023-06-15 → 2023-07-15 (UTC)
  tier: 'pro', billingStatus: 'active', subscriptionStatus: 'active' as string | null,
  totals: { usedUsd: 45.32, includedUsd: 25, overageUsd: 20.32, creditBalanceUsd: 0, forecastUsd: 97.11 },
  byDimension: [
    { dimension: 'ram', quantity: 660, unit: 'GB·min', costUsd: 6.6 },
    { dimension: 'cpu', quantity: 120, unit: 'vCPU·min', costUsd: 3.2 },
  ],
  byProject: [
    { name: 'Project 1', totalCostUsd: 24 },
    { name: 'Project 2', totalCostUsd: 14.5 },
  ],
}

describe('billingLines', () => {
  it('renders included usage and wallet credits as separate figures, plus forecast and both breakdowns', () => {
    const out = billingLines(base).join('\n')
    expect(out).toContain('tier:            pro')
    expect(out).toContain('status:          active')
    expect(out).toContain('billing cycle 2023-06-15 → 2023-07-14') // to − 1 day (inclusive last day)
    expect(out).toContain('included usage:  $25.00')
    expect(out).toContain('used:            $45.3200')
    expect(out).toContain('overage:         $20.3200')
    expect(out).toContain('credits:         $0.00')
    expect(out).toContain('forecast:        $97.1100  (predicted full cycle)')
    expect(out).toContain('subscription:    active')
    expect(out).toContain('by dimension:')
    expect(out).toContain('memory: 660 GB·min  ($6.6000)') // ram → memory label
    expect(out).toContain('cpu: 120 vCPU·min  ($3.2000)')
    expect(out).toContain('by project:')
    expect(out).toContain('  Project 1: $24.0000')
    expect(out).toContain('  Project 2: $14.5000')
  })

  // The whole point of the split: an org whose usage sits under its allowance still shows the full
  // wallet. Adding the two (the legacy `creditsUsd` figure) would print $8 here and mean nothing.
  it('free tier: credits is the wallet alone, never the allowance remainder; no subscription line', () => {
    const out = billingLines({ ...base, tier: 'free', subscriptionStatus: null,
      totals: { usedUsd: 2, includedUsd: 5, overageUsd: 0, creditBalanceUsd: 3, forecastUsd: 4 } }).join('\n')
    expect(out).toContain('included usage:  $5.00')
    expect(out).toContain('credits:         $3.00')
    expect(out).not.toContain('$8.00') // allowance remainder + wallet must never be summed
    expect(out).not.toContain('subscription:')
  })

  // The advice is opposite per cause, so the wrong line is worse than none: waiting for the next
  // cycle never settles an invoice, and there is no plan for a Team org to upgrade to.
  it.each(['past_due', 'unpaid'])('suspended on a paid tier (%s): names the payment', (subscriptionStatus) => {
    const out = billingLines({ ...base, billingStatus: 'suspended', subscriptionStatus }).join('\n')
    expect(out).toContain('subscription payment did not go through')
    expect(out).toContain('insta billing portal')
    expect(out).not.toContain('resumes next cycle')
  })

  // The commands resolve the org independently, so a hint that drops --org acts on a different org
  // than the one being read. Every hint, not just the portal one: the free-tier hint starts a
  // Stripe Checkout, so dropping the flag there subscribes the wrong org.
  it.each([
    ['paid', 'pro', 'past_due', 'insta billing portal --org org_123'],
    ['ended', 'pro', 'canceled', 'insta billing upgrade pro --org org_123'],
    ['free', 'free', null, 'insta billing upgrade pro --org org_123'],
  ])('carries --org into the %s hint', (_label, tier, subscriptionStatus, expected) => {
    const out = billingLines({ ...base, tier, subscriptionStatus, billingStatus: 'suspended' }, 'org_123').join('\n')
    expect(out).toContain(expected)
  })

  // The resubscribe hint has to name the org's OWN tier. `insta billing upgrade pro` on a Team org
  // resubscribes it onto the wrong plan, and enterprise has no self-serve command at all.
  it.each([
    ['pro', 'insta billing upgrade pro'],
    ['team', 'insta billing upgrade team'],
  ])('suspended after a cancellation on %s: names that tier', (tier, expected) => {
    const out = billingLines({ ...base, tier, billingStatus: 'suspended', subscriptionStatus: 'canceled' }).join('\n')
    expect(out).toContain(expected)
  })

  it('suspended after a cancellation on enterprise: no self-serve command exists, so it says so', () => {
    const out = billingLines({ ...base, tier: 'enterprise', billingStatus: 'suspended', subscriptionStatus: 'canceled' }).join('\n')
    expect(out).toContain('contact support')
    expect(out).not.toContain('insta billing upgrade')
  })

  // A cancelled subscription suspends the org and keeps its tier (platform#300), so "your
  // subscription is current" is the one thing it is not — and there is no invoice to settle.
  it('suspended after a cancellation: says the subscription ended, not that it is current', () => {
    const out = billingLines({ ...base, billingStatus: 'suspended', subscriptionStatus: 'canceled' }).join('\n')
    expect(out).toContain('the subscription ended; resubscribe')
    expect(out).not.toContain('is current')
    expect(out).not.toContain('did not go through')
  })

  it('suspended on free: still the wallet story, which a new cycle really does fix', () => {
    const out = billingLines({ ...base, tier: 'free', billingStatus: 'suspended' }).join('\n')
    expect(out).toContain('billing limit reached; resumes next cycle')
  })

  // Suspended while the subscription reads healthy: a recovery whose compute failed to restart.
  // Both other lines are wrong here — there is no invoice to settle and no cycle to wait for.
  it('suspended with a current subscription: neither of the other two stories', () => {
    const out = billingLines({ ...base, billingStatus: 'suspended', subscriptionStatus: 'active' }).join('\n')
    expect(out).toContain('contact support')
    expect(out).not.toContain('did not go through')
    expect(out).not.toContain('resumes next cycle')
    // It must not assert the subscription is healthy: `incomplete` lands here too.
    expect(out).not.toContain('is current')
  })

  it('empty breakdowns: no breakdown headers', () => {
    const out = billingLines({ ...base, byDimension: [], byProject: [] }).join('\n')
    expect(out).not.toContain('by dimension:')
    expect(out).not.toContain('by project:')
  })
})
