import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type RunLock = { release: () => Promise<void> } | { pid: number; runId: string }

/** Takes the lock file for this run, or says who holds it; a lock whose pid is dead is taken over. Two runs starting together can still both win. */
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
    const [pid, heldBy = ''] = (await readFile(file, 'utf8').catch(() => '')).split(' ')
    if (Number(pid) && alive(Number(pid))) return { pid: Number(pid), runId: heldBy }
    await rm(file, { force: true })
  }
}

async function releaseIfOurs(file: string, content: string): Promise<void> {
  if ((await readFile(file, 'utf8').catch(() => '')) === content) await rm(file, { force: true })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
