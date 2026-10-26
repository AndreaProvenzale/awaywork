import { describe, expect, it } from 'vitest'
import {
  approveReply,
  awaitsAnswer,
  commentKind,
  commentMarkdown,
  commentTask,
  markComment,
  planComment,
  questionsComment,
  resultComment,
  resultStatus,
  waitingTasks,
} from '../src/core/footer.js'
import { checkPlan, doneTasks, planState, planYaml } from '../src/core/plan.js'
import type { Item } from '../src/core/types.js'

const limits = { maxTasks: 3, repo: 'acme/api' }
const problem = (yaml: string) => {
  const checked = checkPlan(yaml, limits)
  return 'problem' in checked ? checked.problem : undefined
}

const yaml = `tasks:
  - id: api
    title: VAT export endpoint
    description: |
      Add GET /exports/vat.

      Paged like /exports/sales.
    repo: acme/api
  - id: web
    title: Export button
    skill: implement
    after: { api: merged }
`

describe('plan.yml', () => {
  it('takes tasks with ids, titles and the optional keys', () => {
    expect(checkPlan(yaml, limits)).toEqual({
      plan: {
        tasks: [
          {
            id: 'api',
            title: 'VAT export endpoint',
            description: 'Add GET /exports/vat.\n\nPaged like /exports/sales.\n',
            repo: 'acme/api',
          },
          { id: 'web', title: 'Export button', skill: 'implement', after: { api: 'merged' } },
        ],
      },
    })
  })

  it('refuses each broken plan with the reason', () => {
    const task = (id: string, extra = '') => `  - { id: ${id}, title: T${extra} }\n`
    expect(problem('')).toBe('missing or empty')
    expect(problem('tasks: [')).toMatch(/^not YAML: /)
    expect(problem('tasks: []')).toMatch(/^tasks: /)
    expect(problem('- id: api')).toBe('Invalid input: expected object, received array')
    expect(problem(`tasks:\n  - { id: api }`)).toMatch(/^tasks\.0\.title: /)
    expect(problem(`tasks:\n${task('api', ', estimate: 3')}`)).toBe(
      'tasks.0: Unrecognized key: "estimate"',
    )
    expect(problem(`tasks:\n${task('api')}notes: hi`)).toBe('Unrecognized key: "notes"')
    expect(problem(`tasks:\n${task('a')}${task('b')}${task('c')}${task('d')}`)).toBe(
      '4 tasks, over limits.plan_tasks (3)',
    )
    expect(problem(`tasks:\n${task('Api')}`)).toBe(
      `task id "Api" isn't lowercase letters, digits and dashes`,
    )
    expect(problem(`tasks:\n${task('api/v2')}`)).toMatch(/^task id "api\/v2" isn't/)
    expect(problem(`tasks:\n${task('-api')}`)).toMatch(/^task id "-api" isn't/)
    expect(problem(`tasks:\n${task('api')}${task('api')}`)).toBe('task id "api" is used twice')
    expect(problem(`tasks:\n${task('api', ', repo: acme/web')}`)).toBe(
      "task api: repo acme/web isn't the card's (acme/api) or one the config names",
    )
    expect(problem(`tasks:\n${task('web', ', after: { db: merged }')}`)).toBe(
      'task web: after names no task "db"',
    )
    expect(problem(`tasks:\n${task('web', ', after: { api: 3 }')}${task('api')}`)).toMatch(
      /^tasks\.0\.after\.api: /,
    )
    expect(problem(`tasks:\n${task('api', ', after: { api: merged }')}`)).toBe(
      'tasks wait on each other: api → api',
    )
    const cycle = `tasks:\n${task('a', ', after: { c: merged }')}${task('b', ', after: { a: merged }')}${task('c', ', after: { b: merged }')}`
    expect(problem(cycle)).toBe('tasks wait on each other: a → c → b → a')
  })
})

const at = (n: number) => `2026-01-0${n}T00:00:00Z`
const posted = (body: string, n = 1) => ({
  author: 'me',
  body: markComment(body),
  at: at(n),
  mine: true as const,
})
const plan = posted(planComment('Two tasks: the API first.', yaml))
const yours = (body: string, n = 2) => ({ author: 'me', body, at: at(n), mine: true as const })
const theirs = (body: string, n = 2) => ({ author: 'sam', body, at: at(n) })
const bot = { author: 'ci', body: 'Coverage 91%', at: at(2), bot: true as const }
const state = (...comments: Item['comments']) => planState({ comments }, limits)

describe('the plan comment', () => {
  it('carries the report, plan.yml in a fence and how to answer, and gives plan.yml back', () => {
    expect(planComment('Two tasks.\n', 'tasks: []\n')).toBe(
      'Two tasks.\n\n```yaml\ntasks: []\n```\n\nTo approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.',
    )
    expect(planYaml(plan.body)).toBe(yaml.trim())
    expect(planYaml('Narrative\n\n```yaml\nold: 1\n```\n\n```yaml\ntasks: []\n```')).toBe(
      'tasks: []',
    )
    expect(planYaml('no fence')).toBe('')
  })

  it('reads fence lines with trailing spaces, but only at line start', () => {
    expect(planYaml('```yaml \ntasks: []\n```  ')).toBe('tasks: []')
    expect(planYaml(' ```yaml\ntasks: []\n```')).toBe('')
    const spaced = planComment('Two tasks.', yaml).replace('\n```\n', '\n``` \n')
    expect(state(posted(spaced))).toEqual({ state: 'waiting' })
  })

  it('reads back a plan whose task shows an indented yaml example, fences only at line start', () => {
    const example = `tasks:\n  - id: cfg\n    title: Add the option\n    description: |\n      Document it like this:\n      \`\`\`yaml\n      limits: { plan_tasks: 8 }\n      \`\`\`\n`
    const body = planComment('One task.', example)
    expect(planYaml(body)).toBe(example.trim())
    expect(state(posted(body))).toEqual({ state: 'waiting' })
  })

  it('tells awaywork comments apart by their visible text', () => {
    expect(commentKind(plan)).toBe('plan')
    expect(commentKind(posted(questionsComment('Per user?')))).toBe('questions')
    expect(commentKind(posted('Per user?'))).toBe('questions')
    expect(commentKind(posted(approveReply('Keep the route.')))).toBe('approve')
    expect(commentKind(yours('approve'))).toBeUndefined()
    expect(commentKind({ ...plan, mine: undefined })).toBeUndefined()
    expect(commentKind(posted(resultComment('All green.', 'done', 'triage')))).toBe('result')
    expect(commentKind(yours(resultComment('All green.', 'done', 'triage')))).toBeUndefined()
    // Your approve's notes may end in a status line; a result's heading never reads as approve.
    expect(commentKind(posted(approveReply('Keep it.\nStatus: done')))).toBe('approve')
    expect(commentKind(posted(resultComment('approve\nall of it', 'done', 'triage')))).toBe(
      'result',
    )
  })

  it("carries a result's status above the mark, and a task's result is headed with it", () => {
    const result = posted(resultComment('Evidence: 3 screenshots.\n', 'done', 'qa-evidence', 'qa'))
    expect(result.body).toBe(
      'Result of task qa\n\nEvidence: 3 screenshots.\n\nStatus: done\n\n— awaywork',
    )
    expect(resultStatus(result)).toBe('done')
    expect(commentTask(result)).toBe('qa')
    const unheaded = posted(resultComment('Result of task qa\n\nDone.', 'done', 'triage'))
    expect(unheaded.body).toMatch(/^Result of triage\n\nResult of task qa\n/)
    expect(commentTask(unheaded)).toBeUndefined()
    expect(commentTask(posted(questionsComment('Per user?', 'web')))).toBe('web')
    expect(resultStatus(posted(questionsComment('Status: done')))).toBeUndefined()
    // awaywork's result answers no question: the task's questions still wait.
    const asked = posted(questionsComment('Per user?', 'web'))
    expect(waitingTasks({ comments: [asked, result] })).toEqual(['web'])
  })

  it("waits for an answer only on awaywork's questions, not its plan or approve reply", () => {
    expect(awaitsAnswer({ comments: [posted(questionsComment('Per user?'))] })).toBe(true)
    expect(awaitsAnswer({ comments: [plan] })).toBe(false)
    expect(awaitsAnswer({ comments: [plan, posted(approveReply(''), 2)] })).toBe(false)
    const result = posted(resultComment('Done.', 'done', 'triage'), 2)
    expect(awaitsAnswer({ comments: [posted(questionsComment('Per user?')), result] })).toBe(true)
  })

  it('heads each kind in item.md, the approve reply as yours', () => {
    expect(commentMarkdown(plan)).toMatch(/^\n### awaywork's plan \(me\), /)
    expect(commentMarkdown(posted(questionsComment('Per user?')))).toMatch(
      /^\n### awaywork's questions \(me\), /,
    )
    expect(commentMarkdown(posted(approveReply('')))).toMatch(/^\n### me, /)
    expect(commentMarkdown(posted(resultComment('Done.', 'done', 'triage')))).toMatch(
      /^\n### awaywork's result \(me\), /,
    )
    expect(commentMarkdown(posted(resultComment('Done.', 'done', 'qa-evidence', 'qa')))).toMatch(
      /^\n### awaywork's result of task qa \(me\), /,
    )
    expect(commentMarkdown(posted(questionsComment('Which?', 'web')))).toMatch(
      /^\n### awaywork's questions from task web \(me\), /,
    )
  })
})

describe('a task done by its result', () => {
  const result = (task: string, n: number) =>
    posted(resultComment('Done.', 'done', 'qa-evidence', task), n)
  it("counts a task's done result only after the plan's approval, so a re-plan's leaves older ones behind", () => {
    const approve = posted(approveReply(''), 2)
    expect(doneTasks({ comments: [plan, result('qa', 2)] })).toEqual([])
    expect(doneTasks({ comments: [plan, approve, result('qa', 3), result('api', 4)] })).toEqual([
      'qa',
      'api',
    ])
    const replanned = posted(planComment('Again.', yaml), 5)
    expect(doneTasks({ comments: [plan, approve, result('qa', 3), replanned] })).toEqual([])
    expect(
      doneTasks({
        comments: [plan, approve, result('qa', 3), replanned, posted(approveReply(''), 6)],
      }),
    ).toEqual([])
  })

  it("never reads awaywork's result as the plan's answer", () => {
    expect(state(plan, result('qa', 2))).toEqual({ state: 'waiting' })
    const approve = posted(approveReply(''), 3)
    expect(doneTasks({ comments: [plan, result('api', 2), approve, result('qa', 4)] })).toEqual([
      'qa',
    ])
  })
})

describe('a plan read back from the card', () => {
  it('is none without a plan comment, and waits with no answer but a bot', () => {
    expect(state()).toBeUndefined()
    expect(state(theirs('Please split this.', 0))).toBeUndefined()
    expect(state(plan)).toEqual({ state: 'waiting' })
    expect(state(plan, bot)).toEqual({ state: 'waiting' })
  })

  it('is approved by your reply whose first line is approve, the lines below its notes', () => {
    const approved = state(plan, bot, yours('  Approve  '))
    expect(approved).toMatchObject({ state: 'approved', notes: '' })
    expect(approved?.state === 'approved' && approved.plan.tasks.map((t) => t.id)).toEqual([
      'api',
      'web',
    ])
    expect(state(plan, yours('approve\nKeep the old route.\nNo new deps.'))).toMatchObject({
      state: 'approved',
      notes: 'Keep the old route.\nNo new deps.',
    })
    expect(state(plan, posted(approveReply('Keep the old route.'), 2))).toMatchObject({
      state: 'approved',
      notes: 'Keep the old route.',
    })
  })

  it('takes any other first answer as feedback: approve if…, a codeowner, a later approve', () => {
    expect(state(plan, yours('approve if the route stays'))).toEqual({ state: 'feedback' })
    expect(state(plan, yours('Split web in two.'))).toEqual({ state: 'feedback' })
    expect(state(plan, theirs('approve'))).toEqual({ state: 'feedback' })
    expect(state(plan, theirs('Looks off.'), yours('approve', 3))).toEqual({ state: 'feedback' })
  })

  it('reads a plan and its approve notes with CRLF line endings, as a web edit leaves them', () => {
    const crlf = (c: Item['comments'][number]) => ({ ...c, body: c.body.replace(/\n/g, '\r\n') })
    expect(state(crlf(plan))).toEqual({ state: 'waiting' })
    expect(
      state(crlf(plan), crlf(yours('approve\nKeep the old route.\nNo new deps.'))),
    ).toMatchObject({ state: 'approved', notes: 'Keep the old route.\nNo new deps.' })
  })

  it('reads the newest plan: a re-plan waits for a fresh approval', () => {
    const replan = posted(planComment('One task now.', 'tasks:\n  - { id: api, title: API }'), 3)
    expect(state(plan, yours('Merge them.'), replan)).toEqual({ state: 'waiting' })
    expect(state(plan, yours('Merge them.'), replan, yours('approve', 4))).toMatchObject({
      state: 'approved',
    })
  })

  it('checks your edit of the plan again, and reads none once someone else edited it', () => {
    const edited = posted(
      planComment('Two tasks.', yaml.replace('title: Export button', 'title: Export')),
    )
    expect(state(edited, yours('approve'))).toMatchObject({ state: 'approved' })
    const broken = posted(planComment('Two tasks.', yaml.replace('id: web', 'id: api')))
    expect(state(broken)).toEqual({ state: 'invalid', problem: 'task id "api" is used twice' })
    expect(state(broken, yours('approve'))).toEqual({
      state: 'invalid',
      problem: 'task id "api" is used twice',
    })
    expect(state({ ...plan, mine: undefined }, yours('approve'))).toBeUndefined()
  })
})
