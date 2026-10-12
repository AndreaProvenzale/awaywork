import { pct } from './budget.js'
import { matchesValue } from './queue.js'
import type { Condition } from './types.js'

/** What awaywork knows when it checks a condition: the verdict, and whether the command and paths passed. */
export interface Facts {
  verdict?: string
  command?: boolean
  changed?: boolean
  /** Runs to the long window's reset and the share left under this run's ceiling; unset without a quota reading. */
  runs?: number
  headroom?: number
}

export function holds(condition: Condition, facts: Facts): boolean {
  return (
    (condition.verdict === undefined || matchesValue(condition.verdict, facts.verdict)) &&
    (condition.command === undefined || facts.command === true) &&
    (condition.changed === undefined || facts.changed === true) &&
    (condition.runs_until_reset === undefined ||
      (facts.runs !== undefined && facts.runs <= condition.runs_until_reset)) &&
    (condition.headroom === undefined ||
      (facts.headroom !== undefined && facts.headroom >= condition.headroom))
  )
}

/** E.g. `verdict approve or comments and \`pnpm test\` passes`. */
export function describeCondition(condition: Condition): string {
  const { verdict, command, changed, runs_until_reset, headroom } = condition
  const parts: string[] = []
  if (typeof verdict === 'object' && !Array.isArray(verdict))
    parts.push(`verdict not ${[verdict.not].flat().join(' or ')}`)
  else if (verdict !== undefined) parts.push(`verdict ${[verdict].flat().join(' or ')}`)
  if (command) parts.push(`\`${command}\` passes`)
  if (changed) parts.push(`the branch changes ${changed.join(' or ')}`)
  if (runs_until_reset !== undefined)
    parts.push(
      `the window resets within ${runs_until_reset} ${runs_until_reset === 1 ? 'run' : 'runs'}`,
    )
  if (headroom !== undefined)
    parts.push(`at least ${pct(headroom)} is left under this run's ceiling`)
  return parts.join(' and ')
}
