import { constants } from 'node:fs'
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import type { Unit } from '../core/types.js'
import { changedPaths, head } from './checks.js'
import type { Publisher } from './slices.js'
import { discard, readVerdict, snapshot } from './steps.js'
import { inClone, outputFile, readOutput, refuseSymlinks, WORK_DIR } from './workspace.js'

const SHOWN_PATHS = 3
const LINE_CHARS = 300
const JUDGE_LINES = 10

/** A gate that fired, and its line on the decision card: the scripts' part, or the Judge part when `judged`. */
export interface Fired {
  name: string
  line: string
  judged?: true
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
      const ran = await check(command, unit, dir, () => {}, { from, gate: true })
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

/**
 * Runs each gate's judges, one model run per skill on the slice's commits since `from`, after the other gates: a
 * judge only adds lines, so it can't clear what a script fired. It fires when it writes the verdict `fires`, with its
 * report's lines, and fails closed: also when it didn't run or finish, or changed the clone, which awaywork then puts
 * back as it found it, HEAD, index, worktree and `out/`, so publishing reads what it would have without the judge.
 */
export async function runJudges(
  judge: Publisher['judge'],
  unit: Unit,
  dir: string,
  from: string,
): Promise<Fired[]> {
  const fired: Fired[] = []
  for (const [name, gate] of Object.entries(unit.gates ?? {}))
    for (const skill of gate.skills) {
      const lines = await judged(judge, name, skill, unit, dir, from)
      fired.push(...lines.map((line) => ({ name, line: oneLine(line), judged: true as const })))
    }
  return fired
}

async function judged(
  judge: Publisher['judge'],
  name: string,
  skill: string,
  unit: Unit,
  dir: string,
  from: string,
): Promise<string[]> {
  const out = join(dir, WORK_DIR, 'out')
  // Only the judge's own report and verdict may differ; a missing `out/` reads as an empty one.
  const clearOwn = async () => {
    await refuseSymlinks(dir, [`${WORK_DIR}/out`])
    await mkdir(out, { recursive: true })
    for (const file of [outputFile.report, 'verdict']) await rm(join(out, file), { force: true })
  }
  await clearOwn()
  // Git reads `out/` through attributes, a `.away/.gitattributes` too, so it's also compared and put back as bytes.
  const files = await filesIn(out)
  const start = await head(dir)
  const saved = await snapshot(dir)
  if (!saved) return ["judge didn't run: the clone's index holds a conflict"]
  const why = await judge(name, skill, unit, dir, from)
  await refuseSymlinks(dir, [`${WORK_DIR}/out`])
  const verdict = await readVerdict(dir)
  const report = await readOutput(join(out, outputFile.report))
  await clearOwn()
  const after = await snapshot(dir)
  const changed =
    (await head(dir)) !== start ||
    after?.tree !== saved.tree ||
    after?.staged !== saved.staged ||
    !sameFiles(files, await filesIn(out))
  if (changed) {
    await discard(dir, start, saved)
    await putBack(out, files)
  }
  const lines = [
    ...(why ? [`judge didn't run: ${why}`] : []),
    ...(changed ? ['the judge changed the clone; awaywork dropped its changes'] : []),
  ]
  if (!why && verdict === 'fires') lines.push(...reportLines(report))
  return lines
}

/** The report's lines without their list markers, the first few of them. */
function reportLines(report: string): string[] {
  const lines = report
    .split('\n')
    .map((l) => l.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean)
  if (!lines.length) return ['fired, with no report']
  const more = lines.length - JUDGE_LINES
  return more > 0 ? [...lines.slice(0, JUDGE_LINES), `and ${more} more lines`] : lines
}

type Entry = Buffer | 'dir' | 'other'

/** Each file and folder under `out`, a regular file with one link by its bytes, read without following a link or blocking on a FIFO. */
async function filesIn(out: string): Promise<Map<string, Entry>> {
  const files = new Map<string, Entry>()
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    if (!entry.isFile()) {
      files.set(relative(out, path), entry.isDirectory() ? 'dir' : 'other')
      continue
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const linked = (await file.stat()).nlink > 1
      files.set(relative(out, path), linked ? 'other' : await file.readFile())
    } finally {
      await file.close()
    }
  }
  return files
}

function sameFiles(a: Map<string, Entry>, b: Map<string, Entry>): boolean {
  if (a.size !== b.size) return false
  for (const [path, was] of a) {
    const now = b.get(path)
    if (Buffer.isBuffer(was) ? !Buffer.isBuffer(now) || !was.equals(now) : was !== now) return false
  }
  return true
}

/** Writes `out` back as `filesIn` read it: its regular files and folders. */
async function putBack(out: string, files: Map<string, Entry>): Promise<void> {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  for (const [path, data] of files) {
    if (data === 'dir') await mkdir(join(out, path), { recursive: true })
    else if (data !== 'other') {
      await mkdir(dirname(join(out, path)), { recursive: true })
      await writeFile(join(out, path), data)
    }
  }
}

/** E.g. `gate schema fired`, `gates schema, deps fired`. */
export function describeFired(fired: Fired[]): string | undefined {
  const names = [...new Set(fired.map((f) => f.name))]
  if (!names.length) return undefined
  return `${names.length === 1 ? 'gate' : 'gates'} ${names.join(', ')} fired`
}

/**
 * What awaywork puts first in the PR body whenever the unit has gates, closed by a rule so the agent's text is
 * always below it: the decision card when one fired, the scripts' lines then the judges', else the gates that ran.
 */
export function gatesSection(gates: string[], fired: Fired[]): string {
  if (!fired.length) return `Gates: none fired (${gates.join(', ')})\n\n---`
  const part = (title: string, lines: Fired[]) =>
    lines.length ? [`### ${title}`, '', ...lines.map((f) => `- ${f.name}: ${f.line}`), ''] : []
  return [
    '## Needs a decision',
    '',
    ...part(
      'Gates (from scripts)',
      fired.filter((f) => !f.judged),
    ),
    ...part(
      'Judge',
      fired.filter((f) => f.judged),
    ),
    '---',
  ].join('\n')
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
