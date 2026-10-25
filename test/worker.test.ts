import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type Allowance, allowance } from '../src/core/budget.js'
import type { Job } from '../src/core/types.js'
import { commandProvider } from '../src/providers/command.js'
import { runWorker, type WorkerOptions } from '../src/worker/run.js'
import { defaultLimits, shortage, startWatchdog } from '../src/worker/watchdog.js'
import { escaped, escaping } from './fakes/escape.js'
import { fakeItem } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'

const job: Job = {
  unit: {
    id: 'fake-1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: '',
    foreign: false,
    untrusted: false,
    branch: 'away/fake-1',
    rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
    skill: 'fix',
    skills: [],
    providers: ['fake'],
    instructions: [],
    deliver: 'draft_pr',
  },
  dir: tmpdir(),
  prompt: 'fix it',
  maxTurns: 3,
  env: process.env,
}

const windows = [{ start: '01:00', end: '07:00' }]
const budget = {
  reserve: 0.1,
  session_max: 0.9,
  present_session_max: 0.4,
  fallback: { units: 4, turns: 60 },
}
const quota = await fakeProvider().probe({ env: {}, log: () => {} })
const now = 1790391600 * 1000 - 3 * 24 * 60 * 60 * 1000
const idle = { stop: async () => {} }

async function run(a: Allowance, watch: WorkerOptions['watch'] = () => idle) {
  const lines: string[] = []
  const result = await runWorker(fakeProvider(), job, a, { log: (l) => lines.push(l), watch })
  return { ...result, lines }
}

describe('worker', () => {
  it('runs to the end under the ceiling', async () => {
    const result = await run(allowance(budget, quota, now, windows))
    expect(result).toMatchObject({ status: 'done', turns: 3 })
    expect(result.lines).toEqual(['turn 1', 'turn 2', 'turn 3'])
  })

  it("stops once the long window reaches the run's ceiling", async () => {
    const result = await run(allowance({ ...budget, per_run: 0 }, quota, now, windows))
    expect(result).toMatchObject({
      status: 'stopped: quota',
      reason: 'seven_day at 36%, ceiling 36%',
    })
    expect(result.lines).toEqual(['turn 1', 'stop: seven_day at 36%, ceiling 36%'])
  })

  it('stops once the short window reaches session_max', async () => {
    const result = await run(allowance({ ...budget, session_max: 0.02 }, quota, now, windows))
    expect(result).toMatchObject({
      status: 'stopped: session',
      reason: 'five_hour at 2%, stop at 2%',
    })
  })

  it('stops a present run at present_session_max instead', async () => {
    const strict = { ...budget, present_session_max: 0.02 }
    expect(await run(allowance(strict, quota, now, windows))).toMatchObject({ status: 'done' })
    expect(await run(allowance(strict, quota, now, windows, { present: true }))).toMatchObject({
      status: 'stopped: session',
      reason: 'five_hour at 2%, stop at 2%',
    })
  })

  it('ignores quota on a fallback budget', async () => {
    expect(await run(allowance(budget, null, now, windows))).toMatchObject({ status: 'done' })
  })

  it('stops when the watchdog trips and always stops the watchdog', async () => {
    let stopped = false
    const result = await run(allowance(budget, quota, now, windows), (_dir, onLimit) => {
      onLimit('disk below 2 GB')
      return {
        stop: async () => {
          stopped = true
        },
      }
    })
    expect(result).toMatchObject({ status: 'stopped: resources', reason: 'disk below 2 GB' })
    expect(stopped).toBe(true)
  })

  it('stops at the window end', async () => {
    vi.useFakeTimers()
    const minute = 60_000
    const slow = {
      ...fakeProvider(),
      async *run(job: Job, signal: AbortSignal) {
        for await (const event of fakeProvider().run(job, signal)) {
          yield event
          if (event.type === 'quota') await new Promise((ok) => setTimeout(ok, minute))
        }
      },
    }
    const lines: string[] = []
    const until = new Date(Date.now() + 1.5 * minute)
    const running = runWorker(slow, job, allowance(budget, quota, now, windows), {
      log: (l) => lines.push(l),
      until,
      watch: () => idle,
    })
    await vi.advanceTimersByTimeAsync(3 * minute)
    vi.useRealTimers()
    expect(await running).toMatchObject({
      status: 'stopped: window ended',
      reason: 'reached the window end',
      turns: 2,
    })
    expect(lines).toEqual(['turn 1', 'turn 2', 'stop: reached the window end'])
  })

  it('stops after unit_minutes', async () => {
    vi.useFakeTimers()
    const minute = 60_000
    const slow = {
      ...fakeProvider(),
      async *run(job: Job, signal: AbortSignal) {
        for await (const event of fakeProvider().run(job, signal)) {
          yield event
          if (event.type === 'quota') await new Promise((ok) => setTimeout(ok, minute))
        }
      },
    }
    const lines: string[] = []
    const running = runWorker(slow, job, allowance(budget, quota, now, windows), {
      log: (l) => lines.push(l),
      maxMinutes: 1.5,
      watch: () => idle,
    })
    await vi.advanceTimersByTimeAsync(3 * minute)
    vi.useRealTimers()
    expect(await running).toMatchObject({
      status: 'stopped: time',
      reason: 'reached unit_minutes (1.5)',
      turns: 2,
    })
    expect(lines).toEqual(['turn 1', 'turn 2', 'stop: reached unit_minutes (1.5)'])
  })

  it('stops after unit_minutes while a process that left the group holds the output', async () => {
    const pid = join(job.dir, `awaywork-escaped-${process.pid}.pid`)
    const command = `${escaping(pid)}; echo started; sleep 30`
    const provider = commandProvider('x', { command, secrets: [], skills_dir: '.agents/skills' })
    const lines: string[] = []
    const started = Date.now()
    try {
      const result = await runWorker(provider, job, allowance(budget, null, now, windows), {
        log: (l) => lines.push(l),
        maxMinutes: 0.05,
        watch: () => idle,
      })
      expect(Date.now() - started).toBeLessThan(6000)
      expect(result).toMatchObject({
        status: 'stopped: time',
        reason: 'reached unit_minutes (0.05)',
      })
      expect(lines).toEqual(['started', 'stop: reached unit_minutes (0.05)'])
    } finally {
      process.kill(await escaped(pid), 'SIGKILL')
    }
  }, 60_000)
})

describe('watchdog', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('kills a descendant that started its own session and outlived its parent', async () => {
    const watchdog = startWatchdog(tmpdir(), () => {}, { ...defaultLimits, intervalMs: 50 })
    const parent = spawn(process.execPath, [
      '-e',
      `const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
       console.log(c.pid); setTimeout(() => process.exit(0), 500)`,
    ])
    const orphan = Number(await new Promise<string>((ok) => parent.stdout.once('data', ok)))
    await new Promise((ok) => parent.once('exit', ok))
    expect(alive(orphan)).toBe(true)
    await watchdog.stop()
    await new Promise((ok) => setTimeout(ok, 100))
    expect(alive(orphan)).toBe(false)
  })

  it('spares a descendant alive before it started, like the keep-awake child', async () => {
    const awake = spawn('sleep', ['30'], { stdio: 'ignore' })
    const watchdog = startWatchdog(tmpdir(), () => {}, { ...defaultLimits, intervalMs: 50 })
    await new Promise((ok) => setTimeout(ok, 200))
    await watchdog.stop()
    await new Promise((ok) => setTimeout(ok, 100))
    expect(awake.signalCode).toBeNull()
    awake.kill('SIGKILL')
  })

  it('reports low memory', async () => {
    const reasons: string[] = []
    const limits = { ...defaultLimits, intervalMs: 20, minMemory: Number.POSITIVE_INFINITY }
    const watchdog = startWatchdog(tmpdir(), (r) => reasons.push(r), limits)
    await new Promise((ok) => setTimeout(ok, 200))
    await watchdog.stop()
    expect(reasons[0]).toBe('memory below Infinity GB')
  })

  it('says what the machine is short of, on the volume of a dir that may not exist yet', async () => {
    const none = { ...defaultLimits, minMemory: 0, minDisk: 0 }
    const dir = join(tmpdir(), 'awaywork-none', 'work')
    expect(await shortage(dir, none)).toBeUndefined()
    expect(await shortage(dir, { ...none, minMemory: Number.POSITIVE_INFINITY })).toBe(
      'memory below Infinity GB',
    )
    expect(await shortage(dir, { ...none, minDisk: Number.POSITIVE_INFINITY })).toBe(
      'disk below Infinity GB',
    )
  })
})
