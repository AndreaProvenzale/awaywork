import type { Elements, RenderChildren, RenderElement, RenderInput } from 'claude-code'

import type { ConfigState, Data, Tab, View } from '../types'
import { CARD_ROWS, type Card, card } from './cards'
import { configBody, skillColor } from './config'
import { itemKey, layout, pickOn, type Row } from './rows'
import { cardsFit, counted, rowsOf, twoLines, when, wrap } from './text'

export type Key = { key: string; hotkey?: string; label: string; run: () => unknown }

/** No `strip` when the pane is too short for its regions: the engine scrolls it then. */
export type Drawn = {
  press: Record<string, () => unknown>
  strip?: [number, number]
  detailMax: number
  /** The desktop app scrolls the pane itself: an arrow there is a smooth scroll, many events and none upward from the top. */
  nativeScroll?: boolean
}

/** What the pane's buttons and the Config tab do. */
type On = {
  refresh: () => unknown
  plan: () => unknown
  takes: () => unknown
  tab: (tab: Tab) => unknown
  step: (by: number) => unknown
  select: (id: string) => unknown
  fill: (text: string) => unknown
  setView: (patch: Partial<View>) => unknown
  open: (file: string, line: number) => unknown
  stepRule: (by: number) => unknown
}

type Input = {
  e: RenderInput<'Pane'>
  els: Elements[RenderInput<'Pane'>['surface']]
  now: number
  d: Data
  v: View
  c: ConfigState
  /** The selected card's buttons. */
  keys: (row: Row) => Key[]
  on: On
}

const MAX_ROWS = 28
const MIN_DETAIL = 3

const titles: Record<Tab, string> = {
  needs: 'Needs you',
  last: 'Last run',
  next: 'Next run',
  skipped: 'Skipped',
  config: 'Config',
}

/** The pane: header, tabs, and the selected tab's cards and detail, or the Config tab, and what it drew. */
export function paneView({ e, els, now, d, v, c, keys: cardButtons, on }: Input): {
  tree: RenderElement
  drawn: Drawn
} {
  const { Box, Text, Button } = els
  // Every surface's table names every tag, drawing the ones it lacks as nothing.
  const Client =
    (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in els
      ? els.Client
      : undefined
  const padding = e.surface === 'desktop' ? { x: 2, y: 1 } : { x: 0, y: 0 }
  const width = e.props.bodyColumns - padding.x * 2
  const press: Record<string, () => unknown> = {}

  const { report, heads, rows, tab, order, shown: reviews, list, row } = layout(d, v)
  const shown = c.setup ? (['config'] as const) : c.file ? [...reviews, 'config' as const] : reviews

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
        {button('refresh', 'r', 'refresh', () => (tab === 'config' ? on.takes() : on.refresh()))}
        {!c.setup && button('plan', 'p', 'plan', on.plan)}
      </Box>
    </Box>
  )

  const label = (t: Tab) =>
    (t === 'next' && !d.plan) || t === 'config' ? titles[t] : `${titles[t]} (${rows[t].length})`
  const tabs = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {shown.map((t) => {
        // The digits pick a skill while the picker is up.
        const hotkey = pickOn(v, row) ? undefined : String(order.indexOf(t) + 1)
        if (hotkey) press[hotkey] = () => on.tab(t)
        return (
          <Button
            key={`tab:${t}`}
            plain
            hotkey={hotkey}
            dimColor={t !== tab}
            label={label(t)}
            onPress={() => on.tab(t)}
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
    const drawn = { press, detailMax: 0, nativeScroll: e.surface === 'desktop' }
    const tree = (
      <Box
        flexDirection="column"
        rowGap={gap}
        minHeight={minHeight}
        paddingX={padding.x}
        paddingY={padding.y}
      >
        {header}
        {tabs}
        {rule}
        {body}
        {v.status && <Text dimColor>{v.status}</Text>}
        {minHeight !== undefined && <Text> </Text>}
      </Box>
    )
    return { tree, drawn }
  }

  if (tab === 'config')
    return done(
      configBody({
        fill: on.fill,
        els,
        c,
        v,
        width,
        button,
        setView: on.setView,
        open: on.open,
        step: e.surface === 'desktop' ? on.stepRule : undefined,
      }),
      // Arrows reach `ui.scroll` only with a row to scroll: a spare one, and a blank last row so overflow is exact.
      e.surface !== 'desktop' && (v.source ?? 'flow') === 'flow' && c.view
        ? e.props.scroll.bodyRows + 1
        : undefined,
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
    const word = m
      ? [m.skip, m.approved && 'approved', m.started && 'started'].filter(Boolean).join(', ')
      : r.word
    const color = m ? 'warning' : r.color
    return {
      id: r.id,
      ref: r.ref,
      word,
      title: twoLines(r.title, w - 4),
      ...(color && { color }),
      ...(r.skill && { skill: { name: r.skill, color: skillColor(r.skill) } }),
      ...(r.lead && { lead: r.lead }),
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
        {button('prev', 'h', '‹', () => on.step(-1))}
        {button('nextCard', 'l', '›', () => on.step(1))}
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
            <Button key={`card:${c.id}`} plain label={c.ref} onPress={() => on.select(c.id)} />,
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

  const picking = pickOn(v, row)
  const asks = v.confirm?.question ?? (picking && `Run ${picking.ref} with which skill?`)
  const question = asks ? wrap(asks, width) : []
  const cardKeys = cardButtons(row)
  const keyRows = rowsOf(
    cardKeys.map((b) => (b.hotkey ? `${b.hotkey}: ${b.label}` : b.label)),
    width,
  )
  const buttonRows = asks ? question.length + keyRows : 2

  // header, tabs, rule, nav, strip, buttons, rule, body, status; too short for that, the engine scrolls it all.
  const total = Math.min(e.props.scroll.bodyRows, MAX_ROWS)
  const top = headRows + tabRows + 2
  const spare = total - padding.y * 2 - top - CARD_ROWS - buttonRows - 2
  const fits = spare >= MIN_DETAIL
  const room = fits ? spare : body.length
  const detailMax = Math.max(0, body.length - room)
  const offset = Math.min(v.at ?? 0, detailMax)
  const shownBody = body.slice(offset, offset + room)
  const more = body.length - offset - room

  const keys = cardKeys.map((b) => button(b.key, b.hotkey, b.label, b.run))
  const buttons = asks ? (
    <Box flexDirection="column">
      {question.map((line) => (
        <Text wrap="truncate-end">{line}</Text>
      ))}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {keys}
      </Box>
    </Box>
  ) : (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {keys}
    </Box>
  )

  const drawn: Drawn = fits
    ? { press, strip: [top, top + CARD_ROWS - 1], detailMax }
    : { press, detailMax }
  const tree = (
    <Box
      flexDirection="column"
      height={fits ? total : undefined}
      rowGap={gap}
      paddingX={padding.x}
      paddingY={padding.y}
    >
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
  return { tree, drawn }
}
