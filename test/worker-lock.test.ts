import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { holdingWorker, isolate } from '#core/isolation'

afterEach(() => isolate(undefined))

const lockPath = async () => join(await mkdtemp(join(tmpdir(), 'awaywork-wlock-')), 'worker.lock')

describe('holdingWorker', () => {
  it('takes no lock unless launches run as the worker user', async () => {
    const file = await lockPath()
    await holdingWorker(
      async () => expect(existsSync(file)).toBe(false),
      () => {},
      file,
    )
  })

  it('holds the lock for the whole unit and frees it after', async () => {
    isolate('awaywork')
    const file = await lockPath()
    await holdingWorker(
      async () => expect(existsSync(file)).toBe(true),
      () => {},
      file,
    )
    expect(existsSync(file)).toBe(false)
  })

  it('frees the lock when the unit throws', async () => {
    isolate('awaywork')
    const file = await lockPath()
    await expect(
      holdingWorker(
        () => Promise.reject(new Error('boom')),
        () => {},
        file,
      ),
    ).rejects.toThrow('boom')
    expect(existsSync(file)).toBe(false)
  })

  it('makes a second unit wait for the first, saying so', async () => {
    isolate('awaywork')
    const file = await lockPath()
    const order: string[] = []
    const waits: string[] = []
    let finish = () => {}
    const first = holdingWorker(
      () =>
        new Promise<void>((done) => {
          finish = () => {
            order.push('first')
            done()
          }
        }),
      () => {},
      file,
    )
    await new Promise((r) => setTimeout(r, 100))
    const second = holdingWorker(
      async () => void order.push('second'),
      (line) => waits.push(line),
      file,
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(order).toEqual([])
    expect(waits).toEqual([`worker user: waiting for pid ${process.pid}, which holds ${file}`])
    finish()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('takes over a lock whose holder is dead', async () => {
    isolate('awaywork')
    const file = await lockPath()
    await writeFile(file, (await execa('node', ['-e', 'console.log(process.pid)'])).stdout)
    let ran = false
    await holdingWorker(
      async () => {
        ran = true
      },
      () => {},
      file,
    )
    expect(ran).toBe(true)
  })
})
