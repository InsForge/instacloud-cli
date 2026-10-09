import { describe, expect, it } from 'vitest'
import { upgradePlanLines } from '../src/commands/template.js'

const plan = (over: Record<string, unknown> = {}) => ({
  from_version: '1.3.2', to_version: '1.4.0', to_digest: 'a'.repeat(64), removed: [], refusals: [],
  services: [{
    key: 'app', service_id: 'svc_1', service_name: 'n8n', gone: false, added: false, missing_variables: [],
    fields: [{ field: 'image', label: 'Image', deployed: 'n8nio/n8n:2.36.5', live: 'n8nio/n8n:2.36.5', next: 'n8nio/n8n:2.41.0', drifted: false, verdict: 'applied' }],
  }],
  ...over,
})

describe('upgradePlanLines', () => {
  it('prints the version move and the applied change', () => {
    const lines = upgradePlanLines(plan())
    expect(lines[0]).toContain('1.3.2 → 1.4.0')
    expect(lines.join('\n')).toContain('n8n  Image  n8nio/n8n:2.36.5 → n8nio/n8n:2.41.0')
  })

  it('marks a field the user changed', () => {
    const p = plan()
    p.services[0].fields[0] = { ...p.services[0].fields[0], live: 'n8nio/n8n:custom', drifted: true }
    expect(upgradePlanLines(p).join('\n')).toContain('you changed this')
  })

  it('prints a declared setting it will write', () => {
    const p = plan()
    p.services[0].fields.push({ field: 'always_on', label: 'Always on', deployed: null, live: 'off', next: 'on', drifted: false, verdict: 'applied' })
    expect(upgradePlanLines(p).join('\n')).toContain('Always on  off → on')
  })

  it('leads with the refusals when there are any', () => {
    const p = plan({ refusals: ['service app would change type from web to worker'] })
    expect(upgradePlanLines(p)[0]).toContain('cannot run')
    expect(upgradePlanLines(p).join('\n')).toContain('would change type')
  })

  it('names required variables with no value', () => {
    const p = plan()
    p.services[0].missing_variables = ['N8N_ENCRYPTION_KEY']
    expect(upgradePlanLines(p).join('\n')).toContain('N8N_ENCRYPTION_KEY')
  })
})
