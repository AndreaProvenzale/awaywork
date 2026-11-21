import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isolate } from '#core/isolation'
import type { Job, Provider, Unit } from '#core/types'
import { allowance } from '#quota/budget'
import { asksServe, type ServeRequest, serveRequest, startServe } from '#worker/process/serve'
import { defaultLimits, startWatchdog } from '#worker/process/watchdog'
import { runWorker } from '#worker/process/worker'
import { fakeItem } from './fakes/items'
import { fakeProvider } from './fakes/provider'

const server = fileURLToPath(new URL('./fakes/serve.mjs', import.meta.url))
const settings = { command: `node ${server}`, ready: 'http://localhost:$AWAYWORK_PORT/healthz' }

const unit = (over: Partial<Unit> = {}): Unit => ({
  id: 'fake-1',
  items: [fakeItem()],
  repo: 'acme/api',
  base: '',
  foreign: false,
  untrusted: false,
  branch: 'away/fake-1',
  rule: { skill: 'prove', provider: [], skills: [], instructions: [], serve: true },
  skill: 'prove',
  skills: [],
  providers: ['fake'],
  instructions: [],
  deliver: 'report',
  ...over,
})

async function setup(env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-serve-'))
  await mkdir(join(dir, '.away'))
  const job: Job = {
    unit: unit(),
    dir,
    prompt: 'prove it',
    maxTurns: 1,
    env: { ...process.env, SERVE_PIDS: join(dir, 'pids'), ...env },
  }
  return { dir, job, request: { ...settings, logFile: join(dir, 'serve.log') } as ServeRequest }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pids = async (dir: string) =>
  (await readFile(join(dir, 'pids'), 'utf8')).split('\n').filter(Boolean).map(Number)
const watch = (dir: string, onLimit: (reason: string) => void) =>
  startWatchdog(dir, onLimit, { ...defaultLimits, minMemory: 0, minDisk: 0 })

describe('serve', () => {
  afterEach(() => isolate(undefined))

  it('starts the app for the agent and leaves nothing running once the agent is done', async () => {
    const { dir, job, request } = await setup()
    const seen: { reply: string; prompt: string; url?: string; file: string }[] = []
    const agent: Provider = {
      ...fakeProvider(),
      async *run(j) {
        const url = j.env.AWAYWORK_SERVE_URL
        seen.push({
          reply: await fetch(`${url}/anything`).then((r) => r.text()),
          prompt: j.prompt,
          url,
          file: await readFile(join(j.dir, '.away', 'prompt.md'), 'utf8').catch(() => ''),
        })
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    const a = allowance(
      {
        reserve: 0.1,
        session_max: 0.9,
        present_session_max: 0.4,
        fallback: { units: 4, turns: 60 },
      },
      await fakeProvider().probe({ env: {}, log: () => {} }),
      Date.now(),
      [{ start: '00:00', end: '23:59' }],
    )
    const result = await runWorker(agent, job, a, { log: () => {}, watch, serve: request })

    expect(result).toMatchObject({ status: 'done' })
    const [first] = seen
    expect(first?.reply).toBe('ok')
    expect(first?.url).toMatch(/^http:\/\/localhost:\d+$/)
    expect(first?.prompt).toContain(
      `The app runs at ${first?.url}, started by awaywork from \`${settings.command}\`; it stops with you.`,
    )
    expect(first?.file).toContain('The app runs at')
    expect(result.notes).toEqual([`serve ready at ${first?.url}`])
    expect(await readFile(request.logFile, 'utf8')).toContain('booting in ready mode')

    await expect(fetch(`${first?.url}/`)).rejects.toThrow()
    const [grandchild] = await pids(dir)
    expect(grandchild).toBeGreaterThan(0)
    expect(alive(grandchild as number)).toBe(false)
  })

  it('runs the step without the app when it is never ready, saying why with the log tail', async () => {
    const { dir, job, request } = await setup({ SERVE_MODE: 'never' })
    const served = await startServe(request, job, new AbortController().signal, 1500)

    expect(served.job.env.AWAYWORK_SERVE_URL).toBeUndefined()
    expect(served.job.prompt).toContain("Serve didn't come up")
    expect(served.job.prompt).toContain('booting in never mode')
    expect(served.note).toMatch(/^serve didn't come up: not ready after/)
    const [grandchild] = await pids(dir)
    await new Promise((ok) => setTimeout(ok, 200))
    expect(alive(grandchild as number)).toBe(false)
  })

  it('fails at once when the server exits before it is ready', async () => {
    const { job, request } = await setup({ SERVE_MODE: 'exit' })
    const started = Date.now()
    const served = await startServe(request, job, new AbortController().signal)

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(served.note).toMatch(/exited before it was ready/)
    expect(served.job.prompt).toContain('boom: no database')
  })

  it("doesn't start it on a PR whose author isn't trusted", async () => {
    const started = join(await mkdtemp(join(tmpdir(), 'awaywork-serve-')), 'started')
    const { job } = await setup({ SERVE_STARTED: started })
    const request = serveRequest(unit({ untrusted: true }), settings, join(job.dir, 'serve.log'))
    const served = await startServe(request as ServeRequest, job, new AbortController().signal)

    expect(existsSync(started)).toBe(false)
    expect(served.job.prompt).toContain("Serve, not run: this PR's author isn't trusted")
  })

  it("doesn't start it under isolation: user", async () => {
    isolate('awaywork')
    const { job } = await setup()
    const request = serveRequest(unit(), settings, join(job.dir, 'serve.log'))
    const served = await startServe(request as ServeRequest, job, new AbortController().signal)

    expect(served.job.prompt).toContain("isolation: user and container don't support it yet")
    expect(existsSync(join(job.dir, 'serve.log'))).toBe(false)
  })

  it('asks nothing of a step that did not ask, and says when the repo has no command', () => {
    expect(
      serveRequest(unit({ rule: { ...unit().rule, serve: undefined } }), settings, 'x'),
    ).toBeUndefined()
    expect(serveRequest(unit(), undefined, 'x')?.refused).toBe('acme/api has no serve command')
  })

  it('finds a rule that asks in a step or a loop', () => {
    const rule = (steps: unknown[]) =>
      // biome-ignore lint/suspicious/noThenProperty: the key users write; never a function
      ({ skill: 'prove', provider: [], skills: [], instructions: [], then: steps }) as never
    expect(asksServe(rule([{ skill: 'a' }, { skill: 'b', serve: true }]))).toBe(true)
    expect(asksServe(rule([{ loop: [{ skill: 'b', serve: true }] }]))).toBe(true)
    expect(asksServe(rule([{ skill: 'a' }]))).toBe(false)
  })
})
