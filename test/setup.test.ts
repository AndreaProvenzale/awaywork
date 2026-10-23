import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCommand, runSetup } from '../src/worker/setup.js'
import { escaped, escaping } from './fakes/escape.js'

const env = { PATH: process.env.PATH, NPM_TOKEN: 'npm-secret' }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runSetup', () => {
  it('stops at the deadline even when a background process holds its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
    const started = Date.now()
    const failed = await runSetup('sleep 30 & echo $! > pid; sleep 30', dir, env, () => {}, {
      secrets: [],
      until: new Date(Date.now() + 500),
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(failed).toBe('setup failed: the window ended')
    expect(alive(Number(await readFile(join(dir, 'pid'), 'utf8')))).toBe(false)
  })

  it('stops what it started when it exits, and on an interrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
    expect(await runSetup('sleep 30 & echo $! > pid', dir, env, () => {}, { secrets: [] })).toBe(
      undefined,
    )
    expect(alive(Number(await readFile(join(dir, 'pid'), 'utf8')))).toBe(false)

    const abort = new AbortController()
    setTimeout(() => abort.abort(), 200)
    expect(
      await runSetup('sleep 30', dir, env, () => {}, { secrets: [], signal: abort.signal }),
    ).toBe('setup failed: interrupted')
  })

  it('masks its secrets in the log and the reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-setup-'))
    const lines: string[] = []
    const failed = await runSetup(
      'echo "token $NPM_TOKEN"; exit 1',
      dir,
      env,
      (l) => lines.push(l),
      {
        secrets: ['NPM_TOKEN'],
      },
    )
    expect(lines).toEqual(['setup: token ***'])
    expect(failed).toMatch(/\ntoken \*\*\*$/)
  })
})

describe('runCommand', () => {
  it('marks a command that hit the time limit, not one stopped by the window end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-command-'))
    const real = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(200))
    try {
      const result = await runCommand('sleep 30', dir, env, { secrets: [] })
      expect(result).toMatchObject({ failed: 'timed out after 15 min', timedOut: true })
      expect(result.stopped).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('ends soon after a stop, whatever still holds its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-command-'))
    const pid = join(dir, 'escaped.pid')
    const stop = new AbortController()
    const run = runCommand(`echo hi; ${escaping(pid)}; sleep 30`, dir, env, {
      secrets: [],
      signal: stop.signal,
    })
    await escaped(pid)
    stop.abort()
    const stopped = Date.now()
    try {
      expect(await run).toEqual({ output: 'hi', failed: 'interrupted', stopped: true })
    } finally {
      process.kill(await escaped(pid), 'SIGKILL')
    }
    expect(Date.now() - stopped).toBeLessThan(5000)
  }, 30_000)
})
