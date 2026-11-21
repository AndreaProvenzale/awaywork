import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Unit } from '#core/types'
import { writablePaths } from '#worker/chain/step'

const { root } = vi.hoisted(() => ({ root: { dir: '' } }))

vi.mock('#config/paths', async (original) => {
  const { mkdtemp, realpath } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await realpath(await mkdtemp(`${tmpdir()}/awaywork-paths-`))
  root.dir = dir
  return {
    ...(await original<typeof import('#config/paths')>()),
    configDir: `${dir}/config`,
    defaultConfigPath: `${dir}/default/config.yml`,
    profilesPath: `${dir}/profiles.yml`,
    rootStateDir: `${dir}/state`,
  }
})

const unitOf = (...writable: string[]) => ({ writable }) as Unit

it('refuses awaywork built-in folders, their parent and registered profiles', async () => {
  const other = join(root.dir, 'other')
  const cache = join(root.dir, 'cache')
  for (const dir of ['config', 'default', 'state', 'other', 'cache'])
    await mkdir(join(root.dir, dir))
  await writeFile(join(root.dir, 'profiles.yml'), `profiles: { work: ${other}/config.yml }\n`)
  const lines: string[] = []
  const got = await writablePaths(
    unitOf(
      join(root.dir, 'config'),
      join(root.dir, 'default'),
      join(root.dir, 'state'),
      other,
      root.dir,
      cache,
    ),
    '/clone',
    (l) => lines.push(l),
  )
  expect(got).toEqual([cache])
  expect(lines.filter((l) => l.includes('overlaps'))).toHaveLength(5)
})

it('goes on with a broken registry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-writable-'))
  try {
    await writeFile(join(root.dir, 'profiles.yml'), 'profiles: nope\n')
    expect(await writablePaths(unitOf(dir), '/clone', () => {})).toEqual([await realpath(dir)])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
