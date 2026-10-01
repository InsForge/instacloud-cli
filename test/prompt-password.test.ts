import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { mutePasswordOutput } from '../src/util.js'

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
