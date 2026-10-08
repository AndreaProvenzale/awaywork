import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { bin, packageVersion } from '../src/config/paths.js'

describe('paths', () => {
  it('reads the version from package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageVersion).toBe(pkg.version)
  })

  it('finds a command on PATH past what is not an executable file, and keeps the bare name when absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-bin-'))
    const plain = join(root, 'plain')
    const found = join(root, 'found')
    await mkdir(join(root, 'folder', 'nightshift-tool'), { recursive: true })
    await mkdir(plain)
    await writeFile(join(plain, 'nightshift-tool'), '')
    await mkdir(found)
    await writeFile(join(found, 'nightshift-tool'), '', { mode: 0o755 })
    vi.stubEnv('PATH', ['', plain, join(root, 'folder'), found].join(':'))
    expect(bin('nightshift-tool')).toBe(join(found, 'nightshift-tool'))
    expect(bin('nightshift-missing')).toBe('nightshift-missing')
    vi.unstubAllEnvs()
  })
})
