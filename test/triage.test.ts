import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { pagerCommand } from '../src/cli/browse.js'
import { brandHeader } from '../src/cli/format.js'
import {
  clipLine,
  type Loading,
  loading,
  loadingView,
  planTriage,
  progress,
  ready,
  resize,
  runTriage,
  type State,
  settle,
  tick,
  update,
  view,
} from '../src/cli/triage.js'
import { acmePlan, acmeRun, waitingSkip } from './fakes/acme.js'

const files = [{ text: '1  api#1  PR 1', log: '/runs/1/worker.log' }]

const needsRow = 'T-4  no repo: no linked PR or repo field  https://app.asana.com/0/1/4'

const run = (rows = 30) => runTriage(acmeRun(), ['source tracker: Command failed'], files, rows)

const press = (state: State, ...keys: string[]) =>
  keys.reduce((s, key) => update(s, key).state, state)

const screen = (state: State, cols = 100, rows = state.rows) =>
  view(state, cols, rows).map((line) => stripVTControlCharacters(line).trimEnd())

const selectedLine = (state: State) =>
  stripVTControlCharacters(
    view(state, 100, state.rows).find((line) => line.includes('\u001b[7m')) ?? '',
  ).trim()

describe('triage view', () => {
  it('shows the run: header, warnings, needs you and units unfolded, skipped folded', () => {
    expect(screen(run(24))).toMatchInlineSnapshot(`
      [
        "Run 20261019-220000: 1 draft PR, 0 reports, 1 unit",
        "2026-10-19 22:00:00 to 2026-10-19 22:41:07",
        "claude: fallback, 1 of 4 units (no quota reading)",
        "",
        "▾ Warnings 1",
        "  source tracker: Command failed",
        "",
        "▾ Needs you 1",
        "  T-4  no repo: no linked PR or repo field  https://app.asana.com/0/1/4",
        "       Task 4",
        "",
        "▾ Units 1",
        "     item   skill  status          result",
        "  1  api#1  fix    done, 12 turns  https://github.com/acme/api/pull/9",
        "     Retries the flaky upload test instead of sleeping.",
        "",
        "▸ Skipped 2: 1 no_rule, 1 over_cap",
        "",
        "",
        "",
        "",
        "",
        "⏎ read  o open  l log  d diff  s skip  a approve  ? help  q quit",
        "",
      ]
    `)
  })

  it('shows the plan with its providers on top', () => {
    const lines = screen(planTriage(acmePlan(), [], 20))
    expect(lines.slice(0, 4)).toEqual([
      'Providers',
      '  provider  window    used  ceiling  set by  resets in  session / stop at',
      '  claude    fallback',
      '    4 units, 60 turns each (no quota reading)',
    ])
    expect(lines).toContain('  1  api#1  #1    fix (built-in)  claude    draft_pr  PR 1')
  })

  it('starts on the first Needs you item, in reverse video, else the first unit, else the first row', () => {
    expect(selectedLine(run())).toBe(needsRow)
    expect(view(run(), 80, 30).find((l) => l.includes('\u001b[7m'))).toBe(
      `\u001b[7m${`  ${needsRow}`.padEnd(80)}\u001b[27m`,
    )
    const r = acmeRun()
    r.plan.skipped = r.plan.skipped.filter((s) => s.kind !== 'no_repo')
    const warnings = ['source tracker: Command failed']
    expect(selectedLine(runTriage(r, warnings, files, 30))).toMatch(/^1 {2}api#1/)
    r.results = []
    expect(selectedLine(runTriage(r, warnings, files, 30))).toBe(warnings[0])
  })

  it('clips a long Needs you reason as the plain rows do', () => {
    const plan = acmePlan()
    plan.skipped.push(waitingSkip())
    expect(screen(planTriage(plan, [], 30), 130)).toContain(
      '  api#31  waiting for review: awaywork PR is open; closest #3 fix: ch…  https://github.com/acme/api/pull/31',
    )
  })

  it('unfolds Skipped into kinds, each folded, and a kind into its items', () => {
    const skipped = press(run(), 'G', 'right')
    expect(screen(skipped)).toContain('  ▸ no_rule 1')
    expect(screen(skipped)).toContain('  ▸ over_cap 1')
    const open = press(skipped, 'down', 'space')
    expect(screen(open)).toContain(
      '    api#3: matched no rule; closest #1 fix: checks is passing, wants failing',
    )
    expect(selectedLine(open)).toBe('▾ no_rule 1')
  })

  it('clips lines to the width, keeping their styles closed', () => {
    expect(clipLine('\u001b[1mabcdef\u001b[22m', 4)).toBe('\u001b[1mabc…\u001b[22m')
    expect(clipLine('abc', 4)).toBe('abc')
    for (const line of view(run(), 30, 30))
      expect([...stripVTControlCharacters(line)].length).toBeLessThanOrEqual(30)
  })

  it('shows the brand first, and drops it first on a short terminal, never the footer', () => {
    const brand = brandHeader(false)
    const state = { ...run(24), brand }
    expect(screen(state).slice(0, 4)).toEqual([
      brand,
      '',
      'Run 20261019-220000: 1 draft PR, 0 reports, 1 unit',
      '2026-10-19 22:00:00 to 2026-10-19 22:41:07',
    ])
    expect(screen(state)).toHaveLength(24)
    expect(screen(state).at(-2)).toMatch(/^⏎ read/)
    // 3 header lines, a blank, a body line, the footer and the status: no room for the brand.
    expect(screen(resize(state, 8), 100, 8)[0]).toBe(
      'Run 20261019-220000: 1 draft PR, 0 reports, 1 unit',
    )
    expect(screen(resize(state, 8), 100, 8).at(-2)).toMatch(/^⏎ read/)
    expect(screen(resize(state, 9), 100, 9)[0]).toBe(brand)
  })

  it("leaves log and diff out of a plan's footer and help, as a plan has neither", () => {
    const plan = planTriage(acmePlan(), [], 30)
    const footer = stripVTControlCharacters(view(plan, 120, 30).at(-2) ?? '')
    expect(footer).toBe('⏎ read  o open  s skip  a approve  ? help  q quit')
    const help = screen(update(plan, '?').state)
    expect(help).toContain("  o                 open the unit's PR, else the item")
    expect(help.join('\n')).not.toMatch(/^ {2}[ld] /m)
    const unit = press(plan, 'down', 'down')
    expect(update(unit, 'l')).toEqual({ state: unit })
    expect(screen(update(run(), '?').state)).toContain(
      "  l                 page the step's worker.log",
    )
  })

  it('dims the keys a row has nothing behind', () => {
    const footer = (state: State) => view(state, 120, state.rows).at(-2) ?? ''
    const dim = (label: string) => `\u001b[2m${label}\u001b[22m`
    const unit = press(run(), 'down', 'down')
    expect(selectedLine(unit)).toMatch(/^1 {2}api#1/)
    expect(footer(unit)).toContain(dim('d diff'))
    expect(footer(unit)).not.toContain(dim('l log'))
    const needs = run()
    expect(footer(needs)).toContain(dim('l log'))
    expect(footer(needs)).not.toContain(dim('⏎ read'))
    const heading = press(run(), 'up')
    expect(footer(heading)).toContain('⏎ fold')
    expect(footer(heading)).toContain(dim('o open'))
  })
})

describe('triage update', () => {
  it('moves with arrows and j k, jumps with g G, and stops at either end', () => {
    const start = run()
    expect(selectedLine(press(start, 'down', 'j'))).toMatch(/^1 {2}api#1/)
    expect(selectedLine(press(start, 'k', 'up', 'up', 'up'))).toBe('▾ Warnings 1')
    expect(selectedLine(press(start, 'G', 'down'))).toMatch(/^▸ Skipped 2/)
    expect(selectedLine(press(start, 'end', 'g'))).toBe('▾ Warnings 1')
    expect(selectedLine(press(start, 'home'))).toBe('▾ Warnings 1')
  })

  it('folds with ← and Space, and ← on a row goes to its section', () => {
    const start = run()
    const parent = press(start, 'left')
    expect(selectedLine(parent)).toBe('▾ Needs you 1')
    const folded = press(parent, 'left')
    expect(screen(folded)).not.toContain(`  ${needsRow}`)
    expect(selectedLine(folded)).toBe('▸ Needs you 1')
    expect(selectedLine(press(folded, 'space'))).toBe('▾ Needs you 1')
    expect(selectedLine(press(folded, 'return'))).toBe('▾ Needs you 1')
    expect(selectedLine(press(parent, 'right'))).toBe(needsRow)
  })

  it('scrolls to keep the selection on screen, and back', () => {
    const small = run(10)
    const bottom = press(small, 'G')
    expect(screen(bottom)).toContain('▸ Skipped 2: 1 no_rule, 1 over_cap')
    expect(screen(bottom)).not.toContain('▾ Warnings 1')
    const top = press(bottom, 'g')
    expect(screen(top)[4]).toBe('▾ Warnings 1')
    expect(top.top).toBe(0)
  })

  it('moves a screen with PageDown, PageUp, Ctrl-D and Ctrl-U', () => {
    const small = run(10)
    expect(selectedLine(press(small, 'pagedown'))).toBe('▾ Units 1')
    expect(selectedLine(press(small, 'pagedown', 'ctrl-d'))).toMatch(/^1 {2}api#1/)
    const bottom = press(small, 'pagedown', 'pagedown', 'pagedown')
    expect(selectedLine(bottom)).toMatch(/^▸ Skipped 2/)
    expect(screen(bottom)).toContain('▸ Skipped 2: 1 no_rule, 1 over_cap')
    expect(selectedLine(press(bottom, 'pageup'))).toBe('▾ Units 1')
    expect(selectedLine(press(bottom, 'ctrl-u', 'pageup', 'pageup', 'pageup'))).toBe('▾ Warnings 1')
  })

  it('keeps the footer and the prompt on a short terminal, dropping the header first', () => {
    const asked = update(run(6), 's').state
    expect(screen(asked, 40)).toMatchInlineSnapshot(`
      [
        "2026-10-19 22:00:00 to 2026-10-19 22:41…",
        "claude: fallback, 1 of 4 units (no quot…",
        "",
        "  T-4  no repo: no linked PR or repo fi…",
        "⏎ read  o open  l log  d diff  s skip  …",
        "y/n: skip asana:T-4 in the coming runs?…",
      ]
    `)
  })

  it('scrolls on resize', () => {
    const bottom = press(run(), 'G')
    expect(bottom.top).toBe(0)
    expect(screen(resize(bottom, 10))).toContain('▸ Skipped 2: 1 no_rule, 1 over_cap')
  })

  it('shows a selected heading, not the blank above it, in a one-line body', () => {
    expect(selectedLine(press(run(7), 'down'))).toBe('▾ Units 1')
    const branded = ready(loading(brandHeader(false), 'Loading the report'), run(9))
    expect(selectedLine(press(branded, 'down'))).toBe('▾ Units 1')
  })

  it('pages, opens and pages files through effects', () => {
    const unit = press(run(), 'down', 'down')
    expect(update(unit, 'return').effect).toEqual({
      action: 'read',
      target: files[0]?.text,
      row: 'units/0',
    })
    expect(update(unit, 'o').effect).toMatchObject({ target: 'https://github.com/acme/api/pull/9' })
    expect(update(unit, 'l').effect).toMatchObject({ action: 'log', target: '/runs/1/worker.log' })
    const needs = run()
    expect(update(needs, 'return').effect).toMatchObject({ action: 'read' })
    expect((update(needs, 'return').effect as { target: string }).target).toContain(
      'skipped: no_repo',
    )
    expect(update(needs, 'o').effect).toMatchObject({ target: 'https://app.asana.com/0/1/4' })
  })

  it('says why a key does nothing on this row', () => {
    const unit = press(run(), 'down', 'down')
    const { state, effect } = update(unit, 'd')
    expect(effect).toBeUndefined()
    expect(state.status).toBe('diff: this unit left no diff')
    const remote = runTriage(acmeRun(), [], [{ text: '' }], 30, true)
    expect(update(press(remote, 'down', 'down'), 'l').state.status).toBe(
      'log: a run fetched from GitHub keeps only its report',
    )
    expect(update(press(run(), 'up', 'up'), 's').state.status).toBe('skip: nothing here')
    expect(update(press(run(), 'up'), 'o').state.status).toBe(
      'open: a heading: pick a unit or an item',
    )
  })

  it('asks before it skips or approves, then marks the row', () => {
    const needs = run()
    const asked = update(needs, 's').state
    expect(asked.status).toBe('y/n: skip asana:T-4 in the coming runs? awaywork unskip undoes it')
    expect(update(asked, 'n').state.status).toBe('not skipped')
    expect(update(asked, 'n').effect).toBeUndefined()
    const { state, effect } = update(asked, 'y')
    expect(effect).toEqual({ action: 'skip', target: 'asana:T-4', row: 'needs/0' })
    if (!effect) return
    const done = settle(state, effect, {
      ok: true,
      message: 'skipped with awaywork skip asana:T-4',
    })
    expect(selectedLine(done)).toBe(`${needsRow}  skipped`)
    expect(update(done, 's').state.status).toBe('already skipped')
    expect(update(needs, 'a').state.status).toBe('y/n: approve asana:T-4? there is no undo')
    const approved = settle(
      state,
      { action: 'approve', target: 'asana:T-4', row: 'needs/0' },
      { ok: true, message: '' },
    )
    const both = settle(approved, effect, { ok: true, message: '' })
    expect(selectedLine(both)).toMatch(/ {2}approved, skipped$/)
    expect(update(both, 'a').state.status).toBe('already approved')
    const failed = settle(state, effect, { ok: false, message: 'source "asana" is not configured' })
    expect(failed.marks).toEqual({})
    expect(failed.status).toBe('source "asana" is not configured')
  })

  it('shows help until any key, and quits on q, Esc or Ctrl-C', () => {
    const help = update(run(), '?').state
    expect(screen(help)).toContain('Keys')
    expect(screen(help).at(-1)).toBe('any key closes the help')
    expect(update(help, 'j').state.help).toBe(false)
    for (const key of ['q', 'escape', 'ctrl-c'])
      expect(update(run(), key).effect).toEqual({ action: 'quit' })
    expect(update(help, 'ctrl-c').effect).toEqual({ action: 'quit' })
  })
})

describe('loader', () => {
  const brand = brandHeader(false)
  const loaded = (...steps: Parameters<typeof progress>[1][]) =>
    steps.reduce(progress, loading(brand, 'Planning the next run'))
  const shown = (l: Loading, cols = 60, rows = 10) =>
    loadingView(l, cols, rows).map((line) => stripVTControlCharacters(line).trimEnd())

  it('shows the brand, a spinner on the title, each step as it goes, and q', () => {
    const l = loaded(
      { name: 'github', state: 'done', detail: '142 items' },
      { name: 'tracker', state: 'failed', detail: 'Command failed with exit code 1' },
      { name: 'linking PRs', state: 'running', detail: '57/142' },
    )
    expect(shown(l)).toMatchInlineSnapshot(`
      [
        "☾ >_ awaywork  You're away, your agents work",
        "",
        "⠋ Planning the next run",
        "  ✔ github       142 items",
        "  ✖ tracker      Command failed with exit code 1",
        "  ⠋ linking PRs  57/142",
        "",
        "",
        "q quit",
        "",
      ]
    `)
    expect(shown(tick(l))[2]).toBe('⠙ Planning the next run')
  })

  it('updates a step in place, and adds a new one after the others', () => {
    const l = loaded(
      { name: 'github', state: 'running' },
      { name: 'claude quota', state: 'running' },
      { name: 'github', state: 'done', detail: '3 items' },
    )
    expect(l.steps.map((s) => [s.name, s.state])).toEqual([
      ['github', 'done'],
      ['claude quota', 'running'],
    ])
  })

  it('drops the brand on a short terminal, then the oldest steps, never q', () => {
    const steps = ['a', 'b', 'c', 'd'].map((name) => ({ name, state: 'done' as const }))
    expect(shown(loaded(...steps), 20, 7)[0]).toBe('⠋ Planning the next…')
    expect(shown(loaded(...steps), 20, 5)).toEqual([
      '⠋ Planning the next…',
      '  ✔ c',
      '  ✔ d',
      'q quit',
      '',
    ])
  })

  it('becomes the view under its brand', () => {
    const l = loaded({ name: 'github', state: 'done', detail: '3 items' })
    expect(screen(ready(l, run(24))).slice(0, 3)).toEqual([
      brand,
      '',
      'Run 20261019-220000: 1 draft PR, 0 reports, 1 unit',
    ])
  })
})

describe('pager', () => {
  it('is $PAGER, else less kept open on short texts, as it is for cat', () => {
    expect(pagerCommand('most')).toBe('most')
    for (const pager of ['', 'cat']) expect(pagerCommand(pager)).toBe('less -R -+F -+X')
  })
})
