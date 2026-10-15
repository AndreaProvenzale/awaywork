import { stringify } from 'yaml'
import type { Rule } from '../core/types.js'

const queueHeader =
  'queue:                          # first matching rule wins; top = highest priority'

/** Rules as a `queue:` section in the short form a user writes. */
export function queueYaml(rules: Rule[]): string {
  const lines = [queueHeader]
  for (const rule of rules) {
    const set = Object.entries(rule).filter(
      ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
    )
    set.forEach(([key, value], i) => {
      lines.push(`${i === 0 ? '  - ' : '    '}${key}: ${flow(value)}`)
    })
  }
  return `${lines.join('\n')}\n`
}

export function flow(value: unknown): string {
  return stringify(value, {
    collectionStyle: 'flow',
    flowCollectionPadding: false,
    lineWidth: 0,
  }).trim()
}
