// The deploy request body maps CLI options to the platform API. --websocket is only sent when set, so
// a plain deploy is byte-for-byte unchanged.
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { deployRequestBody, noDockerfileMessage, repoConnectedHint } from '../src/commands/deploy.js'

describe('deployRequestBody', () => {
  it('omits websocket for a normal deploy', () => {
    const b = deployRequestBody({ image: 'img' }, 'main', { port: '3000' })
    expect(b.websocket).toBeUndefined()
    expect(b).toMatchObject({ image: 'img', branch: 'main', port: 3000 })
  })
  it('sends websocket:true when --websocket is set', () => {
    expect(deployRequestBody({ image: 'img' }, 'main', { websocket: true }).websocket).toBe(true)
    expect(deployRequestBody({ image: 'img' }, 'main', { replaceSource: true }).replaceSource).toBe(true)
    expect(deployRequestBody({ image: 'img' }, 'main', {})).not.toHaveProperty('replaceSource', true)
  })
  it('leaves port undefined when not provided', () => {
    expect(deployRequestBody({ image: 'img' }, 'main', {}).port).toBeUndefined()
  })
})

// The bare "add one, or use --image <url>" left the user at a dead end while `insta build` was
// telling them nixpacks would build the same directory. The message must name every real way
// forward, including the nixpacks lane and why it isn't this one.
describe('noDockerfileMessage', () => {
  const msg = noDockerfileMessage('/app/src')

  it('names the missing file and that a directory deploy builds the directory Dockerfile', () => {
    expect(msg).toContain(join('/app/src', 'Dockerfile'))
    expect(msg).toContain('builds the Dockerfile in the directory')
  })

  it('names all three ways forward: write a Dockerfile, --image, the GitHub nixpacks lane', () => {
    expect(msg).toContain('add a Dockerfile to /app/src')
    expect(msg).toContain('insta build /app/src')
    expect(msg).toContain('insta deploy --image <url>')
    expect(msg).toContain('nixpacks')
  })

  it('attributes the nixpacks BUILD lane to the GitHub flow, not to this command', () => {
    const laneLine = msg.split('\n').find((l) => l.includes('nixpacks server-side'))!
    expect(laneLine).toContain('GitHub repo')
    // No line may offer `insta deploy` and a nixpacks build together — that pairing is the lie.
    expect(msg.split('\n').filter((l) => l.includes('insta deploy') && l.includes('nixpacks'))).toEqual([])
  })

  it('never tells the user to save the generated Dockerfile — it is not standalone', () => {
    // It COPYs .nixpacks/nixpkgs-<hash>.nix support files the source dir has no copy of.
    expect(msg).not.toMatch(/--explain/)
    expect(msg).not.toMatch(/save (it|the generated)/i)
  })
})

describe('repoConnectedHint', () => {
  // The platform's 409 names the body field it wants; a CLI user can only pass the flag.
  it('names the flag, and leaves the rest of the platform message alone', () => {
    const real = "this service deploys from acme/app — pass replaceSource: true to switch it to this image (the repo connection is removed), or disconnect the repo first"
    const out = repoConnectedHint(real)
    expect(out).toContain('pass --replace-source to switch it to this image')
    expect(out).toContain('deploys from acme/app')
    expect(out).not.toContain('replaceSource: true')
  })
  it('passes through a message that says nothing about it', () => {
    expect(repoConnectedHint('some other conflict')).toBe('some other conflict')
  })
})
