import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { lockHolder, takeRunLock } from '../src/core/run-lock.js'

const file = join(await mkdtemp(join(tmpdir(), 'awaywork-runlock-')), 'run.lock')

describe('takeRunLock', () => {
  it('refuses while a live run holds it, takes over a dead one, and frees on release', async () => {
    const first = await takeRunLock(file, 'run-a')
    expect(await readFile(file, 'utf8')).toBe(`${process.pid} run-a`)
    expect(await takeRunLock(file, 'run-b')).toEqual({ pid: process.pid, runId: 'run-a' })
    if ('release' in first) await first.release()

    const dead = await execa('node', ['-e', 'console.log(process.pid)'])
    await writeFile(file, `${dead.stdout} run-old`)
    const taken = await takeRunLock(file, 'run-c')
    expect('release' in taken).toBe(true)
    if ('release' in taken) await taken.release()
    expect('release' in (await takeRunLock(file, 'run-d'))).toBe(true)
  })

  it('takes over an empty lock file and leaves a lock that is not ours on release', async () => {
    await writeFile(file, '')
    const taken = await takeRunLock(file, 'run-e')
    expect('release' in taken).toBe(true)
    await writeFile(file, '1 run-other')
    if ('release' in taken) await taken.release()
    expect(await readFile(file, 'utf8')).toBe('1 run-other')
  })

  it("doesn't count a pid given to another process since the lock was written, or another user's", async () => {
    const reused = execa('sleep', ['30'], { reject: false })
    await writeFile(file, `${reused.pid} run-old`)
    const before = new Date(Date.now() - 3_600_000)
    await utimes(file, before, before)
    try {
      expect(await lockHolder(file)).toBeUndefined()
      const taken = await takeRunLock(file, 'run-f')
      expect('release' in taken).toBe(true)
      if ('release' in taken) await taken.release()
    } finally {
      reused.kill()
      await reused
    }
    if (process.getuid?.() === 0) return
    await writeFile(file, '1 run-root')
    expect(await lockHolder(file)).toBeUndefined()
  })
})
