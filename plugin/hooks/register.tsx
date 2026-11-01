import type { Color, EngineInterface, Register } from 'claude-code'
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
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-2' })

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
  await keepRing($)
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
  await keepRing($)
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

/** The open row's key: another element than the shut row's, so focusing it waits for the drawing that opens it. */
const opened = (id: string) => `open:${id}`

/** The keys of the buttons under the open row: ⏎ on the row reads its report, a hotkey presses each other one. */
const rowButtons = ['open', 'report', 'skip', 'approve', 'here', 'yes', 'no']

// The ring keeps its place, not its element, when a tab appears or a row opens: put it on the open row.
async function keepRing($: EngineInterface) {
  const v = await read($, view)
  const { row } = layout(await read($, data), v)
  if (row && !v.reading)
    await $.ui.focus({ requestId: PANE, key: opened(row.id) }).catch(() => undefined)
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

// The ring keeps its place across a redraw: move it onto the new tab's first row.
async function showTab($: EngineInterface, tab: Tab, first?: string) {
  await update($, view, (v) => ({ ...v, tab, row: first, status: undefined }))
  if (first) await $.ui.focus({ requestId: PANE, key: opened(first) }).catch(() => undefined)
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

// The open row is the ring's: Tab opens the row it lands on, a click the row it hits, ⏎ on the open one reads its report.
async function pressRow($: EngineInterface, r: Row, open: boolean) {
  if (open) return r.report && readRow($, r.report)
  await update($, view, (v) => ({ ...v, row: r.id, confirm: undefined, status: undefined }))
  await $.ui.focus({ requestId: PANE, key: opened(r.id) }).catch(() => undefined)
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

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const v = await read($, view)
    const { list, row } = layout(await read($, data), v)
    const after = row && list[list.indexOf(row) + 1]
    // Tab and the arrows go row to row, past the open row's buttons: their hotkeys press them.
    const past = e.origin.kind === 'person' && after && rowButtons.includes(e.element ?? '')
    const moved = past ? { ...e, element: after.id } : e
    const { element } = moved
    if (!element?.startsWith('row:') || element === v.row) return next(moved)
    await update($, view, (x) => ({ ...x, row: element, confirm: undefined, status: undefined }))
    // Once this move is done, the ring goes onto the row it opened.
    $.clock.after(0, () => void keepRing($))
    return next(moved)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, data)
    const v = await read($, view)
    const width = e.props.bodyColumns
    const now = await $.clock.now()

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

    const header = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text>
          <Text bold>awaywork</Text>
          {facts.length > 0 && <Text dimColor> · {facts.join(' · ')}</Text>}
          {needs > 0 && <Text color="warning"> · {needs} need you</Text>}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="refresh"
            plain
            dimColor
            hotkey="r"
            label="refresh"
            onPress={() => void refresh($)}
          />
          <Button
            key="plan"
            plain
            dimColor
            hotkey="p"
            label="plan"
            onPress={() => void loadPlan($)}
          />
        </Box>
      </Box>
    )

    if (d.error)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text>{d.error}</Text>
        </Box>
      )

    if (v.reading)
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{v.reading.title}</Text>
          <Text>{v.reading.text}</Text>
          <Button
            key="back"
            plain
            dimColor
            autoFocus
            hotkey="b"
            label="back"
            onPress={async () => {
              await update($, view, (x) => ({ ...x, reading: undefined }))
              await keepRing($)
            }}
          />
        </Box>
      )

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {shown.map((t) => (
          <Button
            key={`tab:${t}`}
            plain
            hotkey={String(order.indexOf(t) + 1)}
            dimColor={t !== tab}
            label={t === 'next' && !d.plan ? titles[t] : `${titles[t]} (${rows[t].length})`}
            onPress={() => showTab($, t, rows[t][0]?.id)}
          />
        ))}
      </Box>
    )

    const empty = () => {
      if (d.loading) return <Text dimColor>reading the last run…</Text>
      if (noRunsYet)
        return (
          <Text>
            no run yet: `awaywork run`, or wait for the schedule; p shows what the next one takes
          </Text>
        )
      if (d.noReport) return // the header says why
      return (
        <Text>
          {d.plan ? 'the plan' : 'the last run'} found none of your items: `/away` and say what to
          hand over to set up sources and rules
        </Text>
      )
    }

    const next = () => {
      if (d.planning) return <Text dimColor>planning… it probes quota</Text>
      if (!d.plan) return <Text dimColor>plan probes quota (one Haiku call): press p</Text>
      if (list.length === 0) return <Text dimColor>the next run takes nothing</Text>
    }

    // The open row's buttons, or the question one of them asked.
    const buttons = (r: Row) => {
      if (v.confirm) {
        const { action, key } = v.confirm
        return (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text>{v.confirm.question}</Text>
            <Button
              key="yes"
              plain
              hotkey="y"
              label="yes"
              onPress={() => void act($, action, key)}
            />
            <Button
              key="no"
              plain
              hotkey="n"
              label="no"
              onPress={() =>
                update($, view, (x) => ({
                  ...x,
                  confirm: undefined,
                  status: `not ${action === 'approve' ? 'approved' : `${action}ped`}`,
                }))
              }
            />
          </Box>
        )
      }
      const item = r.item && itemKey(r.item)
      const mark = item ? v.marks?.[item] : undefined
      const skip = mark?.skip ? (mark.skip === 'skipped' ? 'unskip' : 'skip') : r.skip
      const ask = (action: Action, question: string) => () =>
        item &&
        update($, view, (x) =>
          action === 'approve' && mark?.approved
            ? { ...x, status: 'already approved' }
            : { ...x, confirm: { action, key: item, question } },
        )
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {r.url && (
            <Button
              key="open"
              plain
              hotkey="o"
              label={opens(r.url)}
              onPress={() => openUrl($, r.url as string)}
            />
          )}
          {r.report && (
            <Button
              key="report"
              plain
              label="read report"
              onPress={() => readRow($, r.report as string[])}
            />
          )}
          {skip && item && (
            <Button
              key="skip"
              plain
              hotkey="s"
              label={skip}
              onPress={ask(skip, questions[skip](item))}
            />
          )}
          {r.approve && item && (
            <Button
              key="approve"
              plain
              hotkey="a"
              label={r.approve === 'plan' ? 'approve plan' : 'mark approved'}
              onPress={ask(
                'approve',
                r.approve === 'plan' ? questions.approvePlan(item) : questions.approve(item),
              )}
            />
          )}
          {r.here && (
            <Button
              key="here"
              plain
              hotkey="h"
              label="ask Claude here"
              onPress={() => $.prompt.submit({ text: r.here as string, asUser: true })}
            />
          )}
        </Box>
      )
    }

    const body = () => {
      if (!tab) return empty()
      if (tab === 'next' && list.length === 0) return next()
      return list.map((r, i) => {
        const open = r.id === row?.id
        const lead = `${open ? '▾ ' : ''}${r.ref}`
        const mark = r.item && v.marks?.[itemKey(r.item)]
        const word = mark
          ? [mark.skip, mark.approved && 'approved'].filter(Boolean).join(', ')
          : r.word
        // Two for the indent, two between ref and title, two before the word.
        const title = clip(r.item?.title ?? '', width - lead.length - word.length - 6)
        return (
          <Box flexDirection="column">
            {r.group !== list[i - 1]?.group && <Text bold>{r.group}</Text>}
            <Box flexDirection="column" paddingLeft={2}>
              <Box key={`line:${r.id}`} flexDirection="row" justifyContent="space-between">
                <Button
                  key={open ? opened(r.id) : r.id}
                  plain
                  autoFocus={i === 0 || undefined}
                  onPress={() => void pressRow($, r, open)}
                >
                  {lead}
                  {'  '}
                  <Text dimColor>{title}</Text>
                </Button>
                <Text color={mark ? 'warning' : r.color} dimColor={!mark && !r.color}>
                  {'  '}
                  {word}
                </Text>
              </Box>
              {open ? (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text dimColor>{r.detail.join('\n')}</Text>
                  {buttons(r)}
                </Box>
              ) : (
                r.note && (
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {r.note}
                  </Text>
                )
              )}
            </Box>
          </Box>
        )
      })
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {tabs}
        <Box flexDirection="column">{body()}</Box>
        {v.status && <Text dimColor>{v.status}</Text>}
      </Box>
    )
  })
}
