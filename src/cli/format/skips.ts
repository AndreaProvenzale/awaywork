import { type SkipKind, shortRef } from '../../core/foreman.js'
import { byKind, needsYouOn, type ReportedSkip } from '../../core/report.js'
import type { Item } from '../../core/types.js'
import { brief, CELL, clip, heading, indent, type Style, TITLE, table, width } from './terminal.js'

/** The skipped items you can act on, under their groups: a row each ending on its action, and what its reason adds under the title. */
export function needsYouLines(skipped: ReportedSkip[], style: Style = (_, text) => text): string[] {
  const waiting = skipped.filter(needsYouOn)
  if (waiting.length === 0) return []
  const group = (list: SkipRow[]) => {
    const lines = table(list.map((r) => [r.ref, clip(r.title, TITLE), r.action]))
    const under = ' '.repeat(Math.max(...list.map((r) => width(r.ref))) + 2)
    return list.flatMap((r, i) => [
      lines[i] ?? '',
      ...(r.note ? [style('dim', `${under}${r.note}`)] : []),
    ])
  }
  return [
    '',
    heading('Needs you', waiting.length, style),
    ...indent(skipRows(waiting).flatMap(([name, list]) => [name, ...indent(group(list))])),
  ]
}

/** What a skip asks of you, or plainly why it waits: the word its row ends on, ranked as its group lists them. */
const actions: Record<SkipKind, string> = {
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

/** What a reason starts with that its kind's action already says. */
const kindSays: Partial<Record<SkipKind, RegExp>> = {
  waiting_for_review: /^waiting for review: (awaywork PR is open$)?/,
  waiting_for_answer: /^waiting for your answer$/,
  waiting_for_approval: /^waiting for your approval of (the )?/,
  invalid_plan: /^plan refused: /,
  all_tasks_done: /^all tasks done: close or move the card$/,
  no_repo: /^no repo: no linked PR or repo field$/,
  no_rule: /^matched no rule(; |$)/,
  over_cap: /^over the cap: /,
  unchanged: /^unchanged /,
  skipped_by_you: /^skipped with awaywork skip \S+(: | |$)/,
  fanned_out: /^fanned out: /,
}

/** Where an item's row goes: the repo its key names, else its source and project key, else its source. */
export function groupOf({ source, key }: Pick<Item, 'source' | 'key'>): string {
  const repo = /^([^/\s]+\/[^/\s]+)#\d+$/.exec(key)?.[1]
  const project = /^([A-Za-z]\w*)-\d+$/.exec(key)?.[1]
  return repo ?? (project ? `${source} ${project}` : source)
}

/** `#7` for an item of `group`, else its short ref. */
export const refIn = (group: string, item: Pick<Item, 'key'>) =>
  item.key.startsWith(`${group}#`) ? item.key.slice(group.length) : shortRef(item)

/** `list` by group, the groups in the order they first come, each one's by `rank`. */
export function byGroup<T>(
  list: T[],
  group: (t: T) => string,
  rank: (t: T) => number = () => 0,
): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const t of list) groups.set(group(t), [...(groups.get(group(t)) ?? []), t])
  return [...groups].map(([name, ts]) => [name, ts.toSorted((a, b) => rank(a) - rank(b))])
}

export interface SkipRow {
  skipped: ReportedSkip
  ref: string
  title: string
  action: string
  /** What the reason adds to the action, clipped; empty when nothing. */
  note: string
}

/** Each skip's row under its group, by action: its ref there, title, action and note, which leaves out the closest rule in Needs you. */
export function skipRows(skipped: ReportedSkip[], clipAt = CELL): [string, SkipRow[]][] {
  const rank = (s: ReportedSkip) => (s.kind ? ranks.indexOf(s.kind) : ranks.length)
  const note = (s: ReportedSkip) => {
    const reason = needsYouOn(s) ? reasonOf(s).replace(/; closest #.*$/, '') : reasonOf(s)
    return brief(reason.replace((s.kind && kindSays[s.kind]) || '', ''), clipAt)
  }
  return byGroup(skipped, (s) => groupOf(s.item), rank).map(([group, list]) => [
    group,
    list.map((s) => ({
      skipped: s,
      ref: refIn(group, s.item),
      title: s.item.title,
      action: s.kind ? actions[s.kind] : 'skipped',
      note: note(s),
    })),
  ])
}

/** A skip's reason without the URL its row, or `--why`, already shows. */
export const reasonOf = (s: ReportedSkip) =>
  s.reason.replace(` ${s.url ?? s.item.url}`, '').replace(/ on$/, '')

/** The other skipped items, counted by kind on one line. */
export function skippedLines(skipped: ReportedSkip[], style: Style = (_, text) => text): string[] {
  const rest = skipped.filter((s) => !needsYouOn(s))
  if (rest.length === 0) return []
  return ['', skippedHeading(rest, style)]
}

/** `Skipped 2: 1 no_rule, 1 over_cap`, or `Skipped 2` for skips without kinds. */
export function skippedHeading(skipped: ReportedSkip[], style: Style = (_, text) => text): string {
  const counts = byKind(skipped)?.map(([kind, list]) => `${list.length} ${kind}`)
  const title = heading('Skipped', skipped.length, style)
  return counts ? `${title}: ${counts.join(', ')}` : title
}

const skippedLine = (s: ReportedSkip) => `${shortRef(s.item)}: ${s.reason}`

/** Every skipped item and why, under the counts `plan` shows, or those of one kind. */
export function formatSkipped(skipped: ReportedSkip[], kind?: string): string {
  const line = (s: ReportedSkip) => `  ${skippedLine(s)}`
  if (kind) {
    const list = skipped.filter((s) => s.kind === kind)
    return [`Skipped ${kind} (${list.length})`, ...list.map(line)].join('\n')
  }
  const waiting = skipped.filter(needsYouOn)
  const rest = skipped.filter((s) => !needsYouOn(s))
  const out = waiting.length > 0 ? [`Needs you ${waiting.length}`, ...waiting.map(line)] : []
  if (rest.length > 0) out.push(skippedHeading(rest), ...rest.map(line))
  return out.length > 0 ? out.join('\n') : 'Skipped 0'
}
