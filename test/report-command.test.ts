import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { printReport } from '#cli/commands/run'
import { fromScreenJson } from '#cli/tui/triage'
import { pausePath, remoteDir, runsDir } from '#config/paths'
import { reportJson } from '#format/json'
import { clearPause, savePause } from '#plan/pause'
import type { RunReport, StepFiles } from '#posts/report'
import { githubPr } from './fakes/items'

vi.mock('#config/paths', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('#config/paths')>()),
    runsDir: `${state}/runs`,
    remoteDir: `${state}/remote`,
    pausePath: `${state}/pause.json`,
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
    const written = { runId: '20261015-220000', plan: { units: [], skipped: [] }, results: [] }
    await writeFile(join(runsDir, written.runId, 'report.json'), JSON.stringify(written))
    const run = await controlRepo([], '')
    const { out, err } = output()
    await printReport(undefined, false, run, true)
    expect(JSON.parse(out.join('\n'))).toEqual({ ...written, warnings: [] })

    await printReport('20261013-220000', false, run, true)
    expect(err).toEqual([`no JSON report for run 20261013-220000 in ${runsDir}`])
    expect(process.exitCode).toBe(1)
  })

  it('passes over a run with no report.json on a bare --json, and only there', async () => {
    const written = { runId: '20261013-220000', plan: { units: [], skipped: [] }, results: [] }
    await writeFile(join(runsDir, written.runId, 'report.json'), JSON.stringify(written))
    const going = '20261016-220000'
    await mkdir(join(runsDir, going), { recursive: true })
    const run = await controlRepo([], '')
    const { out, err } = output()
    await printReport(undefined, false, run, true)
    expect(JSON.parse(out.join('\n'))).toEqual({ ...written, warnings: [] })
    expect(process.exitCode).toBeUndefined()

    await printReport(going, false, run, true)
    await printReport(undefined, false, run)
    expect(err).toEqual([
      `no JSON report for run ${going} in ${runsDir}`,
      `no report for run ${going} in ${runsDir}`,
    ])

    out.length = 0
    await printReport(undefined, true, run)
    expect(out[0]).toBe(`${going}  no report`)
  })

  it('passes over a run with no report.json on bare --unit and --skipped, as on --json', async () => {
    const skipped = [
      { item: { source: 'chores', key: 'CH-1', title: 'Chore' }, kind: 'over_cap', reason: 'cap' },
    ]
    const written = { runId: '20261013-220000', plan: { units: [], skipped }, results: [] }
    await writeFile(join(runsDir, written.runId, 'report.json'), JSON.stringify(written))
    await mkdir(join(runsDir, '20261016-220000'), { recursive: true })
    const run = await controlRepo([], '')
    const { out, err } = output()
    await printReport(undefined, false, run, false, { skipped: true })
    expect(out.join('\n')).toContain('CH-1')
    await printReport(undefined, false, run, false, { unit: '9' })
    expect(err).toEqual([`no unit "9" in run ${written.runId}; awaywork report lists them`])
  })

  it('says none has finished on bare --unit and --skipped when no run has a report.json', async () => {
    const { err } = output()
    await printReport(undefined, false, await controlRepo([], ''), false, { unit: '1' })
    expect(err).toEqual([
      'no finished run yet: run 20261015-220000 is going, or stopped without a report',
    ])
  })

  it('says none has finished on a bare --json when no run has a report.json', async () => {
    const { out, err } = output()
    await printReport(undefined, false, await controlRepo([], ''), true)
    expect(err).toEqual([
      'no finished run yet: run 20261015-220000 is going, or stopped without a report',
    ])
    expect(out).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it("reads back what run wrote: each unit's summary, files and links, and why items were skipped", async () => {
    const [done, skipped] = [githubPr(1), githubPr(2)]
    const planned = { unit: { id: 'acme-api-1', items: [done] } }
    const result = {
      planned,
      status: 'done',
      outcome: { kind: 'none', reason: 'no commits' },
      summary: 'No code changes: the red check is flaky.',
      files: {
        log: 'units/acme-api-1/1-fix/worker.log',
        sliceBody: 'units/acme-api-1/out/pr.md',
      } satisfies StepFiles,
    }
    const waiting = { item: githubPr(3), kind: 'waiting_for_review', reason: 'r' }
    const plan = {
      units: [planned],
      skipped: [{ item: skipped, kind: 'no_rule', reason: 'r' }, waiting],
    }
    const run = { runId: '20261015-220000', plan, results: [result] } as unknown as RunReport
    await writeFile(join(runsDir, run.runId, 'report.json'), reportJson(run))
    const { out } = output()
    await printReport(run.runId, false, await controlRepo([], ''), true)
    const json = JSON.parse(out.join('\n'))
    expect(json.results[0]).toEqual({
      ...result,
      planned: {
        unit: {
          id: 'acme-api-1',
          items: [{ source: 'github', key: 'acme/api#1', title: 'PR 1', url: done.url }],
        },
      },
    })
    expect(json.plan.skipped[0]).toMatchObject({ kind: 'no_rule', item: { key: 'acme/api#2' } })
    expect(json.plan.skipped[0]).not.toHaveProperty('needsYou')
    expect(json.plan.skipped[1]).toMatchObject({ kind: 'waiting_for_review', needsYou: true })
  })

  it('flags what needs you in a report.json an older awaywork wrote without needsYou', async () => {
    const item = (n: number) => ({ source: 'github', key: `acme/api#${n}`, title: `PR ${n}` })
    const skipped = [
      { item: item(1), kind: 'no_rule', reason: 'r' },
      { item: item(2), kind: 'no_repo', reason: 'r' },
    ]
    const old = { runId: '20261015-220000', plan: { units: [], skipped }, results: [] }
    await writeFile(join(runsDir, old.runId, 'report.json'), JSON.stringify(old))
    const { out } = output()
    await printReport(old.runId, false, await controlRepo([], ''), true)
    const json = JSON.parse(out.join('\n'))
    expect(json.plan.skipped).toEqual([skipped[0], { ...skipped[1], needsYou: true }])
  })

  it('prints a run from its report.json, one unit with the files still there, or its skips', async () => {
    const item = githubPr(1)
    const planned = { unit: { id: 'acme-api-1', skill: 'fix', items: [item] } }
    const files = {
      log: 'units/acme-api-1/1-fix/worker.log',
      sliceBody: 'units/acme-api-1/out/pr.md',
    }
    const result = {
      planned,
      status: 'done',
      outcome: { kind: 'none', reason: 'no commits' },
      summary: 'No code changes: the red check is flaky.',
      files,
    }
    const plan = {
      queue: [],
      units: [planned],
      allowances: {},
      skipped: [{ item: githubPr(2), kind: 'over_cap', reason: 'over the cap: limits.units is 1' }],
    }
    const id = '20261015-220000'
    const run = { runId: id, startedAt: 0, finishedAt: 0, plan, results: [result], quotas: {} }
    await writeFile(join(runsDir, id, 'report.json'), reportJson(run as unknown as RunReport))
    await mkdir(join(runsDir, id, 'units/acme-api-1/out'), { recursive: true })
    const body = '# Flaky upload test\n\nNo code changes: the red check is flaky.\n'
    await writeFile(join(runsDir, id, files.sliceBody), body)
    const { out, err } = output()
    const gh = await controlRepo([], '')

    await printReport(id, false, gh)
    expect(out.join('\n')).toContain(
      '  1  api#1  fix    done    no commits\n     No code changes: the red check is flaky.',
    )
    expect(out.join('\n')).toContain('Skipped 1: 1 over_cap')

    out.length = 0
    await printReport(id, false, gh, false, { unit: 'acme/api#1' })
    expect(out.join('\n')).toBe(
      [
        '1  api#1  PR 1',
        '  skill   fix',
        '  status  done',
        '  result  no commits',
        '  item    https://github.com/acme/api/pull/1',
        `  files   ${join(runsDir, id, files.sliceBody)}`,
        '',
        body.trim(),
      ].join('\n'),
    )

    out.length = 0
    await printReport(id, false, gh, false, { skipped: 'over_cap' })
    expect(out).toEqual(['Skipped over_cap (1)\n  api#2: over the cap: limits.units is 1'])

    await printReport(id, false, gh, false, { unit: '2' })
    expect(err).toEqual([`no unit "2" in run ${id}; awaywork report lists them`])
    expect(process.exitCode).toBe(1)
  })

  it('says paused until the date atop a run while a pause is in force', async () => {
    const id = '20261015-220000'
    const run = {
      runId: id,
      startedAt: 0,
      finishedAt: 0,
      plan: { queue: [], units: [], allowances: {}, skipped: [] },
      results: [],
      quotas: {},
    }
    await writeFile(join(runsDir, id, 'report.json'), reportJson(run as unknown as RunReport))
    const { out } = output()
    await savePause(pausePath, { until: '2999-01-01' })
    try {
      await printReport(id, false, await controlRepo([], ''))
    } finally {
      await clearPause(pausePath)
    }
    expect(out.join('\n')).toContain('  paused until 2999-01-01 (awaywork resume to undo)')
  })

  it("prints a unit's worker.log or diff, saying so when it left none or the name fits two", async () => {
    const unit = (n: number, repo: string, files: StepFiles) => ({
      planned: {
        unit: { id: `u${n}`, skill: 'fix', items: [{ ...githubPr(n), key: `${repo}#1` }] },
      },
      status: 'done',
      outcome: { kind: 'none', reason: 'no commits' },
      files,
    })
    const results = [
      unit(1, 'acme/api', { log: 'units/u1/1-fix/worker.log', diff: 'units/u1/1-fix/diff.patch' }),
      unit(2, 'other/api', { log: 'units/u2/1-fix/worker.log' }),
    ]
    const plan = { units: results.map((r) => r.planned), skipped: [] }
    const id = '20261015-220000'
    const run = { runId: id, plan, results } as unknown as RunReport
    await writeFile(join(runsDir, id, 'report.json'), reportJson(run))
    await mkdir(join(runsDir, id, 'units/u1/1-fix'), { recursive: true })
    await writeFile(join(runsDir, id, 'units/u1/1-fix/worker.log'), 'the log')
    await writeFile(join(runsDir, id, 'units/u1/1-fix/diff.patch'), 'the diff')
    let written = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      written += s
      return true
    })
    const { err } = output()
    const gh = await controlRepo([], '')

    await printReport(id, false, gh, false, { unit: '1', log: true })
    await printReport(id, false, gh, false, { unit: 'u1', diff: true })
    expect(written).toBe('the logthe diff')
    expect(process.exitCode).toBeUndefined()

    await printReport(id, false, gh, false, { unit: '2', diff: true })
    await printReport(id, false, gh, false, { unit: '2', log: true })
    await printReport(id, false, gh, false, { unit: 'api#1', log: true })
    expect(err).toEqual([
      `unit 2 of run ${id} left no diff`,
      `unit 2 of run ${id} left no worker.log`,
      expect.stringMatching(/^"api#1" names 2 items; pick one:\n/),
    ])
    expect(written).toBe('the logthe diff')
    expect(process.exitCode).toBe(1)
  })

  it("prints the view as JSON with --screen, a unit's text and files by its number for the laptop to fetch", async () => {
    const planned = { unit: { id: 'acme-api-1', skill: 'fix', items: [githubPr(1)] } }
    const files = {
      log: 'units/acme-api-1/1-fix/worker.log',
      diff: 'units/acme-api-1/x.patch',
      report: 'units/acme-api-1/1-fix/report.md',
    }
    const result = { planned, status: 'done', outcome: { kind: 'none', reason: 'r' }, files }
    const id = '20261015-220000'
    const skipped = [{ item: githubPr(2), kind: 'no_rule', reason: 'no rule takes it' }]
    const plan = { queue: [], units: [planned], allowances: {}, skipped }
    const run = { runId: id, startedAt: 0, finishedAt: 0, plan, results: [result], quotas: {} }
    await writeFile(join(runsDir, id, 'report.json'), reportJson(run as unknown as RunReport))
    await mkdir(join(runsDir, id, 'units/acme-api-1/1-fix'), { recursive: true })
    await writeFile(join(runsDir, id, files.log), 'the log')
    const huge = 'x'.repeat(5_000_000)
    await writeFile(join(runsDir, id, files.report), huge)
    const { out } = output()
    await printReport(undefined, false, await controlRepo([], ''), false, { screen: true })
    const printed = out.join('\n')
    expect(printed.length).toBeLessThan(100_000)
    const screen = fromScreenJson(printed, 30)
    expect(screen?.run).toBe(id)
    const [unit, skip] =
      screen?.state.sections.flatMap((s) => s.children ?? []).flatMap((g) => g.children ?? []) ?? []
    expect(unit?.act).toMatchObject({ unit: '1', log: '1' })
    expect(unit?.act?.read).toBeUndefined()
    expect(unit?.act?.diff).toBeUndefined()
    expect(skip?.act?.read).toContain('no rule takes it')
    out.splice(0)
    await printReport(id, false, await controlRepo([], ''), false, { unit: '1' })
    expect(out.join('\n')).toContain(huge)
  })

  it('prints report.md for a run without report.json, which --unit needs', async () => {
    const { out, err } = output()
    await printReport('20261013-220000', false, await controlRepo([], ''))
    expect(out).toEqual([report('20261013-220000', [pr, 'report below'])])
    await printReport('20261013-220000', false, await controlRepo([], ''), false, { unit: '1' })
    expect(err).toEqual(['run 20261013-220000 has no report.json, which --unit and --skipped read'])
    expect(process.exitCode).toBe(1)
  })

  it('prints only the error with --json for a run with steps but no report.json', async () => {
    const step = join(runsDir, '20261015-220000', 'units', 'u0', 'fix')
    await mkdir(step, { recursive: true })
    await writeFile(join(step, 'worker.log'), '')
    const { out, err } = output()
    await printReport('20261015-220000', false, await controlRepo([], ''), true)
    expect(err).toEqual([`no JSON report for run 20261015-220000 in ${runsDir}`])
    expect(out).toEqual([])
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
      '20261016-010203  1 unit, 1 draft PR, 0 reports  (github: awaywork)',
      '20261015-220000  1 unit, 0 draft PRs, 1 report',
      '20261014-223527  1 unit, 1 draft PR, 0 reports  (github: awaywork)',
      '20261013-220000  2 units, 1 draft PR, 1 report',
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
      '20261015-220000  1 unit, 0 draft PRs, 1 report',
      '20261013-220000  2 units, 1 draft PR, 1 report',
      report('20261015-220000', ['report below']),
    ])
    expect(process.exitCode).toBeUndefined()
  })

  it('leaves the screen before saying there are no runs, with the warnings it held', async () => {
    await rm(runsDir, { recursive: true, force: true })
    const run = await controlRepo(['awaywork.yml'], '', /^gh api/)
    const { err } = output()
    const screen = {
      progress: () => {},
      browse: async () => {},
      close: () => void err.push('closed'),
    }
    const commands = {
      skip: async () => '',
      approve: async () => '',
      log: async () => '',
      diff: async () => '',
    }
    await printReport(undefined, false, run, false, { browse: { screen, commands } })
    expect(err).toEqual([
      'closed',
      'warning: runs on GitHub left out: HTTP 401: Bad credentials (https://api.github.com/graphql)',
      `no runs in ${runsDir}`,
    ])
    expect(process.exitCode).toBe(1)
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
