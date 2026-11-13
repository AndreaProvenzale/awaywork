import type { Item } from '#core/types'
import { isNamed, type PlannedUnit, type RunPlan } from '#plan/foreman'
import type { RunReport } from '#posts/report'
import { describeOccurrence, routines } from '#sources/routines'
import { isCheck } from '#tasks/plan-file'
import {
  checkLines,
  deliverOf,
  describeSkill,
  goesOnLine,
  listedUnits,
  stackLine,
  taskRepo,
  waitLine,
} from './plan'
import { describeRule, queueLines } from './rules'
import { reasonOf } from './skips'
import { clip, indent, TITLE, table } from './terminal'

const itemId = (item: Item) => `${item.source}:${item.key}`

/** The plan's items `name` names by key, `source:key` or ref, each once. */
export function namedItems(plan: RunPlan, name: string): Item[] {
  const all = [...plan.units.flatMap((p) => p.unit.items), ...plan.skipped.map((s) => s.item)]
  const named = all.filter((i) => isNamed(i, name))
  return named.filter((i, k) => named.findIndex((j) => itemId(j) === itemId(i)) === k)
}

/** The refusal of a name that names several: each one by `source:key`, which names one. */
export function ambiguous(name: string, items: Item[]): string {
  const rows = items.map((i) => [itemId(i), clip(i.title, TITLE)])
  return [`"${name}" names ${items.length} items; pick one:`, ...indent(table(rows))].join('\n')
}

/** Why an item is or isn't planned: its unit, or why it was skipped. */
export function formatWhy(plan: RunReport['plan'], named: Item): string {
  const units = listedUnits(plan)
  const out: string[] = []
  const heading = (item: Item) => [
    `${item.source} ${item.key}  ${item.title}`,
    `  ${item.url}`,
    ...(item.task ? taskLines(item) : []),
    ...(item.source === routines.id ? [routineLine(plan, item)] : []),
  ]
  const isIt = (item: Item) => itemId(item) === itemId(named)
  units.forEach((p, i) => {
    const item = p.unit.items.find(isIt)
    if (!item) return
    const passed = p.passed.length > 0 ? ` (${p.passed.join('; ')})` : ''
    const rule = plan.queue[p.rule]
    const goes = goesOnLine(p)
    const stacks = stackLine(p)
    const waits = waitLine(p)
    const rows = [
      ['unit', `${i + 1}, ${p.unit.id}`],
      ['rule', p.unit.oneOff ? '--skill' : `#${p.rule + 1} ${rule ? describeRule(rule) : ''}`],
      ['skill', describeSkill(p)],
      ['provider', `${p.provider ?? noProvider(p)}${passed}`],
      ['deliver', deliverOf(plan, p)],
      ['branch', deliverOf(plan, p) === 'push' ? p.unit.base : p.unit.branch],
      ...(goes ? [['goes on', goes]] : []),
      ...(stacks ? [['stack', stacks]] : []),
      ...(waits ? [['waits', `for ${waits}`]] : []),
      ...checkLines(p).map((check) => ['check', check]),
    ]
    out.push(
      ...(out.length ? [''] : []),
      ...heading(item),
      '  planned',
      ...indent(indent(table(rows))),
    )
  })
  for (const s of plan.skipped.filter((s) => isIt(s.item))) {
    out.push(
      ...(out.length ? [''] : []),
      ...heading(s.item),
      `  skipped${s.kind ? `: ${s.kind}` : ''}`,
    )
    const waits = s.url && s.url !== s.item.url ? [`    waits on ${s.url}`] : []
    out.push(`    ${reasonOf(s)}`, ...waits)
    // The closest rule is named by its number.
    if (s.kind === 'no_rule') out.push('', ...queueLines(plan))
  }
  return out.join('\n')
}

/** Which occurrence of its routine a routine's item is, and when the next one comes due. */
function routineLine(plan: RunReport['plan'], item: Item): string {
  const name = String(item.fields.name)
  const next = plan.routines?.[name]
  const due = describeOccurrence(new Date(String(item.fields.updated)))
  return `  routine ${name}, due ${due}${next ? `; next ${describeOccurrence(new Date(next))}` : ''}`
}

/** A task's place in its card's plan: its repo when it isn't the card's, what it waits on, and where each of those stands. */
function taskLines(item: Item): string[] {
  const task = item.task as NonNullable<Item['task']>
  const repoOf = (id: string) => task.plan.find((t) => t.id === id)?.repo
  const after = Object.entries(task.plan.find((t) => t.id === task.id)?.after ?? {}).map(
    ([id, when]) => {
      const pr = task.parent.taskPrs?.[id]
      const away = repoOf(id) !== repoOf(task.id) ? ` in ${repoOf(id)}` : ''
      const state = pr ? `PR #${pr.number} ${pr.state}` : 'no PR yet'
      if (!isCheck(when)) return `${id} ${when}${away} (${state})`
      const check = pr?.state === 'open' ? `, ${pr.checks?.[when] ?? 'not reported'}` : ''
      return `${id}'s check ${when}${away} (${state}${check})`
    },
  )
  const repo = taskRepo(item)
  return [
    `  task ${task.id} of the plan on ${task.parent.key}${repo ? `, in ${repo}` : ''}`,
    ...(after.length ? [`  after ${after.join(', ')}`] : []),
  ]
}

/** What a unit with no provider does: a merge still runs, and a conflict it read waits for one. */
function noProvider({ unit }: PlannedUnit): string {
  if (!unit.merge) return 'none left'
  const conflicts = unit.items.some((i) => i.fields.conflicts === true)
  return conflicts ? 'none left: the merge runs, a conflict waits' : 'none, awaywork merges'
}
