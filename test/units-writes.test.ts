import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { summarize } from '../src/cli/format/report.js'
import { linkPlanTasks } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { type Attempts, recordAttempts, unchangedSince } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { commentKind, markComment, planComment, resultComment } from '../src/core/comments.js'
import { planRun } from '../src/core/foreman.js'
import { formatReport } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Forge, Item, Provider, Source, Write } from '../src/core/types.js'
import { runUnits } from '../src/worker/units.js'
import { cardAndPr, fakeItem, githubPr, issue, yours } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'
import { asker, finishedRun, looper, originForge } from './fakes/units.js'

it("posts a thread rule's waiting result on a thread issue it opens for a card that can't write, holding no move it can't make", async () => {
  const posted: string[] = []
  const threads: NonNullable<Forge['threads']> = {
    threads: async () => [],
    closeThread: async () => {},
    openThread: async (repo, item) => {
      posted.push(`open ${repo} for ${item.source}:${item.key}`)
      return { host: 'github', key: `${repo}#57`, url: `https://github.com/${repo}/issues/57` }
    },
    threadComment: async (t, body) => {
      posted.push(body)
      return `${t.url}#issuecomment-1`
    },
  }
  const { report, writes } = await finishedRun(
    '  - { skill: review, deliver: report, wait: true, thread: github, on_done: { move: QA } }',
    [yours(1)],
    undefined,
    null,
    undefined,
    threads,
  )
  const body = resultComment('acme-api-1 says nothing.', 'done', 'review', undefined, 0, true)
  expect(writes).toEqual([])
  expect(posted).toEqual([
    'open acme/api for github:acme/api#1',
    markComment(body, { waits: true }),
  ])
  expect(report.results[0]?.result).toEqual([
    {
      item: 'github:acme/api#1',
      url: 'https://github.com/acme/api/issues/57#issuecomment-1',
      post: { waits: true },
    },
  ])
  // A plain one's move says the card stayed put.
  posted.length = 0
  const plain = await finishedRun(
    '  - { skill: review, deliver: report, thread: github, on_done: { comment: result, move: QA } }',
    [{ ...yours(1), thread: { host: 'github', key: 'acme/api#57', url: 'https://x/57' } }],
    undefined,
    null,
    undefined,
    threads,
  )
  expect(posted).toHaveLength(1)
  expect(plain.report.results[0]?.moved).toEqual([
    { item: 'github:acme/api#1', to: 'QA', failed: "github can't write to its items" },
  ])
})

it("moves your items once the chain published, and counts the move as awaywork's own change", async () => {
  const { report, writes } = await finishedRun('  - { skill: implement, on_done: { move: QA } }', [
    yours(1),
  ])
  expect(writes).toEqual([['acme/api#1', { op: 'move', to: 'QA' }]])
  expect(report.results[0]?.moved).toEqual([
    { item: 'github:acme/api#1', to: 'QA', updated: '2026-10-25T01:00:00Z' },
  ])
  expect(formatReport(report)).toContain('- **api#1**: on_done moved acme/api#1 to "QA"')
  expect(summarize(report, 'report.md')).toContain('     on_done moved acme/api#1 to "QA"')
  expect(recordAttempts({}, report)['github:acme/api#1']?.updated).toBe('2026-10-25T01:00:00Z')
})

it('keeps the updated time the plan read when someone changed the item during the run', async () => {
  const { report } = await finishedRun(
    '  - { skill: implement, on_done: { move: QA } }',
    [yours(1)],
    looper({}),
    async () => ({ before: '2026-10-24T00:30:00Z', after: '2026-10-24T01:00:00Z' }),
  )
  expect(report.results[0]?.moved).toEqual([{ item: 'github:acme/api#1', to: 'QA' }])
  const attempts = recordAttempts({}, report)
  expect(attempts['github:acme/api#1']?.updated).toBe('2026-10-24T00:00:00Z')
  const next = { ...yours(1), fields: { ...yours(1).fields, updated: '2026-10-24T01:00:00Z' } }
  expect(unchangedSince(next, 'implement', attempts)).toBeUndefined()
})

it("keeps a closed item's state with the move's updated time, so only a new state re-runs it", async () => {
  const closed = new Date(Date.now() - 86_400_000).toISOString()
  const done = fakeItem({ ...yours(1), fields: { ...yours(1).fields, state: 'closed', closed } })
  const { report } = await finishedRun(
    '  - { skill: implement, where: { state: closed }, on_done: { move: QA } }',
    [done],
  )
  const attempts = recordAttempts({}, report)
  expect(attempts['github:acme/api#1']).toMatchObject({
    updated: '2026-10-25T01:00:00Z',
    state: 'closed',
  })
  const moved = { ...done, fields: { ...done.fields, updated: '2026-10-25T01:00:00Z' } }
  expect(unchangedSince(moved, 'implement', attempts)).toBe('r1')
  const reopened = { ...moved, fields: { ...moved.fields, state: 'open' } }
  expect(unchangedSince(reopened, 'implement', attempts)).toBeUndefined()
})

it("moves only the items of the rule's own source, or of the item it matched without one", async () => {
  const named = await finishedRun(
    '  - { skill: review, source: tracker, deliver: report, on_done: { move: QA } }\n  - { skill: review, deliver: report }',
    cardAndPr(),
  )
  expect(named.report.results[0]?.planned.unit.items.map((i) => i.key)).toEqual([
    'ENG-1',
    'acme/api#2',
  ])
  expect(named.writes).toEqual([['ENG-1', { op: 'move', to: 'QA' }]])
  const unnamed = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { move: QA } }',
    cardAndPr(),
  )
  expect(unnamed.writes).toEqual([['acme/api#2', { op: 'move', to: 'QA' }]])
})

it('moves nothing when a step failed, committed nothing or a loop never held', async () => {
  const failing: Provider = {
    ...fakeProvider('claude'),
    async *run() {
      yield { type: 'done', ok: false, turns: 1 }
    },
  }
  const questions: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      await writeFile(join(job.dir, '.away/out/report.md'), 'Which limit?')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const rule = '  - { skill: implement, on_done: { move: QA } }'
  for (const provider of [failing, questions]) {
    const { report, writes } = await finishedRun(rule, [yours(1)], provider)
    expect(writes).toEqual([])
    expect(report.results[0]?.moved).toBeUndefined()
  }
  const looped = await finishedRun(
    '  - { skill: implement, on_done: { move: QA }, then: { loop: [review, fix], until: { verdict: approve }, max: 1 } }',
    [yours(1)],
  )
  expect(looped.report.results[0]?.outcome?.kind).toBe('pr')
  expect(looped.writes).toEqual([])
})

it('never writes to a review-requested PR or an item only an extra search found', async () => {
  const { writes, lines } = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { move: QA } }',
    [githubPr(2, { mine: false, review_requested: true }), issue(3)],
  )
  expect(writes).toEqual([])
  expect(lines).toContain('on_done: acme/api#2 not moved, not yours')
  expect(lines).toContain('on_done: acme/api#3 not moved, not yours')
})

it('reports a move that failed, its secrets masked, and leaves the unit done', async () => {
  const { report, lines } = await finishedRun(
    '  - { skill: implement, on_done: { move: QA } }',
    [yours(1)],
    looper({}),
    async () => {
      throw new Error('401 for s3cret')
    },
  )
  expect(report.results[0]?.status).toBe('done')
  expect(report.results[0]?.moved).toEqual([
    { item: 'github:acme/api#1', to: 'QA', failed: '401 for ***' },
  ])
  expect(lines).toContain(`on_done: couldn't move acme/api#1 to QA: 401 for ***`)
  expect(formatReport(report)).toContain(`on_done couldn't move acme/api#1 to "QA": 401 for ***`)
})

it("posts a report rule's result before moving, counting both as awaywork's own changes", async () => {
  let at = 0
  const times = ['2026-10-24T00:00:00Z', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z']
  const writes: [string, Write][] = []
  const { report } = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { comment: result, move: QA } }',
    [yours(1)],
    looper({}),
    async (_cfg, item, w) => {
      writes.push([item.key, w])
      return { before: times[at] as string, after: times[++at] as string }
    },
  )
  expect(writes).toEqual([
    [
      'acme/api#1',
      {
        op: 'comment',
        body: 'Result of review\n\nacme-api-1 says nothing.\n\nStatus: done\n\n— awaywork',
      },
    ],
    ['acme/api#1', { op: 'move', to: 'QA' }],
  ])
  expect(report.results[0]?.result).toEqual([
    {
      item: 'github:acme/api#1',
      url: 'https://example.com/1',
      updated: '2026-10-25T01:00:00Z',
    },
  ])
  const text = formatReport(report)
  expect(text).toContain('- **api#1**: result posted on https://example.com/1')
  expect(text).toContain('- **api#1**: on_done moved acme/api#1 to "QA"')
  expect(recordAttempts({}, report)['github:acme/api#1']?.updated).toBe('2026-10-25T02:00:00Z')
})

it("posts a PR rule's result as a link to its PR, and none on an item that isn't yours", async () => {
  const { report, writes } = await finishedRun(
    '  - { skill: implement, deliver: pr, on_done: { comment: result } }',
    [yours(1)],
  )
  expect(writes).toEqual([
    [
      'acme/api#1',
      {
        op: 'comment',
        body: 'Result of implement\n\nOpened https://example.com/acme/api/pull/away/acme-api-1\n\nStatus: done\n\n— awaywork',
      },
    ],
  ])
  expect(recordAttempts({}, report)['github:acme/api#1']?.updated).toBe('2026-10-25T01:00:00Z')
  const theirs = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { comment: result } }',
    [githubPr(2, { mine: false, review_requested: true })],
  )
  expect(theirs.writes).toEqual([])
  expect(theirs.lines).toContain('acme/api#2 got no result, not yours')
})

it('reports a result that failed to post, its secrets masked, and still moves the item', async () => {
  const { report, lines } = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { comment: result, move: QA } }',
    [yours(1)],
    looper({}),
    async (_cfg, _item, w) => {
      if (w.op === 'comment') throw new Error('401 for s3cret')
      return {}
    },
  )
  expect(report.results[0]?.result).toEqual([{ item: 'github:acme/api#1', failed: '401 for ***' }])
  expect(report.results[0]?.moved).toEqual([{ item: 'github:acme/api#1', to: 'QA' }])
  expect(lines).toContain(`couldn't post the result on acme/api#1: 401 for ***`)
  expect(formatReport(report)).toContain(`couldn't post its result on acme/api#1: 401 for ***`)
})

const tasks =
  'tasks:\n  - { id: api, title: VAT export endpoint }\n  - { id: web, title: Export button, after: { api: merged } }\n'

/** A provider whose step writes a report and, unless empty, `plan.yml`; it keeps the prompts it got. */
const planner = (
  yaml: string,
  report = 'Two tasks: the API first.',
  prompts: string[] = [],
): Provider => ({
  ...fakeProvider('claude'),
  async *run(job) {
    prompts.push(job.prompt)
    await writeFile(join(job.dir, '.away/out/report.md'), report)
    if (yaml) await writeFile(join(job.dir, '.away/out/plan.yml'), yaml)
    yield { type: 'done', ok: true, turns: 1 }
  },
})

const planRule =
  '  - { skill: plan, deliver: plan, on_done: { move: Plan review } }\n  - { skill: implement, where: { planned: true } }'

it("posts a plan rule's plan once on your card with its report, and fires on_done on posting", async () => {
  const prompts: string[] = []
  const { report, writes, lines } = await finishedRun(
    planRule,
    [yours(1)],
    planner(tasks, undefined, prompts),
  )
  expect(prompts[0]).toContain(
    'Deliver: a plan. Write `.away/out/report.md` and `.away/out/plan.yml`, and commit nothing. `plan.yml` is YAML: `tasks:`, a list of at most 8 tasks',
  )
  expect(writes).toEqual([
    [
      'acme/api#1',
      { op: 'comment', body: markComment(planComment('Two tasks: the API first.', tasks)) },
    ],
    ['acme/api#1', { op: 'move', to: 'Plan review' }],
  ])
  const [head] = report.results
  expect(head?.planned.unit.deliver).toBe('plan')
  expect(head?.outcome).toEqual({ kind: 'report', text: 'Two tasks: the API first.' })
  expect(head?.plan).toEqual({
    tasks: ['api', 'web'],
    item: 'github:acme/api#1',
    post: { waits: true },
    url: 'https://example.com/1',
  })
  expect(lines).toContain('acme-api-1: plan posted on https://example.com/1')
  const text = formatReport(report)
  expect(text).toContain('- **api#1**: plan posted on https://example.com/1, tasks api, web')
  expect(text).toMatch(/\| done, 1 turn \| report below \|$/m)
  expect(summarize(report, 'report.md')).toContain(
    '     plan posted on https://example.com/1, tasks api, web',
  )
})

it('posts no refused plan, keeps the reason in the report and fires no on_done', async () => {
  const many = `tasks:\n${Array.from({ length: 9 }, (_, i) => `  - { id: t${i}, title: T }`).join('\n')}`
  const refused: [Provider, string][] = [
    [
      planner('tasks:\n  - { id: api, title: A }\n  - { id: api, title: B }'),
      'plan.yml: task id "api" is used twice',
    ],
    [planner(''), 'plan.yml: missing or empty'],
    [planner('tasks: ['), 'plan.yml: not YAML: '],
    [planner(many), 'plan.yml: 9 tasks, over limits.plan_tasks (8)'],
    [planner(tasks, 'x'.repeat(30_001)), 'the plan comment is over 30000 bytes'],
    // Valid YAML, but its line-start fence ends the comment's yaml block early.
    [
      planner('{ tasks: [{ id: api, title: "A\n```\n" }] }'),
      "plan.yml doesn't read back from its comment: not YAML: ",
    ],
    // Task a in the file, task b read back from the comment's last yaml fence.
    [
      planner('{ tasks: [{ id: a, title: "x\n```yaml\ntasks: [{id: b, title: y}]\n#" }] }'),
      "plan.yml doesn't read back from its comment: it reads as another plan",
    ],
  ]
  for (const [provider, reason] of refused) {
    const { report, writes } = await finishedRun(planRule, [yours(1)], provider)
    expect(writes).toEqual([])
    expect(report.results[0]?.plan?.unposted).toContain(reason)
    expect(report.results[0]?.moved).toBeUndefined()
    expect(formatReport(report)).toContain(`plan not posted: ${reason}`)
  }
  const someone = await finishedRun(planRule, [issue(3)], planner(tasks))
  expect(someone.writes).toEqual([])
  expect(someone.report.results[0]?.plan).toEqual({
    tasks: ['api', 'web'],
    unposted: 'acme/api#3 not yours',
  })
})

it('posts a plan whose task shows an indented yaml example', async () => {
  const example =
    'tasks:\n  - id: cfg\n    title: Add the option\n    description: |\n      ```yaml\n      limits: { plan_tasks: 8 }\n      ```\n'
  const { report, writes } = await finishedRun(planRule, [yours(1)], planner(example))
  expect(report.results[0]?.plan).toMatchObject({ tasks: ['cfg'], url: 'https://example.com/1' })
  expect(writes[0]).toEqual([
    'acme/api#1',
    { op: 'comment', body: markComment(planComment('Two tasks: the API first.', example)) },
  ])
})

it("reports a plan whose post failed, its secrets masked, and doesn't move the card", async () => {
  const { report, lines } = await finishedRun(planRule, [yours(1)], planner(tasks), async () => {
    throw new Error('403 for s3cret')
  })
  expect(report.results[0]?.status).toBe('done')
  expect(report.results[0]?.plan).toMatchObject({ unposted: '403 for ***' })
  expect(report.results[0]?.moved).toBeUndefined()
  expect(lines).toContain(`acme-api-1: couldn't post its plan on acme/api#1: 403 for ***`)
})

it('posts no plan when the step asked questions instead', async () => {
  const { report, writes } = await finishedRun(planRule, [yours(1)], asker('Which?'))
  expect(
    writes.map(
      ([, w]) =>
        w.op === 'comment' && commentKind({ author: 'me', at: '', mine: true, body: w.body }),
    ),
  ).toEqual(['questions'])
  expect(report.results[0]?.plan).toBeUndefined()
})

it('goes from no plan to a posted one, waits, re-plans on feedback, and stops once approved, all read off the card', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-plan-'))
  const { forge } = await originForge(root)
  const config = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true } }
`)
  let card = yours(1)
  let at = 0
  // Every comment bumps `updated`, awaywork's own too, as on GitHub.
  const comment = (body: string, mine?: true) => {
    const time = `2026-10-25T0${++at}:00:00Z`
    card = {
      ...card,
      fields: { ...card.fields, updated: time },
      comments: [
        ...card.comments,
        { author: mine ? 'me' : 'sam', body, at: time, ...(mine && { mine }) },
      ],
    }
  }
  const source = {
    ...fakeSource(),
    items: async () => [card],
    write: async (_cfg: unknown, _item: Item, w: Write) => {
      if (w.op === 'comment') comment(w.body, true)
      return {}
    },
  } as Source
  const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
  let attempts: Attempts = {}
  const round = async (yaml: string, n: number) => {
    await linkPlanTasks([card], config, { builtin: builtinSkills }, forge, ctx)
    const plan = planRun({
      config,
      items: [card],
      allowances: { claude: allowance(config.budget, null, 0, config.windows) },
      skills: { builtin: builtinSkills },
      attempts,
    })
    const report = await runUnits({
      config,
      configDir: root,
      plan,
      runId: `r${n}`,
      runDir: join(root, `run-${n}`),
      dryRun: false,
      providers: { claude: planner(yaml) },
      sources: { github: source },
      forge,
      ctx,
      watch: () => ({ stop: async () => {} }),
      shortage: async () => undefined,
      skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    })
    attempts = recordAttempts(attempts, report)
    return { skipped: plan.skipped.map((s) => [s.kind, s.reason]), posted: report.results[0]?.plan }
  }
  const kinds = () => card.comments.map((c) => commentKind(c) ?? c.author)

  expect(await round(tasks, 1)).toMatchObject({ skipped: [], posted: { tasks: ['api', 'web'] } })
  const waiting = [
    ['waiting_for_approval', 'waiting for your approval of the plan on https://example.com/1'],
  ]
  // A teammate's comment is context, never an answer.
  comment('approve')
  expect(await round(tasks, 2)).toEqual({ skipped: waiting, posted: undefined })
  comment('approve if web waits for the API to merge', true)
  expect(await round('tasks:\n  - { id: api, title: A }\n  - { id: api, title: B }\n', 3)).toEqual({
    skipped: [],
    posted: { unposted: 'plan.yml: task id "api" is used twice' },
  })
  expect(await round(tasks, 4)).toEqual({
    skipped: [['unchanged', 'unchanged since run r3']],
    posted: undefined,
  })
  comment('Split web in two.', true)
  expect(await round('tasks:\n  - { id: api, title: VAT export endpoint }\n', 5)).toMatchObject({
    skipped: [],
    posted: { tasks: ['api'] },
  })
  expect(kinds()).toEqual(['plan', 'sam', 'me', 'me', 'plan'])
  expect(await round(tasks, 6)).toEqual({ skipped: waiting, posted: undefined })
  expect(
    await approveItem('github:acme/api#1', config, 'Keep the old route.', {
      sources: { github: source },
      ctx,
    }),
  ).toBe('plan approved: replied approve, with your notes, on https://example.com/1')
  expect(kinds()).toEqual(['plan', 'sam', 'me', 'me', 'plan', 'approve'])
  expect(await round(tasks, 7)).toEqual({
    skipped: [['fanned_out', 'fanned out: api no PR yet']],
    posted: undefined,
  })
  await expect(
    approveItem('github:acme/api#1', config, '', {
      sources: { github: source },
      ctx,
    }),
  ).rejects.toThrow('was already answered by me')
})

it("posts a report that waits with how to answer, holding on_done's move until you approve", async () => {
  const { report, writes } = await finishedRun(
    '  - { skill: review, deliver: report, wait: true, on_done: { move: QA } }',
    [yours(1)],
  )
  const body = resultComment('acme-api-1 says nothing.', 'done', 'review', undefined, 0, true)
  expect(writes).toEqual([
    [
      'acme/api#1',
      { op: 'comment', body: markComment(body, { waits: true, move: 'QA', saw: 'open' }) },
    ],
  ])
  expect(body).toMatch(/\n\nStatus: done\n\nTo approve, reply with approve as the first line\./)
  expect(report.results[0]?.moved).toBeUndefined()
  expect(formatReport(report)).toContain(
    '- **api#1**: result posted on https://example.com/1; it waits for your approve, holding the move to "QA"',
  )
})

it("runs a report rule's own command gate on a read-only copy of what the step left: one that fires holds the post, one that holds lets it go ahead", async () => {
  const gate = (exit: number) =>
    `  - { skill: review, deliver: report, on_done: { move: QA }, gates: { taste: { command: '(echo hacked >> "$AWAYWORK_OUT_DIR/report.md" || touch "$AWAYWORK_OUT_DIR/new") 2>/dev/null || cat "$AWAYWORK_OUT_DIR/report.md"; exit ${exit}' } } }`
  const fired = await finishedRun(gate(1), [yours(1)])
  const card =
    '## Needs a decision\n\n### Gates (from scripts)\n\n- taste: acme-api-1 says nothing.\n\n---'
  const held = resultComment(
    `${card}\n\nacme-api-1 says nothing.`,
    'done',
    'review',
    undefined,
    0,
    true,
  )
  expect(fired.writes).toEqual([
    [
      'acme/api#1',
      { op: 'comment', body: markComment(held, { waits: true, move: 'QA', saw: 'open' }) },
    ],
  ])
  expect(fired.report.results[0]?.outcome).toMatchObject({
    gates: { ran: ['taste'], fired: 'gate taste fired' },
  })
  const clear = await finishedRun(gate(0), [yours(1)])
  const went = resultComment(
    'Gates: none fired (taste)\n\n---\n\nacme-api-1 says nothing.',
    'done',
    'review',
  )
  expect(clear.writes).toEqual([
    ['acme/api#1', { op: 'comment', body: markComment(went, { went: true, gates: ['taste'] }) }],
    ['acme/api#1', { op: 'move', to: 'QA' }],
  ])
})

it('posts a plan that went ahead saying a reply changes nothing, not how to approve', async () => {
  const provider: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      const out = join(job.dir, '.away/out')
      await writeFile(join(out, 'report.md'), 'One task.')
      await writeFile(join(out, 'plan.yml'), 'tasks:\n  - { id: api, title: API }\n')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const { writes } = await finishedRun(
    '  - { skill: plan, deliver: plan, wait: false }\n  - { skill: implement, where: { planned: true } }',
    [yours(1)],
    provider,
  )
  const [[, write]] = writes as [[string, Write]]
  expect(write.op === 'comment' && write.body).toMatch(
    /```\n\nThis plan went ahead without your approve: a reply to it changes nothing\.\n\n— awaywork · went ahead$/,
  )
})

it("gives a plan's judge a read-only copy of the step's out files and its gate's instructions, not the rule's, and posts the plan as the step left it", async () => {
  const notes = join(await mkdtemp(join(tmpdir(), 'awaywork-judges-')), 'product.md')
  await writeFile(notes, 'Copy changes need design.')
  const rules = join(await mkdtemp(join(tmpdir(), 'awaywork-rule-')), 'plan.md')
  await writeFile(rules, 'Plan small.')
  const seen: string[] = []
  const provider: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      const out = join(job.dir, '.away/out')
      if (job.unit.skill === 'judge') {
        const prompt = await readFile(join(job.dir, '.away/prompt.md'), 'utf8')
        seen.push(await readFile(join(job.dir, '.away/context/out/plan.yml'), 'utf8'))
        seen.push(prompt.includes('Copy changes need design.') ? 'gate notes' : 'no notes')
        seen.push(prompt.includes('Plan small.') ? 'rule notes' : 'no rule notes')
        seen.push(prompt.includes('a read-only copy of its `.away/out/`') ? 'out files' : 'a diff')
        await writeFile(join(out, 'plan.yml'), 'tasks: []\n')
        await writeFile(join(out, 'verdict'), 'fires\n')
        await writeFile(join(out, 'report.md'), '- Export button copy → design decides')
      } else {
        await writeFile(join(out, 'report.md'), 'One task.')
        await writeFile(join(out, 'plan.yml'), 'tasks:\n  - { id: api, title: API }\n')
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const { report, writes } = await finishedRun(
    `  - { skill: plan, deliver: plan, wait: false, instructions: [${rules}], gates: { product: { skill: judge, instructions: [${notes}] } } }\n  - { skill: implement, where: { planned: true } }`,
    [yours(1)],
    provider,
  )
  expect(seen).toEqual([
    'tasks:\n  - { id: api, title: API }\n',
    'gate notes',
    'no rule notes',
    'out files',
  ])
  const [[, write]] = writes as [[string, Write]]
  const body = write.op === 'comment' ? write.body : ''
  expect(body).toMatch(
    /^## Needs a decision\n\n### Judge\n\n- product: the judge changed the clone; awaywork dropped its changes\n- product: Export button copy → design decides\n\n---\n\nOne task\.\n\n```yaml\ntasks:\n {2}- \{ id: api, title: API \}\n```\n/,
  )
  // A fired gate holds a plan that would go ahead: a plan with no post state waits.
  expect(body.endsWith('\n\n— awaywork')).toBe(true)
  expect(report.results[0]?.plan).toMatchObject({ tasks: ['api'], post: { waits: true } })
})

const couldntStart = (reason: string) => ({
  type: 'done' as const,
  ok: false,
  turns: 1,
  reason,
})

it("fails a unit whose worker couldn't start, the report saying why with secrets masked, and counts the attempt", async () => {
  const provider: Provider = {
    ...fakeProvider('claude'),
    async *run() {
      yield couldntStart('Not logged in as s3cret · Please run /login')
    },
  }
  const { report } = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { comment: result } }',
    [yours(1)],
    provider,
  )
  expect(report.results[0]).toMatchObject({
    status: 'failed',
    reason: 'Not logged in as *** · Please run /login',
  })
  expect(formatReport(report)).toContain(
    'failed, 1 turn (Not logged in as *** · Please run /login)',
  )
  expect(formatReport(report)).not.toContain('s3cret')
  expect(Object.values(recordAttempts({}, report))[0]).toMatchObject({ failed: 1 })
})

it("fires a post's gate with its judge's reason, masked, when the judge couldn't start", async () => {
  const provider: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      if (job.unit.skill === 'judge') return yield couldntStart('Not logged in as s3cret')
      await writeFile(join(job.dir, '.away/out/report.md'), 'Fine.')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const { writes } = await finishedRun(
    '  - { skill: review, deliver: report, wait: false, on_done: { comment: result }, gates: { risk: { skill: judge } } }',
    [yours(1)],
    provider,
  )
  const [[, write]] = writes as [[string, Write]]
  expect(write.op === 'comment' && write.body).toContain(
    "- risk: judge didn't run: Not logged in as ***\n",
  )
})
