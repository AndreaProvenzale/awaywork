import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pause, resume } from '#cli/commands/pause'
import { pausedUntil } from '#plan/pause'

const now = new Date('2026-10-01T12:00').getTime()
const statePath = async () => join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'pause.json')

describe('pause', () => {
  it('pauses until a date and resumes', async () => {
    const path = await statePath()
    expect(await pausedUntil(path, now)).toBeUndefined()
    expect(await resume(path, now)).toBe('Scheduled runs are not paused')
    expect(await pause('2026-10-05', path, now)).toBe(
      'Scheduled runs paused until 2026-10-05; awaywork resume to undo',
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ until: '2026-10-05' })
    expect(await pausedUntil(path, now)).toBe('2026-10-05')
    expect(await resume(path, now)).toBe('Resumed; scheduled runs were paused until 2026-10-05')
    expect(await pausedUntil(path, now)).toBeUndefined()
  })

  it('counts a pause past its date as none', async () => {
    const path = await statePath()
    await pause('2026-10-05', path, now)
    expect(await pausedUntil(path, new Date('2026-10-05T00:00').getTime())).toBeUndefined()
    expect(await resume(path, new Date('2026-10-06T00:00').getTime())).toBe(
      'Scheduled runs are not paused',
    )
  })

  it('refuses a past or invalid date', async () => {
    const path = await statePath()
    for (const until of ['2026-10-01', '2026-02-30', 'tomorrow'])
      await expect(pause(until, path, now)).rejects.toThrow(
        `--until ${until} is not a future date (YYYY-MM-DD)`,
      )
    expect(await pausedUntil(path, now)).toBeUndefined()
  })
})
