import type { Color, EngineInterface, Register, RenderChildren } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type {
  Action,
  Data,
  ItemRef,
  Mark,
  Plan,
  Planned,
  Report,
  Result,
  Rule,
  Skip,
  Tab,
  View,
  Where,
} from '../types'

const PANE = 'away'
const FIX = 'npm i -g awaywork@latest'

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-3' })

/** One row of a tab under its group, what it shows open, and the buttons it opens to. */
type Row = {
  id: string
  group: string
  /** Its place in its group: a skip's action's, as the CLI ranks them. */
  rank: number
  ref: string
  word: string
  color?: Color
  item?: ItemRef
  /** The line under the shut row: what the word doesn't say. */
  note: string
  /** The open row's lines: the full reason, or the unit's items, and the links. */
  detail: string[]
  url?: string
  /** The CLI's read of a last-run unit: ⏎ on the open row, or its `read report`. */
  report?: string[]
  skip?: 'skip' | 'unskip'
  approve?: 'plan' | 'mark'
  here?: string
}

type Got<T> = { json: T } | { error: string } | { failed: string }

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

async function awaywork($: EngineInterface, args: string[], timeoutMs = 60_000) {
  try {
    return await $.process.run(['awaywork', ...args], { timeoutMs })
  } catch (e) {
    const why = String(e)
    return /ENOENT|not found|no such file/i.test(why)
      ? { exitCode: 127, stdout: '', stderr: '', missing: `awaywork isn't on your PATH: ${FIX}` }
      : { exitCode: 1, stdout: '', stderr: why }
  }
}

async function json<T>($: EngineInterface, args: string[], timeoutMs?: number): Promise<Got<T>> {
  const r = await awaywork($, args, timeoutMs)
  if ('missing' in r && r.missing) return { error: r.missing }
  if (/unknown option '--json'/.test(r.stderr))
    return { error: `this awaywork is too old for the pane (no --json): ${FIX}` }
  if (r.exitCode !== 0)
    return { failed: firstLine(r.stderr) || `awaywork ${args.join(' ')} exited ${r.exitCode}` }
  try {
    return { json: JSON.parse(r.stdout) as T }
  } catch {
    return { failed: `awaywork ${args.join(' ')} printed no JSON` }
  }
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
  waiting_for_approval: 'approve plan',
  invalid_plan: 'fix plan',
  all_tasks_done: 'close card',
  gave_up: 'read logs',
  no_repo: 'add repo',
  invalid_branch: 'fix branch',
  refused_delivery: 'fix rule',
  unstackable: 'fix rule',
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
  continues_later: 'next run',
  running: 'running',
}

const ranks = Object.keys(actions)

/** What a reason starts with that its kind's action already says, as the CLI's `kindSays`. */
const kindSays: Record<string, RegExp> = {
  waiting_for_review: /^waiting for review: (awaywork PR is open$)?/,
  waiting_for_answer: /^waiting for your answer$/,
  waiting_for_approval: /^waiting for your approval of the plan$/,
  invalid_plan: /^plan refused: /,
  all_tasks_done: /^all tasks done: close or move the card$/,
  no_repo: /^no repo: no linked PR or repo field$/,
  no_rule: /^matched no rule(; |$)/,
  over_cap: /^over the cap: /,
  unchanged: /^unchanged /,
  skipped_by_you: /^skipped with awaywork skip \S+(: | |$)/,
  fanned_out: /^fanned out: /,
}

/** Whether a where waits for the mark `awaywork approve` leaves: `approved: true`, or `[true]`, in it or an `any` under it. */
const wantsApproval = ({ approved, any }: Where): boolean =>
  approved === true ||
  (Array.isArray(approved) && approved.includes(true)) ||
  !!any?.some(wantsApproval)

/** Whether a rule that can take `item` takes approved items. */
const takesApproval =
  (item: ItemRef) =>
  ({ source, where }: Rule) =>
    (!source || source === item.source) && !!where && wantsApproval(where)

const lines = (...text: (string | null | undefined)[]) => text.filter((t): t is string => !!t)

/** `marking`: a rule takes the item approved, so `approve` can make it run. */
function skipRow(tab: Tab, s: Skip, marking: (item: ItemRef) => boolean): Row {
  const key = itemKey(s.item)
  const group = groupOf(s.item)
  const url = s.url ?? s.item.url ?? undefined
  const reason = s.needsYou ? reasonOf(s).replace(/; closest #.*$/, '') : reasonOf(s)
  return {
    id: `row:${tab}:${key}`,
    group,
    rank: s.kind ? ranks.indexOf(s.kind) : ranks.length,
    ref: refIn(group, s.item.key),
    word: (s.kind && actions[s.kind]) || s.kind || 'skipped',
    color: s.needsYou ? 'warning' : undefined,
    item: s.item,
    note: reason.replace((s.kind && kindSays[s.kind]) || '', ''),
    detail: lines(reasonOf(s)),
    url,
    skip: s.kind === 'skipped_by_you' ? 'unskip' : 'skip',
    approve:
      s.kind === 'waiting_for_approval'
        ? 'plan'
        : marking(s.item) && !s.needsYou
          ? 'mark'
          : undefined,
  }
}

function resultRow(runId: string, r: Result, marking: (item: ItemRef) => boolean): Row {
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
    word: r.status,
    color: r.status === 'done' ? 'success' : r.status === 'failed' ? 'error' : undefined,
    item: top,
    note,
    detail: lines(note),
    url,
    report: ['report', runId, '--unit', id],
    skip: top && 'skip',
    approve: top && marking(top) ? 'mark' : undefined,
    here: `continue awaywork unit ${id} of run ${runId}; start with \`awaywork report ${runId} --unit ${id}\``,
  }
}

function unitRow(p: Planned): Row {
  const { id, repo, skill, deliver, items } = p.unit
  const top = items[0]
  const note = [deliver && `deliver ${deliver}`, p.provider].filter(Boolean).join(' · ')
  return {
    id: `row:next:${id}`,
    group: repo,
    rank: 0,
    ref: top ? refIn(repo, top.key) : id,
    word: skill,
    item: top,
    note,
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
  const marking = (item: ItemRef) => !!plan?.queue?.some(takesApproval(item))
  const rows: Record<Tab, Row[]> = {
    needs: grouped(skips.filter((s) => s.needsYou).map((s) => skipRow('needs', s, marking))),
    last: report ? grouped(heads.map((r) => resultRow(report.runId, r, marking))) : [],
    next: grouped(d.plan?.units.filter((p) => !p.chain).map(unitRow) ?? []),
    skipped: grouped(skips.filter((s) => !s.needsYou).map((s) => skipRow('skipped', s, marking))),
  }
  const landing =
    (['needs', 'last', 'skipped'] as const).find((t) => rows[t].length) ??
    (rows.next.length ? 'next' : undefined)
  const tab = v.tab === 'next' || (v.tab && rows[v.tab].length) ? v.tab : landing
  const order = ['needs', 'last', 'next', 'skipped'] as const
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
}

const questions = {
  skip: (key: string) => `skip ${key} in the coming runs? awaywork unskip undoes it`,
  unskip: (key: string) => `unskip ${key}? the coming runs can take it again`,
  approvePlan: (key: string) =>
    `approve the plan on ${key}? awaywork replies approve on it, no undo`,
  approve: (key: string) =>
    `mark ${key} approved for approved: true rules, until a unit on it finishes? no undo`,
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
  }))
}

let opener: string | undefined

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
}

const select = ($: EngineInterface, id: string) =>
  update($, view, (v) => ({
    ...v,
    row: id,
    at: 0,
    confirm: undefined,
    reading: undefined,
    status: undefined,
  }))

async function step($: EngineInterface, by: number) {
  const v = await read($, view)
  const { list, row } = layout(await read($, data), v)
  const to = row && list[Math.min(list.length - 1, Math.max(0, list.indexOf(row) + by))]
  if (to && to.id !== row.id) await select($, to.id)
}

// The detail's last offset, as the last drawing wrapped it.
let detailMax = 0

const scrollDetail = ($: EngineInterface, by: number) =>
  update($, view, (v) => ({ ...v, at: Math.min(detailMax, Math.max(0, (v.at ?? 0) + by)) }))

/** What each hotkey drawn last presses, for the keys the cards strip hands on. */
let pressers: Record<string, () => unknown> = {}

/** The strip's rows in the body, as the last drawing laid it out. */
let stripRows: [number, number] = [-1, -1]

const MIN_CARD = 24
const MAX_ROWS = 28

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

export const register: Register = (on) => {
  on('command.run', { command: ['away', 'awaywork:away'] }, async ($, e, next) => {
    // A request goes to the skill, and so does a run nobody typed with no surface to draw on (`-p`).
    // The desktop app attaches only once the pane asks to draw, so a typed /away opens it anyway.
    const headless = e.origin.kind !== 'composer' && (await $.session.surfaces()).length === 0
    if (e.args.trim() || headless) return next(e)
    await update($, view, (v) => ({ marks: v.marks }))
    await update($, data, (d): Data => ({ ...d, loading: true, planning: planCall && true }))
    await $.ui.open({ id: PANE, title: 'awaywork', focus: true, closeOnEscape: true })
    void refresh($)
    return {}
  })

  // The body fits its window: the wheel over the strip steps the cards, anything else scrolls the detail.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const r = e.pointer?.row
    if (r !== undefined && r >= stripRows[0] && r <= stripRows[1]) await step($, Math.sign(e.by))
    else await scrollDetail($, e.by)
    return { deny: 'awaywork scrolls its own regions' }
  })

  on('ui.message', { element: 'cards' }, async ($, e) => {
    const m = e.data as { select?: string; key?: string }
    if (m.select) await select($, m.select)
    else if (m.key === 'up' || m.key === 'down') await scrollDetail($, m.key === 'up' ? -1 : 1)
    else if (m.key === 'pageup' || m.key === 'pagedown')
      await scrollDetail($, m.key === 'pageup' ? -5 : 5)
    else if (m.key) await pressers[m.key]?.()
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Client = 'Client' in els ? els.Client : undefined
    const d = await read($, data)
    const v = await read($, view)
    const width = e.props.bodyColumns
    const now = await $.clock.now()
    const press: Record<string, () => unknown> = {}

    const { report, heads, rows, tab, order, shown, list, row } = layout(d, v)

    const prs = heads.filter((r) => r.outcome?.kind === 'pr').length
    const needs = rows.needs.length
    const noRunsYet = d.noReport && /^no runs in /.test(d.noReport)
    const facts = d.error
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

    const desktop = e.surface !== 'terminal'
    const lead = `☾ awaywork${facts.length ? ` · ${facts.join(' · ')}` : ''}`
    const needsYou = needs > 0 ? ` · ${needs} need you` : ''
    const header = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text>
          <Text bold>☾ awaywork</Text>
          {facts.length > 0 && <Text dimColor> · {facts.join(' · ')}</Text>}
          {needs > 0 && <Text color="warning">{needsYou}</Text>}
        </Text>
        <Box flexDirection="row" gap={1}>
          {button('refresh', 'r', 'refresh', () => refresh($))}
          {button('plan', 'p', 'plan', () => loadPlan($))}
        </Box>
      </Box>
    )
    const headRows = rowsOf([lead + needsYou, 'r: refresh p: plan'], width)

    const label = (t: Tab) =>
      t === 'next' && !d.plan ? titles[t] : `${titles[t]} (${rows[t].length})`
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

    const done = (body?: RenderChildren) => {
      pressers = press
      stripRows = [-1, -1]
      return (
        <Box flexDirection="column" rowGap={desktop ? 'xs' : 0}>
          {header}
          {tabs}
          {rule}
          {body}
          {v.status && <Text dimColor>{v.status}</Text>}
        </Box>
      )
    }

    if (d.error) return done(<Text>{d.error}</Text>)
    if (!tab) {
      if (d.loading) return done(<Text dimColor>reading the last run…</Text>)
      if (noRunsYet)
        return done(
          <Text>
            no run yet: `awaywork run`, or wait for the schedule; p shows what the next one takes
          </Text>,
        )
      if (d.noReport) return done(undefined) // the header says why
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
    const item = row.item && itemKey(row.item)
    const mark = item ? v.marks?.[item] : undefined
    const wordOf = (r: Row) => {
      const m = r.item && v.marks?.[itemKey(r.item)]
      return m ? [m.skip, m.approved && 'approved'].filter(Boolean).join(', ') : r.word
    }
    const { n, w } = cardsFit(width)
    // Client props are JSON: no undefined in them.
    const cards = list.map((r) => {
      const color = r.item && v.marks?.[itemKey(r.item)] ? 'warning' : r.color
      const title = twoLines(r.item?.title ?? r.note, w - 4)
      return { id: r.id, ref: r.ref, word: wordOf(r), title, ...(color && { color }) }
    })

    press.h = () => step($, -1)
    press.l = () => step($, 1)
    const nav = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold>{row.group}</Text>
          <Text dimColor>
            {'  '}
            {at + 1}/{list.length}
          </Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="prev" plain hotkey="h" label="‹" onPress={() => step($, -1)} />
          <Button key="nextCard" plain hotkey="l" label="›" onPress={() => step($, 1)} />
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
        height={5}
      />
    ) : (
      <Box flexDirection="row" columnGap={1} height={5}>
        {cards.slice(start, start + n).map((c, i) => {
          const picked = start + i === at
          return (
            <Button
              key={`card:${c.id}`}
              label={`${c.ref} ${c.word}`}
              onPress={() => select($, c.id)}
            >
              <Box
                width={w}
                height={5}
                flexDirection="column"
                paddingX={1}
                borderStyle={picked ? 'bold' : 'round'}
                borderColor={picked ? 'suggestion' : 'inactive'}
              >
                <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
                  <Text bold={picked} wrap="truncate-end">
                    {c.ref}
                  </Text>
                  <Box flexShrink={0}>
                    <Text color={c.color} dimColor={!c.color}>
                      {c.word}
                    </Text>
                  </Box>
                </Box>
                {c.title.map((line) => (
                  <Text dimColor={!picked} wrap="truncate-end">
                    {line}
                  </Text>
                ))}
              </Box>
            </Button>
          )
        })}
      </Box>
    )

    // The detail: rows the pane scrolls itself.
    const reason = row.detail.length ? row.detail : [row.note]
    const body = v.reading
      ? [
          { text: v.reading.title, dim: true },
          ...wrap(v.reading.text, width).map((text) => ({ text, dim: false })),
        ]
      : [
          ...wrap(row.item?.title ?? '', width).map((text) => ({ text, dim: false })),
          ...[...reason, row.url]
            .filter((l): l is string => !!l)
            .flatMap((l) => wrap(l, width))
            .map((text) => ({ text, dim: true })),
        ]

    // header, tabs, rule, nav, strip (5), buttons (2), rule, body, status.
    const total = Math.min(e.props.scroll.bodyRows, MAX_ROWS)
    const fixed = headRows + tabRows + 1 + 1 + 5 + 2 + 1 + 1
    const room = Math.max(3, total - fixed)
    detailMax = Math.max(0, body.length - room)
    const offset = Math.min(v.at ?? 0, detailMax)
    const shownBody = body.slice(offset, offset + room)
    const more = body.length - offset - room

    const skip = mark?.skip ? (mark.skip === 'skipped' ? 'unskip' : 'skip') : row.skip
    const ask = (action: Action, question: string) => () =>
      item &&
      update($, view, (x) =>
        action === 'approve' && mark?.approved
          ? { ...x, status: 'already approved' }
          : { ...x, confirm: { action, key: item, question } },
      )
    const confirm = v.confirm
    const buttons = confirm ? (
      <Box flexDirection="column">
        <Text wrap="truncate-end">{confirm.question}</Text>
        <Box flexDirection="row" columnGap={2}>
          {button('yes', 'y', 'yes', () => act($, confirm.action, confirm.key))}
          {button('no', 'n', 'no', () =>
            update($, view, (x) => ({
              ...x,
              confirm: undefined,
              status: `not ${confirm.action === 'approve' ? 'approved' : `${confirm.action}ped`}`,
            })),
          )}
        </Box>
      </Box>
    ) : v.reading ? (
      <Box flexDirection="row">
        {button('back', 'b', 'back', () =>
          update($, view, (x) => ({ ...x, reading: undefined, at: 0 })),
        )}
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {row.url && button('open', 'o', opens(row.url), () => openUrl($, row.url as string))}
        {row.report &&
          button('report', 'v', 'view report', () => readRow($, row.report as string[]))}
        {skip && item && button('skip', 's', skip, ask(skip, questions[skip](item)))}
        {row.approve &&
          item &&
          button(
            'approve',
            'a',
            row.approve === 'plan' ? 'approve plan' : 'mark approved',
            ask(
              'approve',
              row.approve === 'plan' ? questions.approvePlan(item) : questions.approve(item),
            ),
          )}
        {row.here &&
          button('here', 'c', 'ask Claude here', () =>
            $.prompt.submit({ text: row.here as string, asUser: true }),
          )}
      </Box>
    )
    if (row.report && !v.reading) press.return = () => readRow($, row.report as string[])

    pressers = press
    const top = headRows + tabRows + 2
    stripRows = [top, top + 4]

    return (
      <Box flexDirection="column" height={total} rowGap={desktop ? 'xs' : 0}>
        {header}
        {tabs}
        {rule}
        {nav}
        {strip}
        <Box height={2}>{buttons}</Box>
        {rule}
        <Box flexDirection="column" height={room}>
          {shownBody.map((l, i) => (
            <Text dimColor={l.dim} wrap="truncate-end">
              {i === room - 1 && more > 0 ? `↓ ${more} more` : l.text}
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
