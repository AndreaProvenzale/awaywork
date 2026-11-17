import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ItemCommands } from '#cli/tui/browse'
import { browseRemotely } from '#cli/tui/remote'
import { runTriage, type State, screenJson } from '#cli/tui/triage'
import { runsDir, skipsPath } from '#config/paths'
import { serveRemote } from '#run/remote'
import { acmeRun } from './fakes/acme'

vi.mock('#config/paths', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-remote-browse-`)
  return {
    ...(await original<typeof import('#config/paths')>()),
    runsDir: `${state}/runs`,
    skipsPath: `${state}/skips.json`,
  }
})

const tui = vi.hoisted(() => ({ interactive: vi.fn(() => true), openScreen: vi.fn() }))
vi.mock('#cli/tui/browse', async (original) => ({
  ...(await original<typeof import('#cli/tui/browse')>()),
  ...tui,
}))

const TOKEN = 'a'.repeat(40)
const RUN = '20261019-220000'
const servers: Server[] = []

/** A screen that browses by running `keys` on the commands it was given. */
function fakeScreen(keys: (commands: ItemCommands) => Promise<unknown> = async () => {}) {
  const screen = {
    progress: vi.fn(),
    close: vi.fn(),
    browsed: undefined as State | undefined,
    answers: [] as unknown,
    browse: vi.fn(async (state: State, commands: ItemCommands) => {
      screen.browsed = state
      screen.answers = await keys(commands)
    }),
  }
  tui.openScreen.mockReturnValue(screen)
  return screen
}

function output() {
  const out = { stdout: '', stderr: '' }
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.stdout += s
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    out.stderr += s
    return true
  })
  vi.spyOn(console, 'error').mockImplementation((s) => {
    out.stderr += `${s}\n`
  })
  return out
}

/** A box's daemon whose CLI prints `SCREEN` for --screen, and answers skip, approve and report --unit --log as awaywork would. */
async function box() {
  const log: string[] = []
  const cli = `const a = process.argv.slice(3)
if (a.includes('--screen')) console.log(process.env.SCREEN)
else if (a[0] === 'skip') console.log('skipped with awaywork skip ' + a[1])
else if (a[0] === 'approve') { console.error('warning: x'); console.error('not yours'); process.exit(1) }
else process.stdout.write('log of ' + a.join(' '))`
  const server = serveRemote(
    { token: TOKEN },
    {
      config: '/daemon/config.yml',
      log: (line) => log.push(line),
      runUnit: vi.fn(),
      cli: [process.execPath, '-e', cli, '--'],
      port: 0,
    },
  ) as Server
  servers.push(server)
  await vi.waitFor(() => expect(log).toHaveLength(1))
  log.splice(0)
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log }
}

describe('plan and report from a laptop', () => {
  const state = runTriage(acmeRun(), [], [{ text: 'unit 1', log: '1' }], 30)
  beforeEach(async () => {
    await mkdir(join(runsDir, RUN), { recursive: true })
    vi.stubEnv('SCREEN', screenJson(state, RUN))
  })
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close()
      server.closeAllConnections()
    }
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    tui.interactive.mockReturnValue(true)
  })

  it("browses the view the box built, here; skip, approve and the unit's log run there", async () => {
    const { url, log } = await box()
    const screen = fakeScreen(async (c) => [
      await c.skip('github:acme/api#1'),
      await c.approve('github:acme/api#1').catch((e: Error) => e.message),
      await c.log('1'),
    ])
    const out = output()
    expect(await browseRemotely(['report'], { url, token: TOKEN })).toBe(0)
    expect(tui.openScreen).toHaveBeenCalledWith('Loading the report')
    expect(screen.progress).toHaveBeenCalledWith({ name: `reading on ${url}`, state: 'running' })
    expect(screen.browsed).toEqual({ ...state, top: 0, rows: process.stdout.rows })
    expect(screen.answers).toEqual([
      'skipped with awaywork skip github:acme/api#1',
      'not yours',
      `log of report ${RUN} --unit 1 --log`,
    ])
    expect(log).toEqual([
      'remote: ["report","--screen"]: exit 0',
      'remote: ["skip","github:acme/api#1"]: exit 0',
      'remote: ["approve","github:acme/api#1"]: exit 1',
      `remote: ["report","${RUN}","--unit","1","--log"]: exit 0`,
    ])
    expect(existsSync(skipsPath)).toBe(false)
    expect(out).toEqual({ stdout: '', stderr: '' })
  })

  it('leaves the plain flags, a pipe and a local run to the forwarding as before', async () => {
    const { url } = await box()
    for (const args of [['plan', '--json'], ['report', '--unit=2'], ['stats'], ['plan', '--why=x']])
      expect(browseRemotely(args, { url, token: TOKEN }), args.join(' ')).toBeUndefined()
    expect(browseRemotely(['plan'], {})).toBeUndefined()
    expect(browseRemotely(['plan'], { url })).toBeUndefined()
    tui.interactive.mockReturnValue(false)
    expect(browseRemotely(['plan'], { url, token: TOKEN })).toBeUndefined()
    expect(tui.openScreen).not.toHaveBeenCalled()
  })

  it('leaves the screen and prints what the box said when it built no view', async () => {
    const { url } = await box()
    vi.stubEnv('SCREEN', '# Awaywork 20261019-220000')
    const screen = fakeScreen()
    const out = output()
    expect(await browseRemotely(['plan'], { url, token: TOKEN })).toBe(0)
    expect(screen.close).toHaveBeenCalled()
    expect(screen.browse).not.toHaveBeenCalled()
    expect(out).toEqual({ stdout: '# Awaywork 20261019-220000\n', stderr: '' })
  })

  it('prints the plain output with a hint when the box is on an awaywork without --screen', async () => {
    const calls: unknown[] = []
    const older = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const { args } = JSON.parse(body)
      calls.push(args)
      if (args.includes('--screen'))
        return res.writeHead(403).end(JSON.stringify({ error: 'refused --screen' }))
      res.writeHead(200).end('{"stdout":"Plan: 1 unit\\n"}\n{"code":0}\n')
    }).listen(0)
    servers.push(older)
    await once(older, 'listening')
    const url = `http://127.0.0.1:${(older.address() as AddressInfo).port}`
    const screen = fakeScreen()
    const out = output()
    expect(await browseRemotely(['plan', '--repo', 'acme/*'], { url, token: TOKEN })).toBe(0)
    expect(tui.openScreen).toHaveBeenCalledWith('Planning the next run')
    expect(screen.close).toHaveBeenCalled()
    expect(calls).toEqual([
      ['plan', '--repo', 'acme/*', '--screen'],
      ['plan', '--repo', 'acme/*'],
    ])
    expect(out).toEqual({
      stdout: 'Plan: 1 unit\n',
      stderr: `AWAYWORK_REMOTE (${url}) runs an older awaywork, so this prints instead of browsing; update awaywork there and restart watch\n`,
    })
  })
})
