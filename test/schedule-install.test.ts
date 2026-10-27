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

const { installed, removed, woke, commands } = vi.hoisted(() => ({
  installed: [] as string[],
  removed: [] as string[],
  woke: [] as string[],
  commands: [] as string[][],
}))

let failCron = false
let failWake = false
let wakeReason: string | undefined
let wakeDefault = true

vi.mock('../src/scheduler/wake.js', async (original) => ({
  ...(await original<typeof import('../src/scheduler/wake.js')>()),
  keepAwake: async () => ['/usr/bin/caffeinate', '-i'],
  wakeFor: async () =>
    wakeReason ?? {
      question: 'Wake this machine when a window opens?',
      initial: wakeDefault,
      install: async () => {
        if (failWake) throw Object.assign(new Error('sudo failed'), { stderr: 'no password' })
        woke.push('wake')
      },
    },
}))

vi.mock('../src/scheduler/index.js', async (original) => {
  const fake = (id: string): Scheduler => ({
    id,
    install: async (s) => {
      if (id === 'cron' && failCron) throw new SchedulerError('cron failed')
      installed.push(id)
      commands.push(s.command)
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
  woke.length = 0
  commands.length = 0
  failCron = false
  failWake = false
  wakeReason = undefined
  wakeDefault = true
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
  const script: [RegExp, unknown][] = [
    [/^Where should it run/, initial],
    [/^Wake this machine/, false],
  ]
  await installSchedule(config, undefined, io(script, true))
  expect(installed).toEqual([defaultScheduler()])
  expect(woke).toEqual([])
})

it('wakes the machine when asked in a terminal, and only says how without one', async () => {
  const { config, io } = await setup()
  await installSchedule(config, 'cron', io([[/^Wake this machine/, initial]], true))
  expect(woke).toEqual(['wake'])
  expect(out.at(-1)).toBe('This machine wakes when a window opens')
  await installSchedule(config, 'cron', io([], false))
  expect(woke).toEqual(['wake'])
  expect(out.at(-1)).toBe(
    '`awaywork schedule install` in a terminal also wakes this machine for the runs',
  )
})

it("takes the wake's default answer, no when it replaces power events", async () => {
  const { config, io } = await setup()
  wakeDefault = false
  await installSchedule(config, 'cron', io([[/^Wake this machine/, initial]], true))
  expect(woke).toEqual([])
})

it('keeps the run awake by wrapping the scheduled command', async () => {
  const { config, io } = await setup()
  await installSchedule(config, 'cron', io([], false))
  expect(commands[0]?.slice(0, 3)).toEqual(['/usr/bin/caffeinate', '-i', process.execPath])
})

it('says why it cannot wake without asking', async () => {
  const { config, io } = await setup()
  wakeReason = 'pmset repeats one wake time'
  await installSchedule(config, 'cron', io([], true))
  expect(installed).toEqual(['cron'])
  expect(out.at(-1)).toBe('pmset repeats one wake time')
  expect(process.exitCode).toBeUndefined()
})

it('takes leaving the wake question as no, and keeps the job', async () => {
  const { config, io } = await setup()
  const terminal = io([], true)
  const ask: Ask = {
    ...terminal.ask,
    confirm: async () => {
      throw new Cancelled('cancelled')
    },
  }
  await installSchedule(config, 'cron', { ...terminal, ask })
  expect(installed).toEqual(['cron'])
  expect(woke).toEqual([])
  expect(out).not.toContain('Cancelled')
  expect(process.exitCode).toBeUndefined()
})

it('keeps the job when setting the wake fails', async () => {
  const { config, io } = await setup()
  failWake = true
  await installSchedule(config, 'cron', io([[/^Wake this machine/, true]], true))
  expect(installed).toEqual(['cron'])
  expect(out.at(-1)).toBe('No wake set: no password')
  expect(process.exitCode).toBe(1)
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
  const install = io(
    [
      [/^Where should it run/, initial],
      [/^Wake this machine/, false],
    ],
    true,
  )
  await installSchedule(config, undefined, { ...install, ask: recording(install.ask) })
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
    [/^Which runner\?$/, initial],
  ]
  await installSchedule(config, undefined, io(script, true))
  expect(installed).toEqual([])
  expect(parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run['runs-on']).toBe(
    'ubuntu-latest',
  )
})

it('asks nothing without a terminal, or where when --with names the scheduler', async () => {
  const { config, io } = await setup()
  await installSchedule(config, undefined, io([], false))
  await installSchedule(config, 'cron', io([[/^Wake this machine/, false]], true))
  expect(installed).toEqual([defaultScheduler(), 'cron'])
  expect(process.exitCode).toBeUndefined()
})

it('installs nothing when the question is left', async () => {
  const { config, io } = await setup()
  const leave = io([], true)
  leave.ask.select = async () => {
    throw new Cancelled('cancelled')
  }
  await installSchedule(config, undefined, leave)
  expect(installed).toEqual([])
  expect(out).toEqual(['Cancelled'])
  expect(process.exitCode).toBe(1)
})

it('leaves the other schedulers alone when the install fails', async () => {
  const { config, io } = await setup()
  failCron = true
  await installSchedule(config, 'cron', io([], true))
  expect(removed).toEqual([])
  expect(out).toEqual(['cron failed'])
  expect(process.exitCode).toBe(1)
})
