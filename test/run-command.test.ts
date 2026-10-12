import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/cli/run.js'
import { runsDir } from '../src/config/paths.js'

vi.mock('../src/providers/index.js', async () => {
  const { fakeProvider } = await import('./fakes/provider.js')
  return { providers: { claude: fakeProvider('claude') } }
})
vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    runsDir: `${state}/runs`,
    attemptsPath: `${state}/attempts.json`,
    skipsPath: `${state}/skips.json`,
  }
})

async function run(...args: string[]) {
  const config = join(await mkdtemp(join(tmpdir(), 'awaywork-run-')), 'config.yml')
  await writeFile(config, 'providers: [claude]\nsources: { chores: { command: exit 1 } }\n')
  const out: string[] = []
  const print = (...line: unknown[]) => void out.push(line.join(' '))
  vi.spyOn(console, 'log').mockImplementation(print)
  vi.spyOn(console, 'error').mockImplementation(print)
  const program = new Command().option('--config <path>')
  runCommand(program)
  await program.parseAsync(['--config', config, 'run', ...args], { from: 'user' })
  return out
}

describe('run command', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('dates its start and shows a failed source in its output and the report', async () => {
    const out = await run()
    expect(out[0]).toMatch(/^awaywork run at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    expect(out[1]).toMatch(/^warning: source chores: Command failed with exit code 1/)
    const [id = ''] = await readdir(runsDir)
    const report = await readFile(join(runsDir, id, 'report.md'), 'utf8')
    expect(report).toMatch(/\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d to \S+ \S+, local time\n/)
    expect(report).toContain('## Warnings\n\n- source chores: Command failed with exit code 1')
  })

  it('refuses a unit not in the plan in one line, leaving no run dir', async () => {
    const before = existsSync(runsDir) ? await readdir(runsDir) : []
    const out = await run('--unit', 'nope')
    expect(out.at(-1)).toBe(`no unit "nope" in this run's plan; awaywork plan lists them`)
    expect(process.exitCode).toBe(1)
    expect(existsSync(runsDir) ? await readdir(runsDir) : []).toEqual(before)
  })
})
