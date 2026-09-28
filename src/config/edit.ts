import { isSeq, parseDocument, stringify } from 'yaml'
import type { Rule } from '../core/types.js'

const queueHeader =
  'queue:                          # first matching rule wins; top = highest priority'

/**
 * The config text with its queue in `order` (old indices, new order). Rules
 * that exist in the file move as source text, with the comments above them,
 * so the rest of the file stays byte for byte; a config without a queue
 * gets `rules` appended in that order.
 */
export function withQueueOrder(text: string, rules: Rule[], order: number[]): string {
  const doc = parseDocument(text)
  if (!doc.has('queue'))
    return `${text.replace(/\n*$/, '\n')}${queueYaml(order.map((i) => rules[i] as Rule))}`

  const seq = doc.get('queue', true)
  if (!isSeq(seq) || seq.flow || seq.items.length !== order.length)
    throw new Error('queue must be a block list (one "- skill:" per rule) to reorder it')
  const lineStart = (at: number) => text.lastIndexOf('\n', at - 1) + 1
  const comment = (from: number, to: number) => /^\s*#/.test(text.slice(from, to))
  const lineEnd = (at: number) => {
    if (text[at - 1] === '\n') return at
    const newline = text.indexOf('\n', at)
    return newline === -1 ? text.length : newline + 1
  }
  const blocks = seq.items.map((node) => {
    const [start, valueEnd] = (node as { range: [number, number, number] }).range
    let from = lineStart(start)
    while (from > 0 && comment(lineStart(from - 1), from - 1)) from = lineStart(from - 1)
    return { from, to: lineEnd(valueEnd) }
  })
  const withNewline = (s: string) => (s.endsWith('\n') ? s : `${s}\n`)
  let out = ''
  let at = 0
  blocks.forEach((slot, i) => {
    const moved = blocks[order[i] as number] as typeof slot
    out += text.slice(at, slot.from) + withNewline(text.slice(moved.from, moved.to))
    at = slot.to
  })
  return out + text.slice(at)
}

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
  return stringify(value, { collectionStyle: 'flow', flowCollectionPadding: false }).trim()
}
