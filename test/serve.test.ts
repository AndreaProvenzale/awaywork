import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMode } from '#core/isolation/index'
import { none } from '#core/isolation/none'
import { userMode } from '#core/isolation/user'
import type { Job, Provider, Unit } from '#core/types'
import type { Allowance } from '#quota/budget'
import { assemblePrompt } from '#worker/clone/prompt'
import {
  asksServe,
  type ServeRequest,
  serveRefusal,
  serveRequest,
  startServe,
} from '#worker/process/serve'
import { defaultLimits, killTree, startWatchdog } from '#worker/process/watchdog'
import { runWorker } from '#worker/process/worker'
import { fakeItem } from './fakes/items'
import { fakeProvider } from './fakes/provider'

vi.mock('#worker/process/watchdog', async (original) => {
  const actual = await original<typeof import('#worker/process/watchdog')>()
  return { ...actual, killTree: vi.fn(actual.killTree) }
})

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
  const serveEnv = { ...process.env, SERVE_PIDS: join(dir, 'pids'), ...env }
  const job: Job = {
    unit: unit(),
    dir,
    prompt: 'prove it',
    maxTurns: 1,
    env: { ...serveEnv, AGENT_LOGIN: 'login-secret' },
  }
  const request = { ...settings, logFile: join(dir, 'serve.log'), env: serveEnv } as ServeRequest
  return { dir, job, request }
}

const fallback: Allowance = { kind: 'fallback', units: 1, turns: 60, reason: 'test' }

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
  afterEach(() => useMode(none))

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
    const result = await runWorker(agent, job, fallback, { log: () => {}, watch, serve: request })

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

  it("refuses it on a stranger's issue", () => {
    expect(serveRefusal(unit({ untrustedText: true }), settings)).toBe("an author isn't on trust")
  })

  it("doesn't start it on a PR whose author isn't trusted", async () => {
    const started = join(await mkdtemp(join(tmpdir(), 'awaywork-serve-')), 'started')
    const { job } = await setup({ SERVE_STARTED: started })
    const request = serveRequest(
      unit({ untrusted: true }),
      settings,
      join(job.dir, 'serve.log'),
      {},
    )
    const served = await startServe(request as ServeRequest, job, new AbortController().signal)

    expect(existsSync(started)).toBe(false)
    expect(served.note).toBe("serve not run: an author isn't on trust")
  })

  it("doesn't start it under isolation: user", async () => {
    useMode(userMode('awaywork'))
    const { job } = await setup()
    const request = serveRequest(unit(), settings, join(job.dir, 'serve.log'), {})
    const served = await startServe(request as ServeRequest, job, new AbortController().signal)

    expect(served.note).toContain("isolation: user and container don't support it yet")
    expect(existsSync(join(job.dir, 'serve.log'))).toBe(false)
  })

  it("doesn't give serve the agent's login or secrets", async () => {
    const { job, request } = await setup()
    const served = await startServe(request, job, new AbortController().signal)
    await served.stop()

    expect(await readFile(request.logFile, 'utf8')).toContain('login=undefined')
    expect(served.job.env.AGENT_LOGIN).toBe('login-secret')
  })

  it('counts a redirect as an answer, without following it', async () => {
    const { job, request } = await setup({ SERVE_MODE: 'redirect' })
    const served = await startServe(request, job, new AbortController().signal, 5000)
    await served.stop()

    expect(served.note).toMatch(/^serve ready at/)
  })

  it("doesn't kill a tree by the pid of a serve that already exited", async () => {
    const { job, request } = await setup({ SERVE_MODE: 'exit' })
    vi.mocked(killTree).mockClear()
    await startServe(request, job, new AbortController().signal)
    expect(killTree).not.toHaveBeenCalled()

    const ready = await setup()
    const served = await startServe(ready.request, ready.job, new AbortController().signal)
    await served.stop()
    expect(killTree).toHaveBeenCalledOnce()
  })

  it('runs the step without the app when the clone is closed to awaywork, writing nothing into it', async () => {
    const { dir, job } = await setup()
    const request = serveRequest(unit({ untrusted: true }), settings, join(dir, 'serve.log'), {})
    let prompt = ''
    const agent: Provider = {
      ...fakeProvider(),
      async *run(j) {
        prompt = j.prompt
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    await chmod(join(dir, '.away'), 0o500)
    const result = await runWorker(agent, job, fallback, { log: () => {}, watch, serve: request })
    await chmod(join(dir, '.away'), 0o700)

    expect(result).toMatchObject({
      status: 'done',
      notes: ["serve not run: an author isn't on trust"],
    })
    expect(prompt).toBe('prove it')
  })

  it('tells the prompt why the app is not running', () => {
    const prompt = assemblePrompt({
      harness: 'h',
      skill: 's',
      instructions: [],
      repo: { serveRefused: "isolation: user and container don't support it yet" },
      rule: [],
    })
    expect(prompt).toContain(
      "Serve, not run: isolation: user and container don't support it yet. The app isn't running",
    )
  })

  it('asks nothing of a step that did not ask, and says when the repo has no command', () => {
    expect(
      serveRequest(unit({ rule: { ...unit().rule, serve: undefined } }), settings, 'x', {}),
    ).toBeUndefined()
    expect(serveRequest(unit(), undefined, 'x', {})?.refused).toBe('acme/api has no serve command')
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
