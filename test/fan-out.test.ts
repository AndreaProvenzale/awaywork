import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { formatRules, formatWhy, planJson } from '../src/cli/format.js'
import { linkPlanTasks } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { type Attempts, recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { taskItem, taskMarkdown, taskPr } from '../src/core/fanout.js'
import {
  approveReply,
  commentKind,
  commentMarkdown,
  footer,
  markComment,
  planComment,
  questionsComment,
  waitingTasks,
} from '../src/core/footer.js'
import { needsYou, planRun } from '../src/core/foreman.js'
import { checkPlan, planContract, planState, taskPrUrls } from '../src/core/plan.js'
import { rank, ruleFor } from '../src/core/queue.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Provider, Source, TaskPr, Unit, Write } from '../src/core/types.js'
import { linksItem, prText } from '../src/forge/pr.js'
import { writeItem } from '../src/sources/index.js'
import { freeBranch } from '../src/worker/slices.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const configOf = (queue: string, extra = '') =>
  parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
${extra}queue:
${queue}
`)
const queue = `  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true } }
`
const config = configOf(queue)

const yaml = `tasks:
  - { id: api, title: VAT export endpoint, description: Add GET /exports/vat. }
  - { id: web, title: Export button, after: { api: merged } }
`
const at = (n: number) => `2026-10-2${n}T00:00:00Z`
const posted = (body: string, n: number) => ({
  author: 'me',
  body: markComment(body),
  at: at(n),
  mine: true as const,
})
const planned = (plan = yaml, n = 1) => posted(planComment('Two tasks.', plan), n)
const yours = (body: string, n = 2) => ({ author: 'me', body, at: at(n), mine: true as const })
const theirs = (body: string, n: number) => ({ author: 'sam', body, at: at(n) })

const card = (comments: Item['comments'], taskPrs: Record<string, TaskPr> = {}): Item =>
  fakeItem({
    source: 'github',
    id: '1',
    key: 'acme/api#1',
    type: 'issue',
    title: 'VAT export',
    description: 'Accountants want a VAT export.',
    mine: true,
    comments,
    fields: { repo: 'acme/api', updated: at(5), label: ['feature'] },
    taskPrs,
  })
const approved = (taskPrs: Record<string, TaskPr> = {}, ...more: Item['comments']) =>
  card([planned(), yours(approveReply('Keep the old route.')), ...more], taskPrs)

const pr = (id: string, state: TaskPr['state'], closedAt?: string): TaskPr => ({
  repo: 'acme/api',
  number: id.length,
  url: `https://github.com/acme/api/pull/${id}`,
  branch: `away/acme-api-1-${id}`,
  ours: true,
  mine: true,
  trusted: true,
  fork: false,
  state,
  ...(closedAt && { closedAt }),
})

const allowances = { claude: allowance(config.budget, null, 0, config.windows) }
const plan = (items: Item[], cfg = config, attempts: Attempts = {}) =>
  planRun({ config: cfg, items, allowances, skills: { builtin: builtinSkills }, attempts })
const skips = (p: ReturnType<typeof plan>) => p.skipped.map((s) => [s.item.key, s.kind, s.reason])
const units = (p: ReturnType<typeof plan>) => p.units.map((u) => [u.unit.id, u.unit.branch])

describe('plan checks for tasks', () => {
  const limits = { maxTasks: 8, repo: 'acme/api', skills: ['implement'] }
  const problem = (text: string, more = {}) => {
    const checked = checkPlan(text, { ...limits, ...more })
    return 'problem' in checked ? checked.problem : undefined
  }

  it("takes a skill only when a planned rule takes it, implement when it's unset", () => {
    expect(problem('tasks: [{ id: api, title: A }]')).toBeUndefined()
    expect(problem('tasks: [{ id: api, title: A, skill: implement }]')).toBeUndefined()
    expect(problem('tasks: [{ id: api, title: A, skill: fix }]')).toBe(
      'task api: no planned rule takes skill fix',
    )
    expect(problem('tasks: [{ id: api, title: A }]', { skills: ['fix'] })).toBe(
      'task api: no planned rule takes skill implement',
    )
  })

  it('refuses a retired id, naming its closed PR', () => {
    const retired = { web: 'https://github.com/acme/api/pull/9' }
    expect(problem('tasks: [{ id: web, title: W }]', { retired })).toBe(
      'task id "web" is retired: its PR https://github.com/acme/api/pull/9 was closed without merging',
    )
    expect(problem('tasks: [{ id: docs, title: D }]', { retired })).toBeUndefined()
  })

  it("tells the plan step the planned rules' skills, the retired ids and the ids with a PR", () => {
    const taskPrs = { api: pr('api', 'merged'), web: pr('web', 'closed') }
    const kept = taskPrUrls({ taskPrs }, (p) => p.state !== 'closed')
    expect(kept).toEqual({ api: 'https://github.com/acme/api/pull/api' })
    const text = planContract({ ...limits, retired: { web: 'https://x/9' } }, kept)
    expect(text).toContain('a `skill` (one of `implement`; `implement` when unset)')
    expect(text).toContain('`after`, a map from other task ids to `merged`')
    expect(text).toContain(
      "These tasks' PRs were closed without merging, so their ids are retired and no task may reuse them: `web` (https://x/9).",
    )
    expect(text).toContain(
      'These tasks already have a PR, open or merged: `api` (https://github.com/acme/api/pull/api). A task that keeps its id keeps its PR',
    )
    expect(planContract(limits)).not.toContain('These tasks')
  })

  it('takes plan rules only with a planned rule, which opens PRs, and planned only at the top', () => {
    const problems = (q: string) => {
      try {
        configOf(q)
        return []
      } catch (e) {
        return (e as Error).message.split('\n').slice(1)
      }
    }
    expect(problems('  - { skill: plan, deliver: plan }')).toEqual([
      expect.stringContaining(
        "queue[0].deliver: plan's tasks need a rule to take them: add one whose where names planned",
      ),
    ])
    expect(
      problems(`${queue}  - { skill: fix, where: { planned: true }, deliver: report }`),
    ).toEqual([
      expect.stringContaining(
        "queue[2].deliver: a plan's task opens its own PR, and that PR is how awaywork knows it's done: deliver draft_pr or pr, not report",
      ),
    ])
    expect(problems(`${queue}  - { skill: fix, where: { any: [{ planned: true }] } }`)).toEqual([
      expect.stringContaining("queue[2].where.any[0].planned: planned only takes a plan's tasks"),
    ])
    expect(problems(`${queue}  - { skill: fix, where: { planned: false } }`)).toEqual([
      expect.stringContaining('queue[2].where.planned: invalid value false'),
    ])
  })

  it("refuses a planned rule's branch template that renders from more than the task's key", () => {
    const problems = (extra: string, rule = '') => {
      try {
        configOf(
          `  - { skill: plan, deliver: plan }\n  - { skill: implement, where: { planned: true }${rule} }\n`,
          extra,
        )
        return []
      } catch (e) {
        return (e as Error).message.split('\n').slice(1)
      }
    }
    const refused = (template: string) =>
      expect.stringContaining(
        `queue[1].branch: a plan's task keeps its PR by its branch, which ${template} renders from the task's title or skill too: set branch on this rule from {key} alone`,
      )
    expect(problems('branch: "away/{title}"\n')).toEqual([refused('away/{title}')])
    expect(problems('repos: { acme/web: { branch: "feat/{key}-{title}" } }\n')).toEqual([
      refused('feat/{key}-{title}'),
    ])
    expect(problems('', ', branch: "{type}/{key}"')).toEqual([refused('{type}/{key}')])
    expect(problems('branch: "away/{title}"\n', ', branch: "away/{key}"')).toEqual([])
  })

  it('takes no task for a skill whose planned rule opens no PR, and lists only the others', () => {
    expect(problem('tasks: [{ id: qa, title: Q, skill: review }]', { noPr: ['review'] })).toBe(
      'task qa: the planned rule for skill review opens no PR, and a task is done when its PR merges',
    )
    const reviewing = configOf(`${queue}  - { skill: review, where: { planned: true } }\n`)
    const qa = 'tasks: [{ id: api, title: A }, { id: qa, title: Q, skill: review }]'
    const waiting = card([planned(qa)])
    expect(skips(plan([waiting], reviewing))).toEqual([
      [
        'acme/api#1',
        'invalid_plan',
        'plan refused: task qa: the planned rule for skill review opens no PR, and a task is done when its PR merges',
      ],
    ])
    const [unit] = plan([card([])], reviewing).units.map((u) => u.unit)
    expect(unit?.planLimits).toEqual({
      maxTasks: 8,
      repo: 'acme/api',
      repos: ['acme/*'],
      skills: ['implement'],
      noPr: ['review'],
      retired: {},
    })
    expect(planContract(unit?.planLimits ?? limits)).toContain(
      'a `skill` (one of `implement`; `implement` when unset)',
    )
  })

  it("puts the card's limits on its plan unit, every id whose PR closed unmerged retired", () => {
    const closed = card([], { api: pr('api', 'merged'), web: pr('web', 'closed', at(3)) })
    const [unit] = plan([closed]).units.map((u) => u.unit)
    expect(unit?.planLimits).toMatchObject({
      skills: ['implement'],
      retired: { web: 'https://github.com/acme/api/pull/web' },
    })
  })

  it('refuses two planned rules for one source on different branches: a re-plan may move a task between them', () => {
    const problems = (rules: string) => {
      try {
        configOf(`  - { skill: plan, deliver: plan }\n${rules}`)
        return []
      } catch (e) {
        return (e as Error).message.split('\n').slice(1)
      }
    }
    const refused = (i: number) =>
      expect.stringContaining(
        `queue[${i}].branch: a re-plan may hand a task another skill, and so another planned rule, which must find its PR on the same branch: set the same branch on every planned rule for its source, or on none`,
      )
    expect(
      problems(
        '  - { skill: implement, where: { planned: true } }\n  - { skill: fix, branch: "fix/{key}", where: { planned: true } }\n',
      ),
    ).toEqual([refused(1), refused(2)])
    expect(
      problems(
        '  - { skill: implement, branch: "t/{key}", where: { planned: true } }\n  - { skill: fix, branch: "t/{key}", where: { planned: true } }\n  - { skill: fix, branch: "fix/{key}" }\n',
      ),
    ).toEqual([])
    expect(() =>
      parseConfig(`providers: [claude: {}]
sources: { github: { repos: [acme/*] }, jira: { site: a.atlassian.net, email: d@a.test } }
queue:
  - { skill: plan, deliver: plan }
  - { skill: implement, source: github, where: { planned: true } }
  - { skill: implement, source: jira, branch: "jira/{key}", where: { planned: true } }
`),
    ).not.toThrow()
  })
})

describe('reading a fanned-out plan back', () => {
  it('plans again once an approved task PR closed unmerged after the plan, and refuses a plan reusing its id', () => {
    const limits = { maxTasks: 8, repo: 'acme/api', skills: ['implement'] }
    expect(planState(approved({ api: pr('api', 'open') }), limits)).toMatchObject({
      state: 'approved',
    })
    const closed = { api: pr('api', 'merged'), web: pr('web', 'closed', at(3)) }
    expect(planState(approved(closed), limits)).toEqual({ state: 'replan', closed: ['web'] })
    // The re-plan posted after the close still names web: that's your edit, refused.
    const replan = card([planned(), yours('approve'), planned(yaml, 4)], closed)
    expect(planState(replan, limits)).toEqual({
      state: 'invalid',
      problem:
        'task id "web" is retired: its PR https://github.com/acme/api/pull/web was closed without merging',
    })
  })
})

describe('tasks as items', () => {
  it("makes each task an item of the card's source, URL, owner, fields and thread", () => {
    const parent = approved()
    const [api] = checkPlanTasks()
    const task = taskItem(parent, api as Parameters<typeof taskItem>[1], checkPlanTasks(), 'Go.')
    expect(task).toMatchObject({
      source: 'github',
      key: 'acme/api#1/api',
      type: 'task',
      title: 'VAT export endpoint',
      description: 'Add GET /exports/vat.',
      url: 'https://example.com/1',
      mine: true,
      linkedPrs: [],
      link: 'Part of https://example.com/1',
      fields: { repo: 'acme/api', updated: at(5), label: ['feature'] },
      comments: parent.comments,
      task: { id: 'api', skill: 'implement', notes: 'Go.' },
    })
    expect(task.task?.parent).toBe(parent)
    const approvedCard = { ...parent, fields: { ...parent.fields, approved: true } }
    expect(taskItem(approvedCard, { id: 'api', title: 'A' }).fields.approved).toBe(false)
    const md = taskMarkdown(task)
    expect(md).toContain(
      '# acme/api#1/api: VAT export endpoint\n\nhttps://example.com/1\n\nAdd GET /exports/vat.\n',
    )
    expect(md).toContain('This is task `api` of the plan you approved on acme/api#1.')
    expect(md).toContain(
      '- `api`: VAT export endpoint (this task)\n- `web`: Export button, after api merged',
    )
    expect(md).toContain('Your notes on approving it:\n\nGo.')
    expect(md).toContain('## The card: acme/api#1, VAT export\n\nAccountants want a VAT export.')
    expect(md).toContain("### awaywork's plan (me)")
  })

  it('goes to the first planned rule for its skill only, which takes nothing else', () => {
    const q =
      configOf(`  - { skill: implement }
  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true, label: backend } }
  - { skill: implement, where: { planned: true } }
  - { skill: fix, where: { planned: true } }
`).queue ?? []
    const task = (skill?: string) =>
      taskItem(approved(), { id: 'api', title: 'A', ...(skill && { skill }) })
    expect(ruleFor(q, task())).toBe(-1)
    expect(ruleFor(q, { ...task(), fields: { ...task().fields, label: ['backend'] } })).toBe(2)
    expect(ruleFor(q, task('fix'))).toBe(4)
    expect(ruleFor(q, task('review'))).toBe(-1)
    const issue = fakeItem({ source: 'github', key: 'acme/api#2', type: 'issue' })
    expect(rank([issue], q.slice(2)).unmatched).toEqual([issue])
  })

  it('fans out onto away/<card>-<id>, or the configured template, and names the card in --why', () => {
    const fanned = plan([approved()])
    expect(units(fanned)).toEqual([['acme-api-1-api', 'away/acme-api-1-api']])
    const branchy = configOf(queue, 'branch: "feat/{key}"\n')
    expect(units(plan([approved()], branchy))).toEqual([['acme-api-1-api', 'feat/acme-api-1-api']])
    const ruled = configOf(
      `  - { skill: plan, deliver: plan }\n  - { skill: implement, where: { planned: true }, branch: "task/{key}" }\n`,
      'branch: "feat/{title}"\n',
    )
    expect(units(plan([approved()], ruled))).toEqual([['acme-api-1-api', 'task/acme-api-1-api']])
    const task = fanned.units[0]?.unit.items[0] as Item
    expect(formatWhy(fanned, task)).toContain('  task api of the plan on acme/api#1')
    const json = JSON.parse(planJson(fanned))
    expect(json.units[0].unit.items[0].task.parent).toEqual({
      source: 'github',
      key: 'acme/api#1',
      title: 'VAT export',
      url: 'https://example.com/1',
    })
    expect(json.units[0].unit.items[0].comments).toHaveLength(2)
  })

  it('waits for a task the other is after, and for review of an open task PR', () => {
    expect(skips(plan([approved({ api: pr('api', 'open') })]))).toEqual([
      ['acme/api#1', 'fanned_out', 'fanned out: api PR open, web waits for api'],
      ['acme/api#1/web', 'waiting_for_task', "waiting for task api's PR to merge"],
      [
        'acme/api#1/api',
        'waiting_for_review',
        'waiting for review: awaywork PR https://github.com/acme/api/pull/api is open',
      ],
    ])
    expect(needsYou.waiting_for_task).toBe(false)
    const merged = plan([approved({ api: pr('api', 'merged') })])
    expect(units(merged)).toEqual([['acme-api-1-web', 'away/acme-api-1-web']])
    expect(skips(merged)).toEqual([
      ['acme/api#1', 'fanned_out', 'fanned out: api merged, web no PR yet'],
      ['acme/api#1/api', 'task_merged', 'merged in https://github.com/acme/api/pull/api'],
    ])
  })

  it('needs you once every task merged, to close or move the card', () => {
    const done = plan([approved({ api: pr('api', 'merged'), web: pr('web', 'merged') })])
    expect(done.units).toEqual([])
    expect(skips(done)[0]).toEqual([
      'acme/api#1',
      'all_tasks_merged',
      'all tasks merged: close or move the card',
    ])
    expect(needsYou.all_tasks_merged).toBe(true)
  })

  it('runs nothing for a card no longer yours, on Bitbucket, or whose task PRs went unread', () => {
    expect(skips(plan([{ ...approved(), mine: undefined }]))).toEqual([
      [
        'acme/api#1',
        'refused_delivery',
        "plan approved, but the card isn't yours: its tasks don't run",
      ],
    ])
    const failed = "its plan's tasks' PRs couldn't be read"
    expect(skips(plan([{ ...approved(), taskPrs: null }]))).toEqual([
      ['acme/api#1', 'fanned_out', failed],
    ])
    const feedback = plan([{ ...card([planned(), theirs('Split web.', 2)]), taskPrs: null }])
    expect(feedback.units).toEqual([])
    expect(skips(feedback)).toEqual([['acme/api#1', 'fanned_out', failed]])
    // A second plan waiting for you still needs you when its tasks' PRs went unread.
    const waiting = {
      ...card([planned(), theirs('Split web.', 2), planned(yaml, 3)]),
      taskPrs: null,
    }
    expect(skips(plan([waiting]))).toEqual([
      [
        'acme/api#1',
        'waiting_for_approval',
        'waiting for your approval of the plan on https://example.com/1',
      ],
    ])
    const bitbucket = parseConfig(`
providers: [claude: {}]
sources: { bitbucket: { repos: [acme/api] }, tracker: { command: 'echo []', write: 'cat' } }
queue:
${queue}`)
    const tracked = { ...approved(), source: 'tracker' }
    expect(skips(plan([tracked], bitbucket))).toEqual([
      [
        'acme/api#1',
        'refused_delivery',
        "plan approved, but its tasks don't run on Bitbucket yet: awaywork can't read their merged and closed PRs there",
      ],
    ])
  })

  it("holds every task while one's questions on the card wait, and one reply answers two", () => {
    const ask = (task: string, n: number) =>
      posted(questionsComment('Per user or per key?', task), n)
    const both = [ask('api', 3), ask('web', 4)]
    expect(waitingTasks({ comments: both })).toEqual(['api', 'web'])
    expect(waitingTasks({ comments: [...both, theirs('Per key, both.', 5)] })).toEqual([])
    expect(
      waitingTasks({ comments: [ask('api', 3), theirs('Per key.', 4), ask('web', 5)] }),
    ).toEqual(['web'])
    expect(waitingTasks({ comments: [...both, posted(approveReply(''), 5)] })).toEqual([
      'api',
      'web',
    ])
    const held = plan([approved({}, ask('api', 3))])
    expect(held.units).toEqual([])
    expect(skips(held)).toEqual([
      [
        'acme/api#1',
        'fanned_out',
        'fanned out: api waits for your answer, web waits for your answer',
      ],
      [
        'acme/api#1/api',
        'waiting_for_answer',
        "waiting for your answer to task api's questions on https://example.com/1",
      ],
      [
        'acme/api#1/web',
        'waiting_for_answer',
        "waiting for your answer to task api's questions on https://example.com/1",
      ],
    ])
    expect(units(plan([approved({}, ask('api', 3), theirs('Per key.', 4))]))).toEqual([
      ['acme-api-1-api', 'away/acme-api-1-api'],
    ])
    const comment = ask('api', 3)
    expect(commentKind(comment)).toBe('questions')
    expect(commentMarkdown(comment)).toMatch(/^\n### awaywork's questions from task api \(me\), /)
  })

  it("writes a task's comments and moves to its card", async () => {
    const writes: [string, Write][] = []
    const source = {
      ...fakeSource(),
      write: async (_cfg: unknown, item: Item, w: Write) => {
        writes.push([item.key, w])
        return {}
      },
    } as Source
    const task = taskItem(approved(), { id: 'api', title: 'A' })
    const ctx = { env: {}, log: () => {} }
    await writeItem(source, {}, task, { op: 'move', to: 'In review' }, ctx)
    await writeItem(source, {}, task, { op: 'comment', body: 'Hi' }, ctx)
    expect(writes).toEqual([
      ['acme/api#1', { op: 'move', to: 'In review' }],
      ['acme/api#1', { op: 'comment', body: markComment('Hi') }],
    ])
    await expect(
      writeItem(source, {}, { ...task, mine: undefined }, { op: 'move', to: 'QA' }, ctx),
    ).rejects.toThrow('not yours')
  })
})

describe("a task's PR", () => {
  const task = {
    card: card([]),
    key: 'acme/api#1/api',
    repo: 'acme/api',
    branch: 'away/acme-api-1-api',
  }
  const body = (key: string) => `Done.\n\n${footer('r1', [{ source: 'github', key }])}`
  const on = (number: number, state: 'open' | 'merged' | 'closed', key = task.key) => ({
    url: `https://github.com/acme/api/pull/${number}`,
    number,
    body: body(key),
    open: state === 'open',
    merged: state === 'merged',
    ...(state !== 'open' && { closedAt: at(3) }),
  })

  it('is the one on its branch whose footer names the task, open or merged first', () => {
    expect(taskPr([], task)).toBeUndefined()
    expect(taskPr([on(4, 'open', 'acme/api#1')], task)).toBeUndefined()
    expect(taskPr([on(4, 'closed'), on(5, 'open')], task)).toMatchObject({
      number: 5,
      state: 'open',
    })
    expect(taskPr([on(4, 'closed'), on(5, 'merged')], task)).toMatchObject({
      number: 5,
      state: 'merged',
    })
    expect(taskPr([on(4, 'closed')], task)).toEqual({
      repo: 'acme/api',
      number: 4,
      url: 'https://github.com/acme/api/pull/4',
      branch: 'away/acme-api-1-api',
      ours: true,
      mine: true,
      trusted: true,
      fork: false,
      state: 'closed',
      closedAt: at(3),
    })
  })

  it('links a task to its PR, never the card, though the branch carries the card key', () => {
    const pr = { branch: 'away/acme-api-1-api', title: 'VAT export endpoint', body: body(task.key) }
    const parent = { ...card([]), key: 'ENG-2101', source: 'jira' }
    const jira = {
      ...pr,
      branch: 'away/ENG-2101-api',
      body: body('ENG-2101/api').replace('github', 'jira'),
    }
    expect(linksItem(parent)(jira)).toBe(false)
    expect(linksItem(taskItem(parent, { id: 'api', title: 'A' }))(jira)).toBe(true)
    expect(linksItem(parent)({ ...jira, body: 'By hand.' })).toBe(true)
  })

  it('is read for every task any plan on the card names, by its branch', async () => {
    const forge = fakeForge()
    forge.heads['acme/api:away/acme-api-1-api'] = [on(4, 'merged')]
    forge.heads['acme/api:away/acme-api-1-old'] = [on(3, 'closed', 'acme/api#1/old')]
    const old = 'tasks: [{ id: old, title: Old }]'
    const parent = {
      ...card([planned(old, 1), theirs('No.', 2), planned(yaml, 3)]),
      taskPrs: undefined,
    }
    const lines: string[] = []
    await linkPlanTasks([parent], config, { builtin: builtinSkills }, forge, {
      env: {},
      log: (l) => lines.push(l),
    })
    expect(parent.taskPrs).toMatchObject({
      api: { number: 4, state: 'merged' },
      old: { number: 3, state: 'closed' },
    })
    expect(Object.keys(parent.taskPrs ?? {})).toEqual(['api', 'old'])
    const failing = { ...forge, prsOn: async () => Promise.reject(new Error('502')) }
    const unread = { ...parent, taskPrs: undefined }
    await linkPlanTasks([unread], config, { builtin: builtinSkills }, failing, {
      env: {},
      log: (l) => lines.push(l),
    })
    expect(unread.taskPrs).toBeNull()
    expect(lines).toContain("reading acme/api#1/api's PR on away/acme-api-1-api: 502")
  })

  it('is not read while the first plan waits for its answer, nothing having run yet', async () => {
    const ctx = { env: {}, log: () => {} }
    let calls = 0
    const counting = {
      ...fakeForge(),
      prsOn: async () => {
        calls++
        return []
      },
    }
    const first = { ...card([planned()]), taskPrs: undefined }
    await linkPlanTasks([first], config, { builtin: builtinSkills }, counting, ctx)
    expect([calls, first.taskPrs]).toEqual([0, undefined])
    const answered = { ...card([planned(), theirs('Split web.', 2)]), taskPrs: undefined }
    await linkPlanTasks([answered], config, { builtin: builtinSkills }, counting, ctx)
    expect([calls, answered.taskPrs]).toEqual([2, {}])
  })
})

/** A forge on a local origin whose PRs carry the real body and footer, and can be merged or closed. */
async function originForge(root: string) {
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const fake = fakeForge()
  const bodies: Record<string, string> = {}
  let n = 10
  const forge = {
    ...fake,
    clone: async (_repo: string, branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    openPr: async (
      repo: string,
      head: string,
      _base: string,
      bodyFile: string,
      runId: string,
      items: Pick<Item, 'source' | 'key'>[],
    ) => {
      const { body } = await prText(bodyFile, head, runId, items)
      const url = `https://github.com/${repo}/pull/${++n}`
      bodies[head] = body
      fake.heads[`${repo}:${head}`] = [{ url, number: n, body, open: true }]
      return url
    },
  }
  const settle = (branch: string, merged: boolean, closedAt: string) => {
    const [pr] = fake.heads[`acme/api:${branch}`] ?? []
    if (pr) Object.assign(pr, { open: false, merged, closedAt })
  }
  return { forge, bodies, settle }
}

it('fans out, merges one task, re-plans on the closed one, and needs you once all merged, all read off the card and the forge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-fanout-'))
  const { forge, bodies, settle } = await originForge(root)
  let clock = 0
  const tick = () => `2026-10-25T${String(++clock).padStart(2, '0')}:00:00Z`
  let item = card([])
  const comment = (body: string, mine?: true) => {
    const time = tick()
    item = {
      ...item,
      fields: { ...item.fields, updated: time },
      comments: [
        ...item.comments,
        { author: mine ? 'me' : 'sam', body, at: time, ...(mine && { mine }) },
      ],
    }
  }
  const source = {
    ...fakeSource(),
    items: async () => [item],
    write: async (_cfg: unknown, _item: Item, w: Write) => {
      if (w.op === 'comment') comment(w.body, true)
      return {}
    },
  } as Source
  const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
  const prompts: Record<string, string> = {}
  let planYml = yaml.replace(', after: { api: merged }', '')
  const worker: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      prompts[job.unit.id] = job.prompt
      const out = join(job.dir, '.away/out')
      if (job.unit.deliver === 'plan') {
        await writeFile(join(out, 'report.md'), 'The plan.')
        await writeFile(join(out, 'plan.yml'), planYml)
      } else {
        await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${job.unit.id}`)
        await writeFile(join(out, 'pr.md'), `Implement ${job.unit.id}\n\nDone.`)
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  let attempts: Attempts = {}
  const round = async (n: number) => {
    const [read] = await source.items({}, ctx)
    const cardNow = { ...(read as Item) }
    await linkPlanTasks([cardNow], config, { builtin: builtinSkills }, forge, ctx)
    const planned = plan([cardNow], config, attempts)
    const report = await runUnits({
      config,
      configDir: root,
      plan: planned,
      runId: `r${n}`,
      runDir: join(root, `run-${n}`),
      dryRun: false,
      providers: { claude: worker },
      sources: { github: source },
      forge,
      ctx,
      watch: () => ({ stop: async () => {} }),
      shortage: async () => undefined,
      skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    })
    attempts = recordAttempts(attempts, report)
    const unposted = report.results[0]?.plan?.unposted
    return {
      skipped: skips(planned),
      ran: report.results.map((r) => [r.planned.unit.id, r.outcome?.kind]),
      ...(unposted && { unposted }),
    }
  }
  const approve = () =>
    approveItem('github:acme/api#1', config, '', { sources: { github: source }, ctx })

  expect(await round(1)).toEqual({ skipped: [], ran: [['acme-api-1', 'report']] })
  expect(prompts['acme-api-1']).toContain('a `skill` (one of `implement`; `implement` when unset)')
  await approve()

  expect(await round(2)).toEqual({
    skipped: [['acme/api#1', 'fanned_out', 'fanned out: api no PR yet, web no PR yet']],
    ran: [
      ['acme-api-1-api', 'pr'],
      ['acme-api-1-web', 'pr'],
    ],
  })
  const body = bodies['away/acme-api-1-api'] ?? ''
  expect(body).toContain('Part of https://example.com/1')
  expect(body).not.toMatch(/closes/i)
  expect(body).toContain('item=github:acme%2Fapi%231%2Fapi -->')
  expect(body).not.toContain('item=github:acme%2Fapi%231 ')

  expect(await round(3)).toMatchObject({
    skipped: [
      ['acme/api#1', 'fanned_out', 'fanned out: api PR open, web PR open'],
      ['acme/api#1/api', 'waiting_for_review', expect.any(String)],
      ['acme/api#1/web', 'waiting_for_review', expect.any(String)],
    ],
    ran: [],
  })

  settle('away/acme-api-1-api', true, tick())
  settle('away/acme-api-1-web', false, tick())
  expect(await round(4)).toEqual({
    skipped: [],
    ran: [['acme-api-1', 'report']],
    unposted:
      'plan.yml: task id "web" is retired: its PR https://github.com/acme/api/pull/12 was closed without merging',
  })
  expect(prompts['acme-api-1']).toContain(
    "These tasks' PRs were closed without merging, so their ids are retired and no task may reuse them: `web` (https://github.com/acme/api/pull/12).",
  )
  expect(item.comments.map((c) => commentKind(c) ?? c.author)).toEqual(['plan', 'approve'])

  comment('Drop web: put the button in the docs instead.')
  planYml =
    'tasks:\n  - { id: api, title: VAT export endpoint }\n  - { id: docs, title: Document the export, after: { api: merged } }\n'
  expect(await round(5)).toEqual({ skipped: [], ran: [['acme-api-1', 'report']] })
  expect(await round(6)).toMatchObject({
    skipped: [['acme/api#1', 'waiting_for_approval', expect.any(String)]],
  })
  await approve()

  expect(await round(7)).toEqual({
    skipped: [
      ['acme/api#1', 'fanned_out', 'fanned out: api merged, docs no PR yet'],
      ['acme/api#1/api', 'task_merged', 'merged in https://github.com/acme/api/pull/11'],
    ],
    ran: [['acme-api-1-docs', 'pr']],
  })
  settle('away/acme-api-1-docs', true, tick())
  expect(await round(8)).toEqual({
    skipped: [
      ['acme/api#1', 'all_tasks_merged', 'all tasks merged: close or move the card'],
      ['acme/api#1/api', 'task_merged', 'merged in https://github.com/acme/api/pull/11'],
      ['acme/api#1/docs', 'task_merged', 'merged in https://github.com/acme/api/pull/13'],
    ],
    ran: [],
  })
})

describe('a card carrying a plan', () => {
  const sticky = configOf(`  - { skill: plan, deliver: plan, where: { label: feature } }
  - { skill: implement, where: { planned: true }, on_done: { move: building } }
  - { skill: implement }
`)
  const moved = (item: Item): Item => ({ ...item, fields: { ...item.fields, label: ['building'] } })

  it('stays with the plan rule out of its where, until reassigned or closed, and no other rule takes it whole', () => {
    const q = sticky.queue ?? []
    expect(ruleFor(q, moved(card([planned()])))).toBe(0)
    expect(ruleFor(q, moved(card([])))).toBe(2)
    expect(ruleFor(q, { ...moved(card([planned()])), mine: undefined })).toBe(2)
    const closed = moved(card([planned()]))
    expect(ruleFor(q, { ...closed, fields: { ...closed.fields, state: 'closed' } })).toBe(-1)
    expect(skips(plan([moved(card([planned()]))], sticky))).toEqual([
      [
        'acme/api#1',
        'waiting_for_approval',
        'waiting for your approval of the plan on https://example.com/1',
      ],
    ])
    expect(units(plan([moved(approved({ api: pr('api', 'merged') }))], sticky))).toEqual([
      ['acme-api-1-web', 'away/acme-api-1-web'],
    ])
  })

  it('stays with the plan rule it still matches when its source has two, else the first', () => {
    const q =
      configOf(`  - { skill: plan, deliver: plan, where: { label: feature } }
  - { skill: review, deliver: plan, where: { label: big } }
  - { skill: implement, where: { planned: true } }
`).queue ?? []
    const big = (item: Item): Item => ({ ...item, fields: { ...item.fields, label: ['big'] } })
    expect(ruleFor(q, big(card([planned()])))).toBe(1)
    expect(ruleFor(q, card([planned()]))).toBe(0)
    expect(ruleFor(q, moved(card([planned()])))).toBe(0)
  })

  it('shows under plan --rules by the plan rule, marked when its where no longer holds it', () => {
    expect(formatRules(sticky.queue ?? [], [moved(card([planned()])), card([])])).toEqual([
      '#1  plan       label=feature deliver=plan',
      '     2 taken: acme/api#1 (plan), acme/api#1',
      '#2  implement  planned=true',
      '     0 taken',
      '#3  implement  every item',
      '     0 taken',
      '     2 taken by #1: acme/api#1, acme/api#1',
      '0 unmatched',
    ])
  })

  it('runs none of its tasks while you skip the card', () => {
    const skipped = planRun({
      config,
      items: [approved()],
      allowances,
      skills: { builtin: builtinSkills },
      skips: { 'github:acme/api#1': { reason: 'not now' } },
    })
    expect(skipped.units).toEqual([])
    expect(skipped.skipped.map((s) => [s.item.key, s.kind])).toEqual([
      ['acme/api#1', 'skipped_by_you'],
    ])
  })

  it("keeps running its tasks once a task's on_done moved it out of the plan rule's where", async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-fanout-'))
    const { forge, settle } = await originForge(root)
    let item = approved()
    const source = {
      ...fakeSource(),
      items: async () => [item],
      write: async (_cfg: unknown, _item: Item, w: Write) => {
        if (w.op === 'move') item = { ...item, fields: { ...item.fields, label: [w.to] } }
        return {}
      },
    } as Source
    const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
    const worker: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${job.unit.id}`)
        await writeFile(join(job.dir, '.away/out/pr.md'), `Implement ${job.unit.id}\n\nDone.`)
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    const round = async (n: number) => {
      const cardNow = { ...item }
      await linkPlanTasks([cardNow], sticky, { builtin: builtinSkills }, forge, ctx)
      const planned = plan([cardNow], sticky)
      const report = await runUnits({
        config: sticky,
        configDir: root,
        plan: planned,
        runId: `r${n}`,
        runDir: join(root, `run-${n}`),
        dryRun: false,
        providers: { claude: worker },
        sources: { github: source },
        forge,
        ctx,
        watch: () => ({ stop: async () => {} }),
        shortage: async () => undefined,
        skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
      })
      return report.results.map((r) => [r.planned.unit.id, r.outcome?.kind])
    }

    expect(await round(1)).toEqual([['acme-api-1-api', 'pr']])
    expect(item.fields.label).toEqual(['building'])
    settle('away/acme-api-1-api', true, at(6))
    expect(await round(2)).toEqual([['acme-api-1-web', 'pr']])
  })
})

/** The example plan's tasks, checked. */
function checkPlanTasks() {
  const checked = checkPlan(yaml, { maxTasks: 8, repo: 'acme/api' })
  return 'plan' in checked ? checked.plan.tasks : []
}

it('takes no other branch for a task: its PR is found by that name', async () => {
  const forge = fakeForge()
  forge.branches.add('acme/api:away/acme-api-1-api')
  const [unit] = plan([approved()]).units.map((u) => u.unit)
  expect(await freeBranch(forge, unit as Unit, new Set())).toEqual({
    skip: 'away/acme-api-1-api exists on acme/api; delete it to run this task',
  })
  expect(await freeBranch(fakeForge(), unit as Unit, new Set())).toEqual({
    branch: 'away/acme-api-1-api',
  })
})

it("posts a task's questions on its card, headed with the task, and holds the feature until answered", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-fanout-'))
  const { forge } = await originForge(root)
  const writes: [string, Write][] = []
  const source = {
    ...fakeSource(),
    write: async (_cfg: unknown, item: Item, w: Write) => {
      writes.push([item.key, w])
      return {}
    },
  } as Source
  const asker: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      await writeFile(join(job.dir, '.away/out/questions.md'), 'Per user or per key?')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const report = await runUnits({
    config,
    configDir: root,
    plan: plan([approved()]),
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: asker },
    sources: { github: source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const body = markComment(questionsComment('Per user or per key?', 'api'))
  expect(writes).toEqual([['acme/api#1', { op: 'comment', body }]])
  expect(body.startsWith('Questions from task api\n\nPer user or per key?')).toBe(true)
  expect(report.results[0]?.questions).toMatchObject({ item: 'github:acme/api#1/api' })
  const after = approved({}, { author: 'me', body, at: at(3), mine: true })
  expect(skips(plan([after])).map(([key, kind]) => [key, kind])).toEqual([
    ['acme/api#1', 'fanned_out'],
    ['acme/api#1/api', 'waiting_for_answer'],
    ['acme/api#1/web', 'waiting_for_answer'],
  ])
})
