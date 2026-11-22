import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Phase } from '#core/egress'
import { isolate, workerRoot } from '#core/isolation'
import { isolateWalled, wallUp } from '#core/wall'
import { runCommand } from '#worker/process/command'

const env = { PATH: process.env.PATH }

/** Linux with the worker user and the network wall (`scripts/worker-user.sh`); run with AWAYWORK_WORKER_TEST=1. */
describe.skipIf(!process.env.AWAYWORK_WORKER_TEST)('network wall, live', () => {
  let origin: Server
  let port: number
  let dir: string
  const lines: string[] = []
  const through = (hosts: string[]): Phase => ({
    name: 'setup',
    hosts,
    log: (line) => lines.push(line),
  })
  const curl = (url: string, egress: Phase) =>
    runCommand(`curl -sS -o /dev/null -w '%{http_code}' --max-time 5 ${url}`, dir, env, {
      secrets: [],
      egress,
    })

  beforeAll(async () => {
    // 127.0.0.2 is loopback too, and not in NO_PROXY, so the worker's curl goes through the proxy.
    origin = createServer((_, res) => res.end('hello')).listen(0, '127.0.0.2')
    await new Promise((ready) => origin.once('listening', ready))
    port = (origin.address() as AddressInfo).port
    await isolateWalled('user', process.env)
    dir = await workerRoot()
  })
  afterAll(() => {
    isolate(undefined)
    origin.close()
  })

  it('stands, probed as the worker', () => {
    expect(wallUp()).toBe(true)
  })

  it('points a launch at the proxy', async () => {
    const result = await runCommand('echo "$HTTPS_PROXY $http_proxy $NO_PROXY"', dir, env, {
      secrets: [],
      egress: through([]),
    })
    expect(result.output).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+ http:\/\/127\.0\.0\.1:\d+ localhost,127\.0\.0\.1,::1$/,
    )
  })

  it('reaches a host of the phase through the proxy', async () => {
    expect((await curl(`http://127.0.0.2:${port}/`, through(['127.0.0.2']))).output).toBe('200')
  })

  it('refuses a host outside the phase, and says so in the log', async () => {
    lines.length = 0
    const result = await curl(`http://127.0.0.2:${port}/`, through(['acme.test']))
    expect(result.output).toBe('403')
    expect(lines).toEqual([`network: refused 127.0.0.2:${port} (setup)`])
  })

  it('reaches nothing outside by itself, by IP or by a client that ignores the proxy', async () => {
    const direct = await curl('--noproxy "*" https://1.1.1.1', through(['*']))
    expect(direct.failed).toBeTruthy()
    const resolver = await runCommand(
      'timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.53/53" && echo reached',
      dir,
      env,
      { secrets: [], egress: through(['*']) },
    )
    expect(resolver.output).not.toContain('reached')
  })
})
