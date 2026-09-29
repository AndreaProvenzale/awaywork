import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { type Allowance, allowance } from '../src/core/budget.js'
import type { Job } from '../src/core/types.js'
import { runWorker, type WorkerOptions } from '../src/worker/run.js'
import { defaultLimits, startWatchdog } from '../src/worker/watchdog.js'
import { fakeItem } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'

const job: Job = {
  unit: {
    id: 'fake-1',
    items: [fakeItem()],
    repo: 'acme/api',
    base: '',
    foreign: false,
    branch: 'night/fake-1',
    rule: { skill: 'fix-ci', provider: [], skills: [], instructions: [] },
    skill: 'fix-ci',
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

const budget = { reserve: 0.1, session_max: 0.9, fallback: { units: 4, turns: 60 } }
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
    const result = await run(allowance(budget, quota, now))
    expect(result).toMatchObject({ status: 'done', turns: 3 })
    expect(result.lines).toEqual(['turn 1', 'turn 2', 'turn 3'])
  })

  it('stops once the long window reaches tonight ceiling', async () => {
    const result = await run(allowance({ ...budget, per_night: 0 }, quota, now))
    expect(result).toMatchObject({
      status: 'stopped: quota',
      reason: 'seven_day at 36%, ceiling 36%',
    })
    expect(result.lines).toEqual(['turn 1', 'stop: seven_day at 36%, ceiling 36%'])
  })

  it('stops once the short window reaches session_max', async () => {
    const result = await run(allowance({ ...budget, session_max: 0.02 }, quota, now))
    expect(result).toMatchObject({
      status: 'stopped: session',
      reason: 'five_hour at 2%, stop at 2%',
    })
  })

  it('ignores quota on a fallback budget', async () => {
    expect(await run(allowance(budget, null, now))).toMatchObject({ status: 'done' })
  })

  it('stops when the watchdog trips and always stops the watchdog', async () => {
    let stopped = false
    const result = await run(allowance(budget, quota, now), (_dir, onLimit) => {
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

  it('stops at night.end', async () => {
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
    const running = runWorker(slow, job, allowance(budget, quota, now), {
      log: (l) => lines.push(l),
      until,
      watch: () => idle,
    })
    await vi.advanceTimersByTimeAsync(3 * minute)
    vi.useRealTimers()
    expect(await running).toMatchObject({
      status: 'stopped: night ended',
      reason: 'reached night.end',
      turns: 2,
    })
    expect(lines).toEqual(['turn 1', 'turn 2', 'stop: reached night.end'])
  })
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

  it('reports low memory', async () => {
    const reasons: string[] = []
    const limits = { ...defaultLimits, intervalMs: 20, minMemory: Number.POSITIVE_INFINITY }
    const watchdog = startWatchdog(tmpdir(), (r) => reasons.push(r), limits)
    await new Promise((ok) => setTimeout(ok, 200))
    await watchdog.stop()
    expect(reasons[0]).toBe('memory below Infinity GB')
  })
})
