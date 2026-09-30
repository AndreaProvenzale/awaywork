import { matchesValue } from './queue.js'
import type { Condition } from './types.js'

/** What night-shift knows when it checks a condition: the verdict, and whether the command and paths passed. */
export interface Facts {
  verdict?: string
  command?: boolean
  changed?: boolean
}

export function holds(condition: Condition, facts: Facts): boolean {
  return (
    (condition.verdict === undefined || matchesValue(condition.verdict, facts.verdict)) &&
    (condition.command === undefined || facts.command === true) &&
    (condition.changed === undefined || facts.changed === true)
  )
}

/** E.g. `verdict approve or comments and \`pnpm test\` passes`; never `|`, which splits a table cell. */
export function describeCondition(condition: Condition): string {
  const { verdict, command, changed } = condition
  const parts: string[] = []
  if (typeof verdict === 'object' && !Array.isArray(verdict))
    parts.push(`verdict not ${[verdict.not].flat().join(' or ')}`)
  else if (verdict !== undefined) parts.push(`verdict ${[verdict].flat().join(' or ')}`)
  if (command) parts.push(`\`${command}\` passes`)
  if (changed) parts.push(`the branch changes ${changed.join(' or ')}`)
  return parts.join(' and ')
}
