import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** Waits until no other live process holds the lock file, then takes it; on abort it stops waiting and returns a release that does nothing. */
export async function lock(
  file: string,
  onWait: (line: string) => void,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  await mkdir(dirname(file), { recursive: true })
  for (let waited = false; ; waited = true) {
    if (signal?.aborted) return async () => {}
    try {
      await writeFile(file, String(process.pid), { flag: 'wx' })
      return () => rm(file, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    const pid = Number(await readFile(file, 'utf8').catch(() => ''))
    if (pid && !alive(pid)) {
      await rm(file, { force: true })
      continue
    }
    if (!waited) onWait(`waiting for pid ${pid}, which holds ${file}`)
    await sleep(1000, undefined, { signal }).catch(() => {})
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
