import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execa } from 'execa'
import { launched } from '../core/launch.js'

const GB = 2 ** 30

interface WatchdogLimits {
  intervalMs: number
  minMemory: number
  minDisk: number
}

export const defaultLimits: WatchdogLimits = {
  intervalMs: 2000,
  minMemory: 1.5 * GB,
  minDisk: 2 * GB,
}

export interface Watchdog {
  /** Kills every descendant seen while watching, including those orphaned since. */
  stop(): Promise<void>
}

/** Why the machine is too short to run a worker: memory, or disk at `dir`'s closest existing directory. */
export async function shortage(
  dir: string,
  limits: WatchdogLimits = defaultLimits,
): Promise<string | undefined> {
  if (process.availableMemory() < limits.minMemory)
    return `memory below ${limits.minMemory / GB} GB`
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir)
  const disk = await statfs(dir)
  if (disk.bavail * disk.bsize < limits.minDisk) return `disk below ${limits.minDisk / GB} GB`
}

/**
 * Watches the worker's processes and the machine while one worker runs.
 *
 * Node has no subreaper, so a background task that starts its own session and outlives
 * the model is reparented away from us. Every tick records the worker's launches and their
 * descendants by pid and start time; `stop` kills those still alive with the same start time,
 * so a pid reused by an unrelated process is spared. Workers run one at a time, awaywork
 * watch's runs included, so every launch running is this worker's; awaywork's own children,
 * like the keep-awake one or a poll, are spared.
 */
export function startWatchdog(
  dir: string,
  onLimit: (reason: string) => void,
  limits: WatchdogLimits = defaultLimits,
): Watchdog {
  const seen = new Map<number, string>()
  let ticking: Promise<void> = Promise.resolve()

  const tick = async () => {
    for (const [pid, started] of under(launched(), await processes())) seen.set(pid, started)
    const reason = await shortage(dir, limits)
    if (reason) onLimit(reason)
  }
  const timer = setInterval(() => {
    ticking = ticking.then(tick).catch(() => {})
  }, limits.intervalMs)

  return {
    async stop() {
      clearInterval(timer)
      await ticking
      await tick().catch(() => {})
      const alive = await processes()
      for (const [pid, started] of seen)
        if (alive.get(pid)?.started === started) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
    },
  }
}

type Table = Map<number, { ppid: number; started: string }>

async function processes(): Promise<Table> {
  const { stdout } = await execa('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { env: { LC_ALL: 'C' } })
  const table: Table = new Map()
  for (const line of stdout.split('\n')) {
    const [, pid, ppid, started] = /^\s*(\d+)\s+(\d+)\s+(.*\S)/.exec(line) ?? []
    if (pid && ppid && started) table.set(Number(pid), { ppid: Number(ppid), started })
  }
  return table
}

/** The processes `roots` names and their descendants, with their start times. */
function under(roots: number[], table: Table): [number, string][] {
  const found: [number, string][] = []
  const frontier = roots.filter((pid) => table.has(pid))
  for (const pid of frontier) found.push([pid, table.get(pid)?.started ?? ''])
  while (frontier.length) {
    const parent = frontier.pop()
    for (const [pid, p] of table)
      if (p.ppid === parent) {
        found.push([pid, p.started])
        frontier.push(pid)
      }
  }
  return found
}
