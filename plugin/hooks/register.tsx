import type { Color, EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type {
  Action,
  Data,
  ItemRef,
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

const data = atom({ plugin: 'awaywork', key: 'data' } as const, {} as Data, { shape: 'data-1' })
const view = atom({ plugin: 'awaywork', key: 'view' } as const, {} as View, { shape: 'view-1' })

/** One row of a tab, and what each key does on it. */
type Row = {
  id: string
  word: string
  color?: Color
  item?: ItemRef
  note: string
  url?: string
  read: string[]
  skip?: 'skip' | 'unskip'
  approve?: string
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
  return { json: JSON.parse(r.stdout) as T }
}

async function reload($: EngineInterface, withPlan: boolean) {
  await update($, data, (d): Data => ({ ...d, loading: 'report' }))
  const got = await json<Report>($, ['report', '--json'])
  const patch: Data =
    'json' in got
      ? { report: got.json }
      : 'failed' in got
        ? { noReport: got.failed }
        : { error: got.error }
  await update($, data, (d) => ({ plan: d.plan, ...patch }))
  if (withPlan && !patch.error) await loadPlan($)
}

const refresh = async ($: EngineInterface) => reload($, !!(await read($, data)).plan)

// plan probes quota and reads the forge, so it runs only when asked.
async function loadPlan($: EngineInterface) {
  if ((await read($, data)).loading === 'plan') return
  await update($, data, (d): Data => ({ ...d, loading: 'plan' }))
  const got = await json<Plan>($, ['plan', '--json'], 600_000)
  const patch: Data =
    'json' in got ? { plan: got.json } : 'error' in got ? { error: got.error } : {}
  await update($, data, (d) => ({ ...d, loading: undefined, ...patch }))
  if ('failed' in got) await update($, view, (v) => ({ ...v, status: `plan: ${got.failed}` }))
}

const itemKey = (item: ItemRef) => `${item.source}:${item.key}`

const approves = (queue: Plan['queue']) =>
  !!queue?.some((rule) => JSON.stringify(rule.where ?? {}).includes('"approved"'))

function skipRow(tab: Tab, s: Skip, queue: Plan['queue']): Row {
  const key = itemKey(s.item)
  const approve =
    s.kind === 'waiting_for_approval'
      ? `approve the plan on ${key}? awaywork replies approve on it, no undo`
      : s.kind === 'no_rule' && approves(queue)
        ? `approve ${key} for your approved: true rules, until a unit on it finishes?`
        : undefined
  return {
    id: `row:${tab}:${key}`,
    word: s.kind ?? 'skipped',
    color: s.needsYou ? 'warning' : undefined,
    item: s.item,
    note: s.reason,
    url: s.url ?? s.item.url ?? undefined,
    read: ['plan', '--why', key],
    skip: s.kind === 'skipped_by_you' ? 'unskip' : 'skip',
    approve,
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
  return {
    id: `row:next:${id}`,
    word: skill,
    item: top,
    note: [repo, deliver && `deliver ${deliver}`, p.provider].filter(Boolean).join(' · '),
    url: top?.url ?? undefined,
    read: top ? ['plan', '--why', itemKey(top)] : [],
    skip: top && 'skip',
  }
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
}

async function act($: EngineInterface, action: Action, key: string) {
  await update($, view, (v) => ({ ...v, confirm: undefined, status: `${action}…` }))
  const r = await awaywork($, [action, key])
  const said = firstLine(r.exitCode === 0 ? r.stdout : r.stderr) || `${action} exited ${r.exitCode}`
  await update($, view, (v) => ({ ...v, status: said }))
  await refresh($)
}

async function readRow($: EngineInterface, row: Row) {
  if (row.read.length === 0) return
  await update($, view, (v) => ({ ...v, status: `awaywork ${row.read.join(' ')}…` }))
  const r = await awaywork($, row.read, 600_000)
  const text = (r.stdout || r.stderr).trimEnd() || `exited ${r.exitCode}`
  await update($, view, (v) => ({
    ...v,
    status: undefined,
    reading: { title: `awaywork ${row.read.join(' ')}`, text },
  }))
}

// The ring keeps its place across a redraw: move it onto the new tab's first row.
async function showTab($: EngineInterface, tab: Tab, first?: string) {
  await update($, view, (v) => ({ ...v, tab, row: first }))
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
    await update($, view, () => ({}))
    await update($, data, (): Data => ({ loading: 'report' }))
    await $.ui.open({ id: PANE, title: 'awaywork', focus: true, closeOnEscape: true })
    void reload($, false)
    return {}
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const { element } = e
    if (element?.startsWith('row:')) await update($, view, (v) => ({ ...v, row: element }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, data)
    const v = await read($, view)
    const width = e.props.bodyColumns
    const now = await $.clock.now()

    const plan = d.plan ?? d.report?.plan
    const skips = plan?.skipped ?? []
    const report = d.report
    const heads = report?.results.filter((r) => !r.planned.chain && !r.retried) ?? []
    const rows: Record<Tab, Row[]> = {
      needs: skips.filter((s) => s.needsYou).map((s) => skipRow('needs', s, plan?.queue)),
      last: report ? heads.map((r) => resultRow(report.runId, r)) : [],
      next: d.plan?.units.filter((p) => !p.chain).map(unitRow) ?? [],
      skipped: skips.filter((s) => !s.needsYou).map((s) => skipRow('skipped', s, plan?.queue)),
    }
    const landing =
      (['needs', 'last', 'skipped'] as const).find((t) => rows[t].length) ??
      (rows.next.length ? 'next' : undefined)
    const tab = v.tab === 'next' || (v.tab && rows[v.tab].length) ? v.tab : landing
    const shown = (['needs', 'last', 'next', 'skipped'] as const).filter(
      (t) => t === 'next' || rows[t].length,
    )
    const list = tab ? rows[tab] : []
    const row = list.find((r) => r.id === v.row) ?? list[0]

    const prs = heads.filter((r) => r.outcome?.kind === 'pr').length
    const needs = rows.needs.length
    const facts = d.error
      ? []
      : [
          report
            ? `last run ${when(report.finishedAt, now)}${report.dryRun ? ' (dry run)' : ''}`
            : d.loading === 'report'
              ? 'reading the last run…'
              : 'no run yet',
          prs > 0 && counted(prs, 'PR'),
        ].filter(Boolean)

    const header = (
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
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
            onPress={() => update($, view, (x) => ({ ...x, reading: undefined }))}
          />
        </Box>
      )

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" gap={2}>
        {shown.map((t, i) => (
          <Button
            key={`tab:${t}`}
            plain
            hotkey={String(i + 1)}
            dimColor={t !== tab}
            label={t === 'next' && !d.plan ? titles[t] : `${titles[t]} ${rows[t].length}`}
            onPress={() => showTab($, t, rows[t][0]?.id)}
          />
        ))}
      </Box>
    )

    const empty = () => {
      if (d.loading === 'report') return <Text dimColor>reading the last run…</Text>
      if (d.noReport && /^no runs in /.test(d.noReport))
        return (
          <Text>
            no run yet: `awaywork run`, or wait for the schedule; p shows what the next one takes
          </Text>
        )
      if (d.noReport) return <Text>{d.noReport}</Text>
      return (
        <Text>
          {d.plan ? 'the plan' : 'the last run'} found none of your items: `/away` and say what to
          hand over to set up sources and rules
        </Text>
      )
    }

    const next = () => {
      if (d.loading === 'plan') return <Text dimColor>planning… it probes quota</Text>
      if (!d.plan) return <Text dimColor>plan probes quota (one Haiku call): press p</Text>
      if (list.length === 0) return <Text dimColor>the next run takes nothing</Text>
    }

    const body = () => {
      if (!tab) return empty()
      if (tab === 'next' && list.length === 0) return next()
      return list.map((r, i) => {
        const key = r.item?.key ?? ''
        const title = clip(r.item?.title ?? '', width - r.word.length - key.length - 2)
        return (
          <Box flexDirection="column">
            <Button
              key={r.id}
              plain
              autoFocus={i === 0 || undefined}
              onPress={() => void readRow($, r)}
            >
              <Text color={r.color} dimColor={!r.color}>
                {r.word}
              </Text>{' '}
              {key} <Text dimColor>{title}</Text>
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
          <Box flexDirection="row" flexWrap="wrap" gap={2}>
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
      const ask = (action: Action, question: string) => () =>
        item && update($, view, (x) => ({ ...x, confirm: { action, key: item, question } }))
      return (
        <Box flexDirection="row" flexWrap="wrap" gap={2}>
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
          {row.skip && item && (
            <Button
              key="skip"
              plain
              dimColor
              hotkey="s"
              label={row.skip}
              onPress={ask(row.skip, questions[row.skip](item))}
            />
          )}
          {row.approve && (
            <Button
              key="approve"
              plain
              dimColor
              hotkey="a"
              label="approve"
              onPress={ask('approve', row.approve)}
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
