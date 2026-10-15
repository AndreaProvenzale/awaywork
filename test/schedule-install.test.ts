import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Cancelled } from '../src/cli/ask.js'
import { type Io, installSchedule, whereToRun } from '../src/cli/schedule.js'
import type { Ask } from '../src/core/types.js'
import { WORKFLOW } from '../src/scheduler/github-actions.js'
import { defaultScheduler, type Scheduler, SchedulerError } from '../src/scheduler/index.js'
import { initial, scriptedAsk } from './fakes/ask.js'

const { installed, removed } = vi.hoisted(() => ({
  installed: [] as string[],
  removed: [] as string[],
}))

let failCron = false

vi.mock('../src/scheduler/index.js', async (original) => {
  const fake = (id: string): Scheduler => ({
    id,
    install: async () => {
      if (id === 'cron' && failCron) throw new SchedulerError('cron failed')
      installed.push(id)
      return `/fake/${id}`
    },
    remove: async () => {
      removed.push(id)
      return false
    },
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
  removed.length = 0
  failCron = false
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

it('offers later at the end of init only, not in schedule install', async () => {
  const { config, io } = await setup()
  const offered: string[][] = []
  const recording = (ask: Ask): Ask => ({
    ...ask,
    select: (message, choices, init) => {
      offered.push(choices.map((c) => c.value))
      return ask.select(message, choices, init)
    },
  })
  const install = io([[/^Where should it run/, initial]], true)
  await installSchedule(config, undefined, undefined, { ...install, ask: recording(install.ask) })
  await whereToRun(recording(scriptedAsk([[/^Where should it run/, initial]])), true)
  expect(offered).toEqual([
    ['', 'github-actions'],
    ['', 'github-actions', 'later'],
  ])
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

it('leaves the other schedulers alone when the install fails', async () => {
  const { config, io } = await setup()
  failCron = true
  await installSchedule(config, 'cron', undefined, io([], true))
  expect(removed).toEqual([])
  expect(out).toEqual(['cron failed'])
  expect(process.exitCode).toBe(1)
})
