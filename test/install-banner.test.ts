// The installer's "Next steps" banner is the CLI's onboarding surface — and, because the binary
// upgrade channel re-runs `curl install.sh | sh` with inherited stdio, its upgrade banner too. It
// used to recommend `insta deploy . --port 3000` unqualified, back when that errored for any app
// without a Dockerfile. The requirement is now PER-TARGET: optional on insta-compute, where the
// gateway builds the directory with nixpacks, still required on a Fly-backed service. A banner
// cannot know which the reader has, so these assertions pin it to claiming neither.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const installSh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const nextSteps = installSh.slice(installSh.indexOf('echo "Next steps:"'))
const deployLine = nextSteps.split('\n').find((l) => l.includes('insta deploy .'))!

describe('installer next-steps banner', () => {
  it('recommends a deploy line at all (the banner is the onboarding path)', () => {
    expect(deployLine).toBeDefined()
  })

  // The requirement is now per-target: optional on insta-compute, required on Fly. A banner cannot
  // know which the reader has, so it must claim NEITHER rather than promise what deploy rejects.
  it('makes no Dockerfile claim either way, since the answer depends on the target', () => {
    expect(deployLine.toLowerCase()).not.toContain('dockerfile')
    expect(deployLine.toLowerCase()).not.toContain('no docker')
  })

  it('points at `insta build` first, so the user sees the plan before the deploy can dead-end', () => {
    expect(nextSteps).toContain('insta build .')
    expect(nextSteps.indexOf('insta build .')).toBeLessThan(nextSteps.indexOf('insta deploy .'))
  })
})
