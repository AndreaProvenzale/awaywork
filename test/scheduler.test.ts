// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { installWorkflow, offerSecrets, staleSchedules } from '../src/cli/schedule.js'
import type { Exec } from '../src/forge/gh.js'
import { cron, cronLines, parseCronLines } from '../src/scheduler/cron.js'
import {
  REPO_CONFIG,
  REPO_SKILLS,
  removeWorkflow,
  staleWorkflow,
  WORKFLOW,
  workflow,
} from '../src/scheduler/github-actions.js'
import { olderJob, type Schedule, type Scheduler, type Start } from '../src/scheduler/index.js'
import { launchd, parsePlist, plist } from '../src/scheduler/launchd.js'
import { parseService, service, systemd } from '../src/scheduler/systemd.js'
import {
  keepAwake,
  pmsetArgs,
  staleWake,
  timerWake,
  wakeFor,
  wakeTimer,
  wakeUndo,
} from '../src/scheduler/wake.js'
import { initial, scriptedAsk } from './fakes/ask.js'

const schedule: Schedule = {
  command: ['/opt/node', '/opt/away work/index.js', 'watch', '--config', "/h/it's.yml"],
  path: '/opt/bin:/usr/bin',
  log: '/h/state/schedule.log',
}

/** Characters each scheduler has to escape. */
const awkward: Schedule = {
  ...schedule,
  command: ['/opt/node', '/opt/a&b<c>/"x"\\y', "it's 100%", '--config', '/h/c.yml'],
  path: "/opt/it's 50%:/usr/bin",
  log: '/h/log & more.log',
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

it('writes a LaunchAgent started at login, restarted on a crash, that logs to the state dir', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const { run, calls } = recorder()
  const scheduler = launchd(home, run, 501)
  const file = await scheduler.install(schedule)
  expect(file).toBe(join(home, 'Library/LaunchAgents/awaywork.plist'))
  const text = await readFile(file, 'utf8')
  expect(text).toBe(plist(schedule))
  expect(text).toContain(
    '<key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
  )
  expect(text).toContain('<key>ExitTimeOut</key><integer>120</integer>')
  expect(text).not.toContain('StartCalendarInterval')
  expect(text).toContain('<string>/opt/away work/index.js</string>')
  expect(calls).toEqual([
    'launchctl bootout gui/501/awaywork',
    `launchctl bootstrap gui/501 ${file}`,
  ])
  expect(await scheduler.read()).toEqual(schedule)
  expect(await scheduler.remove()).toBe(true)
  expect(existsSync(file)).toBe(false)
  expect(await scheduler.remove()).toBe(false)
  expect(await scheduler.read()).toBeUndefined()
})

it('retries bootstrap while launchd still holds the old job', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
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
    'launchctl bootout gui/501/awaywork',
    'failed',
    'failed',
    `launchctl bootstrap gui/501 ${file}`,
  ])
})

it('writes a systemd user service restarted on a crash and enabled at login', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const { run, calls } = recorder()
  await systemd(home, run).install(schedule)
  expect(service(schedule)).toContain(
    `ExecStart="/opt/node" "/opt/away work/index.js" "watch" "--config" "/h/it's.yml"\nRestart=on-failure`,
  )
  expect(service(schedule)).toContain('KillMode=mixed\nTimeoutStopSec=120')
  expect(service(schedule)).toContain('[Install]\nWantedBy=default.target')
  expect(calls).toEqual([
    'systemctl --user daemon-reload',
    'systemctl --user enable awaywork.service',
    'systemctl --user restart awaywork.service',
  ])
  expect(await systemd(home, run).read()).toEqual(schedule)
  expect(await systemd(home, run).remove()).toBe(true)
  expect(existsSync(join(home, '.config/systemd/user/awaywork.service'))).toBe(false)
  expect(await systemd(home, run).read()).toBeUndefined()
})

it("replaces an older awaywork's timer and reads its job back as older until then", async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const dir = join(home, '.config/systemd/user')
  const older = { ...schedule, command: ['/opt/node', '/x/index.js', 'run', '--scheduled'] }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'awaywork.service'), service(older))
  await writeFile(join(dir, 'awaywork.timer'), '[Timer]\nOnCalendar=*-*-* 01:05:00\n')
  const { run, calls } = recorder()
  const job = await systemd(home, run).read()
  expect(job && olderJob(job)).toBe(true)
  expect(calls).toEqual(['systemctl --user is-enabled awaywork.timer'])
  await systemd(home, run).install(schedule)
  expect(calls.slice(1, 2)).toEqual(['systemctl --user disable --now awaywork.timer'])
  expect(existsSync(join(dir, 'awaywork.timer'))).toBe(false)
  const current = await systemd(home, run).read()
  expect(current && olderJob(current)).toBe(false)
})

it('removes its unit files and fails in one line, with the cause, when systemctl fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const run: Exec = async () => {
    throw new Error('Failed to connect to bus: No medium found')
  }
  await expect(systemd(home, run).install(schedule)).rejects.toThrow(
    'systemctl failed (Failed to connect to bus: No medium found); without a systemd user session, log in directly or use --with cron',
  )
  expect(existsSync(join(home, '.config/systemd/user/awaywork.timer'))).toBe(false)
  expect(existsSync(join(home, '.config/systemd/user/awaywork.service'))).toBe(false)
})

it('reports the first line of stderr when the failure carries one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const run: Exec = async () => {
    throw Object.assign(
      new Error('Command failed with exit code 1: systemctl --user daemon-reload'),
      {
        stderr: 'Failed to connect to bus: No medium found\nsecond line',
      },
    )
  }
  await expect(systemd(home, run).install(schedule)).rejects.toThrow(
    'systemctl failed (Failed to connect to bus: No medium found);',
  )
})

it('reloads systemd after restoring the unit files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const calls: string[] = []
  const run: Exec = async (_cmd, args) => {
    calls.push(args.join(' '))
    if (args[1] === 'enable') throw new Error('boom')
    return ''
  }
  await expect(systemd(home, run).install(schedule)).rejects.toThrow('boom')
  expect(calls).toEqual([
    '--user daemon-reload',
    '--user enable awaywork.service',
    '--user daemon-reload',
  ])
})

it('restores the previous unit files when a reinstall fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  await systemd(home, recorder().run).install(schedule)
  const failing: Exec = async () => {
    throw new Error('boom')
  }
  await expect(
    systemd(home, failing).install({ ...schedule, log: '/h/other.log' }),
  ).rejects.toThrow('boom')
  expect(await systemd(home, recorder().run).read()).toEqual(schedule)
})

it('removes the unit files even when daemon-reload fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  await systemd(home, recorder().run).install(schedule)
  const failing: Exec = async () => {
    throw new Error('no bus')
  }
  expect(await systemd(home, failing).remove()).toBe(true)
  expect(existsSync(join(home, '.config/systemd/user/awaywork.service'))).toBe(false)
})

it('reads no job when the service is not enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  await systemd(home, recorder().run).install(schedule)
  const disabled: Exec = async () => {
    throw new Error('disabled')
  }
  expect(await systemd(home, disabled).read()).toBeUndefined()
})

it("adds tagged crontab lines at boot and every 5 minutes, keeps the user's own and removes only its lines", async () => {
  const cronTab = recorder('MAILTO=me\n\n0 9 * * * backup\n')
  const scheduler = cron(cronTab.run)
  await scheduler.install(schedule)
  await scheduler.install(schedule)
  const command = `PATH='/opt/bin:/usr/bin' '/opt/node' '/opt/away work/index.js' 'watch' '--config' '/h/it'\\''s.yml' > /dev/null 2>> '/h/state/schedule.log' & # awaywork`
  expect(cronLines(schedule)).toEqual([`@reboot ${command}`, `*/5 * * * * ${command}`])
  expect(cronTab.crontab()).toBe(
    `MAILTO=me\n\n0 9 * * * backup\n${cronLines(schedule).join('\n')}\n`,
  )
  expect(await scheduler.read()).toEqual(schedule)
  expect(await scheduler.remove()).toBe(true)
  expect(cronTab.crontab()).toBe('MAILTO=me\n\n0 9 * * * backup\n')
  expect(await scheduler.remove()).toBe(false)
  expect(await scheduler.read()).toBeUndefined()
})

it('reads back a job whose paths need escaping', () => {
  expect(parsePlist(plist(awkward))).toEqual(awkward)
  expect(parseService(service(awkward))).toEqual(awkward)
  expect(parseCronLines(cronLines(awkward))).toEqual(awkward)
})

it('writes a workflow with a UTC cron that calls the action with a pinned version', () => {
  const text = workflow({
    starts: [{ hour: 1, minute: 30 }],
    timezone: 'Europe/Rome',
    config: '.awaywork/config.yml',
    version: '0.3.1',
    packages: ['@anthropic-ai/claude-code'],
    secrets: ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    setup: [],
  })
  const parsed = parse(text)
  expect(parsed.on.schedule).toEqual([{ cron: '30 0 * * *' }])
  expect(parsed.name).toBe('awaywork')
  expect(Object.keys(parsed.on.workflow_dispatch.inputs)).toEqual(['unit'])
  expect(parsed.concurrency).toBe('awaywork')
  expect(parsed.permissions).toEqual({ contents: 'read' })
  expect(parsed.jobs.run['runs-on']).toBe('ubuntu-latest')
  expect(parsed.jobs.run['timeout-minutes']).toBe(360)
  expect(parsed.jobs.run.env).toEqual({ TZ: 'Europe/Rome' })
  expect(parsed.jobs.run.steps).toEqual([
    { uses: 'actions/checkout@v5', with: { 'persist-credentials': false } },
    {
      uses: 'AndreaProvenzale/awaywork@v0.3.1',
      env: {
        GH_TOKEN: '${{ secrets.GH_TOKEN }}',
        CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
      },
      with: {
        config: '.awaywork/config.yml',
        version: '0.3.1',
        packages: '@anthropic-ai/claude-code',
        unit: '${{ inputs.unit }}',
      },
    },
  ])
})

it('ships an action that installs the pinned version and runs awaywork once', async () => {
  const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'))
  expect(Object.keys(action.inputs)).toEqual(['config', 'version', 'packages', 'unit'])
  expect(action.runs.using).toBe('composite')
  const runs = action.runs.steps.map((s: { run?: string }) => s.run ?? '')
  expect(runs[0]).toContain('if [ -z "$GH_TOKEN" ]; then')
  expect(runs[0]).toContain("::error::GH_TOKEN is empty: the job's secrets didn't reach it.")
  expect(runs).toContain(
    "awaywork run ${{ github.event_name == 'schedule' && '--scheduled' || '' }} ${UNIT:+--unit \"$UNIT\"}",
  )
  const step = (name: string) => action.runs.steps.find((s: { name?: string }) => s.name === name)
  expect(step("Commit as the token's user").run).toContain(
    'echo "GIT_COMMITTER_EMAIL=$user@users.noreply.github.com"',
  )
})

it("touches a self-hosted machine's disk, global installs and git config not at all", async () => {
  const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'))
  const step = (name: string) => action.runs.steps.find((s: { name?: string }) => s.name === name)
  const hosted = "runner.environment == 'github-hosted'"
  expect(step('Free disk')).toMatchObject({ if: hosted })
  expect(step('Free disk').run).toMatch(/^sudo rm -rf \/usr\/share\/dotnet /)
  expect(step('Install')).toMatchObject({
    if: hosted,
    run: 'npm install -g "awaywork@$VERSION" $PACKAGES',
  })
  const local = step('Install for this job')
  expect(local.if).toBe("runner.environment != 'github-hosted'")
  expect(local.run).toBe(
    'npm install -g --prefix "$RUNNER_TEMP/awaywork" "awaywork@$VERSION"\necho "$RUNNER_TEMP/awaywork/bin" >> "$GITHUB_PATH"\n',
  )
  const commit = step("Commit as the token's user")
  expect(commit.if).toBeUndefined()
  expect(commit.run).not.toContain('git config')
  expect(commit.run).toContain('} >> "$GITHUB_ENV"')
  const unguarded = action.runs.steps.filter((s: { if?: string; run?: string }) => !s.if)
  expect(unguarded.map((s: { run?: string }) => s.run ?? '').join('\n')).not.toMatch(
    /sudo|npm install|git config/,
  )
  expect(step('Morning report')).toMatchObject({
    if: "always() && steps.run.outputs.run-dir != ''",
    run: 'cat "$RUN_DIR/report.md" >> "$GITHUB_STEP_SUMMARY" ||\n  echo "No report.md: the run was cut short." >> "$GITHUB_STEP_SUMMARY"\n',
  })
})

it("uploads only this run's report and units as an artifact named after the workflow", async () => {
  const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'))
  const step = (name: string) => action.runs.steps.find((s: { name?: string }) => s.name === name)
  expect(step('Run').id).toBe('run')
  expect(step('Upload the run')).toEqual({
    name: 'Upload the run',
    if: "always() && steps.run.outputs.run-id != ''",
    uses: 'actions/upload-artifact@v4',
    with: {
      name: '${{ github.workflow }}-${{ steps.run.outputs.run-id }}',
      path: '${{ steps.run.outputs.run-dir }}/report.md\n${{ steps.run.outputs.run-dir }}/report.json\n${{ steps.run.outputs.run-dir }}/units.json\n',
      'if-no-files-found': 'ignore',
    },
  })
})

it("runs command sources' setup in the config's folder before awaywork", () => {
  const text = workflow({
    starts: [{ hour: 1, minute: 30 }],
    timezone: 'Europe/Rome',
    config: '.awaywork/config.yml',
    version: '0.3.1',
    packages: [],
    secrets: [],
    setup: ['cargo build --release\ncp target/release/tracker bin/'],
  })
  const steps: { run?: string; uses?: string; 'working-directory'?: string }[] =
    parse(text).jobs.run.steps
  const setup = steps.findIndex((s) => s.run?.startsWith('cargo'))
  expect(steps[setup]).toEqual({
    'working-directory': '.awaywork',
    run: 'cargo build --release\ncp target/release/tracker bin/\n',
  })
  expect(setup).toBeLessThan(steps.findIndex((s) => s.uses?.startsWith('AndreaProvenzale/')))
})

it('removes only its own workflow from a repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
  await mkdir(join(root, '.github/workflows'), { recursive: true })
  await writeFile(join(root, WORKFLOW), 'name: awaywork\n')
  await writeFile(join(root, '.github/workflows/ci.yml'), 'name: ci\n')
  expect(await removeWorkflow(root)).toBe(true)
  expect(existsSync(join(root, WORKFLOW))).toBe(false)
  expect(existsSync(join(root, '.github/workflows/ci.yml'))).toBe(true)
  expect(await removeWorkflow(root)).toBe(false)
})

describe('schedule install --with github-actions', () => {
  let out: string[]
  beforeEach(() => {
    out = []
    vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)))
    vi.spyOn(console, 'error').mockImplementation((line) => void out.push(String(line)))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  const CONFIG = 'providers: [claude]\nsources: { github: { repos: [acme/api] } }\n'

  /** A repo and a user's config with a skill of its own and one linked from elsewhere. */
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
    const config = join(home, 'config.yml')
    await writeFile(config, CONFIG)
    await mkdir(join(home, 'elsewhere/linked'), { recursive: true })
    await writeFile(join(home, 'elsewhere/linked/SKILL.md'), 'LINKED')
    await mkdir(join(home, 'skills/mine'), { recursive: true })
    await writeFile(join(home, 'skills/mine/SKILL.md'), 'MINE')
    await symlink(join(home, 'elsewhere/linked'), join(home, 'skills/linked'))
    const install = async (script: [RegExp, unknown][] = [], interactive = false) => {
      out = []
      const ask = scriptedAsk(script)
      await installWorkflow(config, {
        run: async () => root,
        ask,
        env: {},
        setSecret: async () => {},
        interactive,
      })
      expect(process.exitCode).toBeUndefined()
    }
    return { root, home, config, install }
  }

  it("writes the workflow and copies the config and skills, linked ones as files; again, it's up to date", async () => {
    const { root, install } = await setup()
    await install()
    expect(parse(await readFile(join(root, WORKFLOW), 'utf8')).name).toBe('awaywork')
    expect(await readFile(join(root, REPO_CONFIG), 'utf8')).toBe(CONFIG)
    expect(await readFile(join(root, REPO_SKILLS, 'mine/SKILL.md'), 'utf8')).toBe('MINE')
    expect(lstatSync(join(root, REPO_SKILLS, 'linked')).isSymbolicLink()).toBe(false)
    expect(await readFile(join(root, REPO_SKILLS, 'linked/SKILL.md'), 'utf8')).toBe('LINKED')
    expect(out).toContain(
      '  commit .github/workflows/awaywork.yml, .awaywork/config.yml and .awaywork/skills',
    )
    await install()
    expect(out.slice(0, 3)).toEqual([
      '.github/workflows/awaywork.yml is up to date',
      '.awaywork/config.yml is up to date',
      '.awaywork/skills is up to date',
    ])
    expect(out.join('\n')).not.toMatch(/commit/)
  })

  it("says codex and a command provider won't run on the hosted runner and leaves them out", async () => {
    const { root, config, install } = await setup()
    const opencode = '{ opencode: { command: opencode, secrets: [OPENCODE_API_KEY] } }'
    await writeFile(
      config,
      `${CONFIG.replace('[claude]', `[claude, codex, ${opencode}]`)}limits: { unit_minutes: 30 }\n`,
    )
    await install()
    expect(out[0]).toMatch(
      /^codex won't run in this workflow: a GitHub-hosted runner has no Codex login/,
    )
    expect(out[1]).toMatch(/^opencode won't run in this workflow/)
    const steps = parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run.steps
    expect(steps.at(-1).with.packages).toBe('@anthropic-ai/claude-code')
    expect(Object.keys(steps.at(-1).env)).toEqual(['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('names each secret the config needs once', async () => {
    const { root, config, install } = await setup()
    await writeFile(
      config,
      `providers: [claude]
sources: { github: { repos: [acme/api] }, asana: { workspace: "100" } }
repos: { acme/api: { secrets: [DATABASE_URL] } }
notify: { command: "true", secrets: [SLACK_WEBHOOK, ASANA_TOKEN, HOOK_TOKEN] }
mcp: { db: { command: npx, secrets: [MCP_DB_URL] } }
`,
    )
    await install()
    const steps = parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run.steps
    expect(Object.keys(steps.at(-1).env)).toEqual([
      'GH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ASANA_TOKEN',
      'SLACK_WEBHOOK',
      'HOOK_TOKEN',
      'DATABASE_URL',
      'MCP_DB_URL',
    ])
  })

  it('asks which runner; self-hosted keeps codex, installs no CLI and adds no secret for it', async () => {
    const { root, config, install } = await setup()
    await writeFile(config, CONFIG.replace('[claude]', '[claude, codex]'))
    await install([[/^Which runner\?$/, 'self-hosted']], true)
    expect(out.join('\n')).not.toMatch(/won't run/)
    const job = parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run
    expect(job['runs-on']).toBe('self-hosted')
    expect(job['timeout-minutes']).toBe(1440)
    expect(job.steps.at(-1).with.packages).toBe('')
    expect(Object.keys(job.steps.at(-1).env)).toEqual(['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    const labelHint = /^`runs-on: self-hosted` matches any self-hosted runner .* a label of its own/
    expect(out[0]).toMatch(labelHint)

    await install()
    expect(out.slice(0, 2)).toEqual([expect.stringMatching(labelHint), `${WORKFLOW} is up to date`])
    await install([[/^Which runner\?$/, initial]], true)
    expect(out[1]).toBe(`${WORKFLOW} is up to date`)
  })

  it.each([
    'runs-on: [self-hosted, macOS]',
    'runs-on:\n      - self-hosted\n      - macOS',
    'runs-on: { group: mine, labels: [self-hosted, macOS] }',
    'runs-on:\n      group: mine\n      labels: self-hosted',
  ])('keeps a runs-on labelled by hand on a re-run: %j', async (label) => {
    const { root, install } = await setup()
    await install([[/^Which runner\?$/, 'self-hosted']], true)
    const file = join(root, WORKFLOW)
    await writeFile(file, (await readFile(file, 'utf8')).replace('runs-on: self-hosted', label))
    await install()
    expect(out[0]).toBe(`${WORKFLOW} is up to date`)
    await writeFile(file, `${await readFile(file, 'utf8')}# mine\n`)
    await install(
      [
        [/^Which runner\?$/, initial],
        [/^Overwrite \.github\/workflows\/awaywork\.yml/, true],
      ],
      true,
    )
    const generated = await readFile(file, 'utf8')
    expect(generated).not.toContain('# mine')
    expect(generated).toContain(`    ${label}\n`)
    expect(parse(generated).jobs.run['runs-on']).toEqual(parse(label)['runs-on'])
  })

  it.each(['runs-on: "self-hosted"', 'runs-on: [self-hosted]', 'runs-on: self-hosted # my box'])(
    'still hints at a label of its own for a plain %j',
    async (label) => {
      const { root, install } = await setup()
      await install([[/^Which runner\?$/, 'self-hosted']], true)
      const file = join(root, WORKFLOW)
      await writeFile(file, (await readFile(file, 'utf8')).replace('runs-on: self-hosted', label))
      await install()
      expect(out.slice(0, 2)).toEqual([
        expect.stringMatching(/^`runs-on: self-hosted` matches any self-hosted runner/),
        `${WORKFLOW} is up to date`,
      ])
    },
  )

  it('says once that run: soon rules run in the windows there', async () => {
    const { config, install } = await setup()
    await writeFile(
      config,
      `${CONFIG}queue: [{ skill: fix, run: soon }, { skill: plan }, { skill: implement, run: soon }]\n`,
    )
    await install()
    expect(out[0]).toBe(
      "run: soon needs awaywork watch, which GitHub Actions doesn't have: rules #1 and #3 run in the windows like the rest",
    )
    expect(out.filter((l) => l.includes('run: soon'))).toHaveLength(1)
  })

  it('refuses a Bitbucket config and writes nothing', async () => {
    const { root, config } = await setup()
    await writeFile(config, 'providers: [claude]\nsources: { bitbucket: { repos: [acme/api] } }\n')
    await installWorkflow(config, {
      run: async () => root,
      ask: scriptedAsk([]),
      env: {},
      setSecret: async () => {},
    })
    expect(process.exitCode).toBe(1)
    expect(out).toEqual([
      'GitHub Actions runs only with the GitHub forge; schedule a Bitbucket config with launchd, systemd or cron',
    ])
    expect(existsSync(join(root, WORKFLOW))).toBe(false)
  })

  it('keeps what differs without a terminal, shows the diff and exits 1', async () => {
    const { root, config, install } = await setup()
    await install()
    const generated = await readFile(join(root, WORKFLOW), 'utf8')
    await writeFile(join(root, WORKFLOW), `${generated}# mine\n`)
    out = []
    await installWorkflow(config, {
      run: async () => root,
      ask: scriptedAsk([]),
      env: { GH_TOKEN: 'ghp_secret' },
      setSecret: async () => {},
    })
    expect(process.exitCode).toBe(1)
    expect(out.join('\n')).toContain('-# mine')
    expect(out).toContain(`Kept ${WORKFLOW}; run this again in a terminal to replace it`)
    expect(out).toContain('  add these repository secrets: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN')
    expect(await readFile(join(root, WORKFLOW), 'utf8')).toBe(`${generated}# mine\n`)
  })

  it('shows what changed and asks; declined keeps, accepted replaces the skills folder as a whole', async () => {
    const { root, home, config, install } = await setup()
    await install()
    await mkdir(join(root, REPO_SKILLS, 'team'), { recursive: true })
    await writeFile(join(root, REPO_SKILLS, 'team/SKILL.md'), 'TEAM')
    await writeFile(config, `${CONFIG}skills: [mine]\n`)
    await writeFile(join(home, 'skills/mine/SKILL.md'), 'CHANGED')
    await install(
      [
        [/^Which runner\?$/, initial],
        [/^Overwrite \.awaywork\/config\.yml/, false],
        [/^Replace all of \.awaywork\/skills/, initial],
      ],
      true,
    )
    expect(out).toContain('Kept .awaywork/skills')
    expect(await readFile(join(root, REPO_SKILLS, 'team/SKILL.md'), 'utf8')).toBe('TEAM')
    await install(
      [
        [/^Which runner\?$/, initial],
        [/^Overwrite \.awaywork\/config\.yml with the changes above\?$/, false],
        [
          /^Replace all of \.awaywork\/skills with the changes above, deleting anything only the repo's copy has\?$/,
          true,
        ],
      ],
      true,
    )
    expect(out.join('\n')).toContain('+skills: [mine]')
    expect(out.join('\n')).toContain('-TEAM')
    expect(out).toContain('Kept .awaywork/config.yml')
    expect(await readFile(join(root, REPO_CONFIG), 'utf8')).toBe(CONFIG)
    expect(await readFile(join(root, REPO_SKILLS, 'mine/SKILL.md'), 'utf8')).toBe('CHANGED')
    expect(existsSync(join(root, REPO_SKILLS, 'team'))).toBe(false)
    expect(out).toContain('  commit .awaywork/skills')
  })

  it('asks before overwriting a hand-edited workflow', async () => {
    const { root, install } = await setup()
    await install()
    const generated = await readFile(join(root, WORKFLOW), 'utf8')
    await writeFile(join(root, WORKFLOW), `${generated}# mine\n`)
    await install(
      [
        [/^Which runner\?$/, initial],
        [/^Overwrite \.github\/workflows\/awaywork\.yml with the changes above\?$/, false],
      ],
      true,
    )
    expect(out).toContain('Kept .github/workflows/awaywork.yml')
    expect(await readFile(join(root, WORKFLOW), 'utf8')).toBe(`${generated}# mine\n`)
    await install(
      [
        [/^Which runner\?$/, initial],
        [/^Overwrite \.github\/workflows\/awaywork\.yml/, initial],
      ],
      true,
    )
    expect(await readFile(join(root, WORKFLOW), 'utf8')).toBe(generated)
    expect(out).toContain('  commit .github/workflows/awaywork.yml')
  })

  it("leaves the repo's skills alone when the user has none, a stray file aside", async () => {
    const { root, home, install } = await setup()
    await rm(join(home, 'skills'), { recursive: true })
    await mkdir(join(home, 'skills'))
    await writeFile(join(home, 'skills/.DS_Store'), '')
    await mkdir(join(root, REPO_SKILLS, 'team'), { recursive: true })
    await writeFile(join(root, REPO_SKILLS, 'team/SKILL.md'), 'TEAM')
    await install()
    expect(await readFile(join(root, REPO_SKILLS, 'team/SKILL.md'), 'utf8')).toBe('TEAM')
    expect(out).toContain('  commit .github/workflows/awaywork.yml and .awaywork/config.yml')
  })
})

it('warns about a workflow that runs its steps inline instead of calling the action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
  expect(await staleWorkflow(root)).toBeUndefined()
  await mkdir(join(root, '.github/workflows'), { recursive: true })
  await writeFile(join(root, WORKFLOW), 'steps:\n  - run: npm install -g awaywork\n')
  expect(await staleWorkflow(root)).toMatch(/doesn't call awaywork's action/)
  const current = {
    starts: [{ hour: 1, minute: 30 }],
    timezone: 'UTC',
    config: 'c.yml',
    version: '0.3.1',
  }
  await writeFile(
    join(root, WORKFLOW),
    workflow({ ...current, packages: [], secrets: [], setup: [] }),
  )
  expect(await staleWorkflow(root)).toBeUndefined()
  await writeFile(join(root, WORKFLOW), 'steps:\n  - uses: AndreaProvenzale/awaywork@v1\n')
  expect(await staleWorkflow(root)).toBeUndefined()
})

it('offers to set only the secrets it has values for, and never prints them', async () => {
  const ask = scriptedAsk([
    [/^Set the GH_TOKEN repository secret/, true],
    [/^Set the ASANA_TOKEN repository secret/, false],
    [/^Set the SLACK_WEBHOOK repository secret/, true],
  ])
  const set: [string, string][] = []
  const unset = await offerSecrets(
    ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ASANA_TOKEN', 'SLACK_WEBHOOK'],
    { GH_TOKEN: 'ghp_secret', ASANA_TOKEN: 'asana_secret', SLACK_WEBHOOK: 'hook_secret' },
    ask,
    async (name, value) => {
      if (name === 'SLACK_WEBHOOK') throw new Error('gh failed')
      set.push([name, value])
    },
  )
  expect(set).toEqual([['GH_TOKEN', 'ghp_secret']])
  expect(unset).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ASANA_TOKEN', 'SLACK_WEBHOOK'])
  expect(ask.notes).toEqual(['Set GH_TOKEN', '`gh secret set SLACK_WEBHOOK` failed'])
  expect(ask.notes.join('\n')).not.toMatch(/_secret/)
})

it("warns about an older awaywork's job for this config, or a wake off the windows' start", async () => {
  const installed = (id: string, job?: Schedule): Scheduler => ({
    id,
    install: async () => '',
    remove: async () => false,
    read: async () => job,
  })
  const older = {
    ...schedule,
    command: ['/opt/node', 'run', '--scheduled', '--config', '/h/o.yml'],
  }
  const all = {
    launchd: installed('launchd', schedule),
    cron: installed('cron', older),
    systemd: installed('systemd'),
  }
  const pmset: Exec = async () => 'Repeating power events:\n  wake at 1:05AM every day\n'
  const windows = (start: string) => [{ start, end: '07:00' }]
  expect(await staleSchedules("/h/it's.yml", windows('01:05'), all, pmset)).toEqual([])
  expect(await staleSchedules('/h/o.yml', windows('01:05'), all, pmset)).toEqual([
    'the cron job was installed by an older awaywork; run `awaywork schedule install` again',
  ])
  const moved = await staleSchedules("/h/it's.yml", windows('02:30'), all, pmset)
  expect(moved).toEqual(
    process.platform === 'darwin'
      ? [
          'this Mac wakes at 01:05, the windows start at 02:30; run `awaywork schedule install` to move the wake',
        ]
      : [],
  )
})

it('says only when the wake set at install no longer lands on the windows start', async () => {
  const sched = (events: string) => async () => `Repeating power events:\n${events}\n`
  const at = [{ hour: 13, minute: 0 }]
  expect(await staleWake(at, sched('  wake at 1:00PM every day'), 'darwin')).toBeUndefined()
  expect(await staleWake(at, sched('  wake at 1:00AM every day'), 'darwin')).toBe(
    'this Mac wakes at 01:00, the windows start at 13:00; run `awaywork schedule install` to move the wake',
  )
  expect(await staleWake(at, sched('  wakepoweron at 7:00AM every day'), 'darwin')).toBeUndefined()
  expect(await staleWake([], sched('  wake at 1:00AM every day'), 'darwin')).toBeUndefined()
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-wake-'))
  expect(await staleWake(at, async () => '', 'linux', dir)).toBeUndefined()
  await writeFile(join(dir, 'awaywork-wake.timer'), wakeTimer(at))
  expect(await staleWake(at, async () => '', 'linux', dir)).toBeUndefined()
  expect(await staleWake([{ hour: 2, minute: 0 }], async () => '', 'linux', dir)).toBe(
    `${dir}/awaywork-wake.timer doesn't wake at the windows' start (02:00); run \`awaywork schedule install\` to move the wake`,
  )
})

const weekly: Start[] = [
  { hour: 1, minute: 5 },
  { hour: 10, minute: 0, days: [0, 6] },
]

it('reads an older per-window crontab back as an older job', async () => {
  const line = `5 1 * * * PATH='/opt/bin' '/opt/node' '/x/index.js' 'run' '--scheduled' '--config' '/h/c.yml' >> '/h/s.log' 2>&1 # awaywork`
  const job = await cron(recorder(`${line}\n`).run).read()
  expect(job).toEqual({
    command: ['/opt/node', '/x/index.js', 'run', '--scheduled', '--config', '/h/c.yml'],
    path: '/opt/bin',
    log: '/h/s.log',
  })
  expect(job && olderJob(job)).toBe(true)
  expect(olderJob(schedule)).toBe(false)
})

it('writes a workflow cron per window', () => {
  const text = workflow({
    starts: weekly,
    timezone: 'UTC',
    config: 'c.yml',
    version: '0.3.1',
    packages: [],
    secrets: [],
    setup: [],
  })
  expect(parse(text).on.schedule).toEqual([{ cron: '5 1 * * *' }, { cron: '0 10 * * 0,6' }])
  const dispatchOnly = workflow({
    starts: [],
    timezone: 'UTC',
    config: 'c.yml',
    version: '0.3.1',
    packages: [],
    secrets: [],
    setup: [],
  })
  expect(parse(dispatchOnly).on).toEqual({ workflow_dispatch: parse(text).on.workflow_dispatch })
})

it("starts the workflow's cron in UTC at the zone's standard time, shifting days across midnight", () => {
  const crons = (timezone: string, starts: Start[]) =>
    parse(
      workflow({
        starts,
        timezone,
        config: 'c.yml',
        version: '0.3.1',
        packages: [],
        secrets: [],
        setup: [],
      }),
    ).on.schedule.map((s: { cron: string }) => s.cron)
  expect(
    crons('Europe/Rome', [
      { hour: 18, minute: 0 },
      { hour: 0, minute: 30, days: [0, 6] },
    ]),
  ).toEqual(['0 17 * * *', '30 23 * * 5,6'])
  expect(
    crons('America/New_York', [
      { hour: 1, minute: 0 },
      { hour: 22, minute: 15, days: [5, 6] },
    ]),
  ).toEqual(['0 6 * * *', '15 3 * * 0,6'])
  expect(
    crons('Asia/Tokyo', [
      { hour: 8, minute: 0, days: [0, 1] },
      { hour: 10, minute: 0 },
    ]),
  ).toEqual(['0 23 * * 0,6', '0 1 * * *'])
  expect(crons('Asia/Kolkata', [{ hour: 1, minute: 0 }])).toEqual(['30 19 * * *'])
  expect(crons('Africa/Casablanca', [{ hour: 1, minute: 0 }])).toEqual(['0 1 * * *'])
})

describe('wake', () => {
  it('holds a Mac awake with caffeinate while the run lasts', async () => {
    const run: Exec = async () => ''
    expect(await keepAwake(run, 'darwin')).toEqual(['/usr/bin/caffeinate', '-i'])
    expect(await keepAwake(run, 'win32')).toEqual([])
  })

  it('holds Linux awake with systemd-inhibit only when a probe of it works', async () => {
    const probes: string[][] = []
    const works: Exec = async (cmd, args) => {
      probes.push([cmd, ...args])
      return ''
    }
    const inhibit = ['systemd-inhibit', '--what=idle', '--who=awaywork', '--why=scheduled run']
    expect(await keepAwake(works, 'linux')).toEqual(inhibit)
    expect(probes).toEqual([[...inhibit, 'true']])
    const noBus: Exec = async () => {
      throw new Error('Failed to connect to bus')
    }
    expect(await keepAwake(noBus, 'linux')).toEqual([])
  })

  it('repeats one pmset wake on the days of the windows starting then', () => {
    expect(pmsetArgs([{ hour: 1, minute: 5 }])).toEqual([
      'pmset',
      'repeat',
      'wake',
      'MTWRFSU',
      '01:05:00',
    ])
    expect(
      pmsetArgs([
        { hour: 1, minute: 5, days: [0, 6] },
        { hour: 1, minute: 5, days: [1] },
      ])?.[3],
    ).toBe('MSU')
    expect(pmsetArgs(weekly)).toBeUndefined()
  })

  it('asks before replacing repeating power events, and says why it cannot wake for two times', async () => {
    const sched = `Repeating power events:
  wakepoweron at 7:00AM every day
Scheduled power events:
 [0]  wake at 10/16/2026 01:01:20 by 'com.apple.alarm'
`
    const calls: string[][] = []
    const run: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      return cmd === 'pmset' ? sched : ''
    }
    const wake = await wakeFor([{ hour: 1, minute: 5 }], run, 'darwin')
    if (!wake || typeof wake === 'string') throw new Error(`no wake: ${wake}`)
    expect(wake.question).toBe(
      'Wake this Mac when the window opens (sudo pmset repeat wake MTWRFSU 01:05:00, replacing wakepoweron at 7:00AM every day)?',
    )
    expect(wake.initial).toBe(false)
    await wake.install()
    expect(calls.at(-1)).toEqual(['sudo', 'pmset', 'repeat', 'wake', 'MTWRFSU', '01:05:00'])
    expect(await wakeFor(weekly, run, 'darwin')).toBe(
      'pmset repeats one wake time and the windows start at 01:05, 10:00 on 0,6; keep this Mac awake for them',
    )
    const none = await wakeFor([{ hour: 1, minute: 5 }], async () => '', 'darwin')
    expect(none && typeof none !== 'string' && none.initial).toBe(true)
    const ours = await wakeFor(
      [{ hour: 1, minute: 5 }],
      async () => 'Repeating power events:\n  wake at 1:00AM every day\n',
      'darwin',
    )
    expect(ours && typeof ours !== 'string' && ours.initial).toBe(true)
  })

  it('names the repeating power events a Mac keeps after remove', async () => {
    const sched = `Repeating power events:
  wakepoweron at 1:00AM every day
  shutdown at 11:00PM weekdays only
`
    expect(await wakeUndo(async () => sched, 'darwin')).toBe(
      'Repeating power events stay (wakepoweron at 1:00AM every day; shutdown at 11:00PM weekdays only); `sudo pmset repeat cancel` removes them all',
    )
    expect(await wakeUndo(async () => 'Scheduled power events:\n', 'darwin')).toBeUndefined()
  })

  it('installs a root timer that wakes the system at each start', async () => {
    expect(wakeTimer(weekly)).toContain(
      'OnCalendar=*-*-* 01:05:00\nOnCalendar=Sun,Sat *-*-* 10:00:00\nWakeSystem=true',
    )
    const calls: string[][] = []
    let installed = ''
    const run: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (args[0] === 'install') installed = await readFile(args[4] ?? '', 'utf8')
      return ''
    }
    await timerWake(weekly, run).install()
    expect(installed).toBe(wakeTimer(weekly))
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'sudo install',
      'sudo systemctl',
      'sudo systemctl',
    ])
    expect(calls.at(-1)).toEqual(['sudo', 'systemctl', 'enable', '--now', 'awaywork-wake.timer'])
  })
})
