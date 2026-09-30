import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSkips, skipItem, unskipItem } from '../src/cli/skip.js'
import { activeSkips, untilTime } from '../src/core/skips.js'

const now = new Date('2026-10-01T12:00').getTime()
const statePath = async () => join(await mkdtemp(join(tmpdir(), 'nightshift-')), 'skips.json')

describe('skip', () => {
  it('records, lists and undoes skips by source:key', async () => {
    const path = await statePath()
    expect(await listSkips(path, now)).toBe('No item is skipped')
    expect(
      await skipItem('github:acme/api#5', { until: '2026-10-05', reason: 'flaky' }, path, now),
    ).toBe('skipped with nightshift skip github:acme/api#5 until 2026-10-05: flaky')
    await skipItem('asana:T-7', {}, path, now)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      'github:acme/api#5': { until: '2026-10-05', reason: 'flaky' },
      'asana:T-7': {},
    })
    expect(await listSkips(path, now)).toBe(
      'skipped with nightshift skip github:acme/api#5 until 2026-10-05: flaky\nskipped with nightshift skip asana:T-7',
    )
    expect(await unskipItem('asana:T-7', path)).toBe('asana:T-7 is no longer skipped')
    expect(await unskipItem('asana:T-7', path)).toBe('asana:T-7 is not skipped')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      'github:acme/api#5': { until: '2026-10-05', reason: 'flaky' },
    })
  })

  it('refuses a key without a known source', async () => {
    const path = await statePath()
    for (const key of ['acme/api#5', 'trello:ENG-12', 'github:'])
      await expect(skipItem(key, {}, path, now)).rejects.toThrow('name the item as source:key')
    await expect(unskipItem('T-7', path)).rejects.toThrow('name the item as source:key')
  })

  it('refuses an --until that is not a future date', async () => {
    const path = await statePath()
    for (const until of ['2026-10-01', '2026-09-30', 'next week', '2026-13-01', '2027-02-30'])
      await expect(skipItem('asana:T-7', { until }, path, now)).rejects.toThrow(
        `--until ${until} is not a future date`,
      )
  })

  it('ends a skip when its until day starts', () => {
    const skips = { a: { until: '2026-10-02' }, b: {} }
    expect(Object.keys(activeSkips(skips, now))).toEqual(['a', 'b'])
    expect(Object.keys(activeSkips(skips, untilTime('2026-10-02') ?? 0))).toEqual(['b'])
  })

  it('reads only dates that exist', () => {
    expect(untilTime('2028-02-29')).toBe(new Date('2028-02-29T00:00').getTime())
    for (const until of ['2026-02-30', '2026-04-31', '2027-02-29', '2026-1-05', ''])
      expect(untilTime(until)).toBeUndefined()
  })
})
