import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Attempts, recordAttempts } from '../src/core/attempts.js'
import { formatReport } from '../src/core/report.js'
import type { Item, Provider } from '../src/core/types.js'
import { yours } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { asker, finishedRun } from './fakes/units.js'

describe('a one-off --skill unit', () => {
  const noRule = '  - { skill: fix, where: { type: pr } }'
  const run = (provider: Provider, items: Item[], skill = 'implement') =>
    finishedRun(noRule, items, provider, undefined, undefined, undefined, {
      named: items[0]?.key ?? '',
      skill,
    })

  it('asks in the report only, and posts nothing on your item', async () => {
    const { report, writes, lines } = await run(asker('Which?'), [yours(1)])
    expect(writes).toEqual([])
    expect(report.results[0]?.questions).toEqual({
      step: 'acme-api-1',
      text: 'Which?',
      unposted: 'acme/api#1 ran with --skill, which posts nothing on the item',
    })
    expect(formatReport(report)).toContain(
      'questions not posted: acme/api#1 ran with --skill, which posts nothing on the item\n\nWhich?',
    )
    expect(lines.join('\n')).not.toContain('posted on')
  })

  it('opens only a draft PR on a new away/ branch, and writes nothing on your item', async () => {
    const { report, writes, opened } = await run(asker('', true), [yours(1)])
    expect(writes).toEqual([])
    expect(opened).toHaveLength(1)
    expect(opened[0]?.head).toBe('away/acme-api-1')
    expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr' })
    expect(report.results[0]?.outcome).not.toMatchObject({ ready: true })
  })

  it('records no attempt, leaving what a rule left on the item', async () => {
    const prior: Attempts = {
      'github:acme/api#1': { runId: 'r0', skill: 'fix', updated: 'x', failed: 2, failedAt: 'y' },
    }
    const { report } = await run(asker('', true), [yours(1)], 'fix')
    expect(recordAttempts(prior, report)).toEqual(prior)
    const left = await run(asker('', true), [yours(1)])
    expect(recordAttempts({}, left.report)).toEqual({})
  })

  it('leaves a draft that said continue to you, promising no later run', async () => {
    const { report, writes, opened } = await run(asker('', true, 'continue'), [yours(1)])
    const url = report.results[0]?.outcome?.kind === 'pr' ? report.results[0].outcome.url : ''
    expect(writes).toEqual([])
    expect(opened[0]?.body).not.toContain('Status:')
    expect(opened[0]?.body).not.toContain('next window run')
    expect(opened[0]?.left).toBeUndefined()
    expect(report.results[0]?.byHand).toBe(
      `ran with --skill, no later run goes on with it: finish ${url} by hand`,
    )
    expect(formatReport(report)).toContain(report.results[0]?.byHand as string)
  })

  it('leaves a draft that asked to you, its questions in the report', async () => {
    const { report, writes, opened } = await run(asker('Which?', true, 'ask'), [yours(1)])
    const url = report.results[0]?.outcome?.kind === 'pr' ? report.results[0].outcome.url : ''
    expect(writes).toEqual([])
    expect(opened[0]?.body).not.toContain('Status:')
    expect(opened[0]?.left).toBeUndefined()
    expect(report.results[0]?.questions?.unposted).toBe(
      `ran with --skill, no later run goes on with it: finish ${url} by hand`,
    )
  })

  it("says a report's continue is yours to finish", async () => {
    const reporter: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        await writeFile(join(job.dir, '.away/out/report.md'), 'Half of it.')
        await writeFile(join(job.dir, '.away/out/status'), 'continue')
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    const { report, writes } = await run(reporter, [yours(1)], 'review')
    expect(writes).toEqual([])
    expect(report.results[0]?.byHand).toBe(
      'ran with --skill, no later run goes on with it: finish it by hand',
    )
  })

  it("keeps a task's report in the report, not on its card", async () => {
    const card = yours(5)
    const task = {
      ...yours(6),
      key: 'acme/api#5/api',
      task: { id: 'api', parent: card, plan: [{ id: 'api', title: 'API', after: {} }] },
    }
    const reporter: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        await writeFile(join(job.dir, '.away/out/report.md'), 'Looked.')
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    const { report, writes } = await run(reporter, [task as Item], 'review')
    expect(writes).toEqual([])
    expect(report.results[0]?.outcome).toMatchObject({ kind: 'report', text: 'Looked.' })
    expect(report.results[0]?.result).toEqual([])
  })
})
