import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { allowance } from '../src/core/budget.js'
import {
  commentKind,
  isAwayworkComment,
  markComment,
  type PostState,
  planComment,
  postState,
  resultComment,
  resultOf,
} from '../src/core/footer.js'
import { planRun } from '../src/core/foreman.js'
import { approvedSkill, heldMove, postAnswer, reportPost } from '../src/core/posts.js'
import type { Item } from '../src/core/types.js'
import { asanaTask, fakeItem, githubPr } from './fakes/items.js'

const at = (n: number) => `2026-11-0${n}T00:00:00Z`
const post = (skill: string, state: PostState | undefined, n = 1) => ({
  author: 'me',
  body: markComment(
    resultComment(
      'Two flows, one open question.',
      'done',
      skill,
      undefined,
      0,
      !!state && 'waits' in state,
    ),
    state,
  ),
  at: at(n),
  mine: true as const,
})
const yours = (body: string, n = 2) => ({ author: 'me', body, at: at(n), mine: true as const })
const theirs = (body: string, n = 2) => ({ author: 'sam', body, at: at(n) })
const bot = { author: 'ci', body: 'Coverage 91%', at: at(2), bot: true as const }
const card = (...comments: Item['comments']) =>
  fakeItem({ source: 'tracker', key: 'ENG-7', type: 'task', mine: true, status: 'Inbox', comments })
const waits: PostState = { waits: true, move: 'Ready for design', saw: 'Inbox' }

describe('the post state on the mark line', () => {
  it('reads back what a post says of itself, its values encoded, and leaves the kind and status readable', () => {
    const waiting = post('story', waits)
    expect(waiting.body).toMatch(/\n\n— awaywork · waits · move=Ready%20for%20design · saw=Inbox$/)
    expect(postState(waiting)).toEqual(waits)
    expect(isAwayworkComment(waiting)).toBe(true)
    expect(commentKind(waiting)).toBe('result')
    expect(resultOf(waiting)).toMatchObject({
      status: 'done',
      text: 'Two flows, one open question.',
    })
    const went = post('story', { went: true, gates: ['taste', 'risk'] })
    expect(went.body).toMatch(/\n\n— awaywork · went ahead · gates=taste,risk$/)
    expect(postState(went)).toEqual({ went: true, gates: ['taste', 'risk'] })
    expect(postState(post('story', { waits: true }))).toEqual({ waits: true })
    expect(postState(post('story', undefined))).toBeUndefined()
    expect(postState({ ...waiting, mine: undefined })).toBeUndefined()
  })
})

describe("a report's post", () => {
  const answer = (...comments: Item['comments']) => {
    const found = reportPost(card(...comments), 'story')
    return found && postAnswer(found)
  }

  it('waits until your first reply: approve approves, anything else is feedback, a teammate or a bot is context', () => {
    expect(answer(post('story', waits))).toBe('waiting')
    expect(answer(post('story', waits), bot, theirs('approve'))).toBe('waiting')
    expect(answer(post('story', waits), theirs('Looks off.'), yours('Approve', 3))).toBe('approved')
    expect(answer(post('story', waits), yours('Split the export flow.'))).toBe('feedback')
    expect(answer(post('story', waits), yours('approve if QA agrees'))).toBe('feedback')
    // A later comment of yours changes nothing: the first reply decided.
    expect(answer(post('story', waits), yours('approve'), yours('Wait, no.', 3))).toBe('approved')
  })

  it("is approved when it went ahead, is the newest of its skill's, and none at all for a plain result", () => {
    expect(answer(post('story', { went: true, gates: [] }), yours('Hmm.'))).toBe('approved')
    expect(answer(post('story', undefined))).toBeUndefined()
    expect(answer(post('story', waits), yours('approve'), post('story', waits, 3))).toBe('waiting')
    expect(reportPost(card(post('prototype', waits)), 'story')).toBeUndefined()
  })

  it("sets the item's approved to the newest approved post's skill, a waiting one leaving it on the one before", () => {
    const story = [post('story', waits), yours('approve')]
    expect(approvedSkill(card(post('story', waits)))).toBeUndefined()
    expect(approvedSkill(card(...story))).toBe('story')
    expect(approvedSkill(card(...story, post('prototype', waits, 3)))).toBe('story')
    expect(approvedSkill(card(...story, post('prototype', { went: true, gates: [] }, 3)))).toBe(
      'prototype',
    )
    expect(approvedSkill(card(post('story', undefined), yours('approve')))).toBeUndefined()
  })
})

describe('the move a waiting post holds', () => {
  const held = (item: Item) => heldMove(item)

  it('is due once you approved, while the card is still where the post saw it and no newer post of awaywork came', () => {
    expect(held(card(post('story', waits)))).toBeUndefined()
    expect(held(card(post('story', waits), yours('Not yet.')))).toBeUndefined()
    expect(held(card(post('story', waits), yours('approve')))).toBe('Ready for design')
    expect(
      held({ ...card(post('story', waits), yours('approve')), status: 'Doing' }),
    ).toBeUndefined()
    expect(
      held(card(post('story', waits), yours('approve'), post('prototype', { waits: true }, 3))),
    ).toBeUndefined()
    expect(held(card(post('story', { waits: true }), yours('approve')))).toBeUndefined()
  })

  it("counts awaywork's own approve as yours, and a GitHub label already added as made", () => {
    const approve = { ...yours('approve'), body: markComment('approve') }
    expect(held(card(post('story', waits), approve))).toBe('Ready for design')
    const labelled = { ...card(post('story', { ...waits, saw: 'open' }), approve), status: 'open' }
    expect(held({ ...labelled, labels: ['Ready for design'] })).toBeUndefined()
    expect(held(labelled)).toBe('Ready for design')
  })
})

describe('planning a report rule whose post waits', () => {
  const config = parseConfig(`
providers: [claude: {}]
sources: { tracker: { command: 'echo []', write: 'cat' } }
queue:
  - { skill: story, where: { type: task }, deliver: report, wait: true, on_done: { move: Ready } }
  - { skill: prototype, where: { approved: story }, deliver: report, gates: { taste: { skill: judge } } }
`)
  const plan = (item: Item) =>
    planRun({
      config,
      items: [
        { ...item, fields: { ...item.fields, repo: 'acme/web', approved: approvedSkill(item) } },
      ],
      allowances: { claude: allowance(config.budget, null, 0, config.windows) },
      skills: {},
    })
  const units = (p: ReturnType<typeof plan>) =>
    p.units.map((u) => [u.unit.skill, u.unit.waits, Object.keys(u.unit.gates ?? {})])
  const skips = (p: ReturnType<typeof plan>) => p.skipped.map((s) => [s.kind, s.reason])

  it('skips the item as waiting for your approval, whatever changed on the card', () => {
    const p = plan({
      ...card(post('story', waits), theirs('Ship it!')),
      fields: { updated: at(3) },
    })
    expect(p.units).toEqual([])
    expect(skips(p)).toEqual([
      [
        'waiting_for_approval',
        "waiting for your approval of story's result on https://example.com/1",
      ],
    ])
  })

  it('runs the step again on your feedback, its next post waiting whatever wait says', () => {
    expect(units(plan(card()))).toEqual([['story', true, []]])
    expect(units(plan(card(post('story', waits), yours('Split it.'))))).toEqual([
      ['story', true, []],
    ])
  })

  it('hands an approved post to the rule after, which carries its own gates, and says why when none takes it', () => {
    const approved = card(post('story', waits), yours('approve'))
    expect(units(plan(approved))).toEqual([['prototype', false, ['taste']]])
    const went = card(
      post('story', waits),
      yours('approve'),
      post('prototype', { went: true, gates: ['taste'] }, 3),
    )
    expect(plan(went).units).toEqual([])
    expect(skips(plan(went))).toEqual([
      [
        'approved',
        "#1 story doesn't run again: you approved its result; to run it again, delete that post on https://example.com/1",
      ],
    ])
  })
})

describe('a post that waits holds its card for its rule only', () => {
  const plan = (queue: string, items: Item[]) => {
    const config = parseConfig(`
providers: [claude: {}]
sources: { asana: { workspace: '1' }, github: { repos: [acme/api] } }
queue:
${queue}`)
    const p = planRun({
      config,
      items,
      allowances: { claude: allowance(config.budget, null, 0, config.windows) },
      skills: {},
    })
    return {
      units: p.units.map((u) => [u.unit.skill, u.unit.items.map((i) => i.key)]),
      skipped: p.skipped.map((s) => [s.item.key, s.kind]),
    }
  }
  const fix = `  - { skill: fix, source: github, where: { type: pr, checks: failing } }`
  const pr = githubPr(7, { checks: 'failing' })
  const linked = (comment: Item['comments'][number]) =>
    asanaTask(1, { repo: 'acme/api' }, { mine: true, linkedPrs: pr.linkedPrs, comments: [comment] })
  const waiting = {
    units: [['fix', ['acme/api#7']]],
    skipped: [['T-1', 'waiting_for_approval']],
  }

  it("leaves the card's linked PR with failing checks to fix, a report's post or a plan, wherever fix ranks", () => {
    const story = `  - { skill: story, source: asana, deliver: report, wait: true }`
    expect(plan(`${story}\n${fix}`, [linked(post('story', waits)), pr])).toEqual(waiting)
    expect(plan(`${fix}\n${story}`, [linked(post('story', waits)), pr])).toEqual(waiting)
    const planned = yours(
      markComment(planComment('One task.', 'tasks: [{ id: api, title: API }]')),
      1,
    )
    const rule = `  - { skill: plan, source: asana, deliver: plan }
  - { skill: implement, where: { planned: true } }`
    expect(plan(`${rule}\n${fix}`, [linked(planned), pr])).toEqual(waiting)
  })

  it('keeps the card from a rule below while it waits', () => {
    const queue = `  - { skill: story, source: asana, where: { section: Ready }, deliver: report, wait: true }
  - { skill: triage, source: asana, deliver: report, on_done: { comment: result } }`
    expect(
      plan(queue, [asanaTask(1, { repo: 'acme/api' }, { comments: [post('story', waits)] })]),
    ).toEqual({
      units: [],
      skipped: [['T-1', 'waiting_for_approval']],
    })
  })
})

it('posts a report rule with wait: false and no gates of its own as a plain result, as one without wait', () => {
  const config = parseConfig(`
providers: [claude: {}]
sources: { tracker: { command: 'echo []', write: 'cat' } }
queue: [{ skill: story, deliver: report, wait: false, on_done: { comment: result } }]
`)
  const plan = planRun({
    config,
    items: [{ ...card(), fields: { repo: 'acme/web' } }],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: {},
  })
  expect(plan.units.map((u) => u.unit.waits)).toEqual([undefined])
})
