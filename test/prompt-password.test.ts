import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { mutePasswordOutput, promptPasswordFrom } from '../src/util.js'

describe('mutePasswordOutput', () => {
  it('drops typed characters and still writes the newline', () => {
    let written = ''
    const real = new Writable({
      write(chunk, _encoding, callback) {
        written += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        callback()
      },
    })
    const mute = mutePasswordOutput(real)
    mute.write('s')
    mute.write('ecret')
    mute.write('\n')
    expect(written).toBe('\n')
  })
})

describe('promptPasswordFrom', () => {
  function capture(): { output: Writable; text: () => string } {
    let written = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        written += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        callback()
      },
    })
    return { output, text: () => written }
  }

  it('returns the line and does not echo it', async () => {
    const { output, text } = capture()
    await expect(promptPasswordFrom(Readable.from(['secret\n']), output, 'Password: ')).resolves.toBe('secret')
    expect(text()).toBe('Password: ')
    expect(text()).not.toContain('secret')
  })

  it('resolves empty when stdin closes without a line', async () => {
    const { output } = capture()
    await expect(promptPasswordFrom(Readable.from([]), output)).resolves.toBe('')
  })
})
