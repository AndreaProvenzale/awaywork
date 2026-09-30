import { matchesValue } from './queue.js'
import type { Condition } from './types.js'

/** What a loop knows after a step. */
export interface Facts {
  verdict?: string
}

export function holds(condition: Condition, facts: Facts): boolean {
  return condition.verdict === undefined || matchesValue(condition.verdict, facts.verdict)
}

/** E.g. `verdict approve|comments`. */
export function describeCondition(condition: Condition): string {
  const { verdict } = condition
  if (verdict === undefined) return ''
  if (typeof verdict === 'object' && !Array.isArray(verdict))
    return `verdict not ${[verdict.not].flat().join('|')}`
  return `verdict ${[verdict].flat().join('|')}`
}
