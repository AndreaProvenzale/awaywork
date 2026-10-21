import { stripVTControlCharacters, styleText } from 'node:util'
import type { RunPlan } from '../core/foreman.js'
import {
  byKind,
  chains,
  needsYouOn,
  quotaLines,
  type ReportedSkip,
  type RunReport,
} from '../core/report.js'
import type { Item } from '../core/types.js'
import {
  formatWhy,
  heading,
  listedUnits,
  needsYouRows,
  planUnitTable,
  providerLines,
  reportUnitTable,
  runHeader,
  skippedHeading,
  skippedRows,
  warningBlock,
} from './format.js'

/** What a key does on a row. */
export type Action = 'read' | 'open' | 'log' | 'diff' | 'skip' | 'approve'

export interface Row {
  id: string
  text: string
  /** Lines under the row, shown unless it's folded: a unit's summary, a section's column header. */
  more?: string[]
  children?: Row[]
  /** What each key acts on: the text to page, a URL, a file, or the item's source:key. */
  act?: Partial<Record<Action, string>>
  /** Why a key does nothing here. */
  why?: Partial<Record<Action, string>>
}

export interface State {
  /** The brand line, shown above the header when there's room. */
  brand?: string
  header: string[]
  sections: Row[]
  /** What this view's keys can do: a plan has no logs or diffs. */
  actions: readonly Action[]
  open: ReadonlySet<string>
  selected: string
  /** The first body line on screen. */
  top: number
  /** The terminal's height. */
  rows: number
  marks: Readonly<Record<string, readonly string[]>>
  confirm?: { action: 'skip' | 'approve'; row: string; key: string }
  status?: string
  help?: boolean
}

export type Effect = { action: 'quit' } | { action: Action; target: string; row: string }

type Format = Parameters<typeof styleText>[0]

// Only a terminal ever sees this view.
const style = (format: Format, text: string) => styleText(format, text, { validateStream: false })

/** Every key, as `?` and the docs list them, with the action it needs. */
const keys: [string, string, Action?][] = [
  ['↑ ↓  j k', 'move'],
  ['g G  Home End', 'first, last row'],
  ['PgDn PgUp  ^D ^U', 'a screen down, up'],
  ['→ ← Space', 'unfold, fold, as ⏎ on a heading; ← on a row goes to its section'],
  ['⏎', 'read it in $PAGER: the unit in full, or why the item is planned or skipped'],
  ['o', "open the unit's PR, else the item"],
  ['l', "page the step's worker.log", 'log'],
  ['d', 'page the diff', 'diff'],
  ['s', 'skip the item in the coming runs, after y'],
  ['a', 'approve the item, after y; there is no undo'],
  ['?', 'this help'],
  ['q Esc', 'quit'],
]

const footerKeys: [string, Action, string][] = [
  ['⏎', 'read', 'read'],
  ['o', 'open', 'open'],
  ['l', 'log', 'log'],
  ['d', 'diff', 'diff'],
  ['s', 'skip', 'skip'],
  ['a', 'approve', 'approve'],
]

const itemKey = (item: Item) => `${item.source}:${item.key}`

const section = (id: string, title: string, children: Row[], more?: string[]): Row => ({
  id,
  text: heading(title, children.length, style),
  children,
  more,
})

function skipRow(
  plan: RunReport['plan'],
  s: ReportedSkip,
  [text = '', ...more]: string[],
  id: string,
): Row {
  const key = itemKey(s.item)
  return {
    id,
    text,
    more,
    act: {
      read: formatWhy(plan, s.item),
      open: s.url ?? s.item.url,
      skip: s.kind === 'skipped_by_you' ? undefined : key,
      approve: key,
    },
    why: {
      log: 'a skipped item has no worker.log',
      diff: 'a skipped item has no diff',
      skip: `already skipped by you; awaywork unskip ${key} undoes it`,
    },
  }
}

function warningSection(warnings: string[]): Row[] {
  if (warnings.length === 0) return []
  const rows = warnings.map((w, i) => {
    const [text = '', ...more] = warningBlock(w)
    return { id: `warnings/${i}`, text, more }
  })
  return [section('warnings', 'Warnings', rows)]
}

// The view clips each line to the terminal, not each cell.
const whole = Infinity

/** Warnings, what needs you, the units, then the other skipped items: by kind, each kind folded, when there are several. */
function sectionsOf(plan: RunReport['plan'], warnings: string[], units: Row): Row[] {
  const needs = needsYouRows(plan.skipped, style, whole).map(({ skipped, lines }, i) =>
    skipRow(plan, skipped, lines, `needs/${i}`),
  )
  const rest = plan.skipped.filter((s) => !needsYouOn(s))
  const rows = (list: ReportedSkip[], id: string) =>
    skippedRows(list, style, whole).map(({ skipped, lines }, i) =>
      skipRow(plan, skipped, lines, `${id}/${i}`),
    )
  const kinds = byKind(rest) ?? []
  const children =
    kinds.length > 1
      ? kinds.map(([kind, list]) => ({
          id: `skipped/${kind}`,
          text: `${kind} ${list.length}`,
          children: rows(list, `skipped/${kind}`),
        }))
      : rows(rest, 'skipped')
  return [
    ...warningSection(warnings),
    ...(needs.length ? [section('needs', 'Needs you', needs)] : []),
    units,
    ...(rest.length ? [{ id: 'skipped', text: skippedHeading(rest, style), children }] : []),
  ]
}

const unitSection = (header: string, rows: Row[]) =>
  section('units', 'Units', rows, [rows.length ? header : style('dim', 'none')])

function triage(
  header: string[],
  sections: Row[],
  rows: number,
  actions: readonly Action[],
): State {
  const open = new Set(sections.filter((s) => s.id !== 'skipped').map((s) => s.id))
  const state = { header, sections, actions, open, selected: '', top: 0, rows, marks: {} }
  const list = visible(state)
  const first =
    list.find((v) => v.parent === 'needs') ??
    list.find((v) => v.parent === 'units') ??
    list.find((v) => !v.row.children) ??
    list[0]
  return follow({ ...state, selected: first?.row.id ?? '' })
}

/** The plan to browse: providers on top, then warnings, what needs you, the units and the skipped items by kind. */
export function planTriage(plan: RunPlan, warnings: string[], rows: number): State {
  const { header, units } = planUnitTable(plan, style, whole)
  const listed = listedUnits(plan)
  const unitRows = units.map(([text = '', ...more], i): Row => {
    const top = listed[i]?.unit.items[0]
    const key = top && itemKey(top)
    return {
      id: `units/${i}`,
      text,
      more,
      act: { read: top && formatWhy(plan, top), open: top?.url, skip: key, approve: key },
    }
  })
  return triage(
    providerLines(plan, style),
    sectionsOf(plan, warnings, unitSection(header, unitRows)),
    rows,
    ['read', 'open', 'skip', 'approve'],
  )
}

/** What `report` pages for a unit: its `--unit` text and the files it left that are still there. */
export interface UnitFiles {
  text: string
  log?: string
  diff?: string
}

/** A run to browse: its headline and quota on top, then warnings, what needs you, the units and the skipped items by kind. */
export function runTriage(
  r: RunReport,
  warnings: string[],
  files: UnitFiles[],
  rows: number,
  remote = false,
): State {
  const { header, units } = reportUnitTable(r, true, whole)
  const missing = (file: string) =>
    remote ? 'a run fetched from GitHub keeps only its report' : `this unit left no ${file}`
  const unitRows = chains(r).map(({ head }, i): Row => {
    const top = head.planned.unit.items[0]
    const key = top && itemKey(top)
    const pr = head.outcome && 'url' in head.outcome ? head.outcome.url : undefined
    const [text = '', ...more] = units[i] ?? []
    return {
      id: `units/${i}`,
      text,
      more,
      act: {
        read: files[i]?.text,
        open: pr || top?.url,
        log: files[i]?.log,
        diff: files[i]?.diff,
        skip: key,
        approve: key,
      },
      why: { log: missing('worker.log'), diff: missing('diff') },
    }
  })
  return triage(
    [...runHeader(r, style), ...quotaLines(r)],
    sectionsOf(r.plan, warnings, unitSection(header, unitRows)),
    rows,
    footerKeys.map(([, action]) => action),
  )
}

interface Visible {
  row: Row
  depth: number
  parent?: string
}

const isOpen = (s: State, row: Row) => !row.children || s.open.has(row.id)

function visible(s: State): Visible[] {
  const out: Visible[] = []
  const walk = (rows: Row[], depth: number, parent?: string) => {
    for (const row of rows) {
      out.push({ row, depth, parent })
      if (row.children && s.open.has(row.id)) walk(row.children, depth + 1, row.id)
    }
  }
  walk(s.sections, 0)
  return out
}

interface Line {
  text: string
  /** The visible row the line belongs to. */
  at: number
  lead?: true
}

function layout(s: State): Line[] {
  const lines: Line[] = []
  visible(s).forEach(({ row, depth }, at) => {
    if (depth === 0 && at > 0) lines.push({ text: '', at })
    const indent = '  '.repeat(depth)
    const fold = row.children ? (isOpen(s, row) ? '▾ ' : '▸ ') : ''
    const marks = s.marks[row.id] ?? []
    const mark = marks.length ? `  ${style('yellow', marks.join(', '))}` : ''
    lines.push({ text: `${indent}${fold}${row.text}${mark}`, at, lead: true })
    if (!isOpen(s, row)) return
    const under = '  '.repeat(depth + (row.children ? 1 : 0))
    for (const more of row.more ?? []) lines.push({ text: `${under}${more}`, at })
  })
  return lines
}

/** The lines above the body: the brand when it leaves a body line, then the header. */
const headerLines = (s: State, rows: number) =>
  s.brand && rows >= s.header.length + 6 ? [s.brand, '', ...s.header] : s.header

const bodyHeight = (s: State, rows = s.rows) => Math.max(1, rows - headerLines(s, rows).length - 3)

/** Scrolls so the selected row is on screen, and no further than the last line. */
function follow(s: State): State {
  const lines = layout(s)
  const at = visible(s).findIndex((v) => v.row.id === s.selected)
  const height = bodyHeight(s)
  let top = s.top
  const last = lines.findLastIndex((l) => l.at === at)
  if (last >= top + height) top = last - height + 1
  const first = lines.findIndex((l) => l.at === at && l.lead)
  if (first < top) top = first
  return { ...s, top: Math.max(0, Math.min(top, lines.length - height)) }
}

/** The terminal's new height. */
export function resize(s: State, rows: number): State {
  return follow({ ...s, rows })
}

const labelOf = (action: Action) => footerKeys.find(([, a]) => a === action)?.[2] ?? action

function whyNot(row: Row, action: Action): string {
  return row.why?.[action] ?? (row.children ? 'a heading: pick a unit or an item' : 'nothing here')
}

const actionKeys: Record<string, Action> = {
  return: 'read',
  o: 'open',
  l: 'log',
  d: 'diff',
  s: 'skip',
  a: 'approve',
}

/** The next state after a key, and what the shell should do: page, open, skip, approve or quit. */
export function update(s: State, key: string): { state: State; effect?: Effect } {
  const state = { ...s, status: undefined }
  if (key === 'ctrl-c') return { state, effect: { action: 'quit' } }
  if (s.help) return { state: { ...state, help: false } }
  if (s.confirm) {
    const { action, row, key: target } = s.confirm
    const done = { ...state, confirm: undefined }
    if (key === 'y') return { state: done, effect: { action, target, row } }
    return { state: { ...done, status: `not ${action === 'skip' ? 'skipped' : 'approved'}` } }
  }
  const list = visible(s)
  const i = list.findIndex((v) => v.row.id === s.selected)
  const current = list[i]
  if (!current) return { state }
  const { row } = current
  const select = (at: number) => {
    const next = list[Math.max(0, Math.min(at, list.length - 1))]
    return { state: follow({ ...state, selected: next?.row.id ?? s.selected }) }
  }
  const fold = (open: boolean) => {
    const set = new Set(s.open)
    if (open) set.add(row.id)
    else set.delete(row.id)
    return { state: follow({ ...state, open: set }) }
  }
  const page = (by: number) => {
    const lines = layout(s)
    const first = lines.findIndex((l) => l.at === i)
    return select(lines[Math.max(0, Math.min(first + by, lines.length - 1))]?.at ?? i)
  }
  switch (key) {
    case 'up':
    case 'k':
      return select(i - 1)
    case 'down':
    case 'j':
      return select(i + 1)
    case 'home':
    case 'g':
      return select(0)
    case 'end':
    case 'G':
      return select(list.length - 1)
    case 'pagedown':
    case 'ctrl-d':
      return page(bodyHeight(s))
    case 'pageup':
    case 'ctrl-u':
      return page(-bodyHeight(s))
    case 'right':
      if (!row.children) return { state }
      return s.open.has(row.id) ? select(i + 1) : fold(true)
    case 'left':
      if (row.children && s.open.has(row.id)) return fold(false)
      if (!current.parent) return { state }
      return select(list.findIndex((v) => v.row.id === current.parent))
    case 'space':
      return row.children ? fold(!s.open.has(row.id)) : { state }
    case '?':
      return { state: { ...state, help: true } }
    case 'q':
    case 'escape':
      return { state, effect: { action: 'quit' } }
  }
  const action = actionKeys[key]
  if (!action || !s.actions.includes(action)) return { state }
  if (action === 'read' && row.children) return fold(!s.open.has(row.id))
  const target = row.act?.[action]
  if (!target) return { state: { ...state, status: `${labelOf(action)}: ${whyNot(row, action)}` } }
  if (action === 'skip' || action === 'approve') {
    const done = action === 'skip' ? 'skipped' : 'approved'
    if (s.marks[row.id]?.includes(done)) return { state: { ...state, status: `already ${done}` } }
    const prompt =
      action === 'skip'
        ? `y/n: skip ${target} in the coming runs? awaywork unskip undoes it`
        : `y/n: approve ${target}? there is no undo`
    return { state: { ...state, confirm: { action, row: row.id, key: target }, status: prompt } }
  }
  return { state, effect: { action, target, row: row.id } }
}

/** After the shell skipped or approved an item: the row's mark, or the error, in the status line. */
export function settle(s: State, effect: Effect, outcome: { ok: boolean; message: string }): State {
  if (effect.action !== 'skip' && effect.action !== 'approve')
    return { ...s, status: outcome.message }
  const mark = effect.action === 'skip' ? 'skipped' : 'approved'
  const marks = outcome.ok
    ? { ...s.marks, [effect.row]: [...(s.marks[effect.row] ?? []), mark] }
    : s.marks
  return { ...s, marks, status: outcome.message }
}

/** The screen: header, the rows that fit with the selected one in reverse video, the keys this row has, and the status line. */
export function view(s: State, cols: number, rows: number): string[] {
  const height = bodyHeight(s, rows)
  const list = visible(s)
  const body = s.help
    ? keyLines(s)
    : layout(s)
        .slice(s.top, s.top + height)
        .map((line) => {
          const selected = line.lead && list[line.at]?.row.id === s.selected
          return selected ? `\u001b[7m${pad(clipLine(line.text, cols), cols)}\u001b[27m` : line.text
        })
  const filler = Array<string>(Math.max(0, height - body.length)).fill('')
  const status = s.help ? style('dim', 'any key closes the help') : (s.status ?? '')
  return [...headerLines(s, rows), '', ...body.slice(0, height), ...filler, footer(s), status]
    .slice(-rows)
    .map((line) => clipLine(line, cols))
}

/** A loading step as it happens: running with how far it got, done with its result, or failed with why. */
export interface Step {
  name: string
  state: 'running' | 'done' | 'failed'
  detail?: string
}

export type OnProgress = (step: Step) => void

/** The screen before the view: the brand, what is loading and each step so far. */
export interface Loading {
  brand: string
  title: string
  steps: Step[]
  frame: number
}

export const loading = (brand: string, title: string): Loading => ({
  brand,
  title,
  steps: [],
  frame: 0,
})

/** A step's news, in place of its earlier line, else after the others. */
export function progress(l: Loading, step: Step): Loading {
  const at = l.steps.findIndex((s) => s.name === step.name)
  return { ...l, steps: at < 0 ? [...l.steps, step] : l.steps.with(at, step) }
}

export const tick = (l: Loading): Loading => ({ ...l, frame: l.frame + 1 })

const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** The loader: the brand, a spinner on the title, a line per step, and q to quit. */
export function loadingView(l: Loading, cols: number, rows: number): string[] {
  const frame = spinner[l.frame % spinner.length] ?? ''
  const marks = { running: frame, done: style('green', '✔'), failed: style('red', '✖') }
  const width = Math.max(0, ...l.steps.map((s) => s.name.length))
  const steps = l.steps.map(
    (s) => `  ${marks[s.state]} ${s.detail ? `${s.name.padEnd(width)}  ${s.detail}` : s.name}`,
  )
  const brand = rows >= steps.length + 5 ? [l.brand, ''] : []
  const room = rows - brand.length - 3
  const body = [`${frame} ${l.title}`, ...(room > 0 ? steps.slice(-room) : [])]
  const filler = Array<string>(Math.max(0, rows - brand.length - body.length - 2)).fill('')
  return [...brand, ...body, ...filler, style('dim', 'q quit'), '']
    .slice(-rows)
    .map((line) => clipLine(line, cols))
}

/** The view, on the loader's screen under the same brand. */
export const ready = (l: Loading, s: State): State => follow({ ...s, brand: l.brand })

function keyLines(s: State): string[] {
  const shown = keys.filter(([, , action]) => !action || s.actions.includes(action))
  const width = Math.max(...shown.map(([k]) => k.length))
  return [style('bold', 'Keys'), ...shown.map(([k, what]) => `  ${k.padEnd(width)}  ${what}`)]
}

function footer(s: State): string {
  const row = visible(s).find((v) => v.row.id === s.selected)?.row
  const listed = footerKeys.filter(([, action]) => s.actions.includes(action))
  const shown = listed.map(([key, action, label]) => {
    if (action === 'read' && row?.children) return `${key} ${isOpen(s, row) ? 'fold' : 'unfold'}`
    return row?.act?.[action] ? `${key} ${label}` : style('dim', `${key} ${label}`)
  })
  return [...shown, '? help', 'q quit'].join('  ')
}

/** CJK, Hangul, fullwidth forms and emoji take two columns; marks and joiners none. */
const wide =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u
const columns = (char: string) =>
  /\p{Mark}|\p{Default_Ignorable_Code_Point}/u.test(char) ? 0 : wide.test(char) ? 2 : 1

const width = (text: string) =>
  [...stripVTControlCharacters(text)].reduce((sum, char) => sum + columns(char), 0)

const pad = (text: string, cols: number) => text + ' '.repeat(Math.max(0, cols - width(text)))

/** Cuts a line to `cols` columns with an ellipsis, keeping every escape code so styles still close. */
export function clipLine(text: string, cols: number): string {
  if (width(text) <= cols) return text
  let out = ''
  let room = cols - 1
  // biome-ignore lint/suspicious/noControlCharactersInRegex: it splits on SGR escape codes
  for (const part of text.split(/(\u001b\[[\d;]*m)/)) {
    if (part.startsWith('\u001b[')) {
      out += part
      continue
    }
    for (const char of part) {
      if (room < 0) break
      room -= columns(char)
      out += room < 0 ? '…' : char
    }
  }
  return out
}
