import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import type { Unit } from '../core/types.js'
import { changedPaths } from './checks.js'
import type { Publisher } from './slices.js'
import { inClone } from './workspace.js'

const SHOWN_PATHS = 3
const LINE_CHARS = 300

/** A gate that fired, and its line on the decision card. */
export interface Fired {
  name: string
  line: string
}

/**
 * Runs the unit's gates: their globs on the slice's commits since `from`, their commands in the clone, each time
 * afresh, with `from` as `AWAYWORK_FROM` and git reading attributes from the chain's start.
 * A command fires when it exits non-zero, its stdout the line, and fails closed: also when it can't
 * run, times out or is stopped, and, without running, when a file it names by its path from the repo
 * root isn't the one the clone held at `start`, before the chain's setup and workers.
 */
export async function runGates(
  check: Publisher['check'],
  unit: Unit,
  dir: string,
  from: string,
  start: string,
): Promise<Fired[]> {
  if (!unit.gates) return []
  const fired: Fired[] = []
  for (const [name, gate] of Object.entries(unit.gates)) {
    const lines: string[] = []
    const matched = gate.changed.length ? await changedPaths(dir, from, gate.changed) : []
    if (matched.length) lines.push(listed(matched))
    for (const command of gate.commands) {
      const swapped = await swappedFile(dir, start, command)
      if (swapped) {
        lines.push(`\`${swapped}\` changed, not run`)
        continue
      }
      const ran = await check(command, unit, dir, () => {}, { from, start })
      if (!ran.failed) continue
      const unchecked = ran.timedOut || ran.stopped || ran.refused
      lines.push(unchecked ? `\`${command}\` not checked: ${ran.failed}` : ran.stdout || ran.failed)
    }
    if (lines.length) fired.push({ name, line: oneLine(lines.join('; ')) })
  }
  return fired
}

/** The first word of `command` naming a file that differs from the one at `start`: edited, added or gone. */
async function swappedFile(dir: string, start: string, command: string) {
  const words = command.split(/[\s&|;()<>"'`]+/).map((word) => word.replace(/^\.\//, ''))
  for (const word of new Set(words)) {
    if (!word || word.startsWith('/') || word.split('/').includes('..')) continue
    if (await differs(dir, start, word)) return word
  }
  return undefined
}

/** Compares the bytes on disk, through any symlink as the command would read them, never the index or attributes. */
async function differs(dir: string, start: string, path: string): Promise<boolean> {
  const was = await fileAt(dir, start, path)
  const file = await open(join(dir, path), constants.O_RDONLY | constants.O_NONBLOCK).catch(
    () => undefined,
  )
  if (!file) return was !== undefined
  try {
    const stats = await file.stat()
    if (!stats.isFile()) return was !== undefined
    if (!was || stats.size !== was.length) return true
    return !(await file.readFile()).equals(was)
  } finally {
    await file.close()
  }
}

/** The file at `path` in commit `start`, through symlinks within its tree, or undefined when there's none. */
async function fileAt(dir: string, start: string, path: string): Promise<Buffer | undefined> {
  const { stdout } = await execa(
    bin('git'),
    [...inClone(dir), 'cat-file', '--batch', '--follow-symlinks'],
    { input: `${start}:${path}\n`, encoding: 'buffer' },
  )
  const out = Buffer.from(stdout)
  const header = out.indexOf('\n')
  const size = /^[0-9a-f]+ blob (\d+)$/.exec(out.subarray(0, header).toString())?.[1]
  return size === undefined ? undefined : out.subarray(header + 1, header + 1 + Number(size))
}

/** E.g. `gate schema fired`, `gates schema, deps fired`. */
export function describeFired(fired: Fired[]): string | undefined {
  if (!fired.length) return undefined
  return `${fired.length === 1 ? 'gate' : 'gates'} ${fired.map((f) => f.name).join(', ')} fired`
}

/**
 * What awaywork puts first in the PR body whenever the unit has gates, closed by a rule so the agent's text is
 * always below it: the decision card when one fired, else the gates that ran.
 */
export function gatesSection(gates: string[], fired: Fired[]): string {
  if (!fired.length) return `Gates: none fired (${gates.join(', ')})\n\n---`
  const lines = fired.map((f) => `- ${f.name}: ${f.line}`)
  return ['## Needs a decision', '', '### Gates (from scripts)', '', ...lines, '', '---'].join('\n')
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
