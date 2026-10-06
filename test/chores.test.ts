import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectItems } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planNight } from '../src/core/foreman.js'
import type { NightReport } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Ctx, Quota } from '../src/core/types.js'

const dir = fileURLToPath(new URL('fixtures/chores', import.meta.url))
const now = Date.UTC(2026, 0, 1, 1)
const quota = (used: number): Quota => ({
  windows: [{ name: 'seven_day', span: 'long', used, resetsAt: now / 1000 + 60 * 3600 }],
})

const yaml = JSON.stringify({
  providers: [{ claude: {} }],
  sources: {
    chores: { command: 'node chores.mjs', fields: ['chore'] },
  },
  queue: [
    { skill: 'implement', source: 'chores', where: { chore: 'tests' }, when: { headroom: '20%' } },
  ],
})

async function night(date: string, attempts = {}) {
  const config = parseConfig(yaml)
  const source = config.sources.chores as { dir?: string }
  source.dir = dir
  const ctx: Ctx = { env: { ...process.env, CHORE_NOW: date }, log: () => {} }
  const items = await collectItems(config, ctx)
  const allowances = { claude: allowance(config.providers[0]?.budget, quota(0), now) }
  return planNight({ config, items, allowances, skills: { builtin: builtinSkills }, attempts })
}

describe('chores from a custom source', () => {
  it('queues one unit per chore and repo the rule matches', async () => {
    const plan = await night('2026-01-07')
    expect(plan.units.map((u) => [u.unit.id, u.unit.skill])).toEqual([
      ['chore-tests-acme-api', 'implement'],
      ['chore-tests-acme-web', 'implement'],
    ])
    expect(plan.skipped.map((s) => s.item.key)).toEqual([
      'chore-todos-acme/api',
      'chore-todos-acme/web',
    ])
  })

  it('does not redo a chore within its week, and offers it again the next', async () => {
    const first = await night('2026-01-07')
    const results = first.units.map((planned) => ({ planned, status: 'done' }))
    const attempts = recordAttempts({}, { runId: 'r1', plan: first, results } as NightReport)

    const sameWeek = await night('2026-01-09', attempts)
    expect(sameWeek.units).toEqual([])
    expect(sameWeek.skipped.map((s) => s.reason)).toContain('unchanged since run r1')

    const nextWeek = await night('2026-01-14', attempts)
    expect(nextWeek.units).toHaveLength(2)
  })
})
