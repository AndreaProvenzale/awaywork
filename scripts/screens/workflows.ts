import { styleText } from 'node:util'
import { z } from 'zod'
import { approveItem } from '../../src/cli/approve.js'
import { listedUnits, planUnitLines } from '../../src/cli/format/plan.js'
import { reportUnitTable } from '../../src/cli/format/report.js'
import { formatSkipped, needsYouLines, skippedLines } from '../../src/cli/format/skips.js'
import { heading, type Style } from '../../src/cli/format/terminal.js'
import { parseConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import { allowance } from '../../src/core/budget.js'
import {
  approveReply,
  markComment,
  planComment,
  questionsComment,
  resultComment,
} from '../../src/core/comments.js'
import { taskMarkdown } from '../../src/core/fanout.js'
import { footer, type Pin, pinBlock, threadBody } from '../../src/core/footer.js'
import { planRun, type RunPlan } from '../../src/core/foreman.js'
import type { RunReport, UnitResult } from '../../src/core/report.js'
import { builtinSkills } from '../../src/core/skills.js'
import type { Item, PrRef, Source, TaskPr } from '../../src/core/types.js'
import { threadTitle } from '../../src/sources/github.js'
import { gatesSection } from '../../src/worker/gates.js'
import { continueLine } from '../../src/worker/slices.js'

const style: Style = (format, text) => styleText(format, text)
const now = Date.parse('2026-10-27T00:00:00Z')
const at = (day: number) => `2026-10-${day}T08:00:00Z`
const skills = { builtin: builtinSkills, user: { story: { deliver: 'report' as const } } }

const configOf = (provider: string, rules: string) =>
  parseConfig(`
providers: [${provider}]
windows: []
limits: { unit_minutes: 60 }
sources: { github: { repos: [acme/*] }, tracker: { command: node tracker.mjs, write: node tracker.mjs write } }
queue:
${rules}`)

function plan(config: Config, items: Item[]): RunPlan {
  const allowances = Object.fromEntries(
    config.providers.map((p) => [p.id, allowance(config.budget, null, now, config.windows)]),
  )
  return planRun({ config, items, allowances, skills, now })
}

type Named = Partial<Item> & Pick<Item, 'source' | 'key' | 'title' | 'url'>

const item = (named: Named): Item => ({
  id: named.key,
  type: 'issue',
  description: '',
  status: 'open',
  reviewers: [],
  labels: [],
  comments: [],
  linkedPrs: [],
  mine: true,
  raw: null,
  ...named,
  fields: { updated: at(26), ...named.fields },
})

/** A card whose plan you approved, with its tasks' PRs. */
const card = (
  named: Named,
  planYml: string,
  taskPrs: Record<string, TaskPr> = {},
  notes = '',
): Item =>
  item({
    ...named,
    comments: [
      { author: 'you', body: markComment(planComment('A plan.', planYml)), at: at(24), mine: true },
      { author: 'you', body: markComment(approveReply(notes)), at: at(25), mine: true },
    ],
    taskPrs,
  })

const pr = (repo: string, number: number, fields: Partial<TaskPr> = {}): TaskPr => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  branch: 'away/x',
  ours: true,
  mine: true,
  trusted: true,
  fork: false,
  state: 'open',
  ...fields,
})

/** The plan's units and the skipped items' counts, without the providers above them. */
const unitsOf = (p: RunPlan, skipped = false) =>
  [
    heading('Units', listedUnits(p).length, style),
    ...planUnitLines(p, style),
    ...(skipped ? skippedLines(p.skipped, style) : []),
  ].join('\n')

const head = '1f8a2313462c9a1f49af169ae1822d14c8adcde3'
const from = '16548667d8e02a7a03e25135ff6054b195de8e51'

function questions(): string {
  const asked = `Before I write code for "Add rate limits":

1. Per user or per API key? The issue says "per client", and src/auth.ts has both.
2. Should a burst over the limit get a 429, or wait for the bucket to refill?`
  return `octocat commented\n\n${markComment(questionsComment(asked))}`
}

function continueDraft(): string {
  const status = continueLine(1)
  const left = { status: 'continue' as const, continued: 1, head, from }
  const items = [{ source: 'github', key: 'acme/api#1/app' }]
  return `Export screen\n\n${status}\n\n[...]\n\n${footer('20261026-232730', items, left)}`
}

function continuePlan(): string {
  const config = configOf(
    'claude',
    `  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true }, deliver: pr, run: soon }`,
  )
  const left = { status: 'continue' as const, continued: 1, head, from }
  const draft = pr('acme/web', 13, { head, left: { ...left, items: ['github:acme/api#1/app'] } })
  const named = {
    source: 'github',
    key: 'acme/api#1',
    title: 'VAT export',
    url: 'https://github.com/acme/api/issues/1',
    fields: { repo: 'acme/api' },
  }
  const tasks = 'tasks:\n  - { id: app, title: Export screen, repo: acme/web }'
  return unitsOf(plan(config, [card(named, tasks, { app: draft })]))
}

function finishByHand(): string {
  const config = configOf('claude', '  - { skill: implement, deliver: pr }')
  const draft: PrRef = {
    repo: 'acme/web',
    number: 8,
    url: 'https://github.com/acme/web/pull/8',
    branch: 'away/acme-web-7',
    head: '9c0ffee5d1b2a3c4e5f60718293a4b5c6d7e8f90',
    ours: true,
    mine: true,
    trusted: true,
    fork: false,
    left: { status: 'continue', continued: 1, head, from, items: ['github:acme/web#7'] },
  }
  const issue = item({
    source: 'github',
    key: 'acme/web#7',
    title: 'Export screen',
    url: 'https://github.com/acme/web/issues/7',
    linkedPrs: [draft],
    fields: { repo: 'acme/web' },
  })
  return needsYouLines(plan(config, [issue]).skipped, style)
    .slice(1)
    .join('\n')
}

const fanOut = configOf(
  'fake: { command: ./fake-agent.sh }',
  `  - { skill: plan, source: tracker, deliver: plan }
  - { skill: implement, where: { planned: true }, deliver: pr }`,
)
const eng2101 = {
  source: 'tracker',
  key: 'ENG-2101',
  title: 'Export VAT report',
  url: 'https://acme.atlassian.net/browse/ENG-2101',
  fields: { repo: 'acme/backend' },
}

const vatPlan = `tasks:
  - id: api
    title: VAT export endpoint
    description: Add GET /exports/vat to src/routes/exports.ts, paged like /exports/sales.
  - id: web
    title: Export button
    description: Add an Export button to the reports page behind the vat_export flag.
    after: { api: merged }`

const planPost = () =>
  markComment(
    planComment(
      `VAT export lands in two PRs: the endpoint first, then the button that calls it.

- \`api\`: \`GET /exports/vat\` in \`src/routes/exports.ts\`, paged like \`/exports/sales\`, with a test next to \`sales.test.ts\`.
- \`web\`: an Export button on the reports page, behind the \`vat_export\` flag; it waits for the endpoint to merge.

Open question: should the export include voided invoices? I left them out.`,
      vatPlan,
    ),
  )

/** Cut as the guide cuts it: each fence after its first line, and how to answer below them. */
function contractPlan(): string {
  const contract = {
    name: 'openapi.yaml',
    text: `openapi: 3.1.0
info: { title: acme backend, version: 1.0.0 }
paths:
  /exports/vat:
    get: { summary: The VAT report as CSV }`,
  }
  const tasks = `contract: .away/out/openapi.yaml
tasks:
  - id: api
    title: VAT export endpoint
    ships: [openapi.yaml]
  - id: web
    title: Export button
    repo: acme/web
    after: { api: opened }`
  const body = planComment(
    'VAT export spans two repos: the endpoint in acme/backend, then the button in acme/web.',
    tasks,
    contract,
  ).replace(/(```yaml\n.*\n)[^`]*/g, '$1[...]\n')
  return body.slice(0, body.lastIndexOf('```') + 3)
}

/** `approve` on ENG-2101 waiting on its plan, through a tracker that links no comment. */
async function approve(): Promise<string> {
  const waiting = item({
    ...eng2101,
    comments: [{ author: 'you', body: planPost(), at: at(24), mine: true }],
  })
  const tracker: Source = {
    id: 'tracker',
    configSchema: z.strictObject({}),
    fields: {},
    secrets: () => [],
    items: async () => [waiting],
    prefetch: async () => {},
    write: async () => ({}),
  }
  const notes = 'Leave voided invoices out.'
  const ctx = { env: {}, log: () => {} }
  const said = await approveItem('tracker:ENG-2101', fanOut, notes, { sources: { tracker }, ctx })
  return `$ awaywork approve tracker:ENG-2101 ${notes}\n${said}`
}

const decisionCard = () =>
  gatesSection(
    ['schema', 'routes', 'deps'],
    [
      { name: 'schema', line: 'migrations/20261023_add_vat_mode.ts' },
      { name: 'routes', line: '+ GET /exports/vat   + POST /exports/vat/retry' },
      {
        name: 'risk',
        line: 'VAT rounding moved from the invoice total to each line → totals change on open invoices',
        judged: true,
      },
    ],
  )

/** A run's report as `formatRun` reads it, of one chain that left `result`. */
function runOf(planned: RunPlan, result: Omit<UnitResult, 'planned' | 'status'>): RunReport {
  const [unit] = planned.units
  if (!unit) throw new Error('the plan has no unit')
  return {
    runId: '20261107-193000',
    dryRun: false,
    startedAt: new Date(now),
    finishedAt: new Date(now),
    plan: planned,
    quotas: {},
    results: [{ planned: unit, status: 'done', ...result }],
  }
}

/** The units table's rows, without its heading and header. */
const unitRows = (r: RunReport) =>
  reportUnitTable(r, true)
    .units.flat()
    .map((line) => `  ${line}`)
    .join('\n')

function planPosted(): string {
  const config = configOf(
    'fake: { command: ./fake-agent.sh }',
    `  - { skill: plan, source: tracker, deliver: plan, on_done: { move: Plan review } }
  - { skill: implement, where: { planned: true }, deliver: pr }`,
  )
  const summary = 'VAT export lands in two PRs: the endpoint first, then the button that calls it.'
  const run = runOf(plan(config, [item(eng2101)]), {
    outcome: { kind: 'report', text: summary },
    summary,
    plan: {
      item: 'tracker:ENG-2101',
      url: eng2101.url,
      tasks: ['api', 'web'],
      post: { waits: true },
    },
    moved: [{ item: 'tracker:ENG-2101', to: 'Plan review' }],
  })
  return unitRows(run)
}

/** Cut as the guide cuts it: the plan's task list, and the card below its heading. */
function taskItemMd(): string {
  const tasks = `tasks:
  - id: api
    title: VAT export endpoint
    description: Add GET /exports/vat to src/routes/exports.ts, paged like /exports/sales.
  - id: web
    title: Export button
    after: { api: opened }`
  const p = plan(fanOut, [card(eng2101, tasks, {}, 'Leave voided invoices out.')])
  const api = p.units[0]?.unit.items[0]
  if (!api) throw new Error('ENG-2101 made no task')
  return taskMarkdown(api)
    .replace(/ENG-2101\. Each task[\s\S]*?(?=\n\nYour notes)/, 'ENG-2101. [...]')
    .replace(/(## The card: .*\n)[\s\S]*/, '$1[...]')
}

function stacked(): string {
  const tasks = `tasks:
  - { id: api, title: VAT export endpoint }
  - { id: web, title: Export button, after: { api: opened } }`
  return unitsOf(plan(fanOut, [card(eng2101, tasks)]), true)
}

function acrossRepos(): string {
  const tasks = `tasks:
  - { id: api, title: VAT export endpoint, ships: [openapi.yaml] }
  - { id: web, title: Export button, repo: acme/web, after: { api: opened } }`
  return unitsOf(plan(fanOut, [card(eng2101, tasks)]))
}

function waitingOnCheck(): string {
  const tasks = `tasks:
  - { id: api, title: VAT export endpoint, ships: [openapi.yaml] }
  - { id: web, title: Export button, repo: acme/web, after: { api: Vercel Preview } }`
  const api = pr('acme/backend', 41, { checks: { 'Vercel Preview': 'pending' } })
  const p = plan(fanOut, [card(eng2101, tasks, { api })])
  return `$ awaywork plan --skipped\n${formatSkipped(p.skipped)}`
}

const postWaits = () =>
  markComment(
    resultComment('Export VAT as CSV from the reports page.', 'done', 'story', undefined, 0, true),
    { waits: true, move: 'Ready for design', saw: 'Inbox' },
  )

function thread(): string {
  const named = {
    source: 'tracker',
    key: 'CARD-1',
    title: 'Export VAT report',
    url: 'https://tracker.example/CARD-1',
  }
  return `${threadTitle(named)}\n\n${threadBody(named)}`
}

function leanPost(): string {
  const pins: Pin[] = [
    {
      name: 'mock.png',
      url: 'file:///…/cfg/files/71e96381-7e32-4ee7-9aab-5f803b4de816/mock.png',
      size: 7,
      sha256: '2d4566582844690f8634a8b2534ea5221560038c6c0650c99140759bad603ae2',
    },
    {
      name: 'report.md',
      url: 'file:///…/cfg/files/a63b0dec-63e2-4701-968e-8350ad439bae/report.md',
      size: 22,
      sha256: '8ce3d4416e83b1da658e0404e2cf700108a3ed2e43b077fadad9eb5ccaa95c8e',
    },
  ]
  const result = resultComment('A story in one line.', 'done', 'story', undefined, 0, true)
  return markComment(`${result}${pinBlock(pins)}`, { waits: true })
}

function editedPost(): string {
  const config = configOf('claude', '  - { skill: story, deliver: report, wait: true }')
  const issue = item({
    source: 'github',
    key: 'acme/api#206',
    title: 'Export VAT report',
    url: 'https://github.com/acme/api/issues/206',
    fields: { repo: 'acme/api' },
  })
  const run = runOf(plan(config, [issue]), {
    outcome: { kind: 'report', text: 'Full report of story.' },
    summary: 'Full report of story.',
    store: [
      "report.md of awaywork's post of 2026-11-07T19:31:26Z changed in the store since awaywork pinned it",
    ],
    result: [
      {
        item: 'github:acme/api#206',
        url: 'https://github.com/acme/api/issues/206#issuecomment-6712036203',
        post: { waits: true },
      },
    ],
  })
  return unitRows(run)
}

export default {
  'workflows-decision-card': decisionCard(),
  'workflows-plan-comment': planPost(),
  'workflows-plan-posted': planPosted(),
  'workflows-approve': await approve(),
  'workflows-contract-plan': contractPlan(),
  'workflows-task-item': taskItemMd(),
  'workflows-questions': questions(),
  'workflows-continue-draft': continueDraft(),
  'workflows-continue-plan': continuePlan(),
  'workflows-finish-by-hand': finishByHand(),
  'workflows-stacked': stacked(),
  'workflows-across-repos': acrossRepos(),
  'workflows-check-wait': waitingOnCheck(),
  'workflows-post-waits': postWaits(),
  'workflows-thread': thread(),
  'workflows-lean-post': leanPost(),
  'workflows-edited-post': editedPost(),
}
