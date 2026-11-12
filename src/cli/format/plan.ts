import { presenceLine } from '../../core/budget.js'
import { describeCondition } from '../../core/condition.js'
import { cardRepo, unpassed } from '../../core/fanout.js'
import { type PlannedUnit, type RunPlan, shortRef } from '../../core/foreman.js'
import { MAX_ATTEMPTS } from '../../core/max-attempts.js'
import { isCheck, openedChain } from '../../core/plan.js'
import type { Item } from '../../core/types.js'
import { describeOccurrence } from '../../sources/routines.js'
import { allowanceNote, allowanceRow } from './allowances.js'
import { NO_QUEUE } from './rules.js'
import { needsYouLines, refIn, skippedLines } from './skips.js'
import {
  clip,
  heading,
  hintLines,
  indent,
  type Style,
  styler,
  TITLE,
  table,
  warningLines,
} from './terminal.js'

/** One per chain: its first step stands for it. */
export function listedUnits(plan: Pick<RunPlan, 'units'>) {
  return plan.units.filter((p) => !p.chain)
}

/** The plan as text: providers, units, what needs you and how many items were skipped. */
export function formatPlan(plan: RunPlan, warnings: string[] = [], styled = false): string {
  const style = styler(styled)
  const out = [...warningLines(warnings, styled), ...providerLines(plan, style)]
  out.push('', heading('Units', listedUnits(plan).length, style), ...planUnitLines(plan, style))
  out.push(...routineLines(plan, style))
  out.push(...needsYouLines(plan.skipped, style), ...skippedLines(plan.skipped, style))
  if (plan.skipped.length > 0)
    out.push(
      '',
      ...hintLines(style, [
        ['awaywork plan --skipped [kind]', 'lists them'],
        ['awaywork plan --why <key>', 'says why an item is planned or not'],
      ]),
    )
  return out.join('\n')
}

/** A note when no queue leaves nothing to run, then each provider's window, ceiling and session. */
export function providerLines(plan: RunPlan, style: Style = (_, text) => text): string[] {
  const out = plan.queue.length === 0 && plan.units.length === 0 ? [NO_QUEUE, ''] : []
  out.push(style('bold', 'Providers'))
  if (plan.present !== undefined) out.push(style('dim', `  ${presenceLine(plan.present)}`))
  const allowances = Object.entries(plan.allowances)
  const providerHeader = [
    'provider',
    'window',
    'used',
    'ceiling',
    'set by',
    'resets in',
    'session / stop at',
  ]
  const lines = table([providerHeader, ...allowances.map(([id, a]) => allowanceRow(id, a))])
  out.push(`  ${style('bold', lines[0] ?? '')}`)
  allowances.forEach(([id, a], i) => {
    out.push(`  ${lines[i + 1]}`)
    out.push(style('dim', `    ${allowanceNote(id, a)}`))
  })
  return out
}

/** Each routine and when it next comes due, local time. */
function routineLines(plan: RunPlan, style: Style): string[] {
  const next = Object.entries(plan.routines ?? {})
  if (next.length === 0) return []
  const rows = next.map(([name, at]) => [name, `next ${describeOccurrence(new Date(at))}`])
  return ['', heading('Routines', next.length, style), ...indent(table(rows))]
}

const stepsOf = (plan: Pick<RunPlan, 'units'>, head: PlannedUnit) =>
  plan.units.filter((p) => p.chain === head.unit.id)

export const deliverOf = (plan: Pick<RunPlan, 'units'>, p: PlannedUnit) =>
  [p, ...stepsOf(plan, p)].find((s) => s.unit.deliver !== 'report')?.unit.deliver ?? 'report'

export function planUnitLines(plan: RunPlan, style: Style = (_, text) => text): string[] {
  const { header, units } = planUnitTable(plan, style)
  return units.length === 0 ? ['  none'] : indent([header, ...units.flat()])
}

/** A unit's item by its short ref, or `inRepo` by its ref in the unit's repo; the unit's id without one. */
export const unitRef = ({ id, repo, items: [top] }: PlannedUnit['unit'], inRepo: boolean) =>
  top ? (inRepo ? refIn(repo, top) : shortRef(top)) : id

/** The units table, unindented: one row per unit with its item, rule, skill, provider, delivery and title, clipped at `clipAt`, then its `when`, merged items and chain. */
export function planUnitTable(
  plan: RunPlan,
  style: Style = (_, text) => text,
  clipAt = TITLE,
  inRepo = false,
): { header: string; units: string[][] } {
  const units = listedUnits(plan)
  const rows = units.map((p, i) => {
    const top = p.unit.items[0]
    return [
      String(i + 1),
      unitRef(p.unit, inRepo),
      p.unit.oneOff
        ? '--skill'
        : `#${p.rule + 1}${plan.queue[p.rule]?.run === 'soon' ? ' soon' : ''}`,
      describeSkill(p),
      p.provider ?? '-',
      deliverOf(plan, p),
      clip(top?.title ?? '', clipAt),
    ]
  })
  const header = ['', 'item', 'rule', 'skill', 'provider', 'deliver', 'title']
  const lines = table([header, ...rows])
  const blocks = units.map((p, i) => {
    const out = [lines[i + 1] ?? '']
    const unmet = p.quotaUnmet ? ` (${p.quotaUnmet})` : ''
    if (p.unit.rule.quota) out.push(`   quota: ${describeCondition(p.unit.rule.quota)}${unmet}`)
    p.unit.items.slice(1).forEach((item, j) => {
      const rule = p.itemRules[j + 1] ?? p.rule
      out.push(`   + ${shortRef(item)}: same feature, matched #${rule + 1}`)
    })
    const repo = taskRepo(p.unit.items[0])
    if (repo) out.push(`   in ${repo}`)
    const goes = goesOnLine(p)
    if (goes) out.push(`   ${goes}`)
    const stacks = stackLine(p)
    if (stacks) out.push(`   ${stacks}`)
    const waits = waitLine(p)
    if (waits) out.push(`   waits for ${waits}`)
    for (const check of checkLines(p)) out.push(`   after ${check}`)
    if (p.passed.length > 0 || (!p.provider && !p.unit.merge))
      out.push(
        `   provider: ${[...p.passed, p.provider ? `took ${p.provider}` : 'none left'].join('; ')}`,
      )
    // A loop's later rounds repeat its first: only round 1 is listed.
    for (const s of stepsOf(plan, p).filter((s) => !s.loop || s.loop.round === 1)) {
      if (s.loop?.step === 0) {
        const { skills, until, max } = s.loop
        out.push(
          `   then loop ${skills.join(' ⇄ ')} until ${describeCondition(until)}, at most ${max} ${max === 1 ? 'round' : 'rounds'}`,
        )
      }
      const when = s.unit.rule.when ? `, when ${describeCondition(s.unit.rule.when)}` : ''
      const passed = s.passed.length > 0 ? ` (${s.passed.join('; ')})` : ''
      const on = `on ${s.provider ?? 'no provider left'}${passed}`
      out.push(`   ${s.loop ? '  ' : 'then '}${describeSkill(s)} ${on}${when}`)
    }
    return out
  })
  return { header: style('bold', lines[0] ?? ''), units: blocks }
}

/** A task's repo when it isn't its card's. */
export function taskRepo(item: Item | undefined): string | undefined {
  const repo = item?.fields.repo
  return item?.task && typeof repo === 'string' && repo !== cardRepo(item.task.parent)
    ? repo
    : undefined
}

/** The PRs in other repos a task's chain waits for in this run, e.g. `api's PR in acme/backend`. */
export function waitLine(p: PlannedUnit): string | undefined {
  const task = p.unit.items[0]?.task
  const repoOf = (id: string) => task?.plan.find((t) => t.id === id)?.repo
  const waits = (p.waitsFor ?? []).map((id) => `${id}'s PR in ${repoOf(id)}`)
  return waits.length ? waits.join(', ') : undefined
}

/** The checks a task's chain starts after and where each stands, but the one its stack line names. */
export function checkLines(p: PlannedUnit): string[] {
  const task = p.unit.items[0]?.task
  if (!task) return []
  const after = task.plan.find((t) => t.id === task.id)?.after ?? {}
  const stacked = stackOn(p)?.after
  return Object.entries(after)
    .filter(([id, when]) => isCheck(when) && id !== stacked)
    .map(([id, name]) => checkText(task, id, name))
}

/** A check a task is after and where it stands, e.g. `api's check Vercel Preview (passed)`. */
function checkText(task: NonNullable<Item['task']>, id: string, name: string): string {
  const pr = task.parent.taskPrs?.[id]
  const state = pr?.state === 'merged' ? `${id} merged` : (unpassed(pr, name) ?? 'passed')
  return `${id}'s check ${name} (${state})`
}

/** How a unit goes on from an earlier run: on awaywork's own draft, or after its `continue` result. */
export function goesOnLine({ unit }: PlannedUnit): string | undefined {
  const count = `continue (${unit.continued} of ${MAX_ATTEMPTS})`
  if (unit.resume)
    return `goes on with its draft ${unit.resume.url}, which ${unit.resume.status === 'ask' ? 'asked questions' : `said ${count}`}`
  if (unit.continued) return `goes on from its result, which said ${count}`
}

/** The task an open PR's stack puts a task's chain after, and that PR's number. */
function stackOn(p: PlannedUnit): { after: string; number: number } | undefined {
  const task = p.unit.items[0]?.task
  const onto = task?.onto
  const pr = onto && task.parent.taskPrs?.[onto]
  if (p.after || !pr || !p.unit.stackedOn) return undefined
  const own = task.plan.find((t) => t.id === task.id)
  return { after: (own && openedChain(own, task.plan)?.at(-1)) ?? onto, number: pr.number }
}

/** Where a task's chain starts when it stacks: on the PR a chain earlier in this run opens, or on one already open. */
export function stackLine(p: PlannedUnit): string | undefined {
  const task = p.unit.items[0]?.task
  const onto = task?.onto
  if (p.after) return `after ${onto}, stacks on its PR`
  const stack = stackOn(p)
  if (!task || !stack) return undefined
  const { after, number } = stack
  const when = task.plan.find((t) => t.id === task.id)?.after[after]
  const what = when && isCheck(when) ? checkText(task, after, when) : after
  return `after ${what}, stacks on ${after === onto ? '' : `${onto}'s `}#${number}`
}

export function describeSkill(p: PlannedUnit): string {
  return `${p.unit.skill} (${p.origin === 'builtin' ? 'built-in' : (p.origin ?? 'in-repo?')})`
}
