import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  bin,
  configDir,
  defaultConfigPath,
  packageVersion,
  skillsDirOf,
} from '../src/config/paths.js'

describe('paths', () => {
  it('reads the version from package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageVersion).toBe(pkg.version)
  })

  it('puts the user skills beside the config in use', () => {
    expect(skillsDirOf(defaultConfigPath)).toBe(join(configDir, 'skills'))
    expect(skillsDirOf('.awaywork/config.yml')).toBe(join('.awaywork', 'skills'))
  })

  it('finds a command on PATH past what is not an executable file, and keeps the bare name when absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-bin-'))
    const plain = join(root, 'plain')
    const found = join(root, 'found')
    await mkdir(join(root, 'folder', 'awaywork-tool'), { recursive: true })
    await mkdir(plain)
    await writeFile(join(plain, 'awaywork-tool'), '')
    await mkdir(found)
    await writeFile(join(found, 'awaywork-tool'), '', { mode: 0o755 })
    vi.stubEnv('PATH', ['', plain, join(root, 'folder'), found].join(':'))
    expect(bin('awaywork-tool')).toBe(join(found, 'awaywork-tool'))
    expect(bin('awaywork-missing')).toBe('awaywork-missing')
    vi.unstubAllEnvs()
  })
})
