import type { Color, EngineInterface, Register, RenderChildren } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type {
  Action,
  ConfigState,
  Data,
  ItemRef,
  Mark,
  Plan,
  Planned,
  Report,
  Result,
  Skip,
  Tab,
  View,
} from '../types'
import { CARD_ROWS, type Card, card } from './cards'
import { awaywork, firstLine, json } from './cli'
import {
  configBody,
  configPaths,
  draftNamed,
  mentionsConfig,
  skillColor,
  syncConfig,
  useDraft,
  wantTakes,
} from './config'

const PANE = 'away'

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-3' })
const config = atom({ plugin: 'awaywork', key: 'config' } as const, {} as ConfigState, {
  shape: 'config-1',
})

/** One item of a tab under its group: its card, its detail, and the buttons it has. */
type Row = {
  id: string
  group: string
  /** Its place in its group: a skip's action's, as the CLI ranks them. */
  rank: number
  ref: string
  word: string
  color?: Color
  /** A card whose word is its status also says the skill. */
  skill?: string
  item?: ItemRef
  title: string
  /** The detail's lines under the title: the reason, or the unit's items and links. */
  detail: string[]
  url?: string
  /** The CLI's read of a last-run unit, what `v` shows. */
  report?: string[]
  skip?: 'skip' | 'unskip'
  approve?: true
  here?: string
}

async function readReport($: EngineInterface) {
  await update($, view, (v) => ({ ...v, status: undefined }))
  await update($, data, (d): Data => ({ ...d, loading: true }))
  const got = await json<Report>($, ['report', '--json'])
  const patch: Data =
    'json' in got
      ? { report: got.json }
      : 'failed' in got
        ? { noReport: got.failed }
        : { error: got.error }
  await update($, data, (d) => ({ plan: d.plan, planning: d.planning, ...patch }))
}

// plan probes quota and reads the forge, so it runs only when asked.
async function readPlan($: EngineInterface) {
  await update($, view, (v) => ({ ...v, status: undefined }))
  await update($, data, (d): Data => ({ ...d, planning: true }))
  const before = acts
  const got = await json<Plan>($, ['plan', '--json'], 600_000)
  const patch: Data =
    'json' in got ? { plan: got.json } : 'error' in got ? { error: got.error } : {}
  await update($, data, (d) => ({ ...d, planning: undefined, ...patch }))
  // A fresh plan shows what the marks said, unless an act came in while it was planning.
  if ('json' in got)
    await update($, view, (v) => ({ ...v, marks: acts === before ? undefined : v.marks }))
  if ('failed' in got) await update($, view, (v) => ({ ...v, status: `plan: ${got.failed}` }))
}

/** Work nobody awaits: whatever goes wrong ends on the error line, never on a "planning…" for good. */
const settled = ($: EngineInterface, work: Promise<void>, flag: 'loading' | 'planning') =>
  work.catch((e) => update($, data, (d) => ({ ...d, [flag]: undefined, error: String(e) })))

let reportCall: Promise<unknown> | undefined
let planCall: Promise<unknown> | undefined

const refresh = ($: EngineInterface) =>
  (reportCall ??= settled($, readReport($), 'loading').finally(() => {
    reportCall = undefined
  }))

const loadPlan = ($: EngineInterface) =>
  (planCall ??= settled($, readPlan($), 'planning').finally(() => {
    planCall = undefined
  }))

const itemKey = (item: ItemRef) => `${item.source}:${item.key}`

/** `shop#7` for `acme/shop#7`, as the CLI's `shortRef`; any other key as is. */
const shortRef = (key: string) => key.replace(/^[^/\s]+\/(?=[^/\s]+#\d+$)/, '')

/** `#7` for an item of `group`, else its short ref, as the CLI's `refIn`. */
const refIn = (group: string, key: string) =>
  key.startsWith(`${group}#`) ? key.slice(group.length) : shortRef(key)

/** Where an item's row goes: the repo its key names, else its source and project key, else its source, as the CLI's `groupOf`. */
function groupOf({ source, key }: ItemRef): string {
  const repo = /^([^/\s]+\/[^/\s]+)#\d+$/.exec(key)?.[1]
  const project = /^([A-Za-z]\w*)-\d+$/.exec(key)?.[1]
  return repo ?? (project ? `${source} ${project}` : source)
}

/** A skip's reason without the URL `o` opens, as the CLI's `reasonOf`. */
const reasonOf = (s: Skip) => s.reason.replace(` ${s.url ?? s.item.url}`, '').replace(/ on$/, '')

/** What a skip asks of you, or plainly why it waits, ranked as its group lists them, as the CLI's `actions`. */
const actions: Record<string, string> = {
  waiting_for_review: 'review PR',
  waiting_for_answer: 'answer question',
  waiting_for_approval: 'approve',
  invalid_plan: 'fix plan',
  store_failed: 'fix store',
  all_tasks_done: 'close card',
  gave_up: 'read logs',
  no_repo: 'add repo',
  invalid_branch: 'fix branch',
  refused_delivery: 'fix rule',
  draft_moved: 'finish by hand',
  continue_cap: 'finish by hand',
  no_rule: 'no rule',
  over_cap: 'over cap',
  unchanged: 'unchanged',
  skipped_by_you: 'skipped by you',
  fanned_out: 'fanned out',
  waiting_for_task: 'waits on task',
  task_merged: 'merged',
  task_done: 'done',
  approved: 'approved',
  continues_later: 'next run',
  running: 'running',
}

const ranks = Object.keys(actions)

const lines = (...text: (string | null | undefined)[]) => text.filter((t): t is string => !!t)

function skipRow(tab: Tab, s: Skip): Row {
  const key = itemKey(s.item)
  const group = groupOf(s.item)
  const url = s.url ?? s.item.url ?? undefined
  return {
    id: `row:${tab}:${key}`,
    group,
    rank: s.kind ? ranks.indexOf(s.kind) : ranks.length,
    ref: refIn(group, s.item.key),
    word: (s.kind && actions[s.kind]) || s.kind || 'skipped',
    color: s.needsYou ? 'warning' : undefined,
    item: s.item,
    title: s.item.title,
    detail: lines(reasonOf(s)),
    url,
    skip: s.kind === 'skipped_by_you' ? 'unskip' : 'skip',
    approve: s.kind === 'waiting_for_approval' || undefined,
  }
}

function resultRow(runId: string, r: Result): Row {
  const { id, repo, skill, items } = r.planned.unit
  const top = items[0]
  const fact =
    r.status === 'done'
      ? (r.summary ?? r.outcome?.url)
      : (r.reason ?? r.outcome?.reason ?? r.summary)
  const note = [skill, fact].filter(Boolean).join(' · ')
  const url = r.outcome?.url ?? top?.url ?? undefined
  return {
    id: `row:last:${id}`,
    group: repo,
    rank: 0,
    ref: top ? refIn(repo, top.key) : id,
    skill,
    word: r.status,
    color: r.status === 'done' ? 'success' : r.status === 'failed' ? 'error' : undefined,
    item: top,
    title: top?.title ?? note,
    detail: lines(note),
    url,
    report: ['report', runId, '--unit', id],
    skip: top && 'skip',
    here: `continue awaywork unit ${id} of run ${runId}; start with \`awaywork report ${runId} --unit ${id}\``,
  }
}

/** What a unit leaves, in the Config tab's words. */
const leavesWords: Record<string, string> = {
  draft_pr: 'draft PR',
  pr: 'PR',
  pending_review: 'pending review',
}

function unitRow(p: Planned): Row {
  const { id, repo, skill, deliver, items } = p.unit
  const top = items[0]
  const leaves = deliver && `${skill} ▶ ${leavesWords[deliver] ?? deliver}`
  const note = [leaves, p.provider].filter(Boolean).join(' · ')
  return {
    id: `row:next:${id}`,
    group: repo,
    rank: 0,
    ref: top ? refIn(repo, top.key) : id,
    word: skill,
    color: skillColor(skill),
    item: top,
    title: top?.title ?? note,
    detail: lines(
      note,
      ...items.flatMap((i) => [`${itemKey(i)}  ${i.title}`, i === top ? undefined : i.url]),
    ),
    url: top?.url ?? undefined,
    skip: top && 'skip',
  }
}

/** Rows under their group, the groups in the order they first come, each one's by rank. */
function grouped(rows: Row[]): Row[] {
  const groups = [...new Set(rows.map((r) => r.group))]
  return rows.toSorted(
    (a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.rank - b.rank,
  )
}

/** The tab and row a drawing shows, and what they come from. */
function layout(d: Data, v: View) {
  const plan = d.plan ?? d.report?.plan
  const skips = plan?.skipped ?? []
  const report = d.report
  const heads = report?.results.filter((r) => !r.planned.chain && !r.retried) ?? []
  const rows: Record<Tab, Row[]> = {
    needs: grouped(skips.filter((s) => s.needsYou).map((s) => skipRow('needs', s))),
    last: report ? grouped(heads.map((r) => resultRow(report.runId, r))) : [],
    next: grouped(d.plan?.units.filter((p) => !p.chain).map(unitRow) ?? []),
    skipped: grouped(skips.filter((s) => !s.needsYou).map((s) => skipRow('skipped', s))),
    config: [],
  }
  const landing =
    (['needs', 'last', 'skipped'] as const).find((t) => rows[t].length) ??
    (rows.next.length ? 'next' : undefined)
  const tab =
    v.tab === 'next' || v.tab === 'config' || (v.tab && rows[v.tab].length) ? v.tab : landing
  const order = ['needs', 'last', 'next', 'skipped', 'config'] as const
  const shown = order.filter((t) => t === 'next' || rows[t].length)
  const list = tab ? rows[tab] : []
  const row = list.find((r) => r.id === v.row) ?? list[0]
  return { report, heads, rows, tab, order, shown, list, row }
}

const pad = (n: number) => String(n).padStart(2, '0')

function when(iso: string, now: number) {
  const t = new Date(iso)
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  if (t.toDateString() === new Date(now).toDateString()) return time
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${time}`
}

const clip = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`

const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

const titles: Record<Tab, string> = {
  needs: 'Needs you',
  last: 'Last run',
  next: 'Next run',
  skipped: 'Skipped',
  config: 'Config',
}

const questions = {
  skip: (ref: string) => `skip ${ref} in the coming runs? awaywork unskip undoes it`,
  unskip: (ref: string) => `unskip ${ref}? the coming runs can take it again`,
  approve: (ref: string) => `approve ${ref}? awaywork replies approve on it, no undo`,
}

const marked: Record<Action, Mark> = {
  skip: { skip: 'skipped' },
  unskip: { skip: 'unskipped' },
  approve: { approved: true },
}

let acts = 0

// The rows come from the last run's or plan's JSON, which an act doesn't change: a mark says what it did.
async function act($: EngineInterface, action: Action, key: string) {
  await update($, view, (v) => ({ ...v, confirm: undefined, status: `${action}…` }))
  const r = await awaywork($, [action, key])
  if (r.exitCode === 0) acts++
  const said = firstLine(r.exitCode === 0 ? r.stdout : r.stderr) || `${action} exited ${r.exitCode}`
  await update($, view, (v) => ({
    ...v,
    status: said,
    marks:
      r.exitCode === 0 ? { ...v.marks, [key]: { ...v.marks?.[key], ...marked[action] } } : v.marks,
  }))
}

async function readRow($: EngineInterface, what: string[]) {
  await update($, view, (v) => ({ ...v, status: `awaywork ${what.join(' ')}…` }))
  const r = await awaywork($, what)
  const text = (r.stdout || r.stderr).trimEnd() || `exited ${r.exitCode}`
  await update($, view, (v) => ({
    ...v,
    status: undefined,
    reading: { title: `awaywork ${what.join(' ')}`, text },
    at: 0,
  }))
}

let opener: string | undefined

async function openInEditor($: EngineInterface, file: string, line: number) {
  const code = await $.process.run(['code', '-g', `${file}:${line}`]).catch(() => undefined)
  if (code?.exitCode !== 0) await openUrl($, file)
}

async function openUrl($: EngineInterface, url: string) {
  opener ??= (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  await $.process.run([opener, url])
}

const opens = (url: string) =>
  /\/(pull|merge_requests|pull-requests)\//.test(url)
    ? 'open PR'
    : /\/issues\//.test(url)
      ? 'open issue'
      : 'open'

async function showTab($: EngineInterface, tab: Tab) {
  await update($, view, (v) => ({ ...v, tab, row: undefined, at: 0, status: undefined }))
  if (tab === 'config') await wantTakes($)
}

type Key = { key: string; hotkey: string; label: string; run: () => unknown }

/** The selected card's buttons: the confirm's yes and no, back from a report, or what the card can do. */
function cardButtons($: EngineInterface, v: View, row: Row): Key[] {
  const { confirm } = v
  if (confirm)
    return [
      { key: 'yes', hotkey: 'y', label: 'yes', run: () => act($, confirm.action, confirm.key) },
      {
        key: 'no',
        hotkey: 'n',
        label: 'no',
        run: () =>
          update($, view, (x) => ({
            ...x,
            confirm: undefined,
            status: `not ${confirm.action === 'approve' ? 'approved' : `${confirm.action}ped`}`,
          })),
      },
    ]
  if (v.reading)
    return [
      {
        key: 'back',
        hotkey: 'b',
        label: 'back',
        run: () => update($, view, (x) => ({ ...x, reading: undefined, at: 0 })),
      },
    ]
  const { url, report, here, ref } = row
  const item = row.item && itemKey(row.item)
  const mark = item ? v.marks?.[item] : undefined
  const skip = mark?.skip ? (mark.skip === 'skipped' ? 'unskip' : 'skip') : row.skip
  const ask = (action: Action, question: string) => () =>
    item &&
    update($, view, (x) =>
      action === 'approve' && mark?.approved
        ? { ...x, status: 'already approved' }
        : { ...x, confirm: { action, key: item, question } },
    )
  const keys: (Key | '' | undefined)[] = [
    url && { key: 'open', hotkey: 'o', label: opens(url), run: () => openUrl($, url) },
    report && { key: 'report', hotkey: 'v', label: 'view report', run: () => readRow($, report) },
    skip && item && { key: 'skip', hotkey: 's', label: skip, run: ask(skip, questions[skip](ref)) },
    row.approve &&
      item && {
        key: 'approve',
        hotkey: 'a',
        label: 'approve',
        run: ask('approve', questions.approve(ref)),
      },
    here && {
      key: 'here',
      hotkey: 'c',
      label: 'ask Claude here',
      run: () => $.prompt.submit({ text: here, asUser: true }),
    },
  ]
  return keys.filter((b): b is Key => !!b)
}

const selected = (v: View, id: string): View => ({
  ...v,
  row: id,
  at: 0,
  confirm: undefined,
  reading: undefined,
  status: undefined,
})

// The card shown already keeps its question or report: the strip names it with every key it posts.
async function select($: EngineInterface, id: string) {
  const d = await read($, data)
  await update($, view, (v) => (layout(d, v).row?.id === id ? v : selected(v, id)))
}

// In one update, so keys pressed in a row each step from where the last one left.
async function step($: EngineInterface, by: number) {
  const d = await read($, data)
  await update($, view, (v) => {
    const { list, row } = layout(d, v)
    const to = row && list[Math.min(list.length - 1, Math.max(0, list.indexOf(row) + by))]
    return to && to.id !== row.id ? selected(v, to.id) : v
  })
}

/** No `strip` when the pane is too short for its regions: the engine scrolls it then. */
type Drawn = { press: Record<string, () => unknown>; strip?: [number, number]; detailMax: number }

/** The last drawing's hotkeys, strip rows and detail end: `ui.scroll` and the strip's posts see no drawing. */
let drawn: Drawn = { press: {}, detailMax: 0 }

const scrollDetail = ($: EngineInterface, by: number) =>
  drawn.strip
    ? update($, view, (v) => ({
        ...v,
        at: Math.min(drawn.detailMax, Math.max(0, (v.at ?? 0) + by)),
      }))
    : $.ui.scroll({ to: by < 0 ? 'start' : 'end', in: PANE })

const MIN_CARD = 24
const MAX_ROWS = 28
const MIN_DETAIL = 3

/** Cards a page and their width: as many as fit MIN_CARD wide, stretched to fill the row. */
function cardsFit(columns: number) {
  const n = Math.max(1, Math.floor((columns + 1) / (MIN_CARD + 1)))
  return { n, w: Math.floor((columns + 1) / n) - 1 }
}

/** A title in at most two lines, the second cut with an ellipsis. */
function twoLines(title: string, width: number) {
  const [first = '', ...rest] = wrap(title, width)
  return rest.length ? [first, clip(rest.join(' '), width)] : [first]
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = ''
      }
      line = line ? `${line} ${word}` : word
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

/** Rows a wrapping row of `parts` takes at `width`, `gap` apart. */
function rowsOf(parts: string[], width: number, gap = 2) {
  let rows = 1
  let used = 0
  for (const p of parts) {
    if (used && used + gap + p.length > width) {
      rows++
      used = 0
    }
    used += (used ? gap : 0) + p.length
  }
  return rows
}

async function inFlow($: EngineInterface) {
  const v = await read($, view)
  const rules = (await read($, config)).view?.rules
  return v.tab === 'config' && (v.source ?? 'flow') === 'flow' && !!rules?.length
}

async function stepRule($: EngineInterface, by: number) {
  const rules = (await read($, config)).view?.rules ?? []
  await update($, view, (v) => {
    const at = Math.max(
      0,
      rules.findIndex((r) => r.rule === v.rule),
    )
    return { ...v, rule: rules[Math.min(rules.length - 1, Math.max(0, at + Math.sign(by)))]?.rule }
  })
}

const paneOpen = async ($: EngineInterface) => (await $.ui.panes()).some((p) => p.id === PANE)

export const register: Register = (on) => {
  on('command.run', { command: ['away', 'awaywork:away'] }, async ($, e, next) => {
    // A request goes to the skill, and so does a run nobody typed with no surface to draw on (`-p`).
    // The desktop app attaches only once the pane asks to draw, so a typed /away opens it anyway.
    const headless = e.origin.kind !== 'composer' && (await $.session.surfaces()).length === 0
    if (headless) return next(e)
    const where = await configPaths($)
    if (where.missing) {
      await update($, view, (v): View => ({ marks: v.marks, tab: 'config' }))
      await $.ui.open({ id: PANE, title: 'awaywork' })
      void wantTakes($)
      return next(e)
    }
    if (e.args.trim()) return next(e)
    const drafting = !!where.draft && (await $.fs.exists(where.draft))
    await update($, view, (v): View => ({ marks: v.marks, tab: drafting ? 'config' : undefined }))
    await update($, data, (d): Data => ({ ...d, loading: true, planning: planCall && true }))
    await $.ui.open({ id: PANE, title: 'awaywork', focus: true, closeOnEscape: true })
    void refresh($)
    void (drafting ? wantTakes($) : syncConfig($))
    return {}
  })

  // Watchers start only here. The folder, so a first setup's files show up too; it must exist.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const { path } = await configPaths($)
    if (!path) return r
    const folder = path.slice(0, path.lastIndexOf('/'))
    await $.process.run(['mkdir', '-p', folder])
    return { ...r, watchPaths: [...(r.watchPaths ?? []), folder] }
  })

  on('classic.FileChanged', async ($, e, next) => {
    if (/\/config(\.draft)?\.yml$/.test(e.file_path) && (await paneOpen($))) void syncConfig($)
    return next(e)
  })

  // The agent's writes where no watcher looks yet: a draft in a control folder picked during setup.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const text =
      e.tool === 'Write' || e.tool === 'Edit' ? e.file_path : e.tool === 'Bash' ? e.command : ''
    if (!text || !mentionsConfig(text, await read($, config))) return r
    if (!(await paneOpen($))) return r
    const named = draftNamed(e.tool === 'Bash' ? text : ` ${text}`)
    if (named) await useDraft($, named)
    void syncConfig($)
    return r
  })

  // A body that fits its window: the wheel over the strip steps the cards, anything else scrolls the detail.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (await inFlow($)) {
      // The wheel still scrolls a body that overflows past the one spare row.
      if (e.pointer && e.contentRows > e.bodyRows + 1) return next(e)
      if (e.origin.kind === 'person') await stepRule($, e.by)
      return { deny: 'the arrows move between rules' }
    }
    if (!drawn.strip) return next(e)
    const r = e.pointer?.row
    const [top, bottom] = drawn.strip
    if (r !== undefined && r >= top && r <= bottom) await step($, Math.sign(e.by))
    else await scrollDetail($, e.by)
    return { deny: 'awaywork scrolls its own regions' }
  })

  on('ui.message', { element: 'cards' }, async ($, e) => {
    const m = e.data as { select?: string; key?: string }
    if (m.select) await select($, m.select)
    if (m.key === 'up' || m.key === 'down') await scrollDetail($, m.key === 'up' ? -1 : 1)
    else if (m.key === 'pageup' || m.key === 'pagedown')
      await scrollDetail($, m.key === 'pageup' ? -5 : 5)
    else if (m.key) {
      // The card's own keys as it is now: the select above may not be drawn yet.
      const d = await read($, data)
      const v = await read($, view)
      const { row } = layout(d, v)
      const own = row && cardButtons($, v, row).find((b) => b.hotkey === m.key)
      await (own ? own.run() : drawn.press[m.key]?.())
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Every surface's table names every tag, drawing the ones it lacks as nothing.
    const Client =
      (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in els
        ? els.Client
        : undefined
    const d = await read($, data)
    const v = await read($, view)
    const c = await read($, config)
    const width = e.props.bodyColumns
    const now = await $.clock.now()
    const press: Record<string, () => unknown> = {}

    const { report, heads, rows, tab, order, shown: reviews, list, row } = layout(d, v)
    const shown = c.setup
      ? (['config'] as const)
      : c.file
        ? [...reviews, 'config' as const]
        : reviews

    const prs = heads.filter((r) => r.outcome?.kind === 'pr').length
    const needs = rows.needs.length
    const noRunsYet = d.noReport && /^no runs in /.test(d.noReport)
    const facts = c.setup
      ? ['setting up']
      : d.error
        ? []
        : [
            report
              ? `last run ${when(report.finishedAt, now)}${report.dryRun ? ' (dry run)' : ''}`
              : d.loading
                ? 'reading the last run…'
                : d.noReport && !noRunsYet
                  ? d.noReport
                  : 'no run yet',
            prs > 0 && counted(prs, 'PR'),
            d.planning && 'planning…',
          ].filter(Boolean)

    /** A plain Button whose hotkey the strip can press too. */
    const button = (key: string, hotkey: string | undefined, label: string, run: () => unknown) => {
      if (hotkey) press[hotkey] = run
      return <Button key={key} plain hotkey={hotkey} label={label} onPress={() => void run()} />
    }

    const gap = e.surface === 'desktop' ? 'xs' : 0
    const needsYou = needs > 0 ? ` · ${needs} need you` : ''
    const lead = `☾ awaywork${facts.length ? ` · ${facts.join(' · ')}` : ''}${needsYou}`
    // The buttons beside the line when both fit, else under it, the line cut: never a wrap to guess.
    const headRows = lead.length + 2 + 'r: refresh p: plan'.length <= width ? 1 : 2
    const header = (
      <Box
        flexDirection={headRows === 1 ? 'row' : 'column'}
        justifyContent="space-between"
        columnGap={2}
      >
        <Text wrap="truncate-end">
          <Text bold>☾ awaywork</Text>
          {facts.length > 0 && <Text dimColor> · {facts.join(' · ')}</Text>}
          {needs > 0 && <Text color="warning">{needsYou}</Text>}
        </Text>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {button('refresh', 'r', 'refresh', () => (tab === 'config' ? wantTakes($) : refresh($)))}
          {!c.setup && button('plan', 'p', 'plan', () => loadPlan($))}
        </Box>
      </Box>
    )

    const label = (t: Tab) =>
      (t === 'next' && !d.plan) || t === 'config' ? titles[t] : `${titles[t]} (${rows[t].length})`
    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {shown.map((t) => {
          const hotkey = String(order.indexOf(t) + 1)
          press[hotkey] = () => showTab($, t)
          return (
            <Button
              key={`tab:${t}`}
              plain
              hotkey={hotkey}
              dimColor={t !== tab}
              label={label(t)}
              onPress={() => showTab($, t)}
            />
          )
        })}
      </Box>
    )
    const tabRows = rowsOf(
      shown.map((t) => `${order.indexOf(t) + 1}: ${label(t)}`),
      width,
    )
    const rule = (
      <Text dimColor wrap="truncate">
        {'─'.repeat(width)}
      </Text>
    )

    const done = (body?: RenderChildren, minHeight?: number) => {
      drawn = { press, detailMax: 0 }
      return (
        <Box flexDirection="column" rowGap={gap} minHeight={minHeight}>
          {header}
          {tabs}
          {rule}
          {body}
          {v.status && <Text dimColor>{v.status}</Text>}
        </Box>
      )
    }

    if (tab === 'config')
      return done(
        configBody({
          fill: (text) => $.prompt.fill({ text }),
          els,
          c,
          v,
          width,
          button,
          setView: (patch) => update($, view, (x) => ({ ...x, ...patch })),
          open: (file, line) => openInEditor($, file, line),
        }),
        // Arrows reach `ui.scroll` only while there's a row to scroll, so the flow keeps one spare.
        (v.source ?? 'flow') === 'flow' && c.view ? e.props.scroll.bodyRows + 1 : undefined,
      )
    if (d.error) return done(<Text>{d.error}</Text>)
    if (!tab) {
      if (d.loading) return done(<Text dimColor>reading the last run…</Text>)
      if (noRunsYet)
        return done(
          <Text>
            no run yet: `awaywork run`, or wait for the schedule; p shows what the next one takes
          </Text>,
        )
      if (d.noReport) return done(<Text>{d.noReport}</Text>)
      return done(
        <Text>
          {d.plan ? 'the plan' : 'the last run'} found none of your items: `/away` and say what to
          hand over to set up sources and rules
        </Text>,
      )
    }
    if (tab === 'next' && list.length === 0) {
      if (d.planning) return done(<Text dimColor>planning… it probes quota</Text>)
      if (!d.plan) return done(<Text dimColor>plan probes quota (one Haiku call): press p</Text>)
      return done(<Text dimColor>the next run takes nothing</Text>)
    }
    if (!row) return done(undefined)

    const at = list.indexOf(row)
    const { n, w } = cardsFit(width)
    // Client props are JSON: no undefined in them.
    const cards = list.map((r): Card => {
      const m = r.item && v.marks?.[itemKey(r.item)]
      const word = m ? [m.skip, m.approved && 'approved'].filter(Boolean).join(', ') : r.word
      const color = m ? 'warning' : r.color
      return {
        id: r.id,
        ref: r.ref,
        word,
        title: twoLines(r.title, w - 4),
        ...(color && { color }),
        ...(r.skill && { skill: { name: r.skill, color: skillColor(r.skill) } }),
      }
    })

    const nav = (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text wrap="truncate-end">
          <Text bold>{row.group}</Text>
          <Text dimColor>
            {'  '}
            {at + 1}/{list.length}
          </Text>
        </Text>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {button('prev', 'h', '‹', () => step($, -1))}
          {button('nextCard', 'l', '›', () => step($, 1))}
        </Box>
      </Box>
    )

    const start = Math.floor(at / n) * n
    const strip = Client ? (
      <Client
        key="cards"
        module="./cards.tsx"
        props={{ cards, at, n, w }}
        width={width}
        height={CARD_ROWS}
      />
    ) : (
      <Box flexDirection="row" columnGap={1} height={CARD_ROWS}>
        {cards
          .slice(start, start + n)
          .map((c, i) =>
            card(
              els,
              c,
              start + i === at,
              w,
              <Button key={`card:${c.id}`} plain label={c.ref} onPress={() => select($, c.id)} />,
            ),
          )}
      </Box>
    )

    // The detail: rows the pane scrolls itself.
    const body = v.reading
      ? [
          { text: v.reading.title, dim: true },
          ...wrap(v.reading.text, width).map((text) => ({ text, dim: false })),
        ]
      : [
          ...wrap(row.title, width).map((text) => ({ text, dim: false })),
          ...[...row.detail, row.url]
            .filter((l): l is string => !!l)
            .flatMap((l) => wrap(l, width))
            .map((text) => ({ text, dim: true })),
        ]

    const confirm = v.confirm
    const question = confirm ? wrap(confirm.question, width) : []
    const buttonRows = confirm ? question.length + 1 : 2

    // header, tabs, rule, nav, strip, buttons, rule, body, status; too short for that, the engine scrolls it all.
    const total = Math.min(e.props.scroll.bodyRows, MAX_ROWS)
    const top = headRows + tabRows + 2
    const fits = total - top - CARD_ROWS - buttonRows - 2 >= MIN_DETAIL
    const room = fits ? total - top - CARD_ROWS - buttonRows - 2 : body.length
    const detailMax = Math.max(0, body.length - room)
    const offset = Math.min(v.at ?? 0, detailMax)
    const shownBody = body.slice(offset, offset + room)
    const more = body.length - offset - room

    const keys = cardButtons($, v, row).map((b) => button(b.key, b.hotkey, b.label, b.run))
    const buttons = confirm ? (
      <Box flexDirection="column">
        {question.map((line) => (
          <Text wrap="truncate-end">{line}</Text>
        ))}
        <Box flexDirection="row" columnGap={2}>
          {keys}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {keys}
      </Box>
    )

    drawn = fits ? { press, strip: [top, top + CARD_ROWS - 1], detailMax } : { press, detailMax }
    return (
      <Box flexDirection="column" height={fits ? total : undefined} rowGap={gap}>
        {header}
        {tabs}
        {rule}
        {nav}
        {strip}
        <Box key="buttons" height={buttonRows}>
          {buttons}
        </Box>
        {rule}
        <Box key="detail" flexDirection="column" height={room}>
          {shownBody.map((l, i) => (
            <Text dimColor={l.dim} wrap="truncate-end">
              {i === room - 1 && more > 0 ? `↓ ${more + 1} more` : l.text}
            </Text>
          ))}
        </Box>
        <Text dimColor wrap="truncate-end">
          {v.status ?? ' '}
        </Text>
      </Box>
    )
  })
}
