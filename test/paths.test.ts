import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { packageVersion } from '../src/config/paths.js'

describe('paths', () => {
  it('reads the version from package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageVersion).toBe(pkg.version)
  })
})
