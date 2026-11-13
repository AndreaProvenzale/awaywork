import { listedRun } from '../../src/cli/commands/run.js'
import { jobLines, wontRun } from '../../src/cli/commands/schedule.js'
import { findChains, formatUnit } from '../../src/cli/format/report.js'
import { configPath, parseConfig } from '../../src/config/load.js'
import { stateDir } from '../../src/config/paths.js'
import { builtinSkills } from '../../src/core/skills.js'
import type { Item } from '../../src/core/types.js'
import { planRun } from '../../src/plan/foreman.js'
import { nextPoll } from '../../src/plan/poll.js'
import { sourceFailure, sourceWarning } from '../../src/plan/probe.js'
import { describeSkip } from '../../src/plan/skips.js'
import { formatReport, type RunReport, type UnitResult } from '../../src/posts/report.js'
import { providerFor } from '../../src/providers/index.js'
import { allowance } from '../../src/quota/budget.js'
import {
  daemonLines,
  failedPoll,
  queuedLine,
  recoveredPoll,
  runStarted,
  stamped,
  watchStarted,
} from '../../src/run/daemon.js'
import { warningLine } from '../../src/run/execute.js'
import { noBoxToken, sshFailure, tokenRefused } from '../../src/run/remote.js'
import type { Outcome } from '../../src/worker/publish.js'

const command = (line: string, text: string) => `$ ${line}\n${text}`
const MINUTE = 60_000

/** As `run` prints a plan warning, a failed source's here: indented under its first line. */
function choresWarning(): string {
  const e = Object.assign(new Error('Command failed with exit code 1: ./chores.sh'), {
    stderr: [
      'file:///HOME/chores/chores.mjs:3',
      'Error: CHORES_TOKEN is not set',
      '    at file:///HOME/chores/chores.mjs:3:9',
      'Node.js v22.20.0',
    ].join('\n'),
  })
  return warningLine(sourceWarning('chores', e))
}

const config = parseConfig(
  'providers: [claude: {}]\nrepos: { acme/*: {} }\nsources: { github: {} }\nqueue: [{ skill: fix }]',
)

const pr = (n: number): Item => ({
  source: 'github',
  id: String(n),
  key: `acme/api#${n}`,
  type: 'pr',
  title: `PR ${n}`,
  description: '',
  url: `https://github.com/acme/api/pull/${n}`,
  status: 'open',
  reviewers: [],
  labels: [],
  comments: [],
  linkedPrs: [
    {
      repo: 'acme/api',
      number: n,
      url: `https://github.com/acme/api/pull/${n}`,
      branch: `feature-${n}`,
      ours: false,
      mine: true,
      trusted: true,
      fork: false,
    },
  ],
  fields: { repo: 'acme/api', mine: true, checks: 'failing', unresolved_threads: 0 },
  mine: true,
  raw: null,
})

/** A run's report.md, as `report --list` counts it, its units planned from `items`. */
function report(runId: string, items: Item[], outcomes: (Outcome | undefined)[]): string {
  const plan = planRun({
    config,
    items,
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const results = plan.units.map(
    (planned, i): UnitResult => ({
      planned,
      provider: 'claude',
      status: outcomes[i] ? 'done' : 'failed',
      outcome: outcomes[i],
    }),
  )
  const at = new Date('2026-10-15T16:00:12Z')
  return formatReport({
    runId,
    dryRun: false,
    startedAt: at,
    finishedAt: at,
    plan,
    results,
    quotas: {},
  })
}

/** `report --list` in a control repo: an uploaded run, tagged with its workflow, then a local one. */
function reportList(): string {
  const draft = (n: number): Outcome => ({
    kind: 'pr',
    url: `https://github.com/acme/api/pull/${n + 100}`,
    commits: 2,
    head: 'abc123',
  })
  const reported: Outcome = { kind: 'report', text: 'Looks fine.' }
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(pr)
  const outcomes = [draft(1), draft(2), draft(3), reported, reported]
  return [
    '$ awaywork report --list',
    listedRun('20261015-160012', report('20261015-160012', items, outcomes), {
      workflow: 'awaywork',
    }),
    listedRun('20261012-203418', report('20261012-203418', [], [])),
  ].join('\n')
}

/** What install says of Codex on a GitHub-hosted runner. */
const codexHosted = () =>
  wontRun(
    'codex',
    'this workflow',
    providerFor('codex', {})?.unavailable?.({ RUNNER_ENVIRONMENT: 'github-hosted' }) ?? '',
  )

/** `schedule status` under launchd, a soon run in progress and a source backing off. */
function scheduleStatus(): string {
  const job = {
    command: ['/usr/local/bin/awaywork', 'watch', '--config', configPath()],
    path: '/HOME/Library/LaunchAgents/awaywork.plist',
    log: `${stateDir}/schedule.log`,
  }
  const daemon = daemonLines(
    {
      pid: 67014,
      since: '2026-10-25T17:26:00Z',
      config: configPath(),
      runs: [{ trigger: 'soon', runId: '20261025-162625' }],
      polls: { flaky: { next: Date.parse('2026-10-25T17:30:00Z'), failures: 1 } },
    },
    [],
    new Date('2026-10-25T17:28:00Z'),
  )
  return command('awaywork schedule status', [...jobLines('launchd', job), ...daemon].join('\n'))
}

/** watch.log: chores' item comes in, then the reply on it at chores' next poll; flaky fails once, backing off. */
function watchLog(): string {
  const start = new Date('2026-10-25T16:17:51Z')
  const flakyEvery = 2 * MINUTE
  const e = new Error('Command failed with exit code 1: ./flaky.sh')
  const flakyNext = nextPoll(flakyEvery, start.getTime(), { failures: 1 }).next
  const choresNext = nextPoll(5 * MINUTE, start.getTime()).next
  return [
    stamped(start, watchStarted(27290, configPath())),
    stamped(start, failedPoll('flaky', flakyNext, sourceFailure(e).split('\n')[0] ?? '', false)),
    stamped(start, runStarted({ trigger: 'soon', runId: '20261025-151751', soon: soon() })),
    '[...]',
    stamped(new Date(flakyNext), recoveredPoll('flaky', flakyEvery)),
    stamped(
      new Date(choresNext),
      runStarted({ trigger: 'soon', runId: '20261025-152200', soon: soon() }),
    ),
  ].join('\n')
}

const soon = () => ({ sources: ['chores'], units: ['ch-1'] })

const remoteRunId = '20261104-220657'

/** The run the daemon queued for CH-1 as the container reports it: a stand-in agent's plan. */
function remoteReport(): RunReport {
  const choresConfig = parseConfig(
    'providers: [claude: {}]\nrepos: { acme/chores: {} }\nsources: { chores: { command: ./chores.sh } }\nqueue: [{ skill: plan }]',
  )
  const ch1: Item = {
    source: 'chores',
    id: 'CH-1',
    key: 'CH-1',
    type: 'task',
    title: 'Write a hello report',
    description: '',
    url: '',
    status: 'open',
    reviewers: [],
    labels: [],
    comments: [],
    linkedPrs: [],
    fields: { repo: 'acme/chores' },
    mine: true,
    raw: null,
  }
  const plan = planRun({
    config: choresConfig,
    items: [ch1],
    allowances: { claude: allowance(choresConfig.budget, null, 0, choresConfig.windows) },
    skills: { builtin: builtinSkills },
  })
  const at = new Date('2026-11-04T22:06:57Z')
  return {
    runId: remoteRunId,
    dryRun: false,
    startedAt: at,
    finishedAt: at,
    plan,
    results: plan.units.map((planned) => ({
      planned,
      provider: 'claude',
      status: 'done',
      outcome: { kind: 'report', text: 'Hello from the stand-in agent, as awaywork' },
      files: { log: 'units/ch-1/1-plan/worker.log', report: 'units/ch-1/1-plan/report.md' },
    })),
    quotas: {},
  }
}

/** `report --unit CH-1` from the laptop: its title, status and first file, the rest cut as the doc does. */
function remoteUnit(): string {
  const report = remoteReport()
  const [found] = findChains(report, 'CH-1')
  if (!found) throw new Error('no CH-1 in the remote run')
  const runDir = `/home/away/.local/state/awaywork/runs/${remoteRunId}`
  const files = Object.values(found.chain.head.files ?? {}).map((f) => `${runDir}/${f}`)
  const outcome = found.chain.head.outcome
  const body = outcome && 'text' in outcome ? outcome.text : undefined
  const lines = formatUnit(found, files, body, true).split('\n')
  const status = lines.findIndex((line) => line.trimStart().startsWith('status'))
  const file = lines.findIndex((line) => line.trimStart().startsWith('files'))
  const value = (lines[file] ?? '').indexOf('/')
  return [
    lines[0],
    lines[status],
    lines[file],
    `${' '.repeat(value)}[...]`,
    ...lines.slice(lines.indexOf('')),
  ].join('\n')
}

/** Against the image over HTTP: a one-off run queued, a skip, and the run's report of it. */
function remoteRun(): string {
  return [
    command('awaywork run --unit CH-1', queuedLine('CH-1', remoteRunId, false)),
    command(
      'awaywork skip chores:CH-1 --until 2030-01-01',
      describeSkip('chores:CH-1', { until: '2030-01-01' }),
    ),
    command(`awaywork report ${remoteRunId} --unit CH-1`, remoteUnit()),
  ].join('\n')
}

/** Over ssh: an unknown host key, no awaywork on the box's PATH, no token there, a stale token. */
function sshErrors(): string {
  const box = 'ssh://box'
  return [
    command(
      'awaywork report',
      sshFailure('ssh://dev@127.0.0.1:2222', 255, 'Host key verification failed.\r\n') ?? '',
    ),
    command(
      'awaywork report',
      sshFailure(box, 127, "env: 'awaywork': No such file or directory\n") ?? '',
    ),
    command('awaywork run --unit CH-1', noBoxToken(box, '/home/dev/.config/awaywork/env')),
    command('awaywork report --list', tokenRefused('http://127.0.0.1:7480', box)),
  ].join('\n')
}

export default {
  'schedule-source-warning': choresWarning(),
  'schedule-report-list': reportList(),
  'schedule-codex-hosted': codexHosted(),
  'schedule-status': scheduleStatus(),
  'schedule-watch-log': watchLog(),
  'schedule-remote-run': remoteRun(),
  'schedule-ssh-errors': sshErrors(),
}
