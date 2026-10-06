import { pct } from './budget.js'
import { matchesValue } from './queue.js'
import type { Condition } from './types.js'

/** What night-shift knows when it checks a condition: the verdict, and whether the command and paths passed. */
export interface Facts {
  verdict?: string
  command?: boolean
  changed?: boolean
  /** Nights to the long window's reset and the share left under tonight's ceiling; unset without a quota reading. */
  nights?: number
  headroom?: number
}

export function holds(condition: Condition, facts: Facts): boolean {
  return (
    (condition.verdict === undefined || matchesValue(condition.verdict, facts.verdict)) &&
    (condition.command === undefined || facts.command === true) &&
    (condition.changed === undefined || facts.changed === true) &&
    (condition.nights_until_reset === undefined ||
      (facts.nights !== undefined && facts.nights <= condition.nights_until_reset)) &&
    (condition.headroom === undefined ||
      (facts.headroom !== undefined && facts.headroom >= condition.headroom))
  )
}

/** E.g. `verdict approve or comments and \`pnpm test\` passes`. */
export function describeCondition(condition: Condition): string {
  const { verdict, command, changed, nights_until_reset, headroom } = condition
  const parts: string[] = []
  if (typeof verdict === 'object' && !Array.isArray(verdict))
    parts.push(`verdict not ${[verdict.not].flat().join(' or ')}`)
  else if (verdict !== undefined) parts.push(`verdict ${[verdict].flat().join(' or ')}`)
  if (command) parts.push(`\`${command}\` passes`)
  if (changed) parts.push(`the branch changes ${changed.join(' or ')}`)
  if (nights_until_reset !== undefined)
    parts.push(
      `the window resets within ${nights_until_reset} ${nights_until_reset === 1 ? 'night' : 'nights'}`,
    )
  if (headroom !== undefined)
    parts.push(`at least ${pct(headroom)} is left under tonight's ceiling`)
  return parts.join(' and ')
}
