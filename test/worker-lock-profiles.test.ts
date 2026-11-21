import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { switchTo } from '#config/profiles'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function isolationOf(home: string, profile: string) {
  vi.stubEnv('HOME', home)
  vi.stubEnv('AWAYWORK_PROFILE', profile)
  vi.resetModules()
  return import('#core/isolation')
}

it('lets the units of two profiles hold their worker locks at once, none waiting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-profiles-'))
  const config = join(home, '.config', 'awaywork')
  await mkdir(config, { recursive: true })
  await writeFile(join(home, 'config.yml'), '')
  for (const name of ['one', 'two'])
    await switchTo(join(config, 'profiles.yml'), name, join(home, 'config.yml'))
  const one = await isolationOf(home, 'one')
  const two = await isolationOf(home, 'two')
  expect(one.WORKER_LOCK).not.toBe(two.WORKER_LOCK)
  one.isolate(one.WORKER)
  two.isolate(two.WORKER)
  const waits: string[] = []
  let finish = () => {}
  const first = one.holdingWorker(
    () => new Promise<void>((done) => (finish = done)),
    (line) => waits.push(line),
  )
  await new Promise((r) => setTimeout(r, 100))
  let ran = false
  await two.holdingWorker(
    async () => {
      ran = true
    },
    (line) => waits.push(line),
  )
  expect(ran).toBe(true)
  expect(waits).toEqual([])
  finish()
  await first
})
