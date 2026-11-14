import type { Color } from 'claude-code'

import type { Data, ItemRef, Planned, Result, Skip, Tab, View } from '../types'
import { skillColor } from './config'
import { lines } from './text'

/** One item of a tab under its group: its card, its detail, and the buttons it has. */
export type Row = {
  id: string
  group: string
  /** Its place in its group: a skip's action's, as the CLI ranks them. */
  rank: number
  ref: string
  word: string
  color?: Color
  /** A card whose word is its status also says the skill. */
  skill?: string
  /** How a last-run unit ended, drawn before the ref in place of a word. */
  lead?: Glyph
  item?: ItemRef
  title: string
  /** The detail's lines under the title: the reason, or the unit's items and links. */
  detail: string[]
  url?: string
  /** What `o` is for, when opening the link is what the card asks of you. */
  openAs?: string
  /** The CLI's read of a last-run unit, what `v` shows. */
  report?: string[]
  skip?: 'skip' | 'unskip'
  approve?: true
  /** What `g` asks before running the item now. */
  start?: string
  /** `g` picks a skill first: no rule takes the item. */
  picks?: true
  /** A GitHub issue that isn't assigned to you: merging a draft for it can close it. */
  theirs?: true
  /** What `c` puts in the prompt box. */
  here?: string
}

export const itemKey = (item: ItemRef) => `${item.source}:${item.key}`

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
const kindWords: Record<string, string> = {
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
  unlisted_repo: 'not in repos',
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

const ranks = Object.keys(kindWords)

type Glyph = { word: string; color?: Color }

const resultGlyphs: Record<string, Glyph> = {
  done: { word: '✓', color: 'success' },
  failed: { word: '✗', color: 'error' },
  error: { word: '✗', color: 'error' },
  stopped: { word: '■' },
}

const stuck: Glyph = { word: '⚑', color: 'error' }

/** A Needs you card's glyph; `on` is the key that does what it asks, without one the detail says it first. */
const needsGlyphs: Record<string, Glyph & { on?: 'o' | 'a' }> = {
  waiting_for_review: { word: '◉', color: 'warning', on: 'o' },
  waiting_for_answer: { word: '?', color: 'warning', on: 'o' },
  waiting_for_approval: { word: '◆', color: 'warning', on: 'a' },
  all_tasks_done: { word: '✓', color: 'success' },
  invalid_plan: stuck,
  store_failed: stuck,
  invalid_branch: stuck,
  refused_delivery: stuck,
  no_repo: stuck,
  gave_up: stuck,
  draft_moved: stuck,
  continue_cap: stuck,
}

const aboutItem = (item: ItemRef, state: string) =>
  `About awaywork item ${itemKey(item)} "${item.title}" (${state}): `

// By name: `run --unit` lifts its unit's attempts, so it would also run past "awaywork pushed onto your PR". The planner reads these after that hold.
const startable = ['unchanged', 'skipped_by_you', 'over_cap', 'gave_up']

export function startQuestion(ref: string, skill?: string, deliver?: string) {
  const leaves = deliver && (leavesWords[deliver] ?? deliver)
  const cost = leaves
    ? `${leaves[0]?.toUpperCase()}${leaves.slice(1)}, uses your quota.`
    : 'Uses your quota.'
  return `Run ${ref} now${skill ? ` with ${skill}` : ''}? ${cost}`
}

function skipRow(tab: Tab, s: Skip): Row {
  const key = itemKey(s.item)
  const group = groupOf(s.item)
  const url = s.url ?? s.item.url ?? undefined
  const ref = refIn(group, s.item.key)
  const stays = s.kind === 'skipped_by_you' ? ' Your skip stays for the coming runs.' : ''
  // Your skip hides "pushed onto your PR": the url on it is that PR.
  const pushedOn = s.kind === 'skipped_by_you' && s.url
  const action = s.kind && kindWords[s.kind]
  const glyph = s.needsYou && s.kind ? needsGlyphs[s.kind] : undefined
  return {
    id: `row:${tab}:${key}`,
    group,
    rank: s.kind ? ranks.indexOf(s.kind) : ranks.length,
    ref,
    word: glyph?.word ?? (action || s.kind || 'skipped'),
    color: glyph?.color ?? (s.needsYou ? 'warning' : undefined),
    item: s.item,
    title: s.item.title,
    detail: lines(glyph && !glyph.on ? `${action} · ${reasonOf(s)}` : reasonOf(s)),
    url,
    openAs: glyph?.on === 'o' ? action : undefined,
    skip: s.kind === 'skipped_by_you' ? 'unskip' : 'skip',
    approve: s.kind === 'waiting_for_approval' || undefined,
    picks: s.kind === 'no_rule' || undefined,
    theirs: (s.item.source === 'github' && s.item.type === 'issue' && !s.item.mine) || undefined,
    start:
      s.kind && startable.includes(s.kind) && !pushedOn
        ? `${startQuestion(ref)}${stays}`
        : undefined,
    here: aboutItem(s.item, reasonOf(s)),
  }
}

function resultRow(runId: string, r: Result): Row {
  const { id, repo, skill, items } = r.planned.unit
  const top = items[0]
  const fact =
    r.status === 'done'
      ? (r.summary ?? r.outcome?.url)
      : (r.reason ?? r.outcome?.reason ?? r.summary)
  // `stopped: quota` and its like share one glyph: the detail keeps which.
  const glyph = resultGlyphs[r.status.replace(/:.*/, '')]
  const note = [skill, r.status.includes(':') && r.status, fact].filter(Boolean).join(' · ')
  const url = r.outcome?.url ?? top?.url ?? undefined
  return {
    id: `row:last:${id}`,
    group: repo,
    rank: 0,
    ref: top ? refIn(repo, top.key) : id,
    skill,
    lead: glyph,
    word: glyph ? '' : r.status,
    item: top,
    title: top?.title ?? note,
    detail: lines(note),
    url,
    report: ['report', runId, '--unit', id],
    skip: top && 'skip',
    here: `continue awaywork unit ${id} of run ${runId}; start with \`awaywork report ${runId} --unit ${id}\`. `,
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
  const ref = top ? refIn(repo, top.key) : id
  return {
    id: `row:next:${id}`,
    group: repo,
    rank: 0,
    ref,
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
    start: top && startQuestion(ref, skill, deliver),
    here: top && aboutItem(top, `next up with ${skill}`),
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
export function layout(d: Data, v: View) {
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

/** The picker `row` has up: a picker belongs to its card, which a load or a refresh may have moved off. */
export const pickOn = (v: View, row: Row | undefined) =>
  v.pick?.row === row?.id ? v.pick : undefined

export const selected = (v: View, id: string): View => ({
  ...v,
  row: id,
  at: 0,
  confirm: undefined,
  pick: undefined,
  reading: undefined,
  status: undefined,
})

export const isPr = (url: string) => /\/(pull|merge_requests|pull-requests)\//.test(url)

export const opens = (url: string) =>
  isPr(url) ? 'open PR' : /\/issues\//.test(url) ? 'open issue' : 'open'
