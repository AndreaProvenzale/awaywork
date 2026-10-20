import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { clearApprovals, withApprovals } from '../src/core/approvals.js'
import { fieldValue } from '../src/core/queue.js'
import type { RunReport } from '../src/core/report.js'
import type { Item } from '../src/core/types.js'

const item = (source: string, key: string, approved = false) =>
  ({ source, key, fields: { approved } }) as unknown as Item

describe('approve', () => {
  it('records an approval by source:key and refuses a bad key', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'awaywork-')), 'approvals.json')
    expect(await approveItem('github:acme/api#5', ['github'], path)).toBe(
      'github:acme/api#5 is approved until a unit on it finishes',
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'github:acme/api#5': true })
    await expect(approveItem('acme/api#5', ['github'], path)).rejects.toThrow('source:key')
    await expect(approveItem('jira:X-1', ['github'], path)).rejects.toThrow('not configured')
  })

  it('sets the `approved` field on approved items only', () => {
    const items = withApprovals([item('github', 'a#1'), item('github', 'a#2')], {
      'github:a#1': true,
    })
    expect(items.map((i) => fieldValue(i, 'approved'))).toEqual([true, false])
  })

  // A run with one chain per item, from its steps' results.
  const run = (...chains: [key: string, approved: boolean, ...steps: object[]][]) => {
    const units: object[] = []
    const results: object[] = []
    for (const [key, approved, ...steps] of chains) {
      const items = [item('github', key, approved)]
      steps.forEach((step, n) => {
        const planned = { unit: { id: `${key}-${n}`, items }, ...(n > 0 && { chain: `${key}-0` }) }
        units.push(planned)
        results.push({ planned, ...step })
      })
    }
    return { plan: { units }, results } as unknown as RunReport
  }
  const approvals: Record<string, true> = { 'github:a#1': true, 'github:a#2': true }
  const done = { status: 'done' }

  it('clears the approval of items a chain finished on, not one a later step failed', () => {
    const report = run(['a#1', true, done, done], ['a#2', true, done, { status: 'failed' }])
    expect(clearApprovals(approvals, report)).toEqual({ 'github:a#2': true })
  })

  it('clears it when a failed step finished on its retry', () => {
    const report = run(['a#1', true, done, { status: 'failed', retried: true }, done])
    expect(clearApprovals(approvals, report)).toEqual({ 'github:a#2': true })
  })

  it('keeps an approval given after the run was planned', () => {
    expect(clearApprovals(approvals, run(['a#1', false, done, done]))).toEqual(approvals)
  })
})
