// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { installWorkflow, offerSecrets, staleSchedules } from '../src/cli/schedule.js'
import type { Exec } from '../src/forge/gh.js'
import { cron, cronLine, cronLines, parseCronLines } from '../src/scheduler/cron.js'
import {
  REPO_CONFIG,
  REPO_SKILLS,
  removeWorkflow,
  staleWorkflow,
  WORKFLOW,
  type Workflow,
  workflow,
  workflows,
} from '../src/scheduler/github-actions.js'
import type { Schedule, Scheduler, Start } from '../src/scheduler/index.js'
import { launchd, parsePlist, plist } from '../src/scheduler/launchd.js'
import { parseUnits, service, systemd, timer } from '../src/scheduler/systemd.js'
import { initial, scriptedAsk } from './fakes/ask.js'

const schedule: Schedule = {
  command: [
    '/opt/node',
    '/opt/away work/index.js',
    'run',
    '--scheduled',
    '--config',
    "/h/it's.yml",
  ],
  starts: [{ hour: 1, minute: 5 }],
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

it('writes a LaunchAgent that starts at the window start and logs to the state dir', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const { run, calls } = recorder()
  const scheduler = launchd(home, run, 501)
  const file = await scheduler.install(schedule)
  expect(file).toBe(join(home, 'Library/LaunchAgents/awaywork.plist'))
  const text = await readFile(file, 'utf8')
  expect(text).toBe(plist(schedule))
  expect(text).toContain('<key>Hour</key><integer>1</integer><key>Minute</key><integer>5</integer>')
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

it('writes a persistent systemd user timer and its service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'awaywork-home-'))
  const { run, calls } = recorder()
  await systemd(home, run).install(schedule)
  expect(timer(schedule)).toContain('OnCalendar=*-*-* 01:05:00\nPersistent=true')
  expect(service(schedule)).toContain(
    `ExecStart="/opt/node" "/opt/away work/index.js" "run" "--scheduled" "--config" "/h/it's.yml"`,
  )
  expect(calls).toEqual([
    'systemctl --user daemon-reload',
    'systemctl --user enable --now awaywork.timer',
  ])
  expect(await systemd(home, run).read()).toEqual(schedule)
  expect(await systemd(home, run).remove()).toBe(true)
  expect(existsSync(join(home, '.config/systemd/user/awaywork.service'))).toBe(false)
  expect(await systemd(home, run).read()).toBeUndefined()
})

it("adds one tagged crontab line, keeps the user's own and removes only its line", async () => {
  const cronTab = recorder('MAILTO=me\n\n0 9 * * * backup\n')
  const scheduler = cron(cronTab.run)
  await scheduler.install(schedule)
  await scheduler.install(schedule)
  expect(cronLine(schedule, schedule.starts[0] as Start)).toBe(
    `5 1 * * * PATH='/opt/bin:/usr/bin' '/opt/node' '/opt/away work/index.js' 'run' '--scheduled' '--config' '/h/it'\\''s.yml' >> '/h/state/schedule.log' 2>&1 # awaywork`,
  )
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
  expect(parseUnits(service(awkward), timer(awkward))).toEqual(awkward)
  expect(parseCronLines(cronLines(awkward))).toEqual(awkward)
})

it('writes a workflow with a local-time cron that calls the action with a pinned version', () => {
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
  expect(parsed.on.schedule).toEqual([{ cron: '30 1 * * *', timezone: 'Europe/Rome' }])
  expect(parsed.name).toBe('awaywork')
  expect(parsed.concurrency).toBe('awaywork')
  expect(parsed.permissions).toEqual({ contents: 'read' })
  expect(parsed.jobs.run.environment).toBeUndefined()
  expect(parsed.jobs.run['runs-on']).toBe('ubuntu-latest')
  expect(parsed.jobs.run.env).toEqual({ TZ: 'Europe/Rome' })
  expect(parsed.jobs.run.steps).toEqual([
    { uses: 'actions/checkout@v5', with: { 'persist-credentials': false } },
    {
      uses: 'AndreaProvenzale/awaywork@v1',
      env: {
        GH_TOKEN: '${{ secrets.GH_TOKEN }}',
        CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
      },
      with: {
        config: '.awaywork/config.yml',
        version: '0.3.1',
        packages: '@anthropic-ai/claude-code',
      },
    },
  ])
})

it('ships an action that installs the pinned version and runs awaywork once', async () => {
  const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'))
  expect(Object.keys(action.inputs)).toEqual(['config', 'version', 'packages'])
  expect(action.runs.using).toBe('composite')
  const runs = action.runs.steps.map((s: { run?: string }) => s.run ?? '')
  expect(runs[0]).toContain('if [ -z "$GH_TOKEN" ]; then')
  expect(runs[0]).toContain("::error::GH_TOKEN is empty: the job's secrets didn't reach it.")
  expect(runs).toContain(
    "awaywork run ${{ github.event_name == 'schedule' && '--scheduled' || '' }}",
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
    if: 'always()',
    run: 'awaywork report >> "$GITHUB_STEP_SUMMARY" || true',
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

const alice: Workflow = {
  starts: [{ hour: 22, minute: 0 }],
  timezone: 'Europe/Rome',
  config: '.awaywork/alice/config.yml',
  version: '0.3.1',
  packages: [],
  secrets: ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SLACK_WEBHOOK'],
  setup: ['make tracker'],
}
const personal = ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']

it("writes a person's workflow with their environment, suffixed secrets, concurrency and config folder", () => {
  const job = parse(workflow({ ...alice, person: { name: 'alice', personal, environment: true } }))
  expect(job.name).toBe('awaywork-alice')
  expect(job.concurrency).toBe('awaywork-alice')
  expect(job.jobs.run.environment).toEqual({ name: 'alice', deployment: false })
  expect(job.jobs.run.env).toEqual({ TZ: 'Europe/Rome' })
  expect(job.jobs.run.steps[2].env).toEqual({
    GH_TOKEN: '${{ secrets.GH_TOKEN__ALICE }}',
    CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN__ALICE }}',
    SLACK_WEBHOOK: '${{ secrets.SLACK_WEBHOOK }}',
  })
  expect(job.jobs.run.steps[1]['working-directory']).toBe('.awaywork/alice')
  expect(job.jobs.run.steps[2].with.config).toBe('.awaywork/alice/config.yml')
})

it('keeps a person named like a YAML number a string', () => {
  const job = parse(
    workflow({
      ...alice,
      config: '.awaywork/007/config.yml',
      person: { name: '007', personal, environment: true },
    }),
  )
  expect(job.name).toBe('awaywork-007')
  expect(job.concurrency).toBe('awaywork-007')
  expect(job.jobs.run.environment).toEqual({ name: '007', deployment: false })
  expect(job.jobs.run.steps[1]['working-directory']).toBe('.awaywork/007')
  expect(job.jobs.run.steps[2].with.config).toBe('.awaywork/007/config.yml')
})

it('differs without an environment only by its environment line', () => {
  const person = { name: 'mary-jo', personal, environment: false }
  const job = parse(workflow({ ...alice, person }))
  expect(job.name).toBe('awaywork-mary-jo')
  expect(job.concurrency).toBe('awaywork-mary-jo')
  expect(job.jobs.run.environment).toBeUndefined()
  expect(job.jobs.run.steps[2].env).toEqual({
    GH_TOKEN: '${{ secrets.GH_TOKEN__MARY_JO }}',
    CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN__MARY_JO }}',
    SLACK_WEBHOOK: '${{ secrets.SLACK_WEBHOOK }}',
  })
  const env = workflow({ ...alice, person: { ...person, environment: true } }).split('\n')
  expect(workflow({ ...alice, person }).split('\n')).toEqual(
    env.filter((line) => !line.includes('environment:')),
  )
})

it("lists every awaywork workflow in a repo and removes only one person's", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-repo-'))
  expect(await workflows(root)).toEqual([])
  const dir = join(root, '.github/workflows')
  await mkdir(dir, { recursive: true })
  for (const f of ['awaywork.yml', 'awaywork-bob.yml', 'awaywork-alice.yml', 'ci.yml'])
    await writeFile(join(dir, f), '')
  expect(await workflows(root)).toEqual(
    ['awaywork-alice.yml', 'awaywork-bob.yml', 'awaywork.yml'].map((f) => join(dir, f)),
  )
  expect(await removeWorkflow(root, 'alice')).toBe(true)
  expect(await removeWorkflow(root, 'alice')).toBe(false)
  expect(await workflows(root)).toEqual(
    ['awaywork-bob.yml', 'awaywork.yml'].map((f) => join(dir, f)),
  )
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
      await installWorkflow(config, undefined, {
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

  it("says codex won't run on the hosted runner and leaves it out of the installs", async () => {
    const { root, config, install } = await setup()
    await writeFile(config, CONFIG.replace('[claude]', '[claude, codex]'))
    await install()
    expect(out[0]).toMatch(
      /^codex won't run in this workflow: a GitHub-hosted runner has no Codex login/,
    )
    const steps = parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run.steps
    expect(steps.at(-1).with.packages).toBe('@anthropic-ai/claude-code')
    expect(Object.keys(steps.at(-1).env)).toEqual(['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('asks whose repo and which runner; self-hosted keeps codex, installs no CLI and adds no secret for it', async () => {
    const { root, config, install } = await setup()
    await writeFile(config, CONFIG.replace('[claude]', '[claude, codex]'))
    await install(
      [
        [/^Whose control repo is this\?$/, initial],
        [/^Which runner\?$/, 'self-hosted'],
      ],
      true,
    )
    expect(out.join('\n')).not.toMatch(/won't run/)
    const job = parse(await readFile(join(root, WORKFLOW), 'utf8')).jobs.run
    expect(job['runs-on']).toBe('self-hosted')
    expect(job.steps.at(-1).with.packages).toBe('')
    expect(Object.keys(job.steps.at(-1).env)).toEqual(['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])

    await install()
    expect(out[0]).toBe(`${WORKFLOW} is up to date`)
    await install([[/^Which runner\?$/, initial]], true)
    expect(out[0]).toBe(`${WORKFLOW} is up to date`)
  })

  it('keeps a runs-on labelled by hand on a re-run', async () => {
    const { root, install } = await setup()
    await install(
      [
        [/^Whose control repo is this\?$/, initial],
        [/^Which runner\?$/, 'self-hosted'],
      ],
      true,
    )
    const labelled = (await readFile(join(root, WORKFLOW), 'utf8')).replace(
      'runs-on: self-hosted',
      'runs-on: [self-hosted, macOS]',
    )
    await writeFile(join(root, WORKFLOW), labelled)
    await install()
    await install([[/^Which runner\?$/, initial]], true)
    expect(out[0]).toBe(`${WORKFLOW} is up to date`)
    expect(parse(labelled).jobs.run['runs-on']).toEqual(['self-hosted', 'macOS'])
  })

  it('keeps what differs without a terminal, shows the diff and exits 1', async () => {
    const { root, config, install } = await setup()
    await install()
    const generated = await readFile(join(root, WORKFLOW), 'utf8')
    await writeFile(join(root, WORKFLOW), `${generated}# mine\n`)
    out = []
    await installWorkflow(config, undefined, {
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
    async ([name], value) => {
      if (name === 'SLACK_WEBHOOK') throw new Error('gh failed')
      set.push([name ?? '', value])
    },
  )
  expect(set).toEqual([['GH_TOKEN', 'ghp_secret']])
  expect(unset).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ASANA_TOKEN', 'SLACK_WEBHOOK'])
  expect(ask.notes).toEqual(['Set GH_TOKEN', '`gh secret set SLACK_WEBHOOK` failed'])
  expect(ask.notes.join('\n')).not.toMatch(/_secret/)
})

it('warns when an installed job for this config no longer starts when its windows open', async () => {
  const installed = (id: string, job?: Schedule): Scheduler => ({
    id,
    install: async () => '',
    remove: async () => false,
    read: async () => job,
  })
  const all = {
    launchd: installed('launchd', schedule),
    cron: installed('cron', { ...schedule, command: ['awaywork', '--config', '/h/other.yml'] }),
    systemd: installed('systemd'),
  }
  expect(await staleSchedules("/h/it's.yml", [{ start: '01:05', end: '07:00' }], all)).toEqual([])
  expect(await staleSchedules("/h/it's.yml", [{ start: '02:30', end: '07:00' }], all)).toEqual([
    "the launchd job starts at 01:05, the config's windows start at 02:30; run `awaywork schedule install`",
  ])
  const reordered = { launchd: installed('launchd', weekly) }
  const windows = [
    { days: ['sun' as const, 'sat' as const], start: '10:00', end: '18:00' },
    { start: '01:05', end: '07:00' },
  ]
  expect(await staleSchedules("/h/it's.yml", windows, reordered)).toEqual([])
})

const weekly: Schedule = {
  ...schedule,
  starts: [
    { hour: 1, minute: 5 },
    { hour: 10, minute: 0, days: [0, 6] },
  ],
}

it('installs one trigger per window in every scheduler and reads them back', async () => {
  expect(parsePlist(plist(weekly))).toEqual(weekly)
  expect(plist(weekly)).toContain('<key>Weekday</key><integer>6</integer>')
  expect(timer(weekly)).toContain('OnCalendar=Sun,Sat *-*-* 10:00:00')
  expect(parseUnits(service(weekly), timer(weekly))).toEqual(weekly)
  expect(cronLines(weekly).map((l) => l.split(' ').slice(0, 5).join(' '))).toEqual([
    '5 1 * * *',
    '0 10 * * 0,6',
  ])
  expect(parseCronLines(cronLines(weekly))).toEqual(weekly)
  const cronTab = recorder()
  const scheduler = cron(cronTab.run)
  await scheduler.install(weekly)
  expect(await scheduler.read()).toEqual(weekly)
  expect(await scheduler.remove()).toBe(true)
})

it('writes a workflow cron per window', () => {
  const text = workflow({
    starts: weekly.starts,
    timezone: 'UTC',
    config: 'c.yml',
    version: '0.3.1',
    packages: [],
    secrets: [],
    setup: [],
  })
  expect(parse(text).on.schedule).toEqual([
    { cron: '5 1 * * *', timezone: 'UTC' },
    { cron: '0 10 * * 0,6', timezone: 'UTC' },
  ])
})
