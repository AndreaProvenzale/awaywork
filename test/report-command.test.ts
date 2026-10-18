import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printReport } from '../src/cli/run.js'
import { remoteDir, runsDir } from '../src/config/paths.js'

vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    runsDir: `${state}/runs`,
    remoteDir: `${state}/remote`,
  }
})

const report = (id: string, units: string[]) =>
  [
    `# Awaywork ${id}`,
    '',
    '## Units',
    '',
    '| # | Unit | Skill | Provider | Status | Result |',
    '|---|---|---|---|---|---|',
    ...units.map((result, i) => `| ${i + 1} | u${i} | fix | claude | done | ${result} |`),
    '',
  ].join('\n')

const pr = 'https://github.com/acme/api/pull/7 (2 commits)'

async function localRun(id: string, units: string[]) {
  await mkdir(join(runsDir, id), { recursive: true })
  await writeFile(join(runsDir, id, 'report.md'), report(id, units))
}

/** A control repo with the given workflow files, answering git and gh like the real ones. */
async function controlRepo(files: string[], artifacts: string, fail?: RegExp) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-control-'))
  await mkdir(join(root, '.github/workflows'), { recursive: true })
  for (const file of files) await writeFile(join(root, '.github/workflows', file), 'name: x\n')
  const calls: string[] = []
  const run = async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (fail?.test(line))
      throw Object.assign(new Error('Command failed'), {
        stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating',
      })
    if (line === 'git rev-parse --show-toplevel') return root
    if (line.startsWith('gh repo view')) return 'acme/control'
    if (line.startsWith('gh api --paginate repos/acme/control/actions/artifacts')) return artifacts
    if (line.startsWith('gh run download')) {
      const id = (args[args.indexOf('-n') + 1] ?? '').slice(-15)
      await writeFile(join(args[args.indexOf('-D') + 1] ?? '', 'report.md'), report(id, [pr]))
      return ''
    }
    throw new Error(`unexpected: ${line}`)
  }
  return Object.assign(run, { calls })
}

function output() {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...line) => void out.push(line.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...line) => void err.push(line.join(' ')))
  return { out, err }
}

describe('report command', () => {
  beforeEach(async () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    await rm(runsDir, { recursive: true, force: true })
    await rm(remoteDir, { recursive: true, force: true })
    await localRun('20261013-220000', [pr, 'report below'])
    await localRun('20261015-220000', ['report below'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = undefined
  })

  it("prints the latest run's report.json with --json, and says so when a run has none", async () => {
    await writeFile(join(runsDir, '20261015-220000', 'report.json'), '{"runId":"20261015-220000"}')
    const run = await controlRepo([], '')
    const { out, err } = output()
    await printReport(undefined, false, run, true)
    expect(out).toEqual(['{"runId":"20261015-220000"}'])

    await printReport('20261013-220000', false, run, true)
    expect(err).toEqual([`no JSON report for run 20261013-220000 in ${runsDir}`])
    expect(process.exitCode).toBe(1)
  })

  it("lists local runs and the control repo's uploaded ones in one list, newest first", async () => {
    const run = await controlRepo(
      ['awaywork.yml'],
      [
        'awaywork-20261014-223527\t11',
        'awaywork-20261016-010203\t12',
        'ci-20261016-020000\t13',
        'coverage\t14',
      ].join('\n'),
    )
    const { out, err } = output()
    await printReport(undefined, true, run)
    expect(out).toEqual([
      '20261016-010203  1 units, 1 draft PRs, 0 reports  (github: awaywork)',
      '20261015-220000  1 units, 0 draft PRs, 1 reports',
      '20261014-223527  1 units, 1 draft PRs, 0 reports  (github: awaywork)',
      '20261013-220000  2 units, 1 draft PRs, 1 reports',
    ])
    expect(err).toEqual([])
    expect(run.calls).toContainEqual(
      expect.stringMatching(
        /^gh run download 12 -R acme\/control -n awaywork-20261016-010203 -D \S+$/,
      ),
    )
    expect(run.calls.join('\n')).not.toContain('ci-')
  })

  it('prints the newest run of either, from the cache once downloaded', async () => {
    const run = await controlRepo(['awaywork.yml'], 'awaywork-20261016-010203\t12')
    const { out } = output()
    await printReport(undefined, false, run)
    await printReport('20261016-010203', false, run)
    expect(out).toEqual([report('20261016-010203', [pr]), report('20261016-010203', [pr])])
    expect(run.calls.filter((c) => c.startsWith('gh run download'))).toHaveLength(1)
  })

  it('warns once and goes on with the local runs when GitHub fails', async () => {
    const run = await controlRepo(['awaywork.yml'], '', /^gh api/)
    const { out, err } = output()
    await printReport(undefined, true, run)
    await printReport(undefined, false, run)
    const warning =
      'warning: runs on GitHub left out: HTTP 401: Bad credentials (https://api.github.com/graphql)'
    expect(err).toEqual([warning, warning])
    expect(out).toEqual([
      '20261015-220000  1 units, 0 draft PRs, 1 reports',
      '20261013-220000  2 units, 1 draft PRs, 1 reports',
      report('20261015-220000', ['report below']),
    ])
    expect(process.exitCode).toBeUndefined()
  })

  it('points a run without a report at the step that is working', async () => {
    const step = async (name: string, at: number) => {
      const dir = join(runsDir, '20261016-220000', 'units', 'api-1', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'worker.log'), 'x')
      await utimes(join(dir, 'worker.log'), at, at)
      return join(dir, 'worker.log')
    }
    await step('1-implement', 100)
    const log = await step('2-review', 200)
    const { out, err } = output()
    await printReport('20261016-220000', false, async () => '')
    expect(err).toEqual([expect.stringContaining('no report for run 20261016-220000')])
    expect(out).toEqual([
      'Done so far: api-1/1-implement',
      'Running (or cut short): api-1/2-review',
      `Its stream: ${log}`,
    ])
  })

  it('falls back to the newest local run when the download fails', async () => {
    const run = await controlRepo(['awaywork.yml'], 'awaywork-20261016-010203\t12', /download/)
    const { out, err } = output()
    await printReport(undefined, false, run)
    expect(err).toHaveLength(1)
    expect(out).toEqual([report('20261015-220000', ['report below'])])
  })

  it('calls no gh without an awaywork workflow, nor for a local run asked by id', async () => {
    const run = await controlRepo(['ci.yml'], '')
    const { out } = output()
    await printReport(undefined, true, run)
    expect(out).toHaveLength(2)
    expect(run.calls).toEqual(['git rev-parse --show-toplevel'])
    const repo = await controlRepo(['awaywork.yml'], '')
    await printReport('20261013-220000', false, repo)
    expect(repo.calls).toEqual([])
  })
})
