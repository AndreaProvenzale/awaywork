import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { clearApprovals, withApprovals } from '../src/core/approvals.js'
import { fieldValue } from '../src/core/queue.js'
import type { RunReport } from '../src/core/report.js'
import type { Item } from '../src/core/types.js'

const item = (source: string, key: string) => ({ source, key, fields: {} }) as unknown as Item

describe('approve', () => {
  it('records an approval by source:key and refuses a bad key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'approvals.json')
    const at = new Date('2026-10-01T12:00:00Z')
    expect(await approveItem('github:acme/api#5', ['github'], path, at)).toBe(
      'github:acme/api#5 is approved until a unit on it finishes',
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      'github:acme/api#5': { at: '2026-10-01T12:00:00.000Z' },
    })
    await expect(approveItem('acme/api#5', ['github'], path)).rejects.toThrow('source:key')
    await expect(approveItem('jira:X-1', ['github'], path)).rejects.toThrow('not configured')
  })

  it('sets the `approved` field on approved items only', () => {
    const items = withApprovals([item('github', 'a#1'), item('github', 'a#2')], {
      'github:a#1': { at: 'now' },
    })
    expect(items.map((i) => fieldValue(i, 'approved'))).toEqual([true, false])
  })

  it('clears the approval of items a unit finished on', () => {
    const results = [
      { status: 'done', planned: { unit: { items: [item('github', 'a#1')] } } },
      { status: 'error', planned: { unit: { items: [item('github', 'a#2')] } } },
    ]
    const approvals = { 'github:a#1': { at: 'x' }, 'github:a#2': { at: 'x' } }
    expect(clearApprovals(approvals, { results } as unknown as RunReport)).toEqual({
      'github:a#2': { at: 'x' },
    })
  })
})
