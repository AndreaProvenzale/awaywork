import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

export type RunLock = { release: () => Promise<void> } | { pid: number; runId: string }

/** Takes the lock file for this run, or says who holds it; a lock no live process of ours holds is taken over. Two runs starting together can still both win. */
export async function takeRunLock(file: string, runId: string): Promise<RunLock> {
  await mkdir(dirname(file), { recursive: true })
  const content = `${process.pid} ${runId}`
  for (;;) {
    try {
      await writeFile(file, content, { flag: 'wx' })
      return { release: () => releaseIfOurs(file, content) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const held = await holder(file)
    if (held) return held
    await rm(file, { force: true })
  }
}

/** The live process holding a lock file, if any. */
export async function lockHolder(file: string): Promise<number | undefined> {
  return (await holder(file))?.pid
}

/**
 * The lock's pid and run, while that pid is a live process of ours that started no later than the
 * lock was written: a lock left by a crash can name a pid the OS has since given to something else.
 */
async function holder(file: string): Promise<{ pid: number; runId: string } | undefined> {
  const written = await stat(file).then(
    (s) => s.mtimeMs,
    () => undefined,
  )
  const [first, runId = ''] = (await readFile(file, 'utf8').catch(() => '')).split(' ')
  const pid = Number(first)
  if (written === undefined || !pid || !alive(pid)) return undefined
  const started = await startOf(pid)
  return started === undefined || started <= written ? { pid, runId } : undefined
}

/** When a process started, to the second, from `ps`; undefined when `ps` can't say. */
async function startOf(pid: number): Promise<number | undefined> {
  const { stdout } = await promisify(execFile)('ps', ['-o', 'lstart=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' },
  }).catch(() => ({ stdout: '' }))
  const started = Date.parse(stdout.trim())
  return Number.isNaN(started) ? undefined : started
}

async function releaseIfOurs(file: string, content: string): Promise<void> {
  if ((await readFile(file, 'utf8').catch(() => '')) === content) await rm(file, { force: true })
}

/** Whether `pid` is a live process we may signal; another user's, such as root's, is never ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
