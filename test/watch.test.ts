import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printStatus } from '../src/cli/schedule.js'
import { appendLog, stopWatch, watch } from '../src/cli/watch.js'
import {
  runLockPath,
  runsDir,
  watchLockPath,
  watchLogPath,
  watchStatePath,
} from '../src/config/paths.js'
import type { Schedule, Scheduler } from '../src/scheduler/index.js'

vi.mock('../src/providers/index.js', async () => {
  const { fakeProvider } = await import('./fakes/provider.js')
  // No quota reading: a present run's units sit out, so none clones.
  const providers = { claude: { ...fakeProvider('claude'), probe: async () => null } }
  return {
    providers,
    providerFor: (id: string) => providers[id as 'claude'],
    providersOf: () => providers,
  }
})
vi.mock('../src/scheduler/wake.js', async (original) => ({
  ...(await original<typeof import('../src/scheduler/wake.js')>()),
  holdAwake: async () => () => {},
}))
vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    runsDir: `${state}/runs`,
    attemptsPath: `${state}/attempts.json`,
    runLockPath: `${state}/run.lock`,
    skipsPath: `${state}/skips.json`,
    approvalsPath: `${state}/approvals.json`,
    watchLockPath: `${state}/watch.lock`,
    watchStatePath: `${state}/watch.json`,
    watchLogPath: `${state}/watch.log`,
  }
})

const hhmm = (offset: number) => new Date(Date.now() + offset * 60_000).toTimeString().slice(0, 5)

/** A config whose one window is open now, or `windows` as given. */
async function config(windows = `[{ start: "${hhmm(-60)}", end: "${hhmm(60)}" }]`) {
  const path = join(await mkdtemp(join(tmpdir(), 'awaywork-watch-')), 'config.yml')
  await writeFile(
    path,
    `providers: [claude]\nsources: { chores: { command: exit 1 } }\nwindows: ${windows}\n`,
  )
  return path
}

const daemonLog = () => readFile(watchLogPath, 'utf8').catch(() => '')

/** Runs the daemon until its log shows `until`, then stops it. */
async function watchUntil(path: string, until: string) {
  const stop = new AbortController()
  const done = watch(path, stop.signal)
  await vi.waitFor(async () => expect(await daemonLog()).toContain(until), { timeout: 10_000 })
  stop.abort()
  await done
  return daemonLog()
}

let out: string[]
beforeEach(async () => {
  out = []
  vi.spyOn(console, 'log').mockImplementation((...line) => void out.push(line.join(' ')))
  vi.stubEnv('GITHUB_OUTPUT', '')
  vi.stubEnv('RUNNER_ENVIRONMENT', '')
  for (const file of [watchLogPath, watchLockPath, watchStatePath, runLockPath])
    await rm(file, { force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('awaywork watch', () => {
  it('starts a window run in an open window, logging events and its output to the run dir', async () => {
    const log = await watchUntil(await config(), 'Report: ')
    const runId = /window run (\d{8}-\d{6}) started, until /.exec(log)?.[1] ?? ''
    expect(log).toMatch(/^\S+ \S+ awaywork watch started, pid \d+, config /)
    expect(log).toContain(`Run ${runId}: 0 units planned, state in ${join(runsDir, runId)}`)
    expect(log).toContain('warning: source chores: Command failed with exit code 1')
    expect(log.trimEnd()).toMatch(/awaywork watch stopped$/)
    const runLog = await readFile(join(runsDir, runId, 'run.log'), 'utf8')
    expect(runLog).toContain(`Run ${runId}: 0 units planned`)
    expect(existsSync(join(runsDir, runId, 'report.md'))).toBe(true)
    expect(existsSync(runLockPath)).toBe(false)
    expect(existsSync(watchLockPath)).toBe(false)
    expect(existsSync(watchStatePath)).toBe(false)
  })

  it('logs a config that fails to load and keeps going with nothing to do', async () => {
    const path = await config()
    await writeFile(path, 'providers: [nope]\n')
    const log = await watchUntil(path, 'config not loaded: ')
    expect(log).not.toContain('window run')
  })

  it('idles with no windows, and waits on a manual run holding the run lock, saying so once', async () => {
    const before = existsSync(runsDir) ? await readdir(runsDir) : []
    await watchUntil(await config('[]'), 'awaywork watch started')
    await writeFile(runLockPath, `${process.pid} 20261025-010000`)
    const log = await watchUntil(await config(), 'holds the run lock')
    expect(log).toContain(
      'a window is open, but run 20261025-010000 (pid ' +
        `${process.pid}) holds the run lock; trying again each minute`,
    )
    expect(log).not.toContain('window run')
    expect(existsSync(runsDir) ? await readdir(runsDir) : []).toEqual(before)
  })

  it('starts a present soon run for a due unit, notifying no run end, and backs off a failing source', async () => {
    const path = await config('[]')
    const dir = dirname(path)
    const item = {
      id: '1',
      key: 'CH-1',
      title: 'Fix the typo',
      url: 'https://example.com/1',
      fields: { repo: 'acme/api', updated: '2026-10-25T10:00:00Z' },
    }
    await writeFile(join(dir, 'items.json'), JSON.stringify([item]))
    await writeFile(
      path,
      `providers: [claude]
windows: []
sources: { chores: { command: cat items.json }, broken: { command: exit 1 } }
queue: [{ skill: plan, run: soon }]
notify: { command: 'echo $AWAYWORK_EVENT >> ${join(dir, 'events.txt')}' }
`,
    )
    const log = await watchUntil(path, 'Report: ')
    expect(log).toMatch(
      /source broken: poll failed, next at \S+ \S+: Command failed with exit code 1: 'exit 1'$/m,
    )
    const runId = /soon run (\d{8}-\d{6}) started for ch-1\n/.exec(log)?.[1] ?? ''
    expect(runId).not.toBe('')
    const plan = await readFile(join(runsDir, runId, 'plan.txt'), 'utf8')
    expect(plan).toContain('present run (outside the windows)')
    expect(plan).toContain('claude sits out a present run')
    expect(await readFile(join(dir, 'events.txt'), 'utf8')).toBe('unit\n')
    expect(existsSync(runLockPath)).toBe(false)
  })

  it('exits in one line while another copy runs, and takes over a dead one', async () => {
    await writeFile(watchLockPath, `${process.pid} watch`)
    await watch(await config(), new AbortController().signal)
    expect(out).toEqual([`awaywork watch is already running (pid ${process.pid})`])
    expect(await daemonLog()).toBe('')

    const dead = await execa('node', ['-e', 'console.log(process.pid)'])
    await writeFile(watchLockPath, `${dead.stdout} watch`)
    await watch(await config(), AbortSignal.abort())
    expect(await daemonLog()).toContain('awaywork watch stopped')
    expect(existsSync(watchLockPath)).toBe(false)
  })
})

describe('stopping the daemon', () => {
  it('SIGTERMs the lock holder and waits for it to exit', async () => {
    const daemon = execa('sleep', ['30'], { reject: false })
    await writeFile(watchLockPath, `${daemon.pid} watch`)
    expect(await stopWatch()).toBeUndefined()
    expect((await daemon).signal).toBe('SIGTERM')
    expect(out).toEqual([`Stopping awaywork watch (pid ${daemon.pid})`])
    expect(await stopWatch()).toBeUndefined()
    expect(out).toHaveLength(1)
  })

  it("leaves alone a pid reused since a crash left the lock, and another user's", async () => {
    const other = execa('sleep', ['30'], { reject: false })
    await writeFile(watchLockPath, `${other.pid} watch`)
    const before = new Date(Date.now() - 3_600_000)
    await utimes(watchLockPath, before, before)
    expect(await stopWatch(300)).toBeUndefined()
    other.kill('SIGKILL')
    expect((await other).signal).toBe('SIGKILL')
    await writeFile(watchLockPath, '1 watch')
    expect(await stopWatch(300)).toBeUndefined()
    expect(out).toEqual([])
  })

  it("gives up after the wait on one that doesn't exit, and says its pid", async () => {
    const daemon = execa(
      'node',
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
      { reject: false },
    )
    await new Promise((ready) => daemon.stdout?.once('data', ready))
    await writeFile(watchLockPath, `${daemon.pid} watch`)
    try {
      expect(await stopWatch(300)).toBe(daemon.pid)
    } finally {
      daemon.kill('SIGKILL')
      await daemon
    }
  })
})

it('rotates a log past its size, keeping one previous generation', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'awaywork-log-')), 'watch.log')
  appendLog(file, 'one', 5)
  appendLog(file, 'two', 5)
  appendLog(file, 'three', 5)
  appendLog(file, 'four', 5)
  expect(await readFile(file, 'utf8')).toBe('four\n')
  expect(await readFile(`${file}.1`, 'utf8')).toBe('three\n')
})

describe('schedule status', () => {
  const job = (command: string[]): Schedule => ({
    command,
    path: '/usr/bin',
    log: '/h/schedule.log',
  })
  const installed = (schedule?: Schedule): Record<string, Scheduler> => ({
    launchd: {
      id: 'launchd',
      install: async () => '',
      remove: async () => false,
      read: async () => schedule,
    },
  })

  it('shows the daemon down, then up with its runs in progress, next polls and the next window', async () => {
    const path = await config('[{ start: "01:00", end: "07:00" }]')
    const current = installed(job(['/node', '/awaywork', 'watch', '--config', path]))
    await printStatus(undefined, current)
    expect(out.slice(0, 3)).toEqual([
      'Scheduled with launchd, keeping awaywork watch running',
      `Config: ${path}`,
      'Log: /h/schedule.log',
    ])
    expect(out).toContain('Daemon: not running')
    expect(out.find((l) => l.startsWith('Next window: '))).toMatch(/ 01:00:00$/)
    expect(out.at(-1)).toBe(`Daemon log: ${watchLogPath}`)

    out = []
    await writeFile(watchLockPath, `${process.pid} watch`)
    const window = { trigger: 'window', runId: '20261025-230000', until: '2026-10-26T05:00:00Z' }
    const runs = [window, { trigger: 'soon', runId: '20261025-231500' }]
    const polls = {
      github: { next: '2026-10-25T23:20:00Z' },
      jira: { next: '2026-10-25T23:50:00Z', failures: 2 },
    }
    const since = '2026-10-25T07:12:03Z'
    const daemon = { pid: process.pid, since, config: path, runs, polls }
    await writeFile(watchStatePath, JSON.stringify(daemon))
    await printStatus(undefined, current)
    const local = (iso: string) => new Date(iso).toLocaleString('sv-SE')
    expect(out).toContain(`Daemon: running, pid ${process.pid}, since ${local(since)}`)
    expect(out).toContain(
      `Run in progress: window run 20261025-230000, until ${local(window.until)}`,
    )
    expect(out).toContain('Run in progress: soon run 20261025-231500')
    expect(out).toContain(`Next poll of github: ${local(polls.github.next)}`)
    expect(out).toContain(
      `Next poll of jira: ${local(polls.jira.next)}, backing off after 2 failed polls`,
    )

    out = []
    await writeFile(watchStatePath, '')
    await printStatus(undefined, current)
    expect(out).toContain('Daemon: not running')
  })

  it('tells an older per-window job to reinstall, without daemon lines', async () => {
    await printStatus(undefined, installed(job(['/node', '/awaywork', 'run', '--scheduled'])))
    expect(out[0]).toBe(
      'Scheduled with launchd, installed by an older awaywork; run `awaywork schedule install` again',
    )
    expect(out.some((l) => l.startsWith('Daemon'))).toBe(false)
  })
})
