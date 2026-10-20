import { parseConfig } from '../../src/config/load.js'
import { allowance } from '../../src/core/budget.js'
import { type PlannedUnit, planRun } from '../../src/core/foreman.js'
import type { RunReport } from '../../src/core/report.js'
import { builtinSkills } from '../../src/core/skills.js'
import { asanaTask, githubPr } from './items.js'

/** An acme plan: one unit, one over the cap, one matching no rule and a task with no repo. */
export function acmePlan() {
  const config = parseConfig(`
limits: { units: 1 }
providers: [claude: {}]
sources: { github: { repos: [acme/api] } }
queue:
  - { skill: fix, where: { checks: failing } }
  - { skill: implement, where: { type: task } }
`)
  return planRun({
    config,
    items: [
      githubPr(1, { checks: 'failing' }),
      githubPr(2, { checks: 'failing' }),
      githubPr(3),
      asanaTask(4),
    ],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
}

/** A run of the acme plan: a draft PR, with its summary and files. */
export function acmeRun(): RunReport {
  const plan = acmePlan()
  return {
    runId: '20261019-220000',
    dryRun: false,
    startedAt: new Date(2026, 9, 19, 22, 0, 0),
    finishedAt: new Date(2026, 9, 19, 22, 41, 7),
    plan,
    results: [
      {
        planned: plan.units[0] as PlannedUnit,
        provider: 'claude',
        status: 'done',
        turns: 12,
        outcome: { kind: 'pr', url: 'https://github.com/acme/api/pull/9', commits: 2, head: 'a' },
        summary: 'Retries the flaky upload test instead of sleeping.',
        files: {
          log: 'units/acme-api-1/1-fix/worker.log',
          sliceBody: 'units/acme-api-1/out/pr.md',
        },
      },
    ],
    quotas: {},
  }
}
