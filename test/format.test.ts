import { describe, expect, it } from 'vitest'
import {
  ambiguous,
  brandHeader,
  describeRule,
  findChains,
  formatPlan,
  formatRun,
  formatSkipped,
  formatUnit,
  formatWhy,
  listedUnits,
  namedItems,
  needsYouRows,
  reportJson,
  statusMarker,
  warningLines,
} from '../src/cli/format.js'
import { parseConfig } from '../src/config/load.js'
import { allowance } from '../src/core/budget.js'
import { type PlannedUnit, planRun, type RunPlan } from '../src/core/foreman.js'
import { formatReport, type RunReport, summaryOf, type UnitResult } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Rule } from '../src/core/types.js'
import { acmePlan, acmeRun, waitingSkip } from './fakes/acme.js'
import { asanaTask, githubPr } from './fakes/items.js'

describe('statusMarker', () => {
  it('colors a glyph per status', () => {
    expect(statusMarker('ok', true)).toBe('\u001b[32m✔\u001b[39m')
    expect(statusMarker('warn', true)).toBe('\u001b[33m⚠\u001b[39m')
    expect(statusMarker('FAIL', true)).toBe('\u001b[31m✖\u001b[39m')
  })

  it('keeps the padded plain words without color', () => {
    expect(statusMarker('ok', false)).toBe('ok  ')
    expect(statusMarker('warn', false)).toBe('warn')
    expect(statusMarker('FAIL', false)).toBe('FAIL')
  })
})

describe('brandHeader', () => {
  it('draws a bold amber prompt, a bold name and a dim tagline', () => {
    expect(brandHeader(true)).toBe(
      "☾ \u001b[1m\u001b[38;2;247;178;64m>_\u001b[39m\u001b[22m \u001b[1mawaywork\u001b[22m  \u001b[2mYou're away, your agents work\u001b[22m",
    )
  })

  it('is plain text without color', () => {
    expect(brandHeader(false)).toBe("☾ >_ awaywork  You're away, your agents work")
  })
})

describe('describeRule', () => {
  it('lists the where keys in order, with any last and its entries split by |', () => {
    const cfg = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix
    where: { type: pr, any: [{ checks: failing, label: urgent }, { any: [{ mine: true }] }], draft: false }
`)
    expect(describeRule(cfg.queue?.[0] as Rule)).toBe(
      'type=pr draft=false any(checks=failing label=urgent | any(mine=true))',
    )
  })
})

describe('listedUnits', () => {
  it('lists one unit per chain', () => {
    const unit = (chain?: string) => ({ chain })
    const units = [unit(), unit('a'), unit('a'), unit()]
    expect(listedUnits({ units } as never)).toEqual([units[0], units[3]])
  })
})

describe('formatPlan', () => {
  it('says why a quota when fails on its when line', () => {
    const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - skill: fix
    where: { checks: failing }
    when: { runs_until_reset: 1 }
`)
    const now = Date.UTC(2026, 0, 1, 1)
    const quota = {
      windows: [
        { name: 'seven_day', span: 'long' as const, used: 0.36, resetsAt: now / 1000 + 60 * 3600 },
      ],
    }
    const allowances = Object.fromEntries(
      config.providers.map((p) => [p.id, allowance(p.budget, quota, now, config.windows)]),
    )
    const plan = planRun({
      config,
      items: [githubPr(1, { checks: 'failing' })],
      allowances,
      skills: { builtin: builtinSkills },
    })
    expect(formatPlan(plan)).toContain(
      "     when the window resets within 1 run (doesn't hold on the probe)",
    )
  })
})

describe('reportJson', () => {
  it('keeps the run header and only references to its items', () => {
    const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue: [{ skill: fix, where: { checks: failing } }]
`)
    const secret = { description: 'PRIVATE', comments: [{ author: 'a', body: 'PRIVATE', at: '' }] }
    const plan = planRun({
      config,
      items: [
        { ...githubPr(1, { checks: 'failing' }), ...secret },
        { ...githubPr(2), ...secret },
      ],
      allowances: {},
      skills: { builtin: builtinSkills },
    })
    const report: RunReport = {
      runId: '20261015-220000',
      dryRun: false,
      startedAt: new Date('2026-10-15T22:00:00Z'),
      finishedAt: new Date('2026-10-15T23:00:00Z'),
      plan,
      results: [
        {
          planned: plan.units[0] as PlannedUnit,
          status: 'done',
          outcome: { kind: 'pr', url: 'https://github.com/acme/api/pull/9', commits: 1, head: 'a' },
          summary: 'Ran the tests.',
          files: {
            log: 'units/acme-api-1/1-fix/worker.log',
            sliceBody: 'units/acme-api-1/out/pr.md',
          },
        },
      ],
      quotas: {},
    }
    const json = reportJson(report, ['a warning'])
    const parsed = JSON.parse(json)
    expect(parsed.warnings).toEqual(['a warning'])
    expect(parsed.startedAt).toBe('2026-10-15T22:00:00.000Z')
    const ref = (n: number) => ({
      source: 'github',
      key: `acme/api#${n}`,
      title: `PR ${n}`,
      url: `https://github.com/acme/api/pull/${n}`,
    })
    expect(parsed.plan.units[0].unit.items).toEqual([ref(1)])
    expect(parsed.results[0].planned.unit.items).toEqual([ref(1)])
    expect(parsed.plan.skipped[0].item).toEqual(ref(2))
    expect(parsed.plan.skipped[0].kind).toBe('no_rule')
    expect(parsed.results[0]).toMatchObject({
      outcome: { url: 'https://github.com/acme/api/pull/9' },
      summary: 'Ran the tests.',
      files: { log: 'units/acme-api-1/1-fix/worker.log', sliceBody: 'units/acme-api-1/out/pr.md' },
    })
    expect(json).not.toContain('PRIVATE')
  })
})

describe('summaryOf', () => {
  it("takes a PR body's first paragraph past its title, on one line", () => {
    const body = '# Fix the flaky test\n\nNo code changes: both red\nchecks are unrelated.\n\nMore.'
    expect(summaryOf(body, true)).toBe('No code changes: both red checks are unrelated.')
    expect(summaryOf('Fix it\n\n## Why\nThe retry hid it.', true)).toBe('The retry hid it.')
  })

  it('leaves out HTML comments, as a PR template leaves them', () => {
    const body = 'Fix it\n\n<!-- Describe the change -->\n## Summary\nDid it.<!--\nwhy\n-->'
    expect(summaryOf(body, true)).toBe('Did it.')
  })

  it("takes a report's first paragraph, cut to 200 characters", () => {
    expect(summaryOf('\nApprove: the diff does what #5 asks.\n\nNits below.')).toBe(
      'Approve: the diff does what #5 asks.',
    )
    const long = summaryOf('word '.repeat(60)) ?? ''
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
  })

  it('is undefined for an empty file or a body with only a title', () => {
    expect(summaryOf('')).toBeUndefined()
    expect(summaryOf('Fix the flaky test\n', true)).toBeUndefined()
  })
})

const why = (plan: RunPlan, name: string) => {
  const [item] = namedItems(plan, name)
  return item && formatWhy(plan, item)
}

/** The acme run with its unit a chain that looped: a review asking for changes, then a fix. */
function loopRun(loop: string): RunReport {
  const run = acmeRun()
  const head = run.results[0] as UnitResult
  const step = (skill: string, provider: string, made: string) => ({
    planned: {
      ...head.planned,
      chain: 'acme-api-1',
      unit: { ...head.planned.unit, id: `acme-api-1-${skill}-1`, skill },
    },
    provider,
    status: 'done' as const,
    turns: 5,
    made,
  })
  run.results = [
    { ...head, loop },
    { ...step('review', 'codex', 'a report'), reported: true, verdict: 'changes' },
    step('fix', 'claude', '1 commit'),
  ]
  return run
}

describe('plan views', () => {
  it('lists the units, what needs you, and counts the rest by kind', () => {
    expect(formatPlan(acmePlan())).toMatchInlineSnapshot(`
      "Providers
        provider  window    used  ceiling  set by  resets in  session / stop at
        claude    fallback
          4 units, 60 turns each (no quota reading)

      Units 1
           item   rule  skill           provider  deliver   title
        1  api#1  #1    fix (built-in)  claude    draft_pr  PR 1

      Needs you 1
        T-4  no repo: no linked PR or repo field
             Task 4

      Skipped 2: 1 no_rule, 1 over_cap

      awaywork plan --skipped [kind]  lists them
      awaywork plan --why <key>       says why an item is planned or not"
    `)
  })

  it('keeps a Needs you reason to its first clause, and the rest, with the URL once, under --why', () => {
    const plan = acmePlan()
    plan.skipped.push(waitingSkip())
    expect(needsYouRows(plan.skipped)[1]?.lines[0]).toBe(
      'api#31  waiting for review: awaywork PR is open',
    )
    expect(formatWhy(plan, githubPr(31))).toMatchInlineSnapshot(`
      "github acme/api#31  PR 31
        https://github.com/acme/api/pull/31
        skipped: waiting_for_review
          waiting for review: awaywork PR is open; closest #3 fix: checks is passing, wants failing"
    `)
  })

  it('names the PR awaywork pushed onto without its URL, and with it under --why', () => {
    const plan = acmePlan()
    const url = 'https://github.com/acme/api/pull/31'
    const reason = `waiting for review: awaywork pushed onto your PR ${url}`
    plan.skipped.push({ item: githubPr(31), kind: 'waiting_for_review', reason, url })
    expect(needsYouRows(plan.skipped)[1]?.lines[0]).toBe(
      'api#31  waiting for review: awaywork pushed onto your PR',
    )
    expect(formatWhy(plan, githubPr(31))).toBe(
      `github acme/api#31  PR 31\n  ${url}\n  skipped: waiting_for_review\n    waiting for review: awaywork pushed onto your PR`,
    )
  })

  it('says which PR an item waits on under --why when it is another', () => {
    const plan = acmePlan()
    const pr = 'https://github.com/acme/api/pull/31'
    const issue = asanaTask(7)
    plan.skipped.push({ ...waitingSkip(), item: issue })
    expect(formatWhy(plan, issue)).toContain(
      `  skipped: waiting_for_review\n    waiting for review: awaywork PR is open; closest #3 fix: checks is passing, wants failing\n    waits on ${pr}`,
    )
  })

  it("clips a Needs you row's reason and title at the given width, as the view asks", () => {
    const plan = acmePlan()
    const long = { ...waitingSkip(), reason: `no repo: ${'x'.repeat(80)}` }
    plan.skipped.push({ ...long, kind: 'no_repo' })
    const [, row] = needsYouRows(plan.skipped)
    expect(row?.lines[0]).toBe(`api#31  no repo: ${'x'.repeat(50)}…`)
    const [, whole] = needsYouRows(plan.skipped, undefined, Number.POSITIVE_INFINITY)
    expect(whole?.lines[0]).toBe(`api#31  no repo: ${'x'.repeat(80)}`)
  })

  it('lists every skipped item, or those of one kind', () => {
    const { skipped } = acmePlan()
    expect(formatSkipped(skipped)).toMatchInlineSnapshot(`
      "Needs you 1
        T-4: no repo: no linked PR or repo field
      Skipped 2: 1 no_rule, 1 over_cap
        api#3: matched no rule; closest #1 fix: checks is passing, wants failing
        api#2: over the cap: limits.units is 1"
    `)
    expect(formatSkipped(skipped, 'over_cap')).toMatchInlineSnapshot(`
      "Skipped over_cap (1)
        api#2: over the cap: limits.units is 1"
    `)
  })

  it('says why an item is planned, by ref, key or source:key', () => {
    const plan = acmePlan()
    expect(why(plan, 'api#1')).toMatchInlineSnapshot(`
      "github acme/api#1  PR 1
        https://github.com/acme/api/pull/1
        planned
          unit      1, acme-api-1
          rule      #1 checks=failing
          skill     fix (built-in)
          provider  claude
          deliver   draft_pr
          branch    away/acme-api-1"
    `)
    expect(why(plan, 'github:acme/api#1')).toBe(why(plan, 'api#1'))
    expect(why(plan, 'ACME/API#1')).toBe(why(plan, 'api#1'))
  })

  it('says why an item is skipped, with the queue for one that matched no rule', () => {
    const plan = acmePlan()
    expect(why(plan, 'asana:T-4')).toMatchInlineSnapshot(`
      "asana T-4  Task 4
        https://app.asana.com/0/1/4
        skipped: no_repo
          no repo: no linked PR or repo field"
    `)
    expect(why(plan, 'acme/api#3')).toMatchInlineSnapshot(`
      "github acme/api#3  PR 3
        https://github.com/acme/api/pull/3
        skipped: no_rule
          matched no rule; closest #1 fix: checks is passing, wants failing

      Queue
        #1  fix        checks=failing
        #2  implement  type=task"
    `)
  })

  it('knows no item the plan never saw', () => {
    expect(why(acmePlan(), 'acme/api#99')).toBeUndefined()
  })

  it("names an item by its exact key, source:key or ref, never a tracker key's look-alike", () => {
    const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue: [{ skill: fix }]
`)
    const labs = {
      ...githubPr(1),
      key: 'acme-labs/api#1',
      url: 'https://github.com/acme-labs/api/pull/1',
      linkedPrs: [],
    }
    const task = { ...asanaTask(7, { repo: 'acme/api' }), key: 'API-1' }
    const plan = planRun({
      config,
      items: [githubPr(1), labs, task],
      allowances: {},
      skills: { builtin: builtinSkills },
    })
    const keys = (name: string) => namedItems(plan, name).map((i) => i.key)
    expect(keys('API-1')).toEqual(['API-1'])
    expect(keys('asana:api-1')).toEqual(['API-1'])
    expect(keys('acme/api#1')).toEqual(['acme/api#1'])
    expect(keys('api#1')).toEqual(['acme/api#1', 'acme-labs/api#1'])
    expect(ambiguous('api#1', namedItems(plan, 'api#1'))).toMatchInlineSnapshot(`
      ""api#1" names 2 items; pick one:
        github:acme/api#1       PR 1
        github:acme-labs/api#1  PR 1"
    `)
  })

  it('indents each line of a warning under its first', () => {
    expect(warningLines(['source tracker: Command failed\n\nError: boom', 'one line'])).toEqual([
      'Warnings 2',
      '  source tracker: Command failed',
      '    Error: boom',
      '  one line',
      '',
    ])
  })
})

describe('report views', () => {
  it('prints a run from its report.json: units with summaries, needs you, counts, quota, hints', () => {
    expect(formatRun(acmeRun(), ['source tracker: Command failed'])).toMatchInlineSnapshot(`
      "Run 20261019-220000: 1 draft PR, 0 reports, 1 unit
      2026-10-19 22:00:00 to 2026-10-19 22:41:07

      Warnings 1
        source tracker: Command failed

      Units 1
           item   skill  status          result
        1  api#1  fix    done, 12 turns  https://github.com/acme/api/pull/9
           Retries the flaky upload test instead of sleeping.

      Needs you 1
        T-4  no repo: no linked PR or repo field
             Task 4

      Skipped 2: 1 no_rule, 1 over_cap

      Quota
        claude: fallback, 1 of 4 units (no quota reading)

      awaywork report 20261019-220000 --unit <n|key>    shows one
      awaywork report 20261019-220000 --skipped [kind]  lists the skipped items"
    `)
  })

  it('lists skips from a report.json older than kinds uncounted, never as needing you', () => {
    const run = acmeRun()
    run.plan.skipped = run.plan.skipped.map(({ item, reason }) => ({ item, reason }))
    const text = formatRun(run)
    expect(text).toContain('\nSkipped 3\n')
    expect(text).not.toContain('Needs you')
    expect(formatSkipped(run.plan.skipped)).toMatch(/^Skipped 3\n {2}api#3: matched no rule;/)
    expect(formatWhy(run.plan, asanaTask(4))).toContain('\n  skipped\n    no repo')
    expect(formatReport(run)).toContain(
      '<summary>Skipped (3)</summary>\n\n- api#3: matched no rule',
    )
  })

  it('shows one unit by number, unit id or item, with its files and body, and no steps for one step', () => {
    const run = acmeRun()
    const [found] = findChains(run, '1')
    expect(findChains(run, 'acme-api-1')).toEqual([found])
    expect(findChains(run, 'api#1')).toEqual([found])
    expect(findChains(run, '2')).toEqual([])
    expect(findChains(run, 'api#3')).toEqual([])
    if (!found) return
    const files = ['/runs/20261019-220000/units/acme-api-1/1-fix/worker.log']
    const body = '# Fix the flaky upload test\n\nRetries it.\n'
    expect(formatUnit(found, files, body)).toMatchInlineSnapshot(`
      "1  api#1  PR 1
        skill   fix
        status  done, 12 turns
        result  https://github.com/acme/api/pull/9
        item    https://github.com/acme/api/pull/1
        files   /runs/20261019-220000/units/acme-api-1/1-fix/worker.log

      # Fix the flaky upload test

      Retries it."
    `)
    expect(formatUnit(found, [], undefined)).toContain(
      '\n\nRetries the flaky upload test instead of sleeping.',
    )
  })

  it("leaves a loop's note to --unit and report.md, and lists a chain's steps in --unit", () => {
    const run = loopRun('2 rounds of review ⇄ fix; until held: sh scripts/approved.sh --strict')
    expect(formatRun(run)).toContain(
      '  1  api#1  fix    done, 22 turns  https://github.com/acme/api/pull/9, verdict changes\n',
    )
    expect(formatReport(run)).toContain(
      '| done, 22 turns (loop: 2 rounds of review ⇄ fix; until held: sh scripts/approved.sh --strict) |',
    )
    const [found] = findChains(run, '1')
    expect(findChains(run, 'acme-api-1-review-1')).toEqual([found])
    expect(found && formatUnit(found, [], undefined)).toMatchInlineSnapshot(`
      "1  api#1  PR 1
        skill   fix
        status  done, 22 turns
        loop    2 rounds of review ⇄ fix; until held: sh scripts/approved.sh --strict
        result  https://github.com/acme/api/pull/9, verdict changes
        item    https://github.com/acme/api/pull/1
        steps   acme-api-1           fix     claude  done, 12 turns  -
                acme-api-1-review-1  review  codex   done, 5 turns   a report, verdict changes
                acme-api-1-fix-1     fix     claude  done, 5 turns   1 commit

      Retries the flaky upload test instead of sleeping."
    `)
  })

  it("clips a long status in the row, and falls back to the item's title with no summary", () => {
    const run = acmeRun()
    const [result] = run.results
    if (!result) return
    Object.assign(result, { status: 'failed', reason: `git clone: ${'x'.repeat(100)}` })
    delete result.summary
    const units = formatRun(run).split('\n\n')[1] ?? ''
    expect(units).toMatchInlineSnapshot(`
      "Units 1
           item   skill  status                                                        result
        1  api#1  fix    failed, 12 turns (git clone: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…  https://github.com/acme/api/pull/9
           PR 1"
    `)
  })

  it("keeps a multi-line reason to its first line in the row, and in full under --unit's result", () => {
    const run = acmeRun()
    const [result] = run.results
    if (!result) return
    const reason = [
      'setup failed: Command failed with exit code 1: pnpm install --frozen-lockfile',
      ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile',
      '',
      '  Failure reason:',
    ].join('\n')
    Object.assign(result, { status: 'skipped', reason, turns: undefined, outcome: undefined })
    const units = formatRun(run).split('\n\n')[1] ?? ''
    expect(units).toMatchInlineSnapshot(`
      "Units 1
           item   skill  status   result
        1  api#1  fix    skipped  setup failed: Command failed with exit code 1: pnpm install…
           Retries the flaky upload test instead of sleeping."
    `)
    const [found] = findChains(run, '1')
    expect(found && formatUnit(found, [], undefined)).toMatchInlineSnapshot(`
      "1  api#1  PR 1
        skill   fix
        status  skipped
        result  setup failed: Command failed with exit code 1: pnpm install --frozen-lockfile
                   ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile
                    Failure reason:
        item    https://github.com/acme/api/pull/1

      Retries the flaky upload test instead of sleeping."
    `)
  })

  it('takes a numeric key over a row number, and leaves the row its ref', () => {
    const run = acmeRun()
    const [head] = run.results
    if (!head) return
    const gid = { ...asanaTask(1), key: '1' }
    const unit = { ...head.planned.unit, id: '1', items: [gid] }
    run.results.push({ ...head, planned: { ...head.planned, unit } })
    expect(findChains(run, '1').map((f) => f.n)).toEqual([2])
    expect(findChains(run, '2').map((f) => f.n)).toEqual([2])
    expect(findChains(run, 'api#1').map((f) => f.n)).toEqual([1])
  })

  it('refuses a name for two units, naming each by source:key', () => {
    const run = acmeRun()
    const [head] = run.results
    if (!head) return
    const labs = { ...githubPr(1), key: 'acme-labs/api#1', title: 'Labs PR 1' }
    const unit = { ...head.planned.unit, id: 'acme-labs-api-1', items: [labs] }
    run.results.push({ ...head, planned: { ...head.planned, unit } })
    const found = findChains(run, 'api#1')
    expect(found.map((f) => f.n)).toEqual([1, 2])
    expect(findChains(run, 'acme-labs/api#1').map((f) => f.n)).toEqual([2])
    const tops = found.flatMap((f) => f.chain.head.planned.unit.items.slice(0, 1))
    expect(ambiguous('api#1', tops)).toMatchInlineSnapshot(`
      ""api#1" names 2 items; pick one:
        github:acme/api#1       PR 1
        github:acme-labs/api#1  Labs PR 1"
    `)
  })

  it('writes report.md with a summary per unit, what needs you, skips by kind and reports folded, headings demoted', () => {
    const run = acmeRun()
    const review = '# Review\n\nApprove.\n\n## Nits\n\n```md\n# not a heading\n```'
    const result = run.results[0]
    if (result) result.outcome = { kind: 'report', text: review }
    const text = formatReport(run)
    expect(text).toContain(
      '| 1 | [api#1 PR 1](https://github.com/acme/api/pull/1) | fix | claude | done, 12 turns | report below |\n\n- **api#1**: Retries the flaky upload test instead of sleeping.\n',
    )
    expect(text).toContain(
      '## Needs you (1)\n\n- [T-4 Task 4](https://app.asana.com/0/1/4): no repo: no linked PR or repo field\n',
    )
    expect(text).toContain(
      [
        '<details><summary>Skipped (2)</summary>',
        '',
        '### no_rule (1)',
        '',
        '- api#3: matched no rule; closest #1 fix: checks is passing, wants failing',
        '',
        '### over_cap (1)',
        '',
        '- api#2: over the cap: limits.units is 1',
        '',
        '</details>',
      ].join('\n'),
    )
    expect(text).toContain(
      [
        '### api#1: PR 1 (fix)',
        '',
        'https://github.com/acme/api/pull/1',
        '',
        'Retries the flaky upload test instead of sleeping.',
        '',
        '<details><summary>Full report</summary>',
        '',
        '#### Review',
        '',
        'Approve.',
        '',
        '##### Nits',
        '',
        '```md',
        '# not a heading',
        '```',
        '',
        '</details>',
      ].join('\n'),
    )
  })
})
