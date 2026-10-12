import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planRun } from '../src/core/foreman.js'
import type { RunReport } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Ctx, Quota } from '../src/core/types.js'
import { type CommandConfig, commandSource } from '../src/sources/command.js'

const dir = fileURLToPath(new URL('fixtures/chores', import.meta.url))
const now = Date.UTC(2026, 0, 1, 1)
const quota: Quota = {
  windows: [{ name: 'seven_day', span: 'long', used: 0, resetsAt: now / 1000 + 60 * 3600 }],
}

const yaml = JSON.stringify({
  providers: [{ claude: {} }],
  sources: {
    chores: { command: 'node chores.mjs', fields: ['chore'] },
  },
  queue: [
    { skill: 'implement', source: 'chores', where: { chore: 'tests' }, when: { headroom: '20%' } },
  ],
})

async function planOn(date: string, attempts = {}) {
  const config = parseConfig(yaml)
  const source = { ...(config.sources.chores as CommandConfig), dir }
  const ctx: Ctx = { env: { ...process.env, CHORE_NOW: date }, log: () => {} }
  const items = await commandSource('chores', source).items(source, ctx)
  const allowances = { claude: allowance(config.budget, quota, now, config.windows) }
  return planRun({ config, items, allowances, skills: { builtin: builtinSkills }, attempts })
}

describe('chores from a custom source', () => {
  it('queues one unit per chore and repo the rule matches', async () => {
    const plan = await planOn('2026-01-07')
    expect(plan.units.map((u) => [u.unit.id, u.unit.skill])).toEqual([
      ['chore-tests-acme-api', 'implement'],
      ['chore-tests-acme-web', 'implement'],
    ])
    expect(plan.skipped.map((s) => s.item.key)).toEqual([
      'chore-todos-acme-api',
      'chore-todos-acme-web',
    ])
  })

  it('does not redo a chore within its week, and offers it again the next', async () => {
    const first = await planOn('2026-01-07')
    const results = first.units.map((planned) => ({ planned, status: 'done' }))
    const attempts = recordAttempts({}, { runId: 'r1', plan: first, results } as RunReport)

    const sameWeek = await planOn('2026-01-09', attempts)
    expect(sameWeek.units).toEqual([])
    expect(sameWeek.skipped.map((s) => s.reason)).toContain('unchanged since run r1')

    const nextWeek = await planOn('2026-01-14', attempts)
    expect(nextWeek.units).toHaveLength(2)
  })
})
