import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/forge/gh.js', () => ({
  exec: async (cmd: string, args: string[]) => {
    if (cmd === 'git') return 'git version 2.50.0\nextra'
    throw new Error(`${cmd} ${args.join(' ')}: not found`)
  },
}))

vi.mock('../src/config/paths.js', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const configDir = mkdtempSync(join(tmpdir(), 'nightshift-config-'))
  return { ...(await importOriginal<object>()), configDir }
})

const { runChecks } = await import('../src/cli/doctor.js')
const { configDir } = await import('../src/config/paths.js')

describe('doctor', () => {
  it('reports each check as { status, what, detail } and stops at a missing config', async () => {
    const path = join(import.meta.dirname, 'fixtures', 'missing.yml')
    const seen: unknown[] = []
    vi.stubEnv('GH_TOKEN', '')
    const checks = await runChecks(path, (c) => seen.push(c))
    vi.unstubAllEnvs()
    expect(seen).toEqual(checks)
    expect(checks).toContainEqual({
      status: 'ok',
      what: 'git',
      detail: 'git version 2.50.0',
    })
    expect(checks).toContainEqual({ status: 'FAIL', what: 'gh', detail: 'not found on PATH' })
    expect(checks).toContainEqual({ status: 'FAIL', what: 'gh login', detail: 'GH_TOKEN unset' })
    expect(checks.at(-1)).toEqual({ status: 'FAIL', what: path, detail: 'file not found' })
  })

  it("warns that the default skills aren't used with a config elsewhere", async () => {
    await mkdir(join(configDir, 'skills/mine'), { recursive: true })
    await writeFile(join(configDir, 'skills/mine/SKILL.md'), '---\nname: mine\n---\n')
    const elsewhere = await mkdtemp(join(tmpdir(), 'nightshift-elsewhere-'))
    expect(await runChecks(join(elsewhere, 'config.yml'), () => {})).toContainEqual({
      status: 'warn',
      what: join(configDir, 'skills'),
      detail: `not used with this config; move or link its skills to ${join(elsewhere, 'skills')}`,
    })
    const own = await runChecks(join(configDir, 'config.yml'), () => {})
    expect(own.map((c) => c.what)).not.toContain(join(configDir, 'skills'))
  })
})
