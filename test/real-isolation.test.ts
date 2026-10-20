import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Allowance, MAX_TURNS } from '../src/core/budget.js'
import { hostedWorker, isolate, WORKER, workerRoot } from '../src/core/launch.js'
import type { Job } from '../src/core/types.js'
import { commandProvider } from '../src/providers/command.js'
import { runWorker } from '../src/worker/run.js'
import { runCommand } from '../src/worker/setup.js'

const CANARY = 'canary-4f2a9c'
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CANARY,
  AWAYWORK_PARENT: `${process.pid}`,
}
const leftover = async () => (await execa('pgrep', ['-u', WORKER], { reject: false })).stdout
const owner = async (path: string) => (await stat(path)).uid
const allowance: Allowance = { kind: 'fallback', units: 1, turns: MAX_TURNS, reason: 'test' }

/** Linux with passwordless sudo and the worker user, as on a hosted runner after `action.yml`; run with AWAYWORK_WORKER_TEST=1. */
describe.skipIf(!process.env.AWAYWORK_WORKER_TEST)('isolation user, live', () => {
  let dir: string
  beforeAll(async () => {
    expect(await hostedWorker({ RUNNER_ENVIRONMENT: 'github-hosted' })).toBe(WORKER)
    dir = join(await workerRoot(), 'clone')
    await execa('git', ['init', '-q', dir])
    isolate(WORKER)
  })
  afterAll(() => isolate(undefined))

  it('runs a command as the worker, with the env but none of its values on argv', async () => {
    const leaks = [
      'id -un; echo "$HOME $CANARY"',
      // Builtins only: an exec'd command would carry the value on its own argv.
      'for f in /proc/[0-9]*/cmdline; do c=$(tr "\\0" " " < $f 2>/dev/null); case "$c" in *"$CANARY"*) echo "argv: $f $c";; esac; done',
      'cat /proc/$AWAYWORK_PARENT/environ >/dev/null 2>&1 && echo "environ readable"',
      'echo out > out.txt',
    ]
    const result = await runCommand(leaks.join('\n'), dir, env, { secrets: [] })
    expect(result.output).toBe(`${WORKER}\n/home/${WORKER} ${CANARY}`)
    expect(await owner(join(dir, 'out.txt'))).toBe(process.getuid?.())
    expect(await owner(dir)).toBe(process.getuid?.())
  })

  it('stops a check that hangs and detaches, and leaves no process behind', async () => {
    const started = Date.now()
    const result = await runCommand('setsid sleep 300 & sleep 300', dir, env, {
      secrets: [],
      timeoutMs: 2000,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await leftover()).toBe('')
  })

  it('reaps what setup leaves running once it exits', async () => {
    const started = Date.now()
    expect((await runCommand('sleep 300 & echo started', dir, env, { secrets: [] })).output).toBe(
      'started',
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await leftover()).toBe('')
  })

  it('stops an agent that ignores SIGTERM at the window’s end', async () => {
    await writeFile(join(dir, 'agent.sh'), "trap '' TERM; setsid sleep 300 & sleep 300\n")
    const agent = commandProvider('mine', {
      command: 'sh agent.sh',
      secrets: [],
      skills_dir: '.agents/skills',
    })
    const job = { dir, prompt: '', maxTurns: 1, env, unit: {} } as unknown as Job
    const started = Date.now()
    const result = await runWorker(agent, job, allowance, {
      log: () => {},
      until: new Date(Date.now() + 2000),
    })
    expect(result.status).toBe('stopped: window ended')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(await leftover()).toBe('')
    expect(await owner(join(dir, 'agent.sh'))).toBe(process.getuid?.())
  })
})
