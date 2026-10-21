import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Allowance, MAX_TURNS } from '../src/core/budget.js'
import { contain, containerize, lostToWorker } from '../src/core/launch.js'
import type { Job } from '../src/core/types.js'
import { codexProvider } from '../src/providers/codex.js'
import { commandProvider } from '../src/providers/command.js'
import { runWorker } from '../src/worker/run.js'
import { runCommand } from '../src/worker/setup.js'

const image = process.env.AWAYWORK_CONTAINER_TEST ?? ''
const CANARY = 'canary-7d1e3b'
const allowance: Allowance = { kind: 'fallback', units: 1, turns: MAX_TURNS, reason: 'test' }
const leftover = async () =>
  (await execa('docker', ['ps', '-aq', '--filter', 'name=^awaywork-'])).stdout

/** A Docker engine and an image with a POSIX shell; run with AWAYWORK_CONTAINER_TEST=<image>, e.g. alpine. */
describe.skipIf(!image)('isolation container, live', { timeout: 30_000 }, () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    // Under your home, which Colima and Docker Desktop both share with their VM.
    outside = await mkdtemp(join(homedir(), '.awaywork-container-test-'))
    await writeFile(join(outside, 'secret'), CANARY)
    dir = join(outside, 'clone')
    await mkdir(dir)
    contain(dir, { image, secrets: ['GIVEN'] })
    containerize(true)
  })
  afterAll(async () => {
    containerize(false)
    await rm(outside, { recursive: true, force: true })
  })

  it('runs a command with the clone only, the phase’s env by name and a HOME in the clone', async () => {
    process.env.YOURS = CANARY
    const env = { PATH: process.env.PATH, HOME: homedir(), YOURS: CANARY, GIVEN: CANARY, SET: 'x' }
    const leaks = [
      'echo "$(id -u):$(id -g) $HOME ${GIVEN-unset} ${YOURS-unset} ${SET-unset}"',
      `cat ${join(outside, 'secret')} 2>/dev/null || echo "no secret"`,
      'ls /var/run/docker.sock /run/docker.sock 2>/dev/null || echo "no docker socket"',
      'echo "processes: $(ls -d /proc/[0-9]* | wc -l), pid 1 $(tr "\\0" " " < /proc/1/cmdline)"',
      'echo out > out.txt',
    ]
    const result = await runCommand(leaks.join('\n'), dir, env, { secrets: [] })
    delete process.env.YOURS
    const id = `${process.getuid?.()}:${process.getgid?.()}`
    const [who, ...rest] = result.output.split('\n')
    expect(who).toBe(`${id} ${dir}/.away/home ${CANARY} unset x`)
    expect(rest.slice(0, 2)).toEqual(['no secret', 'no docker socket'])
    // Its own: docker's init, the shell and the pipeline.
    expect(rest[2]).toMatch(/^processes: [1-9], pid 1 \/sbin\/docker-init -- \/bin\/sh -c /)
    expect((await stat(join(dir, 'out.txt'))).uid).toBe(process.getuid?.())
    expect(await leftover()).toBe('')
  })

  it('stops a check that hangs and detaches, and leaves no container behind', async () => {
    const started = Date.now()
    const result = await runCommand(
      'setsid sleep 300 & sleep 300',
      dir,
      {},
      {
        secrets: [],
        timeoutMs: 2000,
      },
    )
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(await leftover()).toBe('')
  })

  it('reaps what setup leaves running once it exits', async () => {
    const started = Date.now()
    const result = await runCommand('setsid sleep 300 & echo started', dir, {}, { secrets: [] })
    expect(result.output).toBe('started')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(await leftover()).toBe('')
  })

  it('stops an agent that ignores SIGTERM at the window’s end', async () => {
    await writeFile(join(dir, 'agent.sh'), "trap '' TERM; setsid sleep 300 & sleep 300\n")
    const agent = commandProvider('mine', {
      command: 'sh agent.sh',
      secrets: [],
      skills_dir: '.agents/skills',
    })
    const job = { dir, prompt: '', maxTurns: 1, env: {}, unit: {} } as unknown as Job
    const started = Date.now()
    const result = await runWorker(agent, job, allowance, {
      log: () => {},
      until: new Date(Date.now() + 3000),
    })
    expect(result.status).toBe('stopped: window ended')
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(await leftover()).toBe('')
    expect(lostToWorker(dir)).toBe(false)
  })

  it('lends Codex your login and saves back the one it refreshed', async () => {
    const authFile = join(outside, 'codex', 'auth.json')
    const login = (refresh: string) => `{"tokens":{"refresh_token":"${refresh}","account_id":"a1"}}`
    await mkdir(dirname(authFile))
    await writeFile(authFile, login('old'))
    // Refreshes the login it finds in its HOME, as a real one does when its access token expired.
    const fake = [
      '[ "$1" = app-server ] && exit 1',
      'cat > /dev/null',
      `grep -q old "$HOME/.codex/auth.json" && echo '${login('new')}' > "$HOME/.codex/auth.json"`,
      `echo '{"type":"turn.completed"}'`,
    ]
    await writeFile(join(dir, 'codex'), `#!/bin/sh\n${fake.join('\n')}\n`, { mode: 0o755 })
    const job = { dir, prompt: 'hi', maxTurns: 5, env: {}, unit: {} } as unknown as Job
    const codex = codexProvider(join(dir, 'codex'), join(outside, 'codex.lock'), authFile)
    const result = await runWorker(codex, job, allowance, { log: () => {} })
    expect(result.status).toBe('done')
    expect(await readFile(authFile, 'utf8')).toBe(`${login('new')}\n`)
  })
})
