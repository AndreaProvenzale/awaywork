import { styleText } from 'node:util'
import { parseConfig } from '#config/load'
import { builtinSkills } from '#core/skills'
import type { Item } from '#core/types'
import { listedUnits, planUnitLines } from '#format/plan'
import { reportUnitTable } from '#format/report'
import { heading, type Style } from '#format/terminal'
import { type PlannedUnit, planRun } from '#plan/foreman'
import { type RunReport, summaryOf } from '#posts/report'
import { allowance } from '#quota/budget'
import { detachedLine } from '#run/execute'
import { describeFired, gatesSection } from '#worker/gates'

const style: Style = (format, text) => styleText(format, text)
const now = Date.UTC(2026, 10, 9, 22)

const fakeItem = (n: number, overrides: Partial<Item>): Item => ({
  source: 'github',
  id: String(n),
  key: `acme/api#${n}`,
  type: 'issue',
  title: '',
  description: '',
  url: `https://github.com/acme/api/issues/${n}`,
  status: 'open',
  reviewers: [],
  labels: ['awaywork'],
  comments: [],
  linkedPrs: [],
  fields: { repo: 'acme/api', mine: true, label: ['awaywork'] },
  raw: null,
  ...overrides,
})

/** Your PR, its branch `<probe>-feature` behind `<probe>-base`. */
function yourPr(n: number, probe: string, conflicts: boolean): Item {
  const url = `https://github.com/acme/api/pull/${n}`
  const pr = { repo: 'acme/api', number: n, url, branch: `${probe}-feature`, into: `${probe}-base` }
  return fakeItem(n, {
    type: 'pr',
    url,
    linkedPrs: [{ ...pr, ours: false, mine: true, trusted: true, fork: false }],
    fields: { repo: 'acme/api', mine: true, behind: 2, conflicts },
  })
}

function plan(queue: string, items: Item[]) {
  // Enough fallback units that no step runs out of claude.
  const config = parseConfig(`budget: { fallback: { units: 8 } }
providers: [claude: {}, codex: {}]
repos: { acme/api: {} }
sources: { github: {} }
${queue}`)
  const fallback = () => allowance(config.budget, null, now, config.windows)
  return planRun({
    config,
    items,
    allowances: { claude: fallback(), codex: fallback() },
    skills: { builtin: builtinSkills, user: { docs: {} } },
    now,
  })
}

/** `plan`'s units section alone, the providers above it left out. */
function chainPlan(): string {
  const p = plan(
    `queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    then:
      - loop:
          - { skill: review, provider: codex }
          - fix
        until: { verdict: approve }
        max: 3
      - { skill: docs, when: { changed: "src/**" } }
`,
    [fakeItem(12, { title: 'Rate-limit the export endpoint' })],
  )
  return [heading('Units', listedUnits(p).length, style), ...planUnitLines(p, style)].join('\n')
}

/** A `sync` run's units table alone, as `run` ends and `report` lists it. */
function syncRun(item: Item, body: string, gated?: string): string {
  const p = plan(
    `queue:
  - { skill: sync, where: { type: pr, mine: true, behind: { gt: 0 } }, deliver: push }
`,
    [item],
  )
  const report: RunReport = {
    runId: '20261109-220000',
    dryRun: false,
    startedAt: new Date(now),
    finishedAt: new Date(now + 60_000),
    plan: p,
    results: [
      {
        planned: p.units[0] as PlannedUnit,
        status: 'done',
        outcome: {
          kind: 'pushed',
          branch: item.linkedPrs[0]?.branch ?? '',
          url: item.url,
          commits: 1,
          text: body,
          head: 'a',
          ...(gated && { gated }),
        },
        summary: summaryOf(body),
      },
    ],
    quotas: {},
  }
  const { header, units } = reportUnitTable(report, true)
  return [header, ...units.flat()].map((line) => `  ${line}`).join('\n')
}

const resolved = [{ name: 'resolved', line: 'resolve-probe/a.txt' }]

export default {
  'chains-plan': chainPlan(),
  'chains-sync-clean': syncRun(
    yourPr(188, 'awaywork-sync', false),
    'Merge awaywork-sync-base into awaywork-sync-feature: 2 commits, awaywork-sync-base at f25506b.\n',
  ),
  'chains-sync-conflicts': syncRun(
    yourPr(191, 'awaywork-resolve', true),
    `${gatesSection(['resolved'], resolved)}\n\nKept both sides of the greeting.\n`,
    describeFired(resolved),
  ),
  'skills-run-detach': `$ awaywork run --unit CH-1 --skill review --detach\n${detachedLine('CH-1', '20261109-112811')}`,
}
