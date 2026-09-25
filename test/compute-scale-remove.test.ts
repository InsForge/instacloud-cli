import { describe, it, expect } from 'vitest'
import { removeTarget, computeScale } from '../src/commands/compute.js'

const INST = 'inst-0123456789ab'

describe('removeTarget', () => {
  it('takes the first positional as the service', () => {
    expect(removeTarget('api', undefined, { remove: INST })).toBe('api')
  })

  it('leaves the service to be resolved when none is named', () => {
    expect(removeTarget(undefined, undefined, { remove: INST })).toBeUndefined()
  })

  it('refuses a count, since --remove lowers it by one', () => {
    expect(() => removeTarget('2', 'api', { remove: INST })).toThrow(/pass no count/)
    expect(() => removeTarget('2.0', 'api', { remove: INST })).toThrow(/pass no count/)
    expect(() => removeTarget('+2', 'api', { remove: INST })).toThrow(/pass no count/)
  })

  it('takes an all-digit lone positional as the service', () => {
    expect(removeTarget('123', undefined, { remove: INST })).toBe('123')
  })

  it('refuses a malformed instance id before any request', () => {
    expect(() => removeTarget('api', undefined, { remove: 'api-1' })).toThrow(/invalid instance id/)
  })

  it('refuses --region and a stray second argument', () => {
    expect(() => removeTarget('api', undefined, { remove: INST, region: 'us-east' })).toThrow(/--region/)
    expect(() => removeTarget('api', 'web', { remove: INST })).toThrow(/unexpected argument: web/)
  })
})

describe('computeScale', () => {
  it('needs a count unless --remove names an instance', async () => {
    await expect(computeScale(undefined, undefined, {})).rejects.toThrow(/replica count is required/)
  })
})
