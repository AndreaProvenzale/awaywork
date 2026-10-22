import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/cli/run.js'
import { runsDir } from '../src/config/paths.js'

vi.mock('../src/providers/index.js', async () => {
  const { fakeProvider } = await import('./fakes/provider.js')
  const providers = { claude: fakeProvider('claude') }
  return {
    providers,
    providerFor: (id: string) => providers[id as 'claude'],
    providersOf: () => providers,
  }
})
vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    runsDir: `${state}/runs`,
    attemptsPath: `${state}/attempts.json`,
    runLockPath: `${state}/run.lock`,
    skipsPath: `${state}/skips.json`,
  }
})

async function run(args: string[], chores = '{ command: exit 1 }', extra = '') {
  const config = join(await mkdtemp(join(tmpdir(), 'awaywork-run-')), 'config.yml')
  await writeFile(config, `providers: [claude]\nsources: { chores: ${chores} }\n${extra}`)
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...line) => void out.push(line.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...line) => void err.push(line.join(' ')))
  const program = new Command().option('--config <path>')
  runCommand(program)
  await program.parseAsync(['--config', config, 'run', ...args], { from: 'user' })
  return { out, err }
}

/** The latest run's files; runs in the same second share a dir, the latest writing last. */
async function latestRun() {
  const id = (await readdir(runsDir)).sort().at(-1) ?? ''
  const read = (file: string) => readFile(join(runsDir, id, file), 'utf8')
  return { report: await read('report.md'), plan: await read('plan.txt') }
}

describe('run command', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_OUTPUT', '')
    // CI's own hosted runner has no worker user.
    vi.stubEnv('RUNNER_ENVIRONMENT', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = undefined
  })

  it('dates its start and shows a failed source in its output and the report', async () => {
    const { out, err } = await run([])
    expect(out[0]).toMatch(/^awaywork run at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    expect(err[0]).toMatch(/^warning: source chores: Command failed with exit code 1/)
    const { report } = await latestRun()
    expect(report).toMatch(/\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d to \S+ \S+, local time\n/)
    expect(report).toContain('## Warnings (1)\n\n- source chores: Command failed with exit code 1')
  })

  it('writes the results as report.json next to report.md', async () => {
    await run([])
    const id = (await readdir(runsDir)).sort().at(-1) ?? ''
    const json = JSON.parse(await readFile(join(runsDir, id, 'report.json'), 'utf8'))
    expect(json.runId).toBe(id)
  })

  it("hands the run's id and dir to the next steps of an Actions job", async () => {
    const outputs = join(await mkdtemp(join(tmpdir(), 'awaywork-out-')), 'output')
    vi.stubEnv('GITHUB_OUTPUT', outputs)
    await run([])
    const id = (await readdir(runsDir)).sort().at(-1) ?? ''
    expect(await readFile(outputs, 'utf8')).toBe(`run-id=${id}\nrun-dir=${join(runsDir, id)}\n`)
  })

  it('refuses a unit not in the plan in one line, leaving no run dir', async () => {
    const before = existsSync(runsDir) ? await readdir(runsDir) : []
    const { err } = await run(['--unit', 'nope'])
    expect(err.at(-1)).toBe(`no unit "nope" in this run's plan; awaywork plan lists them`)
    expect(process.exitCode).toBe(1)
    expect(existsSync(runsDir) ? await readdir(runsDir) : []).toEqual(before)
  })

  it("masks a source's secret in its warning, the plan and the report", async () => {
    vi.stubEnv('CHORES_TOKEN', 's3cr3t-value')
    const { err } = await run(
      [],
      `{ command: 'echo "auth failed for $CHORES_TOKEN" >&2; exit 1', secrets: [CHORES_TOKEN] }`,
    )
    const { report, plan } = await latestRun()
    for (const text of [err.join('\n'), plan, report]) {
      expect(text).toContain('auth failed for ***')
      expect(text).not.toContain('s3cr3t-value')
    }
  })

  it('runs notify once with the run event and the morning report when the run ends', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-')), 'out.txt')
    const command = `echo "$AWAYWORK_EVENT $AWAYWORK_RUN_ID $AWAYWORK_REPORT" >> '${out}'`
    await run([], undefined, `notify: { command: ${JSON.stringify(command)} }\n`)
    const id = (await readdir(runsDir)).sort().at(-1) ?? ''
    expect(await readFile(out, 'utf8')).toBe(`run ${id} ${join(runsDir, id, 'report.md')}\n`)
  })

  it("masks the notify command's secret in its failure", async () => {
    vi.stubEnv('NOTIFY_TOKEN', 's3cr3t-value')
    const { err } = await run(
      [],
      undefined,
      `notify: { command: 'echo "posting with $NOTIFY_TOKEN" >&2; exit 1', secrets: [NOTIFY_TOKEN] }\n`,
    )
    expect(err.at(-1)).toMatch(/^notify failed: .*\nposting with \*\*\*$/s)
    expect(err.join('\n')).not.toContain('s3cr3t-value')
  })
})
