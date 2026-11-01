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
  Skip,
  Tab,
  View,
} from '../types'

const PANE = 'away'
const FIX = 'npm i -g awaywork@latest'

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-2' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-2' })

/** One row of a tab, and what each key does on it. */
type Row = {
  id: string
  word: string
  color?: Color
  item?: ItemRef
  note: string
  url?: string
  /** What ⏎ shows: the CLI's own read, or what the loaded JSON already says. */
  read: string[] | { title: string; text: string }
  skip?: 'skip' | 'unskip'
  waitsOnPlan?: true
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

/** A skip's reason without the URL `o` opens, as the CLI's `reasonOf`. */
const reasonOf = (s: Skip) => s.reason.replace(` ${s.url ?? s.item.url}`, '').replace(/ on$/, '')

/** What a reason starts with that its kind already says, as the CLI's `kindSays`. */
const kindSays: Record<string, RegExp> = {
  no_rule: /^matched no rule(; |$)/,
  over_cap: /^over the cap: /,
  unchanged: /^unchanged /,
}

function skipRow(tab: Tab, s: Skip): Row {
  const key = itemKey(s.item)
  const url = s.url ?? s.item.url ?? undefined
  return {
    id: `row:${tab}:${key}`,
    word: s.kind ?? 'skipped',
    color: s.needsYou ? 'warning' : undefined,
    item: s.item,
    note: reasonOf(s).replace((s.kind && kindSays[s.kind]) || '', ''),
    url,
    read: { title: `${key}  ${s.item.title}`, text: [reasonOf(s), url].filter(Boolean).join('\n') },
    skip: s.kind === 'skipped_by_you' ? 'unskip' : 'skip',
    waitsOnPlan: s.kind === 'waiting_for_approval' || undefined,
  }
}

function resultRow(runId: string, r: Result): Row {
  const { id, skill, items } = r.planned.unit
  const top = items[0]
  const fact =
    r.status === 'done'
      ? (r.summary ?? r.outcome?.url)
      : (r.reason ?? r.outcome?.reason ?? r.summary)
  return {
    id: `row:last:${id}`,
    word: r.status,
    color: r.status === 'done' ? 'success' : r.status === 'failed' ? 'error' : undefined,
    item: top,
    note: [skill, fact].filter(Boolean).join(' · '),
    url: r.outcome?.url ?? top?.url ?? undefined,
    read: ['report', runId, '--unit', id],
    skip: top && 'skip',
    here: `continue awaywork unit ${id} of run ${runId}; start with \`awaywork report ${runId} --unit ${id}\``,
  }
}

function unitRow(p: Planned): Row {
  const { id, repo, skill, deliver, items } = p.unit
  const top = items[0]
  const note = [repo, deliver && `deliver ${deliver}`, p.provider].filter(Boolean).join(' · ')
  const lines = items.map((i) => `${itemKey(i)}  ${i.title}${i.url ? `\n  ${i.url}` : ''}`)
  return {
    id: `row:next:${id}`,
    word: skill,
    item: top,
    note,
    url: top?.url ?? undefined,
    read: { title: `unit ${id}: ${skill} · ${note}`, text: lines.join('\n') },
    skip: top && 'skip',
  }
}

/** The tab and row a drawing shows, and what they come from. */
function layout(d: Data, v: View) {
  const plan = d.plan ?? d.report?.plan
  const skips = plan?.skipped ?? []
  const report = d.report
  const heads = report?.results.filter((r) => !r.planned.chain && !r.retried) ?? []
  const rows: Record<Tab, Row[]> = {
    needs: skips.filter((s) => s.needsYou).map((s) => skipRow('needs', s)),
    last: report ? heads.map((r) => resultRow(report.runId, r)) : [],
    next: d.plan?.units.filter((p) => !p.chain).map(unitRow) ?? [],
    skipped: skips.filter((s) => !s.needsYou).map((s) => skipRow('skipped', s)),
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

// The ring keeps its place, not its element, when a tab appears or ⏎'s text goes: put it on the row.
async function keepRing($: EngineInterface) {
  const v = await read($, view)
  const { row } = layout(await read($, data), v)
  if (row && !v.reading) await $.ui.focus({ requestId: PANE, key: row.id }).catch(() => undefined)
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

async function readRow($: EngineInterface, { read: what }: Row) {
  if (!Array.isArray(what))
    return update($, view, (v) => ({ ...v, status: undefined, reading: what }))
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
  if (first) await $.ui.focus({ requestId: PANE, key: first }).catch(() => undefined)
}

let opener: string | undefined

async function openUrl($: EngineInterface, url: string) {
  opener ??= (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  await $.process.run([opener, url])
}

export const register: Register = (on) => {
  on('command.run', { command: ['away', 'awaywork:away'] }, async ($, e, next) => {
    // A request goes to the skill, and so does a run with no surface to draw on.
    if (e.args.trim() || (await $.session.surfaces()).length === 0) return next(e)
    await update($, view, (v) => ({ marks: v.marks }))
    await update($, data, (d): Data => ({ ...d, loading: true, planning: planCall && true }))
    await $.ui.open({ id: PANE, title: 'awaywork', focus: true, closeOnEscape: true })
    void refresh($)
    return {}
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const { element } = e
    if (element?.startsWith('row:') && element !== (await read($, view)).row)
      await update($, view, (v) => ({ ...v, row: element, status: undefined }))
    return next(e)
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
            label={t === 'next' && !d.plan ? titles[t] : `${titles[t]} ${rows[t].length}`}
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

    const body = () => {
      if (!tab) return empty()
      if (tab === 'next' && list.length === 0) return next()
      return list.map((r, i) => {
        const ref = r.item ? shortRef(r.item.key) : ''
        const mark = r.item && v.marks?.[itemKey(r.item)]
        const word = mark
          ? [mark.skip, mark.approved && 'approved'].filter(Boolean).join(', ')
          : r.word
        const title = clip(r.item?.title ?? '', width - word.length - ref.length - 2)
        return (
          <Box flexDirection="column">
            <Button
              key={r.id}
              plain
              autoFocus={i === 0 || undefined}
              onPress={() => void readRow($, r)}
            >
              <Text color={mark ? 'warning' : r.color} dimColor={!mark && !r.color}>
                {word}
              </Text>{' '}
              {ref} <Text dimColor>{title}</Text>
            </Button>
            {r.note && (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {r.note}
              </Text>
            )}
          </Box>
        )
      })
    }

    const keys = () => {
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
      if (!row) return
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
      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text dimColor>⏎ read</Text>
          {row.url && (
            <Button
              key="open"
              plain
              dimColor
              hotkey="o"
              label="open"
              onPress={() => openUrl($, row.url as string)}
            />
          )}
          {skip && item && (
            <Button
              key="skip"
              plain
              dimColor
              hotkey="s"
              label={skip}
              onPress={ask(skip, questions[skip](item))}
            />
          )}
          {item && (
            <Button
              key="approve"
              plain
              dimColor
              hotkey="a"
              label="approve"
              onPress={ask(
                'approve',
                row.waitsOnPlan ? questions.approvePlan(item) : questions.approve(item),
              )}
            />
          )}
          {row.here && (
            <Button
              key="here"
              plain
              dimColor
              hotkey="h"
              label="work on it here"
              onPress={() => $.prompt.submit({ text: row.here as string, asUser: true })}
            />
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {tabs}
        <Box flexDirection="column">{body()}</Box>
        {keys()}
        {v.status && <Text dimColor>{v.status}</Text>}
      </Box>
    )
  })
}
