import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { mutePasswordOutput, promptPasswordFrom } from '../src/util.js'

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

function fakeTtyInput(): { input: PassThrough; rawModes: boolean[] } {
  const rawModes: boolean[] = []
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModes.push(mode)
      return input
    },
  })
  return { input, rawModes }
}

describe('mutePasswordOutput', () => {
  function writes(...chunks: string[]): string {
    const { output, text } = capture()
    const mute = mutePasswordOutput(output)
    for (const chunk of chunks) mute.write(chunk)
    return text()
  }

  it('drops typed characters and still writes the newline', () => {
    expect(writes('s', 'ecret', '\n')).toBe('\n')
  })

  it('forwards only the line ending when one chunk carries the secret too', () => {
    expect(writes('secret\n')).toBe('\n')
    expect(writes('secret')).toBe('')
    expect(writes('\r\n')).toBe('\r\n')
  })
})

describe('promptPasswordFrom', () => {
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

  describe('with a TTY stdin and redirected stdout', () => {
    it('uses raw mode and hides keystrokes typed one at a time', async () => {
      const { input, rawModes } = fakeTtyInput()
      const { output, text } = capture()
      const answer = promptPasswordFrom(input, output, 'Password: ')
      for (const ch of 'secret\r') input.write(ch)
      await expect(answer).resolves.toBe('secret')
      expect(rawModes[0]).toBe(true)
      expect(rawModes.at(-1)).toBe(false)
      expect(text()).toContain('Password: ')
      expect(text()).not.toContain('secret')
    })

    it('hides a password that arrives in one chunk with its newline', async () => {
      const { input, rawModes } = fakeTtyInput()
      const { output, text } = capture()
      const answer = promptPasswordFrom(input, output, 'Password: ')
      input.write('secret\n')
      await expect(answer).resolves.toBe('secret')
      expect(rawModes[0]).toBe(true)
      expect(rawModes.at(-1)).toBe(false)
      expect(text()).toContain('Password: ')
      expect(text()).not.toContain('secret')
    })

    it('finishes on Ctrl-C instead of hanging', async () => {
      const { input, rawModes } = fakeTtyInput()
      const { output } = capture()
      const answer = promptPasswordFrom(input, output)
      input.write('sec')
      input.write('\x03')
      await expect(answer).resolves.toBe('')
      expect(rawModes.at(-1)).toBe(false)
    })
  })
})
