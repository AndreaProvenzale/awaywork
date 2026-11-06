import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { busyPlan, busyReport, emptyPlan, emptyReport, noConfig, oldAwaywork } from './fixtures'

// 100 columns: a page of four cards, 24 wide; 30 rows: the pane takes 28, a detail of 15.
const PANE = {
  plugin: 'awaywork',
  component: 'Pane',
  requestId: 'away',
  props: {
    title: 'awaywork',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** The surfaces that run the strip as a `Client`; vscode draws the cards as Buttons. */
const SURFACES = ['terminal', 'desktop'] as const
const ALL = [...SURFACES, 'vscode'] as const
type Surface = (typeof ALL)[number]
const NOW = Date.parse('2099-01-02T12:00:00Z')

type On = Parameters<TestBody>[1]

const away = (args = '', command = 'away') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 160 },
})

type Reply = { exitCode?: number; stdout?: string; stderr?: string }

/** Stands for the engine: a surface, the pane opening, and awaywork answering by subcommand. */
function engine(
  on: On,
  replies: Record<string, Reply | (() => Reply | Promise<Reply>)>,
  surfaces: Surface[] = ['terminal'],
) {
  const calls: string[][] = []
  const opened: string[] = []
  const clock = mock.clock(on, { now: NOW })
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('process.run', async (_, e) => {
    calls.push([...e.argv])
    const reply = replies[e.argv.slice(1).join(' ')] ?? replies[e.argv[1] ?? ''] ?? {}
    const r = typeof reply === 'function' ? await reply() : reply
    const value = { exitCode: 0, stdout: '', stderr: '', ...r }
    return { value: { ...value, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { calls, opened, clock }
}

const ok = (json: unknown) => ({ stdout: JSON.stringify(json) })

type Engine = Parameters<TestBody>[0]

type Size = { bodyColumns?: number; bodyRows?: number; placement?: 'dock' | 'inline' }

const sized = ({ bodyColumns = 100, bodyRows = 30, placement = 'dock' }: Size = {}) => ({
  ...PANE.props,
  bodyColumns,
  placement,
  scroll: { offset: 0, bodyRows },
})

/** Draws the pane once the report /away started reading is in: a refresh settles with it. */
async function mount<S extends Surface>($: Engine, surface: S, size?: Size) {
  const ui = await $.ui.mount({ ...PANE, props: sized(size), surface })
  await ui.press({ key: 'refresh' })
  return ui
}

/** What the reads below need of a drawing on any surface. */
type Ui = Pick<Awaited<ReturnType<typeof mount<Surface>>>, 'surface' | 'find' | 'findAll'>

type Node = string | { props?: { label?: string }; children?: Node[] }

/** What a node shows: its strings and its Buttons' labels. */
const shown = (n: Node): string =>
  typeof n === 'string' ? n : (n.props?.label ?? '') + (n.children ?? []).map(shown).join('')

/** Where the cards are: what the strip's `Client` drew, or the pane's own tree. */
const strip = (ui: Ui) => (ui.surface === 'vscode' ? {} : { in: 'cards' })

/** A card as drawn: its ref and word, its title's lines, and whether it is the selected one. */
async function card(ui: Ui, id: string) {
  const box = await ui.find({ key: id, ...strip(ui) })
  if (!box) return undefined
  const [head, ...title] = box.children as Node[]
  const [ref, word] = (typeof head === 'string' ? [] : (head?.children ?? [])).map(shown)
  return { ref, word, title: title.map(shown), selected: box.props.borderStyle === 'bold' }
}

/** The cards of the page drawn, in order. */
const page = async (ui: Ui) =>
  (await ui.findAll({ type: 'Box', ...strip(ui) }))
    .map((b) => b.key)
    .filter((key) => key?.startsWith('row:'))

const selected = async (ui: Ui) => {
  for (const id of await page(ui)) if (id && (await card(ui, id))?.selected) return id
}

/** The detail's lines as drawn. */
const detail = async (ui: Ui) =>
  ((await ui.find({ key: 'detail' }))?.children as Node[] | undefined)?.map(shown)

const label = async (ui: Ui, key: string) => (await ui.find({ key }))?.props.label

const hotkey = async (ui: Ui, key: string) => (await ui.find({ key }))?.props.hotkey

const text = async (ui: Ui, pattern: string | RegExp) =>
  !!(await ui.find({ type: 'Text', text: pattern }))

const SCROLL = {
  component: 'Pane',
  requestId: 'away',
  offset: 0,
  by: 1,
  bodyRows: 30,
  contentRows: 30,
  origin: { kind: 'person' },
} as const

/** A wheel tick over a body row: the strip takes rows 4 to 8, the detail 12 on. */
const wheel = ($: Engine, row: number, by = 1) =>
  $.ui.scroll({ ...SCROLL, by, pointer: { column: 10, row } })

const needs = (key: string) => `row:needs:${key}`
const SHOP7 = needs('github:acme/shop#7')
const SHOP8 = needs('github:acme/shop#8')
const TICKET = needs('jira:SHOP-12')
const API21 = needs('github:acme/api#21')
const API22 = needs('github:acme/api#22')
const WEB4 = needs('github:acme/web#4')

const REPORT_TEXT = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')

test('bare /away lands on the first tab with something in it, reading only the report', async ($, on) => {
  let report = busyReport
  const { calls, opened } = engine(on, { 'report --json': () => ok(report) })
  await $.command.run(away())
  expect(opened).toEqual(['away'])

  for (const surface of ALL) {
    const ui = await mount($, surface)
    expect(await text(ui, /☾ awaywork/)).toBe(true)
    expect(await text(ui, /last run \d\d-\d\d \d\d:\d\d · 1 PR/)).toBe(true)
    expect(await text(ui, / · 6 need you/)).toBe(true)
    expect(await label(ui, 'tab:needs')).toBe('Needs you (6)')
    expect(await label(ui, 'tab:last')).toBe('Last run (2)')
    expect(await label(ui, 'tab:next')).toBe('Next run')
    expect(await label(ui, 'tab:skipped')).toBe('Skipped (5)')
    expect(await page(ui)).toEqual([SHOP7, SHOP8, TICKET, API21])
    expect(await selected(ui)).toBe(SHOP7)
    await ui.unmount()
  }

  const skipped = busyReport.plan.skipped.filter((s) => !('needsYou' in s))
  report = { ...busyReport, plan: { ...busyReport.plan, skipped } }
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: 'tab:needs' })).toBeFalsy()
  expect(await page(ui)).toEqual(['row:last:acme-shop-3', 'row:last:acme-shop-5'])

  report = { ...report, results: [] }
  await ui.press({ key: 'refresh' })
  expect(await page(ui)).toEqual([
    'row:skipped:github:acme/shop#9',
    'row:skipped:github:acme/shop#10',
    'row:skipped:github:acme/api#30',
    'row:skipped:github:acme/web#5',
  ])
  expect(calls.every((argv) => ['report', 'config'].includes(argv[1] ?? ''))).toBe(true)
})

test('a card shows its ref and action on top and its title in two lines, the detail its reason and URL', async ($, on) => {
  engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  for (const surface of ALL) {
    const ui = await mount($, surface)
    expect(await card(ui, SHOP7)).toEqual({
      ref: '#7',
      word: 'review PR',
      title: ['Retry webhooks on', '5xx'],
      selected: true,
    })
    expect(await card(ui, SHOP8)).toEqual({
      ref: '#8',
      word: 'approve plan',
      title: ['Split the checkout', 'service into cart, …'],
      selected: false,
    })
    expect(await card(ui, TICKET)).toMatchObject({ ref: 'SHOP-12', word: 'answer question' })

    expect(await detail(ui)).toEqual([
      'Retry webhooks on 5xx',
      'waiting for review: awaywork PR is open',
      'https://github.com/acme/shop/pull/31',
    ])
    expect(await label(ui, 'open')).toBe('open PR')
    expect(await label(ui, 'skip')).toBe('skip')
    expect(await ui.find({ key: 'approve' })).toBeFalsy()
    expect(await ui.find({ key: 'report' })).toBeFalsy()

    await ui.press({ key: 'tab:skipped' })
    expect(await card(ui, 'row:skipped:github:acme/shop#10')).toMatchObject({
      word: 'skipped by you',
    })
    expect(await detail(ui)).toEqual([
      'Bump the linter',
      'matched no rule; closest #1 fix: type is issue, wants pr',
      'https://github.com/acme/shop/issues/9',
    ])
    expect(await label(ui, 'open')).toBe('open issue')
    expect(await label(ui, 'approve')).toBe('mark approved')
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
})

test('h and l step card to card, a page at a time, the group line saying where', async ($, on) => {
  engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  for (const surface of ALL) {
    const ui = await mount($, surface)
    expect([await hotkey(ui, 'prev'), await hotkey(ui, 'nextCard')]).toEqual(['h', 'l'])
    expect(await label(ui, 'prev')).toBe('‹')
    expect(await text(ui, /^acme\/shop {2}1\/6$/)).toBe(true)

    await ui.press({ key: 'prev' })
    expect(await selected(ui)).toBe(SHOP7)
    // Keys pressed faster than the pane draws each step from the last.
    await Promise.all([ui.press({ key: 'nextCard' }), ui.press({ key: 'nextCard' })])
    expect(await selected(ui)).toBe(TICKET)
    expect(await text(ui, /^jira SHOP {2}3\/6$/)).toBe(true)
    expect((await detail(ui))?.[0]).toBe(
      'Migrate the billing webhooks to the new event bus before the freeze',
    )
    expect(await label(ui, 'open')).toBe('open')

    await ui.press({ key: 'nextCard' })
    await ui.press({ key: 'nextCard' })
    expect(await page(ui)).toEqual([API22, WEB4])
    expect(await selected(ui)).toBe(API22)
    expect(await text(ui, /^acme\/api {2}5\/6$/)).toBe(true)
    await ui.press({ key: 'nextCard' })
    await ui.press({ key: 'nextCard' })
    expect(await selected(ui)).toBe(WEB4)

    await ui.press({ key: 'prev' })
    await ui.press({ key: 'prev' })
    expect(await page(ui)).toEqual([SHOP7, SHOP8, TICKET, API21])
    expect(await selected(ui)).toBe(API21)

    // A tab starts on its first card.
    await ui.press({ key: 'tab:last' })
    await ui.press({ key: 'tab:needs' })
    expect(await selected(ui)).toBe(SHOP7)
    await ui.unmount()
  }
})

test('the strip moves on a click or an arrow at once and hands every other key to the hotkeys', async ($, on) => {
  const { calls } = engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.post({ select: API21 })
    expect(await selected(ui)).toBe(API21)
    expect((await detail(ui))?.[0]).toBe('Fix the N+1 query in the orders endpoint')

    // A click on the second card of the page: 24 columns and a gap each.
    await ui.pointer({ type: 'down', x: 30, y: 2, button: 'left', in: 'cards' })
    expect(await selected(ui)).toBe(SHOP8)
    await ui.key({ key: 'right', in: 'cards' })
    expect(await selected(ui)).toBe(TICKET)
    await ui.key({ key: 'left', in: 'cards' })
    expect(await selected(ui)).toBe(SHOP8)

    await ui.post({ select: SHOP8, key: 's' })
    expect(await text(ui, /^skip #8 in the coming runs\?/)).toBe(true)
    await ui.post({ select: SHOP8, key: 'n' })
    expect(await text(ui, 'not skipped')).toBe(true)

    // A move and a key in one frame are one post: the key acts on the card it names.
    await ui.post({ select: API21, key: 's' })
    expect(await selected(ui)).toBe(API21)
    expect(await text(ui, /^skip #21 in the coming runs\?/)).toBe(true)
    await ui.post({ select: API21, key: 'n' })

    // A click past the last card of the last page picks nothing.
    await ui.post({ select: API22 })
    await ui.pointer({ type: 'down', x: 60, y: 2, button: 'left', in: 'cards' })
    expect(await selected(ui)).toBe(API22)
    await ui.post({ select: SHOP8 })
    expect(calls.some((argv) => argv[1] === 'skip')).toBe(false)
    await ui.post({ key: 'l' })
    expect(await selected(ui)).toBe(TICKET)
    await ui.post({ key: '4' })
    expect(await selected(ui)).toBe('row:skipped:github:acme/shop#9')
    await ui.post({ key: '1' })
    await ui.post({ key: 'q' })
    expect(await selected(ui)).toBe(SHOP7)
    await ui.unmount()
  }
})

test('the wheel over the strip steps the cards, anywhere else it scrolls the detail', async ($, on) => {
  engine(on, {
    'report --json': ok(busyReport),
    'report 20990101-050000 --unit acme-shop-3': { stdout: REPORT_TEXT },
  })
  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await wheel($, 6)).toEqual({ deny: 'awaywork scrolls its own regions' })
    expect(await selected(ui)).toBe(SHOP8)
    await wheel($, 4, -3)
    expect(await selected(ui)).toBe(SHOP7)

    await ui.press({ key: 'tab:last' })
    await ui.press({ key: 'report' })
    const all = ['awaywork report 20990101-050000 --unit acme-shop-3', ...REPORT_TEXT.split('\n')]
    expect(await detail(ui)).toEqual([...all.slice(0, 14), '↓ 17 more'])
    await wheel($, 20, 2)
    expect(await detail(ui)).toEqual([...all.slice(2, 16), '↓ 15 more'])
    await ui.key({ key: 'down', in: 'cards' })
    await ui.key({ key: 'pagedown', in: 'cards' })
    expect((await detail(ui))?.[0]).toBe('line 8')
    await wheel($, 20, 99)
    expect(await detail(ui)).toEqual(all.slice(16))
    await wheel($, 0, -99)
    expect((await detail(ui))?.[0]).toBe(all[0])

    // A scroll key, with no pointer, scrolls the detail too.
    await $.ui.scroll({ ...SCROLL, by: 4 })
    expect((await detail(ui))?.[0]).toBe('line 4')
    await ui.press({ key: 'back' })
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
})

test('s and a ask yes or no in the buttons row first, then mark the card', async ($, on) => {
  const { calls } = engine(on, {
    'report --json': ok(busyReport),
    'skip github:acme/shop#7': { stdout: 'github:acme/shop#7 is skipped until awaywork unskip' },
    'approve github:acme/shop#8': { stdout: 'plan approved: replied approve on the issue' },
    'approve github:acme/shop#9': {
      stdout: 'github:acme/shop#9 is approved until a unit on it finishes',
    },
  })
  await $.command.run(away())
  const ui = await mount($, 'terminal')

  await ui.press({ key: 'skip' })
  expect(await text(ui, 'skip #7 in the coming runs? awaywork unskip undoes it')).toBe(true)
  expect([await hotkey(ui, 'yes'), await hotkey(ui, 'no')]).toEqual(['y', 'n'])
  expect(await ui.find({ key: 'open' })).toBeFalsy()
  await ui.press({ key: 'no' })
  expect(await text(ui, 'not skipped')).toBe(true)
  expect(calls.some((argv) => argv[1] === 'skip')).toBe(false)

  await ui.press({ key: 'skip' })
  await ui.press({ key: 'yes' })
  expect(calls).toContainEqual(['awaywork', 'skip', 'github:acme/shop#7'])
  expect(await text(ui, /is skipped until awaywork unskip/)).toBe(true)
  expect((await card(ui, SHOP7))?.word).toBe('skipped')
  expect(await label(ui, 'skip')).toBe('unskip')

  // Another card drops the question.
  await ui.press({ key: 'nextCard' })
  await ui.press({ key: 'approve' })
  expect(await text(ui, /approve #8's plan\? .* no undo$/)).toBe(true)
  await ui.press({ key: 'prev' })
  expect(await ui.find({ key: 'yes' })).toBeFalsy()
  await ui.press({ key: 'nextCard' })
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'yes' })
  expect(calls).toContainEqual(['awaywork', 'approve', 'github:acme/shop#8'])
  expect((await card(ui, SHOP8))?.word).toBe('approved')
  await ui.press({ key: 'approve' })
  expect(await text(ui, 'already approved')).toBe(true)

  await ui.press({ key: 'tab:skipped' })
  await ui.press({ key: 'approve' })
  expect(await text(ui, /mark #9 approved for approved: true rules, .* no undo$/)).toBe(true)
  await ui.press({ key: 'yes' })
  expect(calls).toContainEqual(['awaywork', 'approve', 'github:acme/shop#9'])
  expect(calls.filter((argv) => argv[1] === 'approve')).toHaveLength(2)
})

test('v shows the report in the detail and b goes back; o opens the URL; c hands the unit to the chat', async ($, on) => {
  const { calls } = engine(on, {
    'report --json': ok(busyReport),
    'report 20990101-050000 --unit acme-shop-3': { stdout: 'acme-shop-3: Pinned the clock' },
  })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.command.run(away())
  for (const surface of ALL) {
    const ui = await mount($, surface)
    await ui.press({ key: 'tab:last' })
    expect(await card(ui, 'row:last:acme-shop-5')).toMatchObject({ ref: '#5', word: 'failed' })
    expect(await detail(ui)).toEqual([
      'Flaky cart test',
      'fix · Pinned the clock in the cart test',
      'https://github.com/acme/shop/pull/40',
    ])
    expect(await label(ui, 'report')).toBe('view report')
    expect([await hotkey(ui, 'report'), await hotkey(ui, 'here')]).toEqual(['v', 'c'])
    expect(await label(ui, 'approve')).toBe('mark approved')

    await ui.press({ key: 'report' })
    expect(await detail(ui)).toEqual([
      'awaywork report 20990101-050000 --unit acme-shop-3',
      'acme-shop-3: Pinned the clock',
    ])
    expect(await ui.find({ key: 'open' })).toBeFalsy()
    expect(await hotkey(ui, 'back')).toBe('b')
    await ui.press({ key: 'back' })
    expect((await detail(ui))?.[0]).toBe('Flaky cart test')

    await ui.press({ key: 'open' })
    expect(calls).toContainEqual(['xdg-open', 'https://github.com/acme/shop/pull/40'])
    await ui.press({ key: 'nextCard' })
    await ui.press({ key: 'here' })
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
  expect(prompts[0]).toBe(
    'continue awaywork unit acme-shop-5 of run 20990101-050000; start with `awaywork report 20990101-050000 --unit acme-shop-5`',
  )
  expect(calls.some((argv) => argv[1] === 'plan')).toBe(false)
})

test('every region keeps its height while you browse, ask and read', async ($, on) => {
  engine(on, {
    'report --json': ok(busyReport),
    'report 20990101-050000 --unit acme-shop-3': { stdout: REPORT_TEXT },
  })
  await $.command.run(away())
  for (const surface of ALL) {
    const ui = await mount($, surface)
    const heights = async () => {
      const box = await ui.find({ key: 'detail' })
      expect((box?.children ?? []).length).toBeLessThanOrEqual(15)
      return [
        (await ui.find({ type: 'Box' }))?.props.height,
        (await ui.find({ key: 'buttons' }))?.props.height,
        box?.props.height,
      ]
    }
    const fixed = [28, 2, 15]
    for (let i = 0; i < 6; i++) {
      expect(await heights()).toEqual(fixed)
      await ui.press({ key: 'nextCard' })
    }
    await ui.press({ key: 'skip' })
    expect(await heights()).toEqual(fixed)
    await ui.press({ key: 'no' })
    await ui.press({ key: 'tab:last' })
    await ui.press({ key: 'report' })
    expect(await heights()).toEqual(fixed)
    await ui.press({ key: 'back' })
    await ui.press({ key: 'tab:skipped' })
    expect(await heights()).toEqual(fixed)
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
})

test('the confirm shows its whole question, taking its rows from the detail', async ($, on) => {
  engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  for (const surface of ALL) {
    // 26 columns: one card a page, the header on two rows, the tabs on four.
    const ui = await mount($, surface, { bodyColumns: 26, bodyRows: 24 })
    const heights = async () => [
      (await ui.find({ type: 'Box' }))?.props.height,
      (await ui.find({ key: 'buttons' }))?.props.height,
      (await ui.find({ key: 'detail' }))?.props.height,
    ]
    expect(await heights()).toEqual([24, 2, 7])
    await ui.press({ key: 'tab:skipped' })
    await ui.press({ key: 'approve' })
    const [asked] = ((await ui.find({ key: 'buttons' }))?.children ?? []) as { children: Node[] }[]
    expect(asked?.children.slice(0, -1).map(shown)).toEqual([
      'mark #9 approved for',
      'approved: true rules,',
      'until a unit on it',
      'finishes? no undo',
    ])
    expect(await heights()).toEqual([24, 5, 4])
    await ui.press({ key: 'no' })
    expect(await heights()).toEqual([24, 2, 7])
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
})

test('v and b each show the detail from its top, wherever it was scrolled', async ($, on) => {
  engine(on, {
    'report --json': ok(busyReport),
    'report 20990101-050000 --unit acme-shop-3': { stdout: REPORT_TEXT },
  })
  await $.command.run(away())
  for (const surface of SURFACES) {
    // The header takes two rows and the tabs four: the strip is rows 8 to 12, the detail four from 16.
    const ui = await mount($, surface, { bodyColumns: 26, bodyRows: 21 })
    await ui.press({ key: 'tab:last' })
    expect(await detail(ui)).toEqual([
      'Flaky cart test',
      'fix · Pinned the clock in',
      'the cart test',
      '↓ 2 more',
    ])
    await wheel($, 7)
    expect((await detail(ui))?.[0]).toBe('fix · Pinned the clock in')
    await wheel($, 8)
    expect(await selected(ui)).toBe('row:last:acme-shop-5')
    await wheel($, 12, -1)
    expect(await selected(ui)).toBe('row:last:acme-shop-3')

    await wheel($, 13)
    expect((await detail(ui))?.[0]).toBe('fix · Pinned the clock in')
    await ui.press({ key: 'report' })
    expect((await detail(ui))?.[0]).toBe('awaywork report 20990101-050000 --unit acme-shop-3')
    await wheel($, 16, 3)
    expect((await detail(ui))?.[0]).toBe('line 3')
    await ui.press({ key: 'back' })
    expect((await detail(ui))?.[0]).toBe('Flaky cart test')
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
})

test('a pane too short for the fixed regions draws them all and lets the engine scroll it', async ($, on) => {
  engine(on, {
    'report --json': ok(busyReport),
    'report 20990101-050000 --unit acme-shop-3': { stdout: REPORT_TEXT },
  })
  const scrolled: number[] = []
  on('ui.scroll', (_, e) => {
    scrolled.push(e.by)
    return {}
  })
  await $.command.run(away())
  for (const surface of SURFACES)
    for (const size of [
      { bodyRows: 15 },
      { bodyColumns: 76, bodyRows: 14, placement: 'inline' as const },
    ]) {
      const ui = await mount($, surface, size)
      expect((await ui.find({ type: 'Box' }))?.props.height).toBeUndefined()
      expect(await label(ui, 'tab:skipped')).toBe('Skipped (5)')
      expect(await text(ui, /^acme\/shop {2}1\/6$/)).toBe(true)
      expect(await wheel($, 6)).toEqual({})
      expect(await selected(ui)).toBe(SHOP7)

      await ui.press({ key: 'tab:last' })
      await ui.press({ key: 'report' })
      expect(await detail(ui)).toEqual([
        'awaywork report 20990101-050000 --unit acme-shop-3',
        ...REPORT_TEXT.split('\n'),
      ])
      await ui.press({ key: 'back' })
      await ui.redraw(sized({ ...size, bodyRows: 30 }))
      expect((await ui.find({ type: 'Box' }))?.props.height).toBe(28)
      expect(await wheel($, 20)).toEqual({ deny: 'awaywork scrolls its own regions' })
      await ui.press({ key: 'tab:needs' })
      await ui.unmount()
    }
  expect(scrolled).toEqual([1, 1, 1, 1])
})

test('on a surface with no Client the cards are Buttons', async ($, on) => {
  engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  const ui = await mount($, 'vscode')
  expect(await ui.find({ type: 'Client' })).toBeFalsy()
  expect(await label(ui, `card:${SHOP8}`)).toBe('#8')
  await ui.press({ key: `card:${API21}` })
  expect(await selected(ui)).toBe(API21)
  expect((await detail(ui))?.[0]).toBe('Fix the N+1 query in the orders endpoint')
})

test('/away with a request goes to the skill', async ($, on) => {
  const { opened } = engine(on, {})
  on('command.run', () => ({ text: 'the skill ran' }))
  const ran = await $.command.run(away('why did acme/shop#7 not run?', 'awaywork:away'))
  expect(ran.text).toBe('the skill ran')
  expect(opened).toEqual([])
})

test('bare /away with no config goes to the skill, which sets awaywork up', async ($, on) => {
  const { calls, opened } = engine(on, { 'config path': noConfig })
  on('command.run', () => ({ text: 'the skill ran' }))
  const ran = await $.command.run(away())
  expect(ran.text).toBe('the skill ran')
  expect(opened).toEqual([])
  expect(calls).toEqual([['awaywork', 'config', 'path']])
})

test('an awaywork too old for config path still opens the pane', async ($, on) => {
  const { opened } = engine(on, { 'config path': oldAwaywork, 'report --json': ok(busyReport) })
  await $.command.run(away())
  expect(opened).toEqual(['away'])
  const ui = await mount($, 'terminal')
  expect(await text(ui, /6 need you/)).toBe(true)
})

test('bare /away opens the pane when typed before the desktop attaches, not under -p', async ($, on) => {
  const { opened } = engine(on, { 'report --json': ok(busyReport) }, [])
  on('command.run', () => ({ text: 'the skill ran' }))
  await $.command.run(away('', 'awaywork:away'))
  expect(opened).toEqual(['away'])
  const ui = await mount($, 'desktop')
  expect(await text(ui, /6 need you/)).toBe(true)
  await ui.unmount()
  const ran = await $.command.run({ ...away('', 'awaywork:away'), origin: { kind: 'sdk' } })
  expect(ran.text).toBe('the skill ran')
  expect(opened).toEqual(['away'])
})

test('p plans once however often it is pressed; r reads only the report', async ($, on) => {
  const { calls, clock } = engine(on, {
    'report --json': ok(busyReport),
    'plan --json': async () => {
      await clock.sleep(1000)
      return ok(busyPlan)
    },
  })
  const plans = () => calls.filter((argv) => argv[1] === 'plan').length
  await $.command.run(away())
  const ui = await mount($, 'terminal')

  await ui.press({ key: 'tab:next' })
  expect(await text(ui, /plan probes quota \(one Haiku call\): press p/)).toBe(true)
  await ui.press({ key: 'plan' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'plan' })
  expect(await text(ui, /· planning…/)).toBe(true)
  expect(await text(ui, /planning… it probes quota/)).toBe(true)
  await clock.advance(1000)
  expect(plans()).toBe(1)
  await ui.unmount()

  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'tab:next' })
    expect(await page(ui)).toEqual(['row:next:acme-shop-12'])
    expect(await card(ui, 'row:next:acme-shop-12')).toMatchObject({
      ref: '#12',
      word: 'implement',
      title: ['Coupon codes'],
    })
    expect(await detail(ui)).toEqual([
      'Coupon codes',
      'deliver draft_pr · claude',
      'github:acme/shop#12  Coupon codes',
      'https://github.com/acme/shop/issues/12',
    ])
    expect(await label(ui, 'tab:next')).toBe('Next run (1)')
    expect(await hotkey(ui, 'tab:skipped')).toBe('4')
    await ui.unmount()
  }
  expect(plans()).toBe(1)
})

test('a reply that is not JSON says so instead of reading for good', async ($, on) => {
  engine(on, { 'report --json': { stdout: 'Debugger attached.\n{}' } })
  await $.command.run(away())
  const ui = await mount($, 'terminal')
  expect(await text(ui, /awaywork report --json printed no JSON/)).toBe(true)
  expect(await text(ui, /reading the last run/)).toBe(false)
})

test('with a plan loaded, a failed report still says why, and the plan clears the marks', async ($, on) => {
  let report: Reply = ok(busyReport)
  engine(on, {
    'report --json': () => report,
    'plan --json': ok(busyPlan),
    'skip github:acme/shop#7': { stdout: 'github:acme/shop#7 is skipped until awaywork unskip' },
  })
  await $.command.run(away())
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'skip' })
  await ui.press({ key: 'yes' })
  expect((await card(ui, SHOP7))?.word).toBe('skipped')

  await ui.press({ key: 'plan' })
  expect((await card(ui, SHOP7))?.word).toBe('review PR')
  report = { stdout: 'Debugger attached.\n{}' }
  await ui.press({ key: 'refresh' })
  expect(await text(ui, /awaywork report --json printed no JSON/)).toBe(true)
  expect(await text(ui, /no run yet/)).toBe(false)
})

test('reopening keeps the marks on the cards they correct', async ($, on) => {
  engine(on, {
    'report --json': ok(busyReport),
    'skip github:acme/shop#7': { stdout: 'github:acme/shop#7 is skipped until awaywork unskip' },
  })
  await $.command.run(away())
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'skip' })
  await ui.press({ key: 'yes' })
  await ui.unmount()

  await $.command.run(away())
  const again = await mount($, 'terminal')
  expect((await card(again, SHOP7))?.word).toBe('skipped')
  expect(await label(again, 'skip')).toBe('unskip')
})

test('mark approved shows only while a rule for the item takes approved items', async ($, on) => {
  const [first] = busyReport.plan.queue
  const nested = { skill: 'implement', where: { any: [{ any: [{ approved: [true] }] }] } }
  let queue: unknown[] = [first, { ...nested, source: 'jira' }]
  engine(on, { 'report --json': () => ok({ ...busyReport, plan: { ...busyReport.plan, queue } }) })
  await $.command.run(away())
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'tab:skipped' })
  expect(await ui.find({ key: 'approve' })).toBeFalsy()
  await ui.press({ key: 'tab:needs' })
  await ui.press({ key: 'nextCard' })
  expect(await label(ui, 'approve')).toBe('approve plan')

  queue = [first, nested]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab:skipped' })
  expect(await label(ui, 'approve')).toBe('mark approved')
})

test('no run yet, and a run that found nothing, each say why and what next', async ($, on) => {
  let report: Reply = { exitCode: 1, stderr: 'no runs in /home/dev/.local/state/awaywork/runs' }
  engine(on, { 'report --json': () => report, 'plan --json': ok(emptyPlan) })
  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await text(ui, /no run yet: `awaywork run`, or wait for the schedule/)).toBe(true)
    expect(await ui.find({ key: 'tab:needs' })).toBeFalsy()
    await ui.unmount()
  }
  report = ok(emptyReport)
  const ui = await mount($, 'terminal')
  expect(await text(ui, /the last run found none of your items/)).toBe(true)
})

test('awaywork missing from PATH, or too old for --json, says the fix', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let old = false
  on('process.run', () => {
    if (!old) return { deny: 'spawn awaywork ENOENT' }
    return {
      value: {
        exitCode: 1,
        stdout: '',
        stderr: "error: unknown option '--json'",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await text(ui, "awaywork isn't on your PATH: npm i -g awaywork@latest")).toBe(true)
    await ui.unmount()
  }
  old = true
  const ui = await mount($, 'terminal')
  expect(
    await text(ui, 'this awaywork is too old for the pane (no --json): npm i -g awaywork@latest'),
  ).toBe(true)
})
