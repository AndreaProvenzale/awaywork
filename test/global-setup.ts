import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** Every temp file of the run, its tests' and the code's they spawn, goes in one folder, removed when the run ends. */
export default async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-tests-'))
  process.env.TMPDIR = dir
  return async () => {
    // Some tests leave read-only folders behind.
    await promisify(execFile)('chmod', ['-R', 'u+rwX', dir]).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}
