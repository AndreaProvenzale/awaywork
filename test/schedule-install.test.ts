import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Cancelled } from '../src/cli/ask.js'
import { type Io, installSchedule } from '../src/cli/schedule.js'
import { WORKFLOW } from '../src/scheduler/github-actions.js'
import { defaultScheduler, type Scheduler } from '../src/scheduler/index.js'
import { initial, scriptedAsk } from './fakes/ask.js'

const { installed } = vi.hoisted(() => ({ installed: [] as string[] }))

vi.mock('../src/scheduler/index.js', async (original) => {
  const fake = (id: string): Scheduler => ({
    id,
    install: async () => {
      installed.push(id)
      return `/fake/${id}`
    },
    remove: async () => false,
    read: async () => undefined,
  })
  return {
    ...(await original<typeof import('../src/scheduler/index.js')>()),
    schedulers: () => ({ launchd: fake('launchd'), systemd: fake('systemd'), cron: fake('cron') }),
  }
})

let out: string[]
beforeEach(() => {
  out = []
  installed.length = 0
  vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line) => void out.push(String(line)))
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
  const config = join(await mkdtemp(join(tmpdir(), 'awaywork-home-')), 'config.yml')
  await writeFile(config, 'providers: [claude]\nsources: { github: { repos: [acme/api] } }\n')
  const io = (script: [RegExp, unknown][], interactive: boolean): Io => ({
    run: async () => root,
    ask: scriptedAsk(script),
    env: {},
    setSecret: async () => {},
    interactive,
  })
  return { root, config, io }
}

it("asks where it runs in a terminal; this machine takes the platform's scheduler", async () => {
  const { config, io } = await setup()
  await installSchedule(config, undefined, undefined, io([[/^Where should it run/, initial]], true))
  expect(installed).toEqual([defaultScheduler()])
})

it('asks the GitHub Actions questions after picking it', async () => {
  const { root, config, io } = await setup()
  const script: [RegExp, unknown][] = [
    [/^Where should it run on a schedule\?$/, 'github-actions'],
    [/^Whose control repo is this\?$/, initial],
    [/^Which runner\?$/, initial],
  ]
  await installSchedule(config, undefined, undefined, io(script, true))
  expect(installed).toEqual([])
  expect(parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run['runs-on']).toBe(
    'ubuntu-latest',
  )
})

it('asks nothing without a terminal, or when --with names the scheduler', async () => {
  const { config, io } = await setup()
  await installSchedule(config, undefined, undefined, io([], false))
  await installSchedule(config, 'cron', undefined, io([], true))
  expect(installed).toEqual([defaultScheduler(), 'cron'])
  expect(process.exitCode).toBeUndefined()
})

it('installs nothing when the question is left', async () => {
  const { config, io } = await setup()
  const leave = io([], true)
  leave.ask.select = async () => {
    throw new Cancelled('cancelled')
  }
  await installSchedule(config, undefined, undefined, leave)
  expect(installed).toEqual([])
  expect(out).toEqual(['Cancelled'])
  expect(process.exitCode).toBe(1)
})
