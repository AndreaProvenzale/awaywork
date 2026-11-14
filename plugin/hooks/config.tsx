import type { ClientElements, Color, RenderChildren } from 'claude-code'

import type { ConfigRule, ConfigState, View } from '../types'
import { DRAFT } from './cli'
import { clip } from './text'

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The draft a tool call is working on: a Write or Edit of `config.draft.yml`, or an `awaywork --config` at one by a path that says where it is. */
export function draftNamed(isFile: boolean, text: string) {
  if (isFile) return nameOf(text) === DRAFT ? text : undefined
  return /(?:^|[\s;&|(])awaywork\s[^;&|\n]*?--config(?:=|\s+)['"]?(~?\/(?:[^\s'"$]*\/)?config\.draft\.yml)(?=$|[\s'"])/.exec(
    text,
  )?.[1]
}

export const mentionsConfig = (text: string, c: ConfigState) =>
  text.includes(DRAFT) || (!!c.path && text.includes(c.path))

/** One hunk from the first changed line to the last, what a single write changes. */
export function lastChange(before: string, after: string): string | undefined {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++
  if (start === a.length && start === b.length) return undefined
  const from = Math.max(0, start - 2)
  const old = a.slice(start, a.length - end)
  const now = b.slice(start, b.length - end)
  const lead = a.slice(from, start)
  const tail = a.slice(a.length - end, a.length - end + 2)
  const count = (n: number) => lead.length + n + tail.length
  return [
    `@@ -${from + 1},${count(old.length)} +${from + 1},${count(now.length)} @@`,
    ...lead.map((l) => ` ${l}`),
    ...old.map((l) => `-${l}`),
    ...now.map((l) => `+${l}`),
    ...tail.map((l) => ` ${l}`),
  ].join('\n')
}

const SKILL_COLORS: Record<string, Color> = {
  implement: 'suggestion',
  fix: 'claude',
  review: 'merged',
  plan: 'planMode',
  sync: 'success',
  judge: 'bashBorder',
}
const OTHER_COLORS: Color[] = ['permission', 'autoAccept', 'remember', 'ide']

/** A skill's own color, the same one wherever it's drawn; a custom skill's comes from its name. */
export function skillColor(skill: string): Color {
  const hash = [...skill].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) % 9973, 7)
  return SKILL_COLORS[skill] ?? OTHER_COLORS[hash % OTHER_COLORS.length] ?? 'text'
}

/** One run of text: a skill in its color, an arrow dim, the rest as is. */
type Part = { text: string; color?: Color; dim?: boolean }

const skillPart = (skill: string): Part => ({ text: skill, color: skillColor(skill) })
const arrow = (text = ' ▶ '): Part => ({ text, dim: true })

function joined(skills: string[], between: string): Part[] {
  return skills.flatMap((s, i) => (i ? [arrow(between), skillPart(s)] : [skillPart(s)]))
}

const endParts = (r: ConfigRule): Part[] => [
  arrow(),
  ...(r.waits ? [{ text: '◆ ', color: 'warning' as Color }] : []),
  { text: r.leaves },
]

const lengthOf = (parts: Part[]) => parts.reduce((n, p) => n + p.text.length, 0)

/** A rule's row: its steps and what it leaves, short. */
function workParts(r: ConfigRule): Part[] {
  return [
    skillPart(r.skill),
    ...r.steps.flatMap((s) =>
      'loop' in s ? [arrow(' ⟲ '), ...joined(s.loop, '→')] : [arrow(), skillPart(s.skill)],
    ),
    ...endParts(r),
  ]
}

/** The rule's steps left to right, a loop drawn under its steps, on one line when the pane is too narrow. */
function flowOf(r: ConfigRule, rules: ConfigRule[], width: number) {
  const line = [skillPart(r.skill)]
  let under = ' '.repeat(r.skill.length)
  const add = (parts: Part[], below?: string) => {
    line.push(...parts)
    under += below ?? ' '.repeat(lengthOf(parts))
  }
  for (const s of r.steps) {
    add([arrow()])
    if ('loop' in s) {
      const inner = joined(s.loop, ' ▶ ')
      const room = lengthOf(inner) + 2
      const left = Math.floor((room - 1) / 2)
      add(
        [arrow('┌ '), ...inner, arrow(' ┐')],
        `└${'─'.repeat(left)}⟲${'─'.repeat(room - 1 - left)}┘`,
      )
      add([arrow(` until ${s.until}, max ${s.max}`)])
    } else add([skillPart(s.skill)])
  }
  const tasks = r.plan && rules.find((x) => x.planned)
  const tail = [...endParts(r), ...(tasks ? [arrow(), { text: `rule ${tasks.rule}` }] : [])]
  add(tail)
  if (lengthOf(line) <= width)
    return { line, under: r.steps.some((s) => 'loop' in s) ? under : undefined }
  const flat = [
    skillPart(r.skill),
    ...r.steps.flatMap((s) =>
      'loop' in s
        ? [arrow(' ▶ ⟲ ('), ...joined(s.loop, ' ▶ '), arrow(`) until ${s.until}, max ${s.max}`)]
        : [arrow(), skillPart(s.skill)],
    ),
    ...tail,
  ]
  return { line: flat, under: undefined }
}

type Button = (
  key: string,
  hotkey: string | undefined,
  label: string,
  run: () => unknown,
) => RenderChildren

type Input = {
  fill: (text: string) => unknown
  els: Pick<ClientElements, 'Box' | 'Text' | 'Code'>
  c: ConfigState
  v: View
  width: number
  button: Button
  setView: (patch: Partial<View>) => unknown
  open: (file: string, line: number) => unknown
  /** Steps the rule by key where the arrows can't. */
  step?: (by: number) => unknown
}

const GHOST: ConfigRule[] = [
  ['my PRs, checks failing', 'fix', 'draft PR'],
  ['PRs, review requested', 'review', 'report'],
  ['issues, label awaywork', 'implement', 'draft PR'],
].map(([takes = '', skill = '', leaves = ''], i) => ({
  rule: i + 1,
  takes,
  skill,
  leaves,
  steps: [],
  waits: false,
  plan: false,
  planned: false,
  soon: false,
}))

// Desktop draws the rule's number as a native button, with no room in its box for the marker.
const MARK_W = 1
const LEAD_W = MARK_W + 3

/** A rule's row at `width`, on two lines below 60. One that takes nothing now is dim, one that does says how many. */
function rulesTable(
  { els: { Box, Text }, c, width, button, setView }: Input,
  rules: ConfigRule[],
  at: number,
  ghost: boolean,
) {
  const count = (r: ConfigRule) =>
    ghost ? undefined : c.takes?.rules.find((t) => t.rule === r.rule)?.taken.length
  const suffix = (r: ConfigRule) => (count(r) ? ` · ${count(r)}` : '')
  const lead = LEAD_W + 1
  const room = width - lead - 2
  // What a rule does stays whole; what it takes can be cut, the detail below has it in full.
  const longest = Math.max(...rules.map((r) => lengthOf(workParts(r))))
  const workW = Math.min(longest, Math.ceil(room * 0.6))
  const takesW = room - workW
  const narrow = width < 60
  const paint = (parts: Part[], muted: boolean) =>
    parts.map((p) => (
      <Text color={muted ? undefined : p.color} dimColor={muted || p.dim}>
        {p.text}
      </Text>
    ))
  const takesCell = (r: ConfigRule, on: boolean, w: number) => {
    const tail = suffix(r)
    const quiet = ghost || count(r) === 0
    return (
      <Box width={w} flexShrink={0}>
        <Text wrap="truncate-end" bold={on} dimColor={quiet && !on}>
          {clip(r.takes, w - tail.length)}
          {tail && <Text color="suggestion">{tail}</Text>}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {!narrow && (
        <Box flexDirection="row" columnGap={1}>
          <Box width={LEAD_W} />
          <Box width={takesW}>
            <Text dimColor>TAKES</Text>
          </Box>
          <Text dimColor>DOES</Text>
        </Box>
      )}
      {rules.map((r, i) => {
        const on = !ghost && i === at
        const mark = ghost ? (
          <Box width={LEAD_W}>
            <Text dimColor>·</Text>
          </Box>
        ) : (
          <Box width={LEAD_W} flexDirection="row">
            <Box width={MARK_W}>
              <Text>{on ? '▸' : ' '}</Text>
            </Box>
            <Box flexShrink={0}>
              {button(`rule:${r.rule}`, undefined, String(r.rule), () => setView({ rule: r.rule }))}
            </Box>
          </Box>
        )
        const does = (w: number) => (
          <Box width={w}>
            <Text wrap="truncate-end">{paint(workParts(r), ghost)}</Text>
          </Box>
        )
        return narrow ? (
          <Box key={`lane:${r.rule}`} flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              {mark}
              {takesCell(r, on, width - lead)}
            </Box>
            <Box paddingLeft={lead}>{does(width - lead)}</Box>
          </Box>
        ) : (
          <Box key={`lane:${r.rule}`} flexDirection="row" columnGap={1}>
            {mark}
            {takesCell(r, on, takesW)}
            {does(workW)}
          </Box>
        )
      })}
    </Box>
  )
}

export function configBody(input: Input): RenderChildren {
  const { fill, els, c, v, width, button, setView, open, step } = input
  const { Box, Text, Code } = els
  const problems = c.problems?.length ? c.problems : undefined

  if (!c.view && !problems)
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text>
          Your config shows up here as soon as you've picked repos and a window. It'll read like
          this:
        </Text>
        {rulesTable(input, GHOST, -1, true)}
      </Box>
    )

  const name = c.file ? nameOf(c.file) : 'config'
  const state = problems
    ? `✗ ${problems.length} problem${problems.length === 1 ? '' : 's'}`
    : '✓ valid'
  const facts =
    c.view &&
    [
      c.view.windows.join(', ') || 'no window',
      c.view.providers.join(', '),
      c.view.sources.join(', '),
      c.view.reserve && `keeps ${c.view.reserve} in reserve`,
    ]
      .filter(Boolean)
      .join(' · ')

  const mode = v.source ?? 'flow'
  const change =
    c.previous !== undefined && c.text !== undefined ? lastChange(c.previous, c.text) : undefined
  const toggles = (
    <Box flexDirection="row" columnGap={2} flexShrink={0}>
      {button('flow', 'f', 'flow', () => setView({ source: 'flow' }))}
      {button('yaml', 'y', 'YAML', () => setView({ source: 'yaml' }))}
      {change && button('diff', 'd', 'diff', () => setView({ source: 'diff' }))}
    </Box>
  )
  const head = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" columnGap={2}>
          <Text bold wrap="truncate-end">
            {name}
          </Text>
          <Box flexShrink={0}>
            <Text color={problems ? 'error' : 'success'}>{state}</Text>
          </Box>
        </Box>
        {toggles}
      </Box>
      {facts && (
        <Text dimColor wrap="truncate-end">
          {facts}
        </Text>
      )}
      {problems?.map((p) => (
        <Text color="error" wrap="wrap">
          {p}
        </Text>
      ))}
    </Box>
  )

  if (mode === 'yaml' && c.text !== undefined)
    return (
      <Box flexDirection="column" rowGap={1}>
        {head}
        <Code source={c.text} language="yaml" startLine={1} />
      </Box>
    )
  if (mode === 'diff' && change)
    return (
      <Box flexDirection="column" rowGap={1}>
        {head}
        <Code source={change} format="diff" language="yaml" />
      </Box>
    )
  if (!c.view) return head

  const rules = c.view.rules
  const at = Math.max(
    0,
    rules.findIndex((r) => r.rule === v.rule),
  )
  const r = rules[at]
  if (!r) return head
  const told = c.takes?.rules.find((t) => t.rule === r.rule)
  const refs = (items: { key: string; title: string }[], room: number) =>
    items.map((i) => clip(`${i.key}  ${i.title}`, room))
  const unmatched = c.takes?.unmatched ?? []
  const editLine = r.line
  const flow = flowOf(r, rules, width)
  const parts = (list: Part[]) =>
    list.map((p) => (
      <Text color={p.color} dimColor={p.dim}>
        {p.text}
      </Text>
    ))
  const keys = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {step ? (
        [
          button('nextRule', 'j', 'next rule', () => step(1)),
          button('previousRule', 'k', 'previous rule', () => step(-1)),
        ]
      ) : (
        <Text dimColor>↑↓ rule</Text>
      )}
      {button('ask', 'c', 'ask Claude', () => fill(`About rule ${r.rule} (${r.takes}): `))}
      {c.file &&
        editLine &&
        button('open', 'o', `open ${name}:${editLine}`, () => open(c.file as string, editLine))}
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      {head}
      {rulesTable(input, rules, at, false)}
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          {r.rule}. {r.takes}
          {r.soon ? ' · as soon as it shows up' : ''}
        </Text>
        <Text wrap="wrap">{parts(flow.line)}</Text>
        {flow.under && <Text dimColor>{flow.under}</Text>}
      </Box>
      <Box flexDirection="column">
        {c.takesError ? (
          <Text dimColor wrap="wrap">
            can't read your items: {c.takesError}
          </Text>
        ) : !told ? (
          <Text dimColor>{c.readingTakes ? 'reading your items…' : ''}</Text>
        ) : told.taken.length === 0 ? (
          <Text dimColor>Takes nothing right now</Text>
        ) : (
          [
            <Text dimColor>Takes now</Text>,
            ...refs(told.taken, width).map((l) => <Text wrap="truncate-end">{l}</Text>),
          ]
        )}
        {told?.takenBy.map((t) => (
          <Text dimColor wrap="truncate-end">
            Rule {t.rule} takes first: {t.items.map((i) => i.key).join(', ')}
          </Text>
        ))}
      </Box>
      {unmatched.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>No rule takes ({unmatched.length})</Text>
          {unmatched.slice(0, 3).map((u) => (
            <Text dimColor wrap="truncate-end">
              {clip(`${u.key}  ${u.title}: ${u.reason}`, width)}
            </Text>
          ))}
        </Box>
      )}
      {keys}
    </Box>
  )
}
