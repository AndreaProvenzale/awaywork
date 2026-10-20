import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  clipLine,
  planTriage,
  resize,
  runTriage,
  type State,
  settle,
  update,
  view,
} from '../src/cli/triage.js'
import { acmePlan, acmeRun } from './fakes/acme.js'

const files = [{ text: '1  api#1  PR 1', log: '/runs/1/worker.log' }]

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
        "Run 20261019-220000: 1 draft PRs, 0 reports, 1 units",
        "2026-10-19 22:00:00 to 2026-10-19 22:41:07",
        "claude: fallback, 1 of 4 units (no quota reading)",
        "",
        "▾ Warnings",
        "  source tracker: Command failed",
        "",
        "▾ Needs you",
        "  T-4  no repo: no linked PR or repo field  https://app.asana.com/0/1/4",
        "       Task 4",
        "",
        "▾ Units",
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

  it('starts on the first row that is not a heading, in reverse video', () => {
    expect(selectedLine(run())).toBe('source tracker: Command failed')
    expect(view(run(), 60, 30).find((l) => l.includes('\u001b[7m'))).toBe(
      `\u001b[7m  source tracker: Command failed${' '.repeat(28)}\u001b[27m`,
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

  it('dims the keys a row has nothing behind', () => {
    const footer = (state: State) => view(state, 120, state.rows).at(-2) ?? ''
    const dim = (label: string) => `\u001b[2m${label}\u001b[22m`
    const unit = press(run(), 'down', 'down', 'down', 'down')
    expect(selectedLine(unit)).toMatch(/^1 {2}api#1/)
    expect(footer(unit)).toContain(dim('d diff'))
    expect(footer(unit)).not.toContain(dim('l log'))
    const needs = press(run(), 'down', 'down')
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
    expect(selectedLine(press(start, 'down', 'j'))).toBe(
      'T-4  no repo: no linked PR or repo field  https://app.asana.com/0/1/4',
    )
    expect(selectedLine(press(start, 'k', 'up', 'up'))).toBe('▾ Warnings')
    expect(selectedLine(press(start, 'G', 'down'))).toMatch(/^▸ Skipped 2/)
    expect(selectedLine(press(start, 'end', 'g'))).toBe('▾ Warnings')
    expect(selectedLine(press(start, 'home'))).toBe('▾ Warnings')
  })

  it('folds with ← and Space, and ← on a row goes to its section', () => {
    const start = run()
    const parent = press(start, 'left')
    expect(selectedLine(parent)).toBe('▾ Warnings')
    const folded = press(parent, 'left')
    expect(screen(folded)).not.toContain('  source tracker: Command failed')
    expect(selectedLine(folded)).toBe('▸ Warnings')
    expect(selectedLine(press(folded, 'space'))).toBe('▾ Warnings')
    expect(selectedLine(press(folded, 'return'))).toBe('▾ Warnings')
    expect(selectedLine(press(parent, 'right'))).toBe('source tracker: Command failed')
  })

  it('scrolls to keep the selection on screen, and back', () => {
    const small = run(10)
    const bottom = press(small, 'G')
    expect(screen(bottom)).toContain('▸ Skipped 2: 1 no_rule, 1 over_cap')
    expect(screen(bottom)).not.toContain('▾ Warnings')
    const top = press(bottom, 'g')
    expect(screen(top)[4]).toBe('▾ Warnings')
    expect(top.top).toBe(0)
  })

  it('scrolls on resize', () => {
    const bottom = press(run(), 'G')
    expect(bottom.top).toBe(0)
    expect(screen(resize(bottom, 10))).toContain('▸ Skipped 2: 1 no_rule, 1 over_cap')
  })

  it('pages, opens and pages files through effects', () => {
    const unit = press(run(), 'down', 'down', 'down', 'down')
    expect(update(unit, 'return').effect).toEqual({
      action: 'read',
      target: files[0]?.text,
      row: 'units/0',
    })
    expect(update(unit, 'o').effect).toMatchObject({ target: 'https://github.com/acme/api/pull/9' })
    expect(update(unit, 'l').effect).toMatchObject({ action: 'log', target: '/runs/1/worker.log' })
    const needs = press(run(), 'down', 'down')
    expect(update(needs, 'return').effect).toMatchObject({ action: 'read' })
    expect((update(needs, 'return').effect as { target: string }).target).toContain(
      'skipped: no_repo',
    )
    expect(update(needs, 'o').effect).toMatchObject({ target: 'https://app.asana.com/0/1/4' })
  })

  it('says why a key does nothing on this row', () => {
    const unit = press(run(), 'down', 'down', 'down', 'down')
    const { state, effect } = update(unit, 'd')
    expect(effect).toBeUndefined()
    expect(state.status).toBe('diff: this unit left no diff')
    const remote = runTriage(acmeRun(), [], [{ text: '' }], 30, true)
    expect(update(press(remote, 'down', 'down'), 'l').state.status).toBe(
      'log: a run fetched from GitHub keeps only its report',
    )
    expect(update(run(), 's').state.status).toBe('skip: nothing here')
    expect(update(press(run(), 'up'), 'o').state.status).toBe(
      'open: a heading: pick a unit or an item',
    )
  })

  it('asks before it skips or approves, then marks the row', () => {
    const needs = press(run(), 'down', 'down')
    const asked = update(needs, 's').state
    expect(asked.status).toBe('skip asana:T-4 in the coming runs? awaywork unskip undoes it  y/n')
    expect(update(asked, 'n').state.status).toBe('not skipped')
    expect(update(asked, 'n').effect).toBeUndefined()
    const { state, effect } = update(asked, 'y')
    expect(effect).toEqual({ action: 'skip', target: 'asana:T-4', row: 'needs/0' })
    if (!effect) return
    const done = settle(state, effect, {
      ok: true,
      message: 'skipped with awaywork skip asana:T-4',
    })
    expect(selectedLine(done)).toBe(
      'T-4  no repo: no linked PR or repo field  https://app.asana.com/0/1/4  skipped',
    )
    expect(update(done, 's').state.status).toBe('already skipped')
    expect(update(needs, 'a').state.status).toBe('approve asana:T-4? there is no undo  y/n')
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
