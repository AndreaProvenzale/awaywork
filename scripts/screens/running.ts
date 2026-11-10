import { join } from 'node:path'
import {
  brandHeader,
  findChains,
  formatPlan,
  formatQueue,
  formatRun,
  formatUnit,
  formatWhy,
  namedItems,
} from '../../src/cli/format.js'
import { detachedLine } from '../../src/cli/run.js'
import {
  loading,
  planTriage,
  ready,
  runTriage,
  type State,
  type UnitFiles,
  update,
  view,
} from '../../src/cli/triage.js'
import { parseConfig } from '../../src/config/load.js'
import { runsDir } from '../../src/config/paths.js'
import type { Allowance } from '../../src/core/budget.js'
import { type PlannedUnit, planRun, type RunPlan } from '../../src/core/foreman.js'
import { defaultRules } from '../../src/core/queue.js'
import { chains, type RunReport } from '../../src/core/report.js'
import { builtinSkills } from '../../src/core/skills.js'
import type { Item, PrRef } from '../../src/core/types.js'

const startedAt = new Date('2026-10-19T22:00:12Z')
const resetsAt = startedAt.getTime() / 1000 + 5 * 24 * 3600

function item(
  source: string,
  key: string,
  type: Item['type'],
  title: string,
  url: string,
  fields: Item['fields'] = {},
  linkedPrs: PrRef[] = [],
): Item {
  return {
    source,
    id: key,
    key,
    type,
    title,
    description: '',
    url,
    status: 'open',
    reviewers: [],
    labels: [],
    comments: [],
    linkedPrs,
    fields,
    ...(fields.mine === true && { mine: true }),
    raw: null,
  }
}

const prRef = (repo: string, n: number, mine: boolean): PrRef => ({
  repo,
  number: n,
  url: `https://github.com/${repo}/pull/${n}`,
  branch: `feature-${n}`,
  ours: false,
  mine,
  trusted: true,
  fork: false,
})

/** A PR as the GitHub source reads it: it links itself. */
function pr(repo: string, n: number, title: string, fields: Item['fields'] = {}): Item {
  const mine = fields.mine === true
  const url = `https://github.com/${repo}/pull/${n}`
  return item('github', `${repo}#${n}`, 'pr', title, url, { repo, mine, ...fields }, [
    prRef(repo, n, mine),
  ])
}

const issue = (repo: string, n: number, title: string, linked: PrRef[] = []) =>
  item(
    'github',
    `${repo}#${n}`,
    'issue',
    title,
    `https://github.com/${repo}/issues/${n}`,
    { repo },
    linked,
  )

const card = (key: string, title: string, column: string) =>
  item('tracker', key, 'task', title, `https://tracker.acme.dev/${key}`, { column })

const config = parseConfig(`
limits: { units_per_repo: 2 }
providers: [claude: {}]
sources:
  github: { repos: [acme/api, acme/web] }
  tracker: { command: ./tracker.sh, fields: [column] }
queue:
  - { skill: fix, where: { type: pr, mine: true } }
  - { skill: review, where: { type: pr, review_requested: true } }
  - { skill: implement, where: { type: issue } }
  - { skill: fix, where: { column: QA } }
`)

const items = [
  pr('acme/api', 1, 'Add rate limits to the public API', { mine: true }),
  pr('acme/web', 3, 'WIP: new billing page', { mine: true }),
  pr('acme/api', 2, 'Cache user sessions', { review_requested: true }),
  issue('acme/api', 5, 'Rate limit the public API', [prRef('acme/api', 1, true)]),
  issue('acme/api', 4, 'Paginate the audit log'),
  card('T-4', 'Export invoices as CSV', 'QA'),
  card('T-7', 'Onboarding emails', 'Backlog'),
]

function plan(claude: Allowance, present: boolean): RunPlan {
  const skills = { builtin: builtinSkills }
  const planned = planRun({
    config,
    items,
    allowances: { claude },
    skills,
    now: startedAt.getTime(),
  })
  return { ...planned, present }
}

const quota = (ceiling: number, stopAt: number, present: boolean): Allowance => ({
  kind: 'quota',
  window: 'seven_day',
  used: 0.05,
  resetsAt,
  ceiling,
  runs: 5,
  limits: [
    { name: 'pacing', value: ceiling },
    { name: 'reserve', value: 0.9 },
  ],
  session: { used: 0.02, stopAt, limit: present ? 'present_session_max' : 'session_max' },
})

const planned = plan(quota(0.257, 0.4, true), true)

/** A browsing screen after `keys`, under the brand, 100 columns wide so the doc's summary clips where it does. */
function browsed(state: State, keys: string[] = []): string {
  const start = ready(loading(brandHeader(true), ''), state)
  const end = keys.reduce((s, key) => update(s, key).state, start)
  return lines(view(end, 100, end.rows))
}

const reversed = '\u001b[27m'

// The selected row's reverse video ends at its text, so the doc's block keeps no trailing spaces.
const lines = (screen: string[]) =>
  screen
    .map((line) =>
      line.endsWith(reversed)
        ? `${line.slice(0, -reversed.length).trimEnd()}${reversed}`
        : line.trimEnd(),
    )
    .join('\n')
    .trimEnd()

const command = (line: string, text: string) => `$ ${line}\n${text}`

function planView(): string {
  return browsed(planTriage(planned, [], 29), ['G', 'right', 'down', 'right', 'down', 'down'])
}

/** The last lines of `plan` piped: how to dig in. */
const planHints = () => formatPlan(planned, [], true).split('\n').slice(-2).join('\n')

function planWhy(): string {
  const [t7] = namedItems(planned, 'T-7')
  return command('awaywork plan --why T-7', t7 ? formatWhy(planned, t7) : '')
}

/** `plan --rules` on the default queue, its third rule cut as the doc does. */
function planRules(): string {
  const listed = formatQueue(
    defaultRules(['github']),
    [
      pr('acme/api', 1, 'Add rate limits to the public API', {
        mine: true,
        checks: 'failing',
        unresolved_threads: 0,
      }),
      pr('acme/api', 2, 'Cache user sessions', { review_requested: true, trusted: true }),
      pr('acme/api', 3, 'Bump the SDK'),
    ],
    true,
  )
  const third = listed.findIndex((line) => line.startsWith('  #3'))
  const fourth = listed.findIndex((line) => line.startsWith('  #4'))
  return [...listed.slice(0, third), '  [...]', ...listed.slice(fourth)].join('\n')
}

const runId = '20261019-220012'

function run(): RunReport {
  const p = plan(quota(0.429, 0.9, false), false)
  const unit = (id: string) => p.units.find((u) => u.unit.id === id) as PlannedUnit
  return {
    runId,
    dryRun: false,
    startedAt,
    finishedAt: new Date('2026-10-19T23:47:40Z'),
    plan: p,
    results: [
      {
        planned: unit('acme-api-1'),
        provider: 'claude',
        status: 'done',
        turns: 14,
        outcome: { kind: 'pr', url: 'https://github.com/acme/api/pull/14', commits: 3, head: 'a' },
        summary:
          'Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a timeout.',
        files: { log: 'units/acme-api-1/1-fix/worker.log', sliceDiff: 'units/acme-api-1/out/diff' },
      },
      {
        planned: unit('acme-web-3'),
        provider: 'claude',
        status: 'done',
        turns: 9,
        outcome: { kind: 'none', reason: 'nothing' },
        summary:
          'No code changes: the red check is the visual diff job, which fails on main too since #212.',
        files: {
          log: 'units/acme-web-3/1-fix/worker.log',
          sliceBody: 'units/acme-web-3/out/pr.md',
        },
      },
      {
        planned: unit('acme-api-2'),
        provider: 'claude',
        status: 'done',
        turns: 6,
        outcome: { kind: 'report', text: 'Approve.' },
        verdict: 'approve',
        summary: 'Approve: the session cache keys on the user id and expires with the token.',
        files: { log: 'units/acme-api-2/1-review/worker.log' },
      },
    ],
    quotas: {
      claude: {
        windows: [
          { name: 'seven_day', span: 'long', used: 0.17, resetsAt },
          { name: 'five_hour', span: 'short', used: 0.31, resetsAt },
        ],
      },
    },
  }
}

const report = run()

const prBody = `Fix the billing page build

No code changes: the red check is the visual diff job, which fails on main too since #212.`

/** What `report` pages for each unit, as if its files were there. */
const unitFiles = (): UnitFiles[] =>
  chains(report).map((chain, i) => {
    const files = Object.values(chain.head.files ?? {}).map((f) => join(runsDir, runId, f))
    const body = chain.head.files?.sliceBody ? prBody : undefined
    return {
      text: formatUnit({ chain, n: i + 1 }, files, body, true),
      log: chain.head.files?.log && join(runsDir, runId, chain.head.files.log),
      diff: chain.head.files?.sliceDiff && join(runsDir, runId, chain.head.files.sliceDiff),
    }
  })

const reportState = (rows: number) => runTriage(report, [], unitFiles(), rows)

/** `report | cat`: its headline, then from the quota on, the units between cut as the doc does. */
function reportPiped(): string {
  const text = formatRun(report, [], true).split('\n')
  const quota = text.findIndex((line) => line.includes('Quota'))
  return command('awaywork report | cat', [text[0], '[...]', ...text.slice(quota)].join('\n'))
}

/** `report --unit 2`, its PR body cut after the title line. */
function reportUnit(): string {
  const [found] = findChains(report, '2')
  const text = found ? (unitFiles()[found.n - 1]?.text ?? '') : ''
  const body = text.split('\n')
  const title = body.indexOf('Fix the billing page build')
  return command('awaywork report --unit 2', [...body.slice(0, title + 1), '[...]'].join('\n'))
}

export default {
  'plan-view': planView(),
  'plan-hints': planHints(),
  'plan-why': planWhy(),
  'plan-rules': planRules(),
  'report-view': browsed(reportState(28), ['G', 'right', 'up', 'd']),
  'report-unit': reportUnit(),
  'report-piped': reportPiped(),
  'readme-report': browsed(reportState(26)),
  'run-detach': command(
    'awaywork run --unit api#1 --detach',
    detachedLine('api#1', '20261109-095329'),
  ),
}
