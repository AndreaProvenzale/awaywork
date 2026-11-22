import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function remove(dir: string) {
  // Some tests leave read-only folders behind.
  await promisify(execFile)('chmod', ['-R', 'u+rwX', dir]).catch(() => {})
  await rm(dir, { recursive: true, force: true })
}

/** Every temp file of the run, its tests' and the code's they spawn, goes in one folder, removed when the run ends. */
export default async function setup() {
  const parent = tmpdir()
  // Best effort: a dead run's folder may be undeletable or still being written.
  for (const name of await readdir(parent).catch(() => [])) {
    const pid = Number(/^awaywork-tests-(\d+)-/.exec(name)?.[1])
    if (pid && !isAlive(pid)) await remove(join(parent, name)).catch(() => {})
  }
  const previous = process.env.TMPDIR
  const dir = await mkdtemp(join(parent, `awaywork-tests-${process.pid}-`))
  process.env.TMPDIR = dir
  return async () => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    await remove(dir)
  }
}
