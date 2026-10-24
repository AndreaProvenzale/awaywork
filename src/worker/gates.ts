import type { Unit } from '../core/types.js'
import { changedPaths } from './checks.js'
import type { Publisher } from './slices.js'

const SHOWN_PATHS = 3
const LINE_CHARS = 300

/** A gate that fired, and its line on the decision card. */
export interface Fired {
  name: string
  line: string
}

/**
 * Runs the unit's gates on the slice's commits since `from`. A command fires when it exits non-zero, its
 * stdout the line, and fails closed: also when it can't run, times out or is stopped, and, without
 * running, when it names a file those commits changed.
 */
export async function runGates(
  check: Publisher['check'],
  unit: Unit,
  dir: string,
  from: string,
): Promise<Fired[]> {
  if (!unit.gates) return []
  const changed = await changedPaths(dir, from)
  const fired: Fired[] = []
  for (const [name, gate] of Object.entries(unit.gates)) {
    const lines: string[] = []
    const matched = gate.changed.length ? await changedPaths(dir, from, gate.changed) : []
    if (matched.length) lines.push(listed(matched))
    for (const command of gate.commands) {
      const named = command
        .split(/\s+/)
        .map((token) => token.replace(/^["']+|["';]+$/g, '').replace(/^\.\//, ''))
        .find((token) => changed.includes(token))
      if (named) {
        lines.push(`\`${named}\` changed in this PR`)
        continue
      }
      const ran = await check(command, unit, dir, () => {}, false)
      if (!ran.failed) continue
      const unchecked = ran.timedOut || ran.stopped || ran.refused
      lines.push(unchecked ? `\`${command}\` not checked: ${ran.failed}` : ran.stdout || ran.failed)
    }
    if (lines.length) fired.push({ name, line: oneLine(lines.join('; ')) })
  }
  return fired
}

/** E.g. `gate schema fired`, `gates schema, deps fired`. */
export function describeFired(fired: Fired[]): string | undefined {
  if (!fired.length) return undefined
  return `${fired.length === 1 ? 'gate' : 'gates'} ${fired.map((f) => f.name).join(', ')} fired`
}

/** The card awaywork puts first in the PR body, which the model never writes. */
export function decisionCard(fired: Fired[]): string {
  const gates = fired.map((f) => `- ${f.name}: ${f.line}`)
  return ['## Needs a decision', '', '### Gates (from scripts)', '', ...gates].join('\n')
}

function listed(paths: string[]): string {
  const more = paths.length - SHOWN_PATHS
  return `${paths.slice(0, SHOWN_PATHS).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** On one line and capped; an escaped `<` can't open a comment that hides the rest of the body. */
function oneLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('   ')
    .replaceAll('<', '&lt;')
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1).trimEnd()}…` : line
}
