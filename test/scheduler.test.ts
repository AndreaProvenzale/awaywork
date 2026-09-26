// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import type { Exec } from '../src/forge/gh.js'
import { cron, cronLine } from '../src/scheduler/cron.js'
import { workflow } from '../src/scheduler/github-actions.js'
import type { Schedule } from '../src/scheduler/index.js'
import { launchd, plist } from '../src/scheduler/launchd.js'
import { service, systemd, timer } from '../src/scheduler/systemd.js'

const schedule: Schedule = {
  command: [
    '/opt/node',
    '/opt/night shift/index.js',
    'run',
    '--scheduled',
    '--config',
    "/h/it's.yml",
  ],
  hour: 1,
  minute: 5,
  path: '/opt/bin:/usr/bin',
  log: '/h/state/schedule.log',
}

function recorder(crontab = '') {
  const calls: string[] = []
  const run: Exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'crontab' && args[0] === '-l') return crontab
    if (cmd === 'crontab') crontab = await readFile(args[0] ?? '', 'utf8')
    return ''
  }
  return { run, calls, crontab: () => crontab }
}

it('writes a LaunchAgent that starts at the night start and logs to the state dir', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nightshift-home-'))
  const { run, calls } = recorder()
  const scheduler = launchd(home, run, 501)
  const file = await scheduler.install(schedule)
  expect(file).toBe(join(home, 'Library/LaunchAgents/nightshift.plist'))
  const text = await readFile(file, 'utf8')
  expect(text).toBe(plist(schedule))
  expect(text).toContain('<key>Hour</key><integer>1</integer><key>Minute</key><integer>5</integer>')
  expect(text).toContain('<string>/opt/night shift/index.js</string>')
  expect(calls).toEqual([
    'launchctl bootout gui/501/nightshift',
    `launchctl bootstrap gui/501 ${file}`,
  ])
  expect(await scheduler.remove()).toBe(true)
  expect(existsSync(file)).toBe(false)
  expect(await scheduler.remove()).toBe(false)
})

it('retries bootstrap while launchd still holds the old job', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nightshift-home-'))
  const { run, calls } = recorder()
  let busy = 2
  const flaky: Exec = async (cmd, args) => {
    if (args[0] === 'bootstrap' && busy-- > 0) {
      calls.push('failed')
      throw new Error('Bootstrap failed: 5: Input/output error')
    }
    return run(cmd, args)
  }
  const file = await launchd(home, flaky, 501, 0).install(schedule)
  expect(calls).toEqual([
    'launchctl bootout gui/501/nightshift',
    'failed',
    'failed',
    `launchctl bootstrap gui/501 ${file}`,
  ])
})

it('writes a persistent systemd user timer and its service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nightshift-home-'))
  const { run, calls } = recorder()
  await systemd(home, run).install(schedule)
  expect(timer(schedule)).toContain('OnCalendar=*-*-* 01:05:00\nPersistent=true')
  expect(service(schedule)).toContain(
    `ExecStart="/opt/node" "/opt/night shift/index.js" "run" "--scheduled" "--config" "/h/it's.yml"`,
  )
  expect(calls).toEqual([
    'systemctl --user daemon-reload',
    'systemctl --user enable --now nightshift.timer',
  ])
  expect(await systemd(home, run).remove()).toBe(true)
  expect(existsSync(join(home, '.config/systemd/user/nightshift.service'))).toBe(false)
})

it("adds one tagged crontab line, keeps the user's own and removes only its line", async () => {
  const cronTab = recorder('MAILTO=me\n\n0 9 * * * backup\n')
  const scheduler = cron(cronTab.run)
  await scheduler.install(schedule)
  await scheduler.install(schedule)
  expect(cronLine(schedule)).toBe(
    `5 1 * * * PATH='/opt/bin:/usr/bin' '/opt/node' '/opt/night shift/index.js' 'run' '--scheduled' '--config' '/h/it'\\''s.yml' >> '/h/state/schedule.log' 2>&1 # night-shift`,
  )
  expect(cronTab.crontab()).toBe(`MAILTO=me\n\n0 9 * * * backup\n${cronLine(schedule)}\n`)
  expect(await scheduler.remove()).toBe(true)
  expect(cronTab.crontab()).toBe('MAILTO=me\n\n0 9 * * * backup\n')
  expect(await scheduler.remove()).toBe(false)
})

it('writes a workflow with a local-time cron, disk cleanup and secrets by name only', () => {
  const text = workflow({
    start: '01:30',
    timezone: 'Europe/Rome',
    config: '.night-shift/config.yml',
    packages: ['@anthropic-ai/claude-code'],
    secrets: ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  })
  const parsed = parse(text)
  expect(parsed.on.schedule).toEqual([{ cron: '30 1 * * *', timezone: 'Europe/Rome' }])
  expect(parsed.jobs.night.env).toEqual({
    TZ: 'Europe/Rome',
    NIGHT_SHIFT_CONFIG: '.night-shift/config.yml',
    GH_TOKEN: '${{ secrets.GH_TOKEN }}',
    CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
  })
  const runs = parsed.jobs.night.steps.map((s: { run?: string }) => s.run ?? '')
  expect(runs[0]).toMatch(/^sudo rm -rf \/usr\/share\/dotnet /)
  expect(runs).toContain('npm install -g nightshift-agent @anthropic-ai/claude-code')
  expect(runs).toContain(
    "nightshift run ${{ github.event_name == 'schedule' && '--scheduled' || '' }}",
  )
})
