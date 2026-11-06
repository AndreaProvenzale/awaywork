import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { secretFrom } from '../src/cli/secret.js'

const envIn = async () => join(await mkdtemp(join(tmpdir(), 'awaywork-env-')), 'env')
const piped = (text: string) => Readable.from([text])

describe('awaywork secret', () => {
  it('saves what is piped in, less its last newline, and says where without the value', async () => {
    const file = await envIn()
    const said = await secretFrom('ASANA_TOKEN', piped('2/1234:abcd\r\n'), file)
    expect(said).toBe(`Saved ASANA_TOKEN in ${file}`)
    expect(said).not.toContain('2/1')
    expect(await readFile(file, 'utf8')).toBe('ASANA_TOKEN=2/1234:abcd\n')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await secretFrom('ASANA_TOKEN', piped('new'), file)
    expect(await readFile(file, 'utf8')).toBe('ASANA_TOKEN=new\n')
  })

  it('refuses a name that is no variable, and an empty or multi-line value, saving nothing', async () => {
    const file = await envIn()
    for (const name of ['asana_token', '1TOKEN', 'A-B', 'A B', ''])
      await expect(secretFrom(name, piped('x'), file)).rejects.toThrow("isn't a variable name")
    await expect(secretFrom('T', piped('\n'), file)).rejects.toThrow('the value for T is empty')
    await expect(secretFrom('T', piped('a\nb\n'), file)).rejects.toThrow('spans lines')
    await expect(stat(file)).rejects.toThrow('ENOENT')
  })
})
