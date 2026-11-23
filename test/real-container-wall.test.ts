import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { containerMode } from '#core/isolation/container'
import { lowerContainerWall, WALL_IMAGE } from '#core/isolation/container-wall'
import { checkPhase, type Phase, setupPhase } from '#core/isolation/egress'
import { contain, raiseWall, useMode, wallUp } from '#core/isolation/index'
import { none } from '#core/isolation/none'
import { runCommand } from '#worker/process/command'

/** A Docker engine and the internet; run with AWAYWORK_CONTAINER_WALL_TEST=1. */
describe.skipIf(!process.env.AWAYWORK_CONTAINER_WALL_TEST)(
  'container network wall, live',
  { timeout: 60_000 },
  () => {
    let outside: string
    let dir: string
    const lines: string[] = []
    const log = (line: string) => lines.push(line)
    const node = (script: string, phase: Phase) =>
      runCommand(
        `node -e "${script}"`,
        dir,
        { PATH: process.env.PATH },
        { secrets: [], egress: phase },
      )
    const fetches = (url: string) =>
      `fetch('${url}').then((r) => console.log(r.status), (e) => console.log('failed', e.cause?.code ?? e.message))`
    const left = async () => {
      const filter = ['--filter', 'label=awaywork.wall']
      const containers = await execa('docker', ['ps', '-aq', ...filter])
      const networks = await execa('docker', ['network', 'ls', '-q', ...filter])
      return `${containers.stdout}${networks.stdout}`
    }

    beforeAll(async () => {
      // Under your home, which Colima and Docker Desktop both share with their VM.
      outside = await mkdtemp(join(homedir(), '.awaywork-wall-test-'))
      dir = join(outside, 'clone')
      await mkdir(dir)
      useMode(containerMode())
      await raiseWall(process.env)
      contain(dir, { image: WALL_IMAGE, secrets: [] })
    }, 60_000)
    afterAll(async () => {
      useMode(none)
      await lowerContainerWall()
      await rm(outside, { recursive: true, force: true })
    })

    it('stands', () => {
      expect(wallUp()).toBe(true)
    })

    it('reaches a host of the phase through the proxy and refuses another, with a line in the log', async () => {
      lines.length = 0
      const phase = setupPhase([], log)
      expect((await node(fetches('https://registry.npmjs.org/'), phase)).output).toBe('200')
      expect((await node(fetches('https://example.org/'), phase)).output).toMatch(/^failed/)
      expect(lines).toEqual(['network: refused example.org:443 (setup)'])
    })

    it('gives a check the hosts of `network` only', async () => {
      expect(
        (await node(fetches('https://registry.npmjs.org/'), checkPhase([], log))).output,
      ).toMatch(/^failed/)
      expect(
        (
          await node(
            fetches('https://registry.npmjs.org/'),
            checkPhase(['registry.npmjs.org'], log),
          )
        ).output,
      ).toBe('200')
    })

    it('has no direct way out: no connect, no name, not the host', async () => {
      const script = [
        "const net = require('net'), dns = require('dns')",
        "const tcp = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); s.on('connect', () => done('open')); s.on('timeout', () => done('timeout')); s.on('error', (e) => done(e.code)) })",
        'const name = (n) => new Promise((done) => dns.lookup(n, (e, a) => done(e ? e.code : a)))',
        "Promise.all([tcp('1.1.1.1', 443), tcp('192.168.1.1', 80), name('registry.npmjs.org'), name('host.docker.internal')]).then((r) => console.log(r.join(' ')))",
      ].join('; ')
      const ran = await runCommand(
        `node -e "${script.replaceAll('"', '\\"')}"`,
        dir,
        { PATH: process.env.PATH },
        { secrets: [], egress: setupPhase([], log) },
      )
      expect(ran.output).toBe('ENETUNREACH ENETUNREACH EAI_AGAIN EAI_AGAIN')
    })

    it('removes what a process that is gone left, and keeps what a live one holds, at the next start', async () => {
      const kept = ['--label', `awaywork.wall=${process.ppid}`]
      const gone = ['--label', 'awaywork.wall=2147483646']
      await execa('docker', ['network', 'create', ...gone, 'awaywork-wall-stale'])
      await execa('docker', ['network', 'create', ...kept, 'awaywork-wall-kept'])
      await execa('docker', [
        'run',
        '-d',
        '--name',
        'awaywork-wall-stale-forwarder',
        ...gone,
        '--network',
        'awaywork-wall-stale',
        WALL_IMAGE,
        'sleep',
        '300',
      ])
      try {
        await raiseWall(process.env)
        const names = (await execa('docker', ['network', 'ls', '--format', '{{.Name}}'])).stdout
        expect(names).not.toContain('awaywork-wall-stale')
        expect(names).toContain('awaywork-wall-kept')
        const containers = (await execa('docker', ['ps', '-a', '--format', '{{.Names}}'])).stdout
        expect(containers).not.toContain('awaywork-wall-stale-forwarder')
      } finally {
        await execa('docker', ['network', 'rm', 'awaywork-wall-kept'], { reject: false })
      }
    })

    it('leaves nothing behind once lowered', async () => {
      expect(await left()).not.toBe('')
      await lowerContainerWall()
      expect(await left()).toBe('')
    })
  },
)
