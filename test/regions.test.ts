import { afterEach, describe, expect, it, vi } from 'vitest'
import { regionsList } from '../src/commands/regions.js'

const regions = [
  { slug: 'us-east', label: 'US East (Virginia)' },
  { slug: 'eu-central', label: 'Europe (Frankfurt)' },
  { slug: 'ap-southeast', label: 'Asia Pacific (Singapore)' },
]

afterEach(() => vi.restoreAllMocks())

describe('insta config regions', () => {
  it.each([false, true])('prints only the platform catalog (json=%s)', async (json) => {
    const request = vi.fn().mockResolvedValue({ regions })
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })

    await regionsList({ json }, { api: { request } })

    expect(request).toHaveBeenCalledWith('GET', '/regions')
    const output = chunks.join('')
    if (json) expect(JSON.parse(output)).toEqual(regions)
    else expect(output).toBe(regions.map((r) => `${r.slug}  ${r.label}\n`).join(''))
  })
})
