import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attemptsPath, runLockPath, runsDir } from '../src/config/paths.js'
import { pruneRuns } from '../src/core/retention.js'

vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    runsDir: `${state}/runs`,
    attemptsPath: `${state}/attempts.json`,
    runLockPath: `${state}/run.lock`,
  }
})

const now = new Date('2026-10-25T12:00:00Z')

async function makeRun(id: string, bytes = 10) {
  await mkdir(join(runsDir, id, 'units'), { recursive: true })
  await writeFile(join(runsDir, id, 'units', 'worker.log'), 'x'.repeat(bytes))
}

describe('pruneRuns', () => {
  beforeEach(async () => {
    await rm(runsDir, { recursive: true, force: true })
    await rm(attemptsPath, { force: true })
    await rm(runLockPath, { force: true })
  })

  it('removes runs older than keep_runs and keeps the young ones', async () => {
    await makeRun('20260920-120000', 100)
    await makeRun('20260925-115959', 50)
    await makeRun('20260925-120001')
    await makeRun('20261025-110000')
    expect(await pruneRuns({ keep_runs: '30d' }, now)).toEqual({
      removed: 2,
      bytes: 150,
      failures: [],
    })
    expect((await readdir(runsDir)).sort()).toEqual(['20260925-120001', '20261025-110000'])
  })

  it('keeps the runs attempts.json reads a report from and the one holding the run lock', async () => {
    await makeRun('20260101-000000')
    await makeRun('20260102-000000')
    await makeRun('20260103-000000')
    await makeRun('20260104-000000')
    await writeFile(
      attemptsPath,
      JSON.stringify({
        'github:acme/api#1': {
          runId: '20260102-000000',
          skill: 'review',
          updated: '',
          report: {
            runId: '20260103-000000',
            unit: 'acme-api-1',
            step: '1-review',
            skill: 'review',
          },
        },
      }),
    )
    await writeFile(runLockPath, `${process.pid} 20260104-000000`)
    expect((await pruneRuns({ keep_runs: '1d' }, now)).removed).toBe(2)
    expect((await readdir(runsDir)).sort()).toEqual(['20260103-000000', '20260104-000000'])
  })

  it('leaves anything not named like a run, and tolerates a missing runs dir', async () => {
    expect(await pruneRuns({ keep_runs: '30d' }, now)).toEqual({
      removed: 0,
      bytes: 0,
      failures: [],
    })
    await makeRun('notes')
    await makeRun('2026-01-01')
    await makeRun('.mount-check-abc')
    expect((await pruneRuns({ keep_runs: '0d' }, now)).removed).toBe(0)
    expect(existsSync(join(runsDir, 'notes'))).toBe(true)
    expect((await readdir(runsDir)).length).toBe(3)
  })

  it('reports a dir it cannot remove instead of throwing', async () => {
    await makeRun('20260101-000000')
    await chmod(join(runsDir, '20260101-000000', 'units'), 0o500)
    try {
      const pruned = await pruneRuns({ keep_runs: '1d' }, now)
      expect(pruned.removed).toBe(0)
      expect(pruned.failures).toEqual([
        expect.stringContaining(`couldn't remove old run ${join(runsDir, '20260101-000000')}`),
      ])
    } finally {
      await chmod(join(runsDir, '20260101-000000', 'units'), 0o700)
    }
  })
})
