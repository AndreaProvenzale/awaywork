import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { busyPlan, busyReport, emptyPlan, emptyReport } from './fixtures'

const PANE = {
  plugin: 'awaywork',
  component: 'Pane',
  requestId: 'away',
  props: {
    title: 'awaywork',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2099-01-02T12:00:00Z')

type On = Parameters<TestBody>[1]

const away = (args = '', command = 'away') => ({
  command,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 160 },
})

const focus = (element: string) =>
  ({ component: 'Pane', requestId: 'away', element, origin: { kind: 'person' } }) as const

type Reply = { exitCode?: number; stdout?: string; stderr?: string }

/** Stands for the engine: a surface, the pane opening, and awaywork answering by subcommand. */
function engine(
  on: On,
  replies: Record<string, Reply | (() => Reply | Promise<Reply>)>,
  surfaces: (typeof SURFACES)[number][] = ['terminal'],
) {
  const calls: string[][] = []
  const opened: string[] = []
  const clock = mock.clock(on, { now: NOW })
  on('ui.focus', () => ({}))
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

/** Draws the pane once the report /away started reading is in: a refresh settles with it. */
async function mount($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'refresh' })
  return ui
}

type Ui = Awaited<ReturnType<typeof mount>>

/** A row as drawn: its ref and title, then its word at the end. */
const line = async (ui: Ui, row: string) => (await ui.find({ key: `line:${row}` }))?.text

/** The rows in the order drawn, the open one by its shut key. */
const rows = async (ui: Ui) =>
  (await ui.findAll({ type: 'Button' }))
    .map((b) => b.key?.replace(/^open:/, ''))
    .filter((key) => key?.startsWith('row:'))

const label = async (ui: Ui, key: string) => (await ui.find({ key }))?.props.label

const SHOP7 = 'row:needs:github:acme/shop#7'
const SHOP8 = 'row:needs:github:acme/shop#8'
const TICKET = 'row:needs:jira:SHOP-12'

test('bare /away opens the pane on what needs you, by repo and action, reading only the report', async ($, on) => {
  const { calls, opened } = engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  expect(opened).toEqual(['away'])

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /last run \d\d-\d\d \d\d:\d\d/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /3 need you/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 PR/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: 'acme/shop' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: 'jira SHOP' })).toBeTruthy()
    expect(await rows(ui)).toEqual([SHOP7, SHOP8, TICKET])
    expect(await line(ui, SHOP7)).toMatch(/^▾ #7 {2}Retry webhooks on 5xx +review PR$/)
    expect(await line(ui, SHOP8)).toMatch(/^#8 {2}Split the checkout service +approve plan$/)
    expect(await line(ui, TICKET)).toMatch(/^SHOP-12 {2}Migrate billing webhooks +answer question$/)
    expect(await ui.find({ type: 'Text', text: /waiting for your/ })).toBeFalsy()
    expect(await ui.find({ key: 'row:needs:github:acme/shop#9' })).toBeFalsy()

    await ui.press({ key: 'tab:last' })
    expect(await rows(ui)).toEqual(['row:last:acme-shop-3', 'row:last:acme-shop-5'])
    expect(await line(ui, 'row:last:acme-shop-5')).toMatch(/^#5 {2}Dark mode toggle +failed$/)
    expect(await ui.find({ type: 'Text', text: /implement · verify failed/ })).toBeTruthy()

    await ui.press({ key: 'tab:next' })
    expect(
      await ui.find({ type: 'Text', text: /plan probes quota \(one Haiku call\): press p/ }),
    ).toBeTruthy()

    await ui.press({ key: 'tab:skipped' })
    expect(await rows(ui)).toEqual([
      'row:skipped:github:acme/shop#9',
      'row:skipped:github:acme/shop#10',
    ])
    expect(await line(ui, 'row:skipped:github:acme/shop#10')).toMatch(/skipped by you$/)
    expect(await ui.find({ type: 'Text', text: /not now/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /skipped with awaywork skip/ })).toBeFalsy()
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
  expect(calls.every((argv) => argv[1] === 'report')).toBe(true)
})

test('/away with a request goes to the skill', async ($, on) => {
  const { opened } = engine(on, {})
  on('command.run', () => ({ text: 'the skill ran' }))
  const ran = await $.command.run(away('why did acme/shop#7 not run?', 'awaywork:away'))
  expect(ran.text).toBe('the skill ran')
  expect(opened).toEqual([])
})

test('bare /away opens the pane when typed before the desktop attaches, not under -p', async ($, on) => {
  const { opened } = engine(on, { 'report --json': ok(busyReport) }, [])
  on('command.run', () => ({ text: 'the skill ran' }))
  await $.command.run(away('', 'awaywork:away'))
  expect(opened).toEqual(['away'])
  const ui = await mount($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /3 need you/ })).toBeTruthy()
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

  await ui.press({ key: 'plan' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'plan' })
  expect(await ui.find({ type: 'Text', text: /· planning…/ })).toBeTruthy()
  await ui.press({ key: 'tab:next' })
  expect(await ui.find({ type: 'Text', text: /planning… it probes quota/ })).toBeTruthy()
  await clock.advance(1000)
  expect(plans()).toBe(1)
  await ui.unmount()

  await $.command.run(away())

  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await ui.press({ key: 'tab:next' })
    expect(await rows(ui)).toEqual(['row:next:acme-shop-12'])
    expect(await line(ui, 'row:next:acme-shop-12')).toMatch(/^▾ #12 {2}Coupon codes +implement$/)
    expect(
      await ui.find({ type: 'Text', text: /^deliver draft_pr · claude\ngithub:acme\/shop#12/ }),
    ).toBeTruthy()
    expect((await ui.find({ key: 'tab:skipped' }))?.props.hotkey).toBe('4')
    await ui.unmount()
  }
  expect(plans()).toBe(1)
})

test('a reply that is not JSON says so instead of reading for good', async ($, on) => {
  engine(on, { 'report --json': { stdout: 'Debugger attached.\n{}' } })
  await $.command.run(away())
  const ui = await mount($, 'terminal')
  expect(
    await ui.find({ type: 'Text', text: /awaywork report --json printed no JSON/ }),
  ).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /reading the last run/ })).toBeFalsy()
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
  expect(await line(ui, SHOP7)).toMatch(/ skipped$/)

  await ui.press({ key: 'plan' })
  expect(await line(ui, SHOP7)).toMatch(/ review PR$/)
  report = { stdout: 'Debugger attached.\n{}' }
  await ui.press({ key: 'refresh' })
  expect(
    await ui.find({ type: 'Text', text: /awaywork report --json printed no JSON/ }),
  ).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /no run yet/ })).toBeFalsy()
})

test('reopening keeps the marks on the rows they correct', async ($, on) => {
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
  expect(await line(again, SHOP7)).toMatch(/ skipped$/)
  expect(await label(again, 'skip')).toBe('unskip')
})

test('a click or Tab opens a row in place, with its reason, link and only the buttons it has', async ($, on) => {
  engine(on, { 'report --json': ok(busyReport) })
  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(
      await ui.find({
        type: 'Text',
        text: 'waiting for review: awaywork PR is open\nhttps://github.com/acme/shop/pull/31',
      }),
    ).toBeTruthy()
    expect(await label(ui, 'open')).toBe('open PR')
    expect(await label(ui, 'skip')).toBe('skip')
    expect(await ui.find({ key: 'approve' })).toBeFalsy()
    expect(await ui.find({ key: 'here' })).toBeFalsy()

    await ui.press({ key: SHOP8 })
    expect(await line(ui, SHOP7)).toMatch(/^#7 /)
    expect(await line(ui, SHOP8)).toMatch(/^▾ #8 /)
    expect(await label(ui, 'open')).toBe('open issue')
    expect(await label(ui, 'approve')).toBe('approve plan')

    await $.ui.focus(focus(TICKET))
    expect(await label(ui, 'open')).toBe('open')
    expect(await ui.find({ key: 'approve' })).toBeFalsy()

    // A rule takes `approved: true` items, so approving one it skipped can make it run.
    await ui.press({ key: 'tab:skipped' })
    expect(await label(ui, 'approve')).toBe('mark approved')
    await ui.press({ key: 'tab:last' })
    expect(await label(ui, 'report')).toBe('read report')
    expect(await label(ui, 'here')).toBe('ask Claude here')
    expect(await label(ui, 'approve')).toBe('mark approved')
    await ui.press({ key: 'tab:needs' })
    await ui.unmount()
  }
})

test('mark approved shows only while a rule takes approved items', async ($, on) => {
  const [first] = busyReport.plan.queue
  engine(on, {
    'report --json': ok({ ...busyReport, plan: { ...busyReport.plan, queue: [first] } }),
  })
  await $.command.run(away())
  const ui = await mount($, 'terminal')
  await ui.press({ key: 'tab:skipped' })
  expect(await ui.find({ key: 'approve' })).toBeFalsy()
  await ui.press({ key: 'tab:needs' })
  await ui.press({ key: SHOP8 })
  expect(await label(ui, 'approve')).toBe('approve plan')
})

test('s and a ask under the row and mark it, ⏎ on an open unit reads its report, h works on it here', async ($, on) => {
  const { calls } = engine(on, {
    'report --json': ok(busyReport),
    'report 20990101-050000 --unit acme-shop-3': { stdout: 'acme-shop-3: Pinned the clock' },
    'skip github:acme/shop#7': { stdout: 'github:acme/shop#7 is skipped until awaywork unskip' },
    'approve github:acme/shop#8': { stdout: 'plan approved: replied approve on the issue' },
    'approve github:acme/shop#9': {
      stdout: 'github:acme/shop#9 is approved until a unit on it finishes',
    },
  })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.command.run(away())
  const ui = await mount($, 'terminal')

  await ui.press({ key: 'skip' })
  expect(
    await ui.find({ type: 'Text', text: /skip github:acme\/shop#7 in the coming runs\?/ }),
  ).toBeTruthy()
  expect(await ui.find({ key: 'open' })).toBeFalsy()
  await ui.press({ key: 'no' })
  expect(calls.some((argv) => argv[1] === 'skip')).toBe(false)
  await ui.press({ key: 'skip' })
  await ui.press({ key: 'yes' })
  expect(calls).toContainEqual(['awaywork', 'skip', 'github:acme/shop#7'])
  expect(await ui.find({ type: 'Text', text: /is skipped until awaywork unskip/ })).toBeTruthy()
  expect(await line(ui, SHOP7)).toMatch(/ skipped$/)
  expect(await label(ui, 'skip')).toBe('unskip')

  await $.ui.focus(focus(SHOP8))
  await ui.press({ key: 'approve' })
  expect(
    await ui.find({ type: 'Text', text: /approve the plan on github:acme\/shop#8\?/ }),
  ).toBeTruthy()
  await $.ui.focus(focus(SHOP7))
  expect(await ui.find({ key: 'yes' })).toBeFalsy()
  await $.ui.focus(focus(SHOP8))
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'yes' })
  expect(calls).toContainEqual(['awaywork', 'approve', 'github:acme/shop#8'])
  expect(await line(ui, SHOP8)).toMatch(/ approved$/)
  await ui.press({ key: 'approve' })
  expect(await ui.find({ type: 'Text', text: 'already approved' })).toBeTruthy()

  await ui.press({ key: 'tab:skipped' })
  expect(await ui.find({ type: 'Text', text: 'already approved' })).toBeFalsy()
  await $.ui.focus(focus('row:skipped:github:acme/shop#10'))
  expect(await label(ui, 'skip')).toBe('unskip')
  await $.ui.focus(focus('row:skipped:github:acme/shop#9'))
  await ui.press({ key: 'approve' })
  expect(
    await ui.find({
      type: 'Text',
      text: /mark github:acme\/shop#9 approved for approved: true rules/,
    }),
  ).toBeTruthy()
  await ui.press({ key: 'yes' })
  expect(calls).toContainEqual(['awaywork', 'approve', 'github:acme/shop#9'])
  expect(calls.filter((argv) => argv[1] === 'approve')).toHaveLength(2)

  await ui.press({ key: 'tab:last' })
  await ui.press({ key: 'open:row:last:acme-shop-3' })
  expect(await ui.find({ type: 'Text', text: 'acme-shop-3: Pinned the clock' })).toBeTruthy()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'row:last:acme-shop-5' })
  expect(calls.filter((argv) => argv[2] === '20990101-050000')).toHaveLength(1)
  await ui.press({ key: 'here' })
  expect(prompts).toEqual([
    'continue awaywork unit acme-shop-5 of run 20990101-050000; start with `awaywork report 20990101-050000 --unit acme-shop-5`',
  ])
  expect(calls.some((argv) => argv[1] === 'plan')).toBe(false)
})

test('no run yet, and a run that found nothing, each say why and what next', async ($, on) => {
  let report: Reply = { exitCode: 1, stderr: 'no runs in /home/dev/.local/state/awaywork/runs' }
  engine(on, { 'report --json': () => report, 'plan --json': ok(emptyPlan) })
  await $.command.run(away())
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(
      await ui.find({ type: 'Text', text: /no run yet: `awaywork run`, or wait for the schedule/ }),
    ).toBeTruthy()
    expect(await ui.find({ key: 'tab:needs' })).toBeFalsy()
    await ui.unmount()
  }
  report = ok(emptyReport)
  const ui = await mount($, 'terminal')
  expect(
    await ui.find({ type: 'Text', text: /the last run found none of your items/ }),
  ).toBeTruthy()
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
    expect(
      await ui.find({
        type: 'Text',
        text: "awaywork isn't on your PATH: npm i -g awaywork@latest",
      }),
    ).toBeTruthy()
    await ui.unmount()
  }
  old = true
  const ui = await mount($, 'terminal')
  expect(
    await ui.find({
      type: 'Text',
      text: 'this awaywork is too old for the pane (no --json): npm i -g awaywork@latest',
    }),
  ).toBeTruthy()
})
