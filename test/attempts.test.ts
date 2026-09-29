import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import {
  type Attempts,
  failedAttempts,
  itemVersion,
  loadAttempts,
  recordAttempts,
  saveAttempts,
} from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import type { UnitResult } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item } from '../src/core/types.js'
import { fakeItem, githubPr } from './fakes/items.js'

const config = parseConfig(
  'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\nqueue: [{ skill: fix-ci }]',
)
const plan = (items: Item[], attempts: Attempts) =>
  planNight({
    config,
    items,
    allowances: { claude: allowance(config.budget, null, 0) },
    skills: { builtin: builtinSkills },
    attempts,
  })

it('gives up on an item after three failed attempts, until it changes', () => {
  const pr = githubPr(1, { updated: '2026-01-01T00:00:00Z' })
  const failed = (p: ReturnType<typeof plan>): UnitResult[] =>
    p.units.map((planned) => ({
      planned,
      status: 'failed',
      outcome: { kind: 'none', reason: 'no commits' },
    }))

  let attempts: Attempts = {}
  for (let night = 1; night <= 3; night++) {
    const p = plan([pr], attempts)
    expect(p.units).toHaveLength(1)
    attempts = recordAttempts(attempts, failed(p))
  }
  expect(failedAttempts(attempts, pr)).toBe(3)
  const gaveUp = plan([pr], attempts)
  expect(gaveUp.units).toEqual([])
  expect(gaveUp.skipped.map((s) => s.reason)).toEqual([
    'gave up after 3 attempts; waiting for the item to change',
  ])

  const changed = githubPr(1, { updated: '2026-01-02T00:00:00Z' })
  expect(plan([changed], attempts).units).toHaveLength(1)
  expect(failedAttempts(recordAttempts(attempts, failed(plan([changed], attempts))), changed)).toBe(
    1,
  )
})

it('clears attempts on a delivery and ignores units that did not run', () => {
  const pr = githubPr(1)
  const [planned] = plan([pr], {}).units
  if (!planned) throw new Error('no unit')
  const start = { [`github ${pr.key}`]: { version: itemVersion(pr), failed: 2 } }
  const after = (r: Omit<UnitResult, 'planned'>) =>
    failedAttempts(recordAttempts(start, [{ planned, ...r }]), pr)

  expect(after({ status: 'done', outcome: { kind: 'pr', url: 'u', commits: 1 } })).toBe(0)
  expect(after({ status: 'stopped: night ended', outcome: { kind: 'report', text: 'ok' } })).toBe(0)
  expect(after({ status: 'error', reason: 'clone failed' })).toBe(3)
  expect(after({ status: 'stopped: quota', outcome: { kind: 'none', reason: 'no commits' } })).toBe(
    3,
  )
  expect(after({ status: 'skipped', reason: 'interrupted' })).toBe(2)
  expect(after({ status: 'prepared' })).toBe(2)
  expect(after({ status: 'stopped: aborted' })).toBe(2)
})

it('versions an item without an updated time by its content', () => {
  const item = fakeItem()
  expect(itemVersion(fakeItem())).toBe(itemVersion(item))
  const commented = fakeItem({ comments: [{ author: 'a', body: 'try again', at: 'now' }] })
  expect(itemVersion(commented)).not.toBe(itemVersion(item))
})

it('saves and loads attempts, empty when there is no file', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'nightshift-attempts-')), 'state/attempts.json')
  expect(await loadAttempts(file)).toEqual({})
  await saveAttempts(file, { 'github acme/api#1': { version: 'v', failed: 1 } })
  expect(await loadAttempts(file)).toEqual({ 'github acme/api#1': { version: 'v', failed: 1 } })
})
