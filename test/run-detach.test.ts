import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'

const chore = (n: number) => ({
  id: String(n),
  key: `CH-${n}`,
  title: `Chore ${n}`,
  url: `https://e.com/${n}`,
  fields: { repo: 'no-such-owner-awaywork/none' },
})

const quota = () => ({
  windows: [
    {
      name: '7d',
      span: 'long',
      used: 0.1,
      resetsAt: Math.floor(Date.now() / 1000) + 86_400,
      minutes: 10_080,
    },
  ],
})

/** A home of its own, holding the config and the run state, with one provider and two chores. */
async function home(provider = 'probe: ./quota.sh', extra = '') {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-detach-'))
  await writeFile(join(dir, 'items.json'), JSON.stringify([chore(1), chore(2)]))
  await writeFile(
    join(dir, 'quota.sh'),
    `#!/bin/sh\necho probed >> probes\necho '${JSON.stringify(quota())}'\n`,
    { mode: 0o755 },
  )
  await writeFile(
    join(dir, 'config.yml'),
    `providers:\n  - mine:\n      command: echo worked\n      ${provider}\nlimits: { unit_minutes: 5, units: 1 }\nwindows: []\nsources: { chores: { command: cat items.json } }\nqueue: [{ skill: plan }]\n${extra}`,
  )
  return dir
}

/** The real CLI, from source, against that home and none of this machine's logins. */
const cli = (dir: string, ...args: string[]) =>
  execa(
    process.execPath,
    [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      '--import',
      './scripts/ts-resolve.mjs',
      'src/cli/index.ts',
      ...args,
    ],
    {
      reject: false,
      env: {
        HOME: dir,
        AWAYWORK_CONFIG: join(dir, 'config.yml'),
        AWAYWORK_REMOTE: '',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        GITHUB_OUTPUT: '',
        GITHUB_ACTIONS: '',
        RUNNER_ENVIRONMENT: '',
      },
    },
  )

const stateOf = (dir: string) => join(dir, '.local', 'state', 'awaywork')
const runsOf = (dir: string) => readdir(join(stateOf(dir), 'runs')).catch(() => [] as string[])

describe('run --unit --detach', () => {
  it('refuses without --unit', async () => {
    const dir = await home()
    const { exitCode, stderr } = await cli(dir, 'run', '--detach')
    expect([exitCode, stderr]).toEqual([1, '--detach needs --unit <id>'])
    expect(await runsOf(dir)).toEqual([])
  })

  it('says why it can not start, on one probe, and leaves no run behind', async () => {
    const dir = await home()
    const { exitCode, stderr } = await cli(dir, 'run', '--unit', 'CH-9', '--detach')
    expect([exitCode, stderr]).toEqual([
      1,
      `no unit "CH-9" in this run's plan; awaywork plan lists them`,
    ])
    expect(await runsOf(dir)).toEqual([])
    expect(await readFile(join(dir, 'probes'), 'utf8')).toBe('probed\n')
  })

  it('refuses a unit with no provider, which a foreground run would only skip', async () => {
    const dir = await home('skills_dir: .agents/skills')
    const { exitCode, stderr } = await cli(dir, 'run', '--unit', 'CH-1', '--detach')
    expect(exitCode).toBe(1)
    expect(stderr).toBe('no provider left: mine sits out a present run (no quota reading)')
    expect(await runsOf(dir)).toEqual([])
  })

  it('refuses while another run holds the lock, and on a broken config', async () => {
    const dir = await home()
    await mkdir(stateOf(dir), { recursive: true })
    await writeFile(join(stateOf(dir), 'run.lock'), `${process.pid} 20261025-010000`)
    const held = await cli(dir, 'run', '--unit', 'CH-1', '--detach')
    expect(held.exitCode).toBe(1)
    expect(held.stderr).toMatch(/^already running \(pid \d+, run 20261025-010000\)/)
    expect(await runsOf(dir)).toEqual([])

    await writeFile(join(dir, 'config.yml'), 'providers: [nope]\n')
    const broken = await cli(dir, 'run', '--unit', 'CH-1', '--detach')
    expect(broken.exitCode).toBe(1)
    expect(broken.stderr).toContain('config.yml')
    expect(await runsOf(dir)).toEqual([])
  })

  it('names the log when the run dies before it reports', async () => {
    const dir = await home()
    await writeFile(
      join(dir, 'config.yml'),
      (await readFile(join(dir, 'config.yml'), 'utf8')).replace('cat items.json', 'kill -9 $PPID'),
    )
    const { exitCode, stderr } = await cli(dir, 'run', '--unit', 'CH-1', '--detach')
    const [runId = ''] = await runsOf(dir)
    const log = join(stateOf(dir), 'runs', runId, 'run.log')
    expect(exitCode).toBe(1)
    expect(stderr).toBe(`the run stopped before it said whether CH-1 started; see ${log}`)
    expect(existsSync(log)).toBe(true)
  })

  it('starts a unit past the cap and returns while the run goes on without it', async () => {
    const dir = await home(
      'probe: ./quota.sh',
      `notify: { command: 'sleep 2; touch "$HOME/ended"' }\n`,
    )
    const started = await cli(dir, 'run', '--unit', 'CH-2', '--detach')
    expect(started.exitCode).toBe(0)
    expect(started.stderr).toBe('')
    const runId =
      /^Started CH-2 as run (\d{8}-\d{6}); awaywork report \1 shows it once it ends$/.exec(
        started.stdout,
      )?.[1]
    expect(runId).toBeDefined()
    expect(existsSync(join(dir, 'ended'))).toBe(false)

    const log = join(stateOf(dir), 'runs', runId as string, 'run.log')
    await vi.waitFor(() => expect(existsSync(join(dir, 'ended'))).toBe(true), { timeout: 12_000 })
    await vi.waitFor(() => expect(existsSync(join(stateOf(dir), 'run.lock'))).toBe(false), {
      timeout: 12_000,
    })
    expect(await readFile(log, 'utf8')).toContain('Report: ')
    expect(await readFile(join(dir, 'probes'), 'utf8')).toBe('probed\n')
  })
})
