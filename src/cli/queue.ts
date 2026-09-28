import { readFile, writeFile } from 'node:fs/promises'
import { clearScreenDown, emitKeypressEvents, moveCursor } from 'node:readline'
import { styleText } from 'node:util'
import type { Command } from 'commander'
import { withQueueOrder } from '../config/edit.js'
import { configPath, loadConfig, parseConfig } from '../config/load.js'
import { defaultRules, ruleMatches } from '../core/queue.js'
import type { Item, Rule } from '../core/types.js'
import { reportConfigError } from './config.js'
import { describeRule } from './format.js'
import { collectItems } from './plan.js'

export function queueCommand(program: Command): void {
  const queue = program
    .command('queue')
    .description('show what each rule matches tonight and reorder the rules with the keyboard')
    .action(async () => {
      const path = configPath(program.opts().config)
      try {
        const config = await loadConfig(path)
        const text = await readFile(path, 'utf8')
        const warnings: string[] = []
        process.stderr.write("Reading tonight's items…\n")
        const items = await collectItems(config, { env: process.env, log: (l) => warnings.push(l) })
        const rules = config.queue ?? defaultRules(Object.keys(config.sources))
        const header = [
          ...warnings.map((w) => `warning: ${w}`),
          config.queue ? `Queue in ${path}` : 'Default queue (none in config; saving writes it)',
          '',
        ]
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.log([...header, ...formatQueue(rules, items).flat()].join('\n'))
          return
        }
        const order = await reorder(rules, items, header)
        if (!order) console.log('Not saved')
        else if (config.queue && order.every((old, i) => old === i)) console.log('No change')
        else await saveOrder(path, text, rules, order)
      } catch (e) {
        reportConfigError(e)
      }
    })

  queue
    .command('move <from> <to>')
    .description('move the rule at position <from> to position <to>, as numbered by queue')
    .action(async (from: string, to: string) => {
      const path = configPath(program.opts().config)
      try {
        const config = await loadConfig(path)
        const text = await readFile(path, 'utf8')
        const rules = config.queue ?? defaultRules(Object.keys(config.sources))
        const order = moveOrder(rules.length, Number(from), Number(to))
        if (!order) return queue.error(`error: positions go from 1 to ${rules.length}`)
        if (config.queue && order.every((old, i) => old === i)) console.log('No change')
        else await saveOrder(path, text, rules, order)
      } catch (e) {
        reportConfigError(e)
      }
    })
}

async function saveOrder(path: string, text: string, rules: Rule[], order: number[]) {
  const next = withQueueOrder(text, rules, order)
  parseConfig(next, path)
  await writeFile(path, next)
  console.log(`Saved ${path}`)
}

/** The order (old indices) after moving position `from` to `to` (1-based); undefined when out of range. */
export function moveOrder(length: number, from: number, to: number): number[] | undefined {
  const valid = (p: number) => Number.isInteger(p) && p >= 1 && p <= length
  if (!valid(from) || !valid(to)) return undefined
  const order = Array.from({ length }, (_, i) => i)
  order.splice(to - 1, 0, ...order.splice(from - 1, 1))
  return order
}

/** One block of lines per rule, then the unmatched items; numbers are positions in `rules`. */
export function formatQueue(rules: Rule[], items: Item[]): string[][] {
  const matches = ruleMatches(items, rules)
  const keys = (list: Item[]) =>
    list.length === 0
      ? ''
      : `: ${list
          .slice(0, 3)
          .map((i) => i.key)
          .join(', ')}${list.length > 3 ? ', …' : ''}`
  const width = Math.max(...rules.map((r) => r.skill.length))
  const blocks = rules.map((rule, i) => {
    const { taken, shadowed } = matches[i] ?? { taken: [], shadowed: [] }
    const lines = [`#${i + 1}  ${rule.skill.padEnd(width)}  ${describeRule(rule)}`]
    lines.push(`     ${taken.length} tonight${keys(taken)}`)
    for (const by of new Set(shadowed.map((s) => s.by))) {
      const list = shadowed.filter((s) => s.by === by).map((s) => s.item)
      lines.push(`     ${list.length} taken by #${by + 1}${keys(list)}`)
    }
    return lines
  })
  const matched = new Set(matches.flatMap((m) => m.taken))
  const unmatched = items.filter((i) => !matched.has(i))
  return [...blocks, [`${unmatched.length} unmatched${keys(unmatched)}`]]
}

export interface Cursor {
  order: number[]
  at: number
  grabbed: boolean
}

/** One keypress: arrows move the cursor or, once grabbed with space, the rule under it. */
export function press(state: Cursor, key: string): Cursor | 'save' | 'quit' {
  if (key === 'q' || key === 'escape') return 'quit'
  if (key === 'return') return 'save'
  if (key === 'space') return { ...state, grabbed: !state.grabbed }
  const step = { up: -1, k: -1, down: 1, j: 1 }[key]
  const to = state.at + (step ?? 0)
  if (!step || to < 0 || to >= state.order.length) return state
  const order = [...state.order]
  if (state.grabbed) [order[state.at], order[to]] = [order[to] as number, order[state.at] as number]
  return { order, at: to, grabbed: state.grabbed }
}

/** The new order as old indices, or undefined when the user quits. */
function reorder(rules: Rule[], items: Item[], header: string[]): Promise<number[] | undefined> {
  const { stdin, stdout } = process
  let state: Cursor = { order: rules.map((_, i) => i), at: 0, grabbed: false }
  let drawn = 0
  const draw = () => {
    const blocks = formatQueue(
      state.order.map((i) => rules[i] as Rule),
      items,
    )
    // A wrapped line would break the redraw, which moves up one row per line.
    const clip = (line: string) => (stdout.columns ? line.slice(0, stdout.columns - 1) : line)
    const lines = [
      ...header.map(clip),
      ...blocks.flatMap((block, i) =>
        block.map((line, j) => {
          if (i !== state.at) return clip(`  ${line}`)
          const style = state.grabbed ? 'inverse' : 'bold'
          return styleText(style, clip(`${j === 0 ? '›' : ' '} ${line}`))
        }),
      ),
      '',
      state.grabbed
        ? '↑↓ move the rule · space drop it'
        : '↑↓ select · space pick up · enter save · q quit',
    ]
    if (drawn > 0) {
      moveCursor(stdout, 0, -drawn)
      clearScreenDown(stdout)
    }
    stdout.write(`${lines.join('\n')}\n`)
    drawn = lines.length
  }

  emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve) => {
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      const next = key.ctrl && key.name === 'c' ? 'quit' : press(state, key.name ?? '')
      if (typeof next === 'object') {
        state = next
        return draw()
      }
      stdin.off('keypress', onKey)
      stdin.setRawMode(false)
      stdin.pause()
      resolve(next === 'save' ? state.order : undefined)
    }
    stdin.on('keypress', onKey)
    draw()
  })
}
