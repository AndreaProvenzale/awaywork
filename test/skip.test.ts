import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSkips, skipItem, unskipItem } from '../src/cli/skip.js'
import { activeSkips, untilTime } from '../src/core/skips.js'

const now = new Date('2026-10-01T12:00').getTime()
const statePath = async () => join(await mkdtemp(join(tmpdir(), 'nightshift-')), 'attempts.json')

describe('skip', () => {
  it('records, lists and undoes skips next to the attempts', async () => {
    const path = await statePath()
    const attempt = { 'github:acme/api#5': { runId: 'r1', skill: 'fix-ci', updated: 'u1' } }
    await writeFile(path, JSON.stringify(attempt))
    expect(await listSkips(path, now)).toBe('No item is skipped')
    expect(await skipItem('acme/api#5', { until: '2026-10-05', reason: 'flaky' }, path, now)).toBe(
      'skipped with nightshift skip acme/api#5 until 2026-10-05: flaky',
    )
    await skipItem('T-7', {}, path, now)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ...attempt,
      'acme/api#5': { skip: { until: '2026-10-05', reason: 'flaky' } },
      'T-7': { skip: {} },
    })
    expect(await listSkips(path, now)).toBe(
      'skipped with nightshift skip acme/api#5 until 2026-10-05: flaky\nskipped with nightshift skip T-7',
    )
    expect(await unskipItem('T-7', path)).toBe('T-7 is no longer skipped')
    expect(await unskipItem('T-7', path)).toBe('T-7 is not skipped')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ...attempt,
      'acme/api#5': { skip: { until: '2026-10-05', reason: 'flaky' } },
    })
  })

  it('refuses an --until that is not a future date', async () => {
    const path = await statePath()
    for (const until of ['2026-10-01', '2026-09-30', 'next week', '2026-13-01'])
      await expect(skipItem('T-7', { until }, path, now)).rejects.toThrow(
        `--until ${until} is not a future date`,
      )
  })

  it('ends a skip when its until day starts', () => {
    const state = { a: { skip: { until: '2026-10-02' } }, b: { skip: {} }, c: {} }
    expect(Object.keys(activeSkips(state, now))).toEqual(['a', 'b'])
    expect(Object.keys(activeSkips(state, untilTime('2026-10-02') ?? 0))).toEqual(['b'])
  })
})
