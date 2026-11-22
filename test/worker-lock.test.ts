import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdingWorker, useMode } from '#core/isolation/index'
import { none } from '#core/isolation/none'
import { WORKER_LOCK as file, userMode } from '#core/isolation/user'

vi.mock('#config/paths', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  return {
    ...(await original<typeof import('#config/paths')>()),
    rootStateDir: await mkdtemp(`${tmpdir()}/awaywork-root-state-`),
  }
})

afterEach(async () => {
  useMode(none)
  await rm(file, { force: true })
})

describe('holdingWorker', () => {
  it('takes no lock unless launches run as the worker user', async () => {
    await holdingWorker(
      async () => expect(existsSync(file)).toBe(false),
      () => {},
    )
  })

  it('holds the lock for the whole unit and frees it after', async () => {
    useMode(userMode('awaywork'))
    await holdingWorker(
      async () => expect(existsSync(file)).toBe(true),
      () => {},
    )
    expect(existsSync(file)).toBe(false)
  })

  it('frees the lock when the unit throws', async () => {
    useMode(userMode('awaywork'))
    await expect(
      holdingWorker(
        () => Promise.reject(new Error('boom')),
        () => {},
      ),
    ).rejects.toThrow('boom')
    expect(existsSync(file)).toBe(false)
  })

  it('makes a second unit wait for the first, saying so', async () => {
    useMode(userMode('awaywork'))
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
    )
    await new Promise((r) => setTimeout(r, 100))
    const second = holdingWorker(
      async () => void order.push('second'),
      (line) => waits.push(line),
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(order).toEqual([])
    expect(waits).toEqual([`worker user: waiting for pid ${process.pid}, which holds ${file}`])
    finish()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })

  it('takes over a lock whose holder is dead', async () => {
    useMode(userMode('awaywork'))
    await writeFile(file, (await execa('node', ['-e', 'console.log(process.pid)'])).stdout)
    let ran = false
    await holdingWorker(
      async () => {
        ran = true
      },
      () => {},
    )
    expect(ran).toBe(true)
  })

  it('stops waiting when the signal aborts, and never runs the unit', async () => {
    useMode(userMode('awaywork'))
    await writeFile(file, String(process.pid))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 100)
    let ran = false
    const result = await holdingWorker(
      async () => {
        ran = true
      },
      () => {},
      { signal: abort.signal },
    )
    expect(result).toBeUndefined()
    expect(ran).toBe(false)
    expect(existsSync(file)).toBe(true)
  })
})
