import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { formatPlan, formatRun, formatWhy } from '../src/cli/format.js'
import { linkPlanTasks } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { type Attempts, recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { taskMarkdown } from '../src/core/fanout.js'
import { approveReply, markComment, planComment } from '../src/core/footer.js'
import { planRun } from '../src/core/foreman.js'
import { checkPlan, planContract } from '../src/core/plan.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Provider, Source, TaskPr } from '../src/core/types.js'
import { prText } from '../src/forge/pr.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const configOf = (extra = '', rules = '') =>
  parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
${extra}queue:
  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true } }
${rules}`)
const config = configOf()

const chain = `tasks:
  - { id: api, title: VAT export endpoint }
  - { id: web, title: Export button, after: { api: opened } }
  - { id: docs, title: Document the export, after: { web: opened } }
`
const at = (n: number) => `2026-10-2${n}T00:00:00Z`
const card = (plan: string, taskPrs: Record<string, TaskPr> = {}): Item =>
  fakeItem({
    source: 'github',
    id: '1',
    key: 'acme/api#1',
    type: 'issue',
    title: 'VAT export',
    mine: true,
    comments: [
      { author: 'me', body: markComment(planComment('Three tasks.', plan)), at: at(1), mine: true },
      { author: 'me', body: approveReply(''), at: at(2), mine: true },
    ],
    fields: { repo: 'acme/api', updated: at(5) },
    taskPrs,
  })
const pr = (id: string, state: TaskPr['state'], number = 12): TaskPr => ({
  repo: 'acme/api',
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  branch: `away/acme-api-1-${id}`,
  ours: true,
  mine: true,
  trusted: true,
  fork: false,
  state,
})

const allowances = { claude: allowance(config.budget, null, 0, config.windows) }
const plan = (items: Item[], cfg = config, attempts: Attempts = {}) =>
  planRun({ config: cfg, items, allowances, skills: { builtin: builtinSkills }, attempts })
const shape = (p: ReturnType<typeof plan>) =>
  p.units.map((u) => [u.unit.id, u.unit.base, u.unit.stackedOn ?? '-', u.after ?? '-'])
const skips = (p: ReturnType<typeof plan>) =>
  p.skipped.filter((s) => s.item.task).map((s) => [s.item.key, s.kind, s.reason])

describe('after: opened in a plan', () => {
  const limits = { maxTasks: 8, repo: 'acme/api', skills: ['implement'] }
  const problem = (tasks: string) => {
    const checked = checkPlan(`tasks:\n${tasks}`, limits)
    return 'problem' in checked ? checked.problem : undefined
  }
  const schema = '  - { id: schema, title: S }\n'

  it('takes opened tasks on one chain, merged mixed in, and refuses two that are not', () => {
    expect(problem(chain.replace('tasks:\n', ''))).toBeUndefined()
    expect(
      problem(
        `${schema}  - { id: api, title: A, after: { schema: opened } }\n  - { id: web, title: W, after: { api: opened, schema: opened } }\n`,
      ),
    ).toBeUndefined()
    expect(
      problem(
        `${schema}  - { id: api, title: A, after: { schema: merged } }\n  - { id: web, title: W, after: { schema: opened, api: opened } }\n`,
      ),
    ).toBeUndefined()
    expect(
      problem(
        `${schema}  - { id: api, title: A }\n  - { id: web, title: W, after: { api: opened, schema: merged } }\n`,
      ),
    ).toBeUndefined()
    expect(
      problem(
        `${schema}  - { id: api, title: A }\n  - { id: web, title: W, after: { api: opened, schema: opened } }\n`,
      ),
    ).toBe(
      "task web: its opened tasks api, schema aren't on one chain: make each after the one before, e.g. schema after api: opened",
    )
  })

  it('tells the plan step what opened and merged mean, and the one-chain rule', () => {
    const text = planContract(limits)
    expect(text).toContain('a map from other task ids to `merged` or `opened`')
    expect(text).toContain("its PR stacks on that task's PR")
    expect(text).toContain("A task's `opened` tasks must lie on one chain")
  })
})

describe('the feature block', () => {
  it("runs a card's tasks back to back in the order they wait on each other, each stacking on the one before", () => {
    const cfg = parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
queue:
  - { skill: plan, deliver: plan, where: { label: feature } }
  - { skill: implement, where: { planned: true } }
  - { skill: implement, where: { label: bug } }
  - { skill: fix, where: { planned: true } }
`)
    const listed = `tasks:
  - { id: docs, title: Document the export, after: { web: opened } }
  - { id: web, title: Export button, skill: fix, after: { api: opened } }
  - { id: api, title: VAT export endpoint }
`
    const bug = fakeItem({
      source: 'github',
      id: '2',
      key: 'acme/api#2',
      type: 'issue',
      labels: ['bug'],
      fields: { repo: 'acme/api', label: ['bug'] },
    })
    const feature = card(listed)
    feature.fields.label = ['feature']
    const p = plan([feature, bug], cfg)
    expect(shape(p)).toEqual([
      ['acme-api-1-api', '', '-', '-'],
      ['acme-api-1-web', '', '-', 'acme-api-1-api'],
      ['acme-api-1-docs', '', '-', 'acme-api-1-web'],
      ['acme-api-2', '', '-', '-'],
    ])
    expect(formatPlan(p)).toContain('   after api, stacks on its PR')
    const web = p.units[1]?.unit.items[0] as Item
    expect(formatWhy(p, web)).toContain('  after api opened (no PR yet)')
    expect(formatWhy(p, web)).toContain('stack     after api, stacks on its PR')
    expect(taskMarkdown(web)).toContain('- `web`: Export button (this task), after api opened')
  })

  it("starts on a dependency's open PR, from the default branch once it merged, and waits for one that won't run", () => {
    const open = plan([card(chain, { api: pr('api', 'open') })])
    expect(shape(open)).toEqual([
      ['acme-api-1-web', 'away/acme-api-1-api', 'https://github.com/acme/api/pull/12', '-'],
      ['acme-api-1-docs', '', '-', 'acme-api-1-web'],
    ])
    expect(formatPlan(open)).toContain('   after api, stacks on #12')
    const web = open.units[0]?.unit.items[0] as Item
    expect(formatWhy(open, web)).toContain('  after api opened (PR #12 open)')

    const merged = plan([card(chain, { api: pr('api', 'merged') })])
    expect(shape(merged)).toEqual([
      ['acme-api-1-web', '', '-', '-'],
      ['acme-api-1-docs', '', '-', 'acme-api-1-web'],
    ])

    const stacked = plan([card(chain, { api: pr('api', 'merged', 11), web: pr('web', 'open') })])
    expect(shape(stacked)).toEqual([
      ['acme-api-1-docs', 'away/acme-api-1-web', 'https://github.com/acme/api/pull/12', '-'],
    ])

    const held = plan([card(chain)], configOf('', ''), {
      'github:acme/api#1/api': { runId: 'r1', skill: 'implement', updated: at(5) },
    })
    expect(shape(held)).toEqual([])
    expect(skips(held)).toEqual([
      ['acme/api#1/api', 'unchanged', 'unchanged since run r1'],
      ['acme/api#1/web', 'waiting_for_task', "waiting for task api's PR to open"],
      ['acme/api#1/docs', 'waiting_for_task', "waiting for task web's PR to open"],
    ])
  })

  it('stacks on the last opened task whose PR is not merged, and waits on merged ones first', () => {
    const tasks = `tasks:
  - { id: schema, title: S }
  - { id: api, title: A, after: { schema: opened } }
  - { id: web, title: W, after: { api: opened, schema: opened } }
`
    const p = plan([
      card(tasks, { schema: pr('schema', 'open', 10), api: pr('api', 'merged', 11) }),
    ])
    expect(shape(p)).toEqual([
      ['acme-api-1-web', 'away/acme-api-1-schema', 'https://github.com/acme/api/pull/10', '-'],
    ])
    const mixed = `tasks:
  - { id: schema, title: S }
  - { id: api, title: A }
  - { id: web, title: W, after: { api: opened, schema: merged } }
`
    const waits = plan([card(mixed, { schema: pr('schema', 'open', 10) })])
    expect(shape(waits)).toEqual([['acme-api-1-api', '', '-', '-']])
    expect(skips(waits)).toContainEqual([
      'acme/api#1/web',
      'waiting_for_task',
      "waiting for task schema's PR to merge",
    ])
  })

  it('follows the stack down past merged PRs, to the first one not merged', () => {
    const tasks = `tasks:
  - { id: schema, title: S }
  - { id: api, title: A, after: { schema: opened } }
  - { id: web, title: W, after: { api: opened } }
`
    const p = plan([
      card(tasks, { schema: pr('schema', 'open', 10), api: pr('api', 'merged', 11) }),
    ])
    expect(shape(p)).toEqual([
      ['acme-api-1-web', 'away/acme-api-1-schema', 'https://github.com/acme/api/pull/10', '-'],
    ])
    expect(formatPlan(p)).toContain("   after api, stacks on schema's #10")
    const own = plan([card(chain, { api: pr('api', 'open', 11), web: pr('web', 'merged', 12) })])
    expect(shape(own)).toEqual([
      ['acme-api-1-docs', 'away/acme-api-1-api', 'https://github.com/acme/api/pull/11', '-'],
    ])
    const landed = plan([
      card(tasks, { schema: pr('schema', 'merged', 10), api: pr('api', 'merged', 11) }),
    ])
    expect(shape(landed)).toEqual([['acme-api-1-web', '', '-', '-']])
  })

  it('counts a merged task as merged only once the stack under it merged too', () => {
    const tasks = `tasks:
  - { id: schema, title: S }
  - { id: api, title: A, after: { schema: opened } }
  - { id: web, title: W, after: { api: merged } }
`
    const waits = plan([
      card(tasks, { schema: pr('schema', 'open', 10), api: pr('api', 'merged', 11) }),
    ])
    expect(shape(waits)).toEqual([])
    expect(skips(waits)).toContainEqual([
      'acme/api#1/web',
      'waiting_for_task',
      "waiting for task schema's PR to merge, api's merged into it",
    ])
    const landed = plan([
      card(tasks, { schema: pr('schema', 'merged', 10), api: pr('api', 'merged', 11) }),
    ])
    expect(shape(landed)).toEqual([['acme-api-1-web', '', '-', '-']])
  })

  it('is cut by a cap, the tasks past it left for the next run', () => {
    const capped = plan([card(chain)], configOf('limits: { units: 2 }\n'))
    expect(shape(capped).map(([id]) => id)).toEqual(['acme-api-1-api', 'acme-api-1-web'])
    expect(skips(capped)).toEqual([
      ['acme/api#1/docs', 'over_cap', 'over the cap: limits.units is 2'],
    ])
    const first = plan([card(chain)], configOf('limits: { units: 1 }\n'))
    expect(skips(first)).toEqual([
      ['acme/api#1/web', 'over_cap', 'over the cap: limits.units is 1'],
      ['acme/api#1/docs', 'waiting_for_task', "waiting for task web's PR to open"],
    ])
  })
})

/** A forge on a local origin that takes pushes and opens PRs carrying the real body and footer, on the base they name. */
async function originForge(root: string) {
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const fake = fakeForge()
  const bases: Record<string, string> = {}
  const clones: Record<string, string> = {}
  let n = 10
  const forge = {
    ...fake,
    clone: async (_repo: string, branch: string, dir: string) => {
      clones[dir] = branch || 'main'
      await execa(bin('git'), ['clone', '-q', ...(branch ? ['--branch', branch] : []), origin, dir])
    },
    push: async (dir: string, branch: string, to: { repo: string }) => {
      await fake.push(dir, branch, to)
      await git(dir, 'push', '-q', origin, `HEAD:refs/heads/${branch}`)
    },
    openPr: async (
      repo: string,
      head: string,
      base: string,
      bodyFile: string,
      runId: string,
      items: Pick<Item, 'source' | 'key'>[],
    ) => {
      const { body } = await prText(bodyFile, head, runId, items)
      const url = `https://github.com/${repo}/pull/${++n}`
      bases[head] = base || 'main'
      fake.heads[`${repo}:${head}`] = [{ url, number: n, body, open: true }]
      return url
    },
  }
  const merge = (branch: string) => {
    const [found] = fake.heads[`acme/api:${branch}`] ?? []
    if (found) Object.assign(found, { open: false, merged: true, closedAt: at(9) })
  }
  return { forge, bases, clones, merge, stacked: fake.stacked }
}

describe('a feature block run by run', () => {
  const setup = async (cfg = config, failing: string[] = []) => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-block-'))
    const origin = await originForge(root)
    const item = card(chain)
    const source = { ...fakeSource(), items: async () => [item] } as Source
    const logs: string[] = []
    const ctx = { env: { PATH: process.env.PATH }, log: (line: string) => logs.push(line) }
    // What each task's clone held when its worker started.
    const found: Record<string, string[]> = {}
    const worker: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        const id = job.unit.id.replace('acme-api-1-', '')
        found[id] = ['api', 'web'].filter((t) => existsSync(join(job.dir, `${t}.txt`)))
        if (failing.includes(id)) return yield { type: 'done', ok: false, turns: 1 }
        await writeFile(join(job.dir, `${id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${id}`)
        await writeFile(join(job.dir, '.away/out/pr.md'), `Implement ${id}\n\nDone.`)
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    let attempts: Attempts = {}
    let runs = 0
    const run = async (extra: Partial<Parameters<typeof runUnits>[0]> = {}) => {
      const n = ++runs
      const cardNow = { ...item }
      await linkPlanTasks([cardNow], cfg, { builtin: builtinSkills }, origin.forge, ctx)
      const planned = plan([cardNow], cfg, attempts)
      const report = await runUnits({
        config: cfg,
        configDir: root,
        plan: planned,
        runId: `r${n}`,
        runDir: join(root, `run-${n}`),
        dryRun: false,
        providers: { claude: worker },
        sources: { github: source },
        forge: origin.forge,
        ctx,
        watch: () => ({ stop: async () => {} }),
        shortage: async () => undefined,
        skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
        ...extra,
      })
      attempts = recordAttempts(attempts, report)
      return {
        report,
        ran: report.results.map((r) => [
          r.planned.unit.id.replace('acme-api-1-', ''),
          r.outcome?.kind === 'pr' ? r.outcome.url : `${r.status}: ${r.reason ?? ''}`,
        ]),
      }
    }
    return { ...origin, found, logs, run }
  }

  it("stacks web on api's PR and docs on web's in one run, each cloned from the one before", async () => {
    const { run, found, bases, clones, stacked } = await setup()
    expect((await run()).ran).toEqual([
      ['api', 'https://github.com/acme/api/pull/11'],
      ['web', 'https://github.com/acme/api/pull/12'],
      ['docs', 'https://github.com/acme/api/pull/13'],
    ])
    expect(Object.values(clones)).toEqual(['main', 'away/acme-api-1-api', 'away/acme-api-1-web'])
    expect(found).toEqual({ api: [], web: ['api'], docs: ['api', 'web'] })
    expect(bases).toEqual({
      'away/acme-api-1-api': 'main',
      'away/acme-api-1-web': 'away/acme-api-1-api',
      'away/acme-api-1-docs': 'away/acme-api-1-web',
    })
    expect(stacked).toEqual([
      ['https://github.com/acme/api/pull/11', 'https://github.com/acme/api/pull/12'],
      ['https://github.com/acme/api/pull/12', 'https://github.com/acme/api/pull/13'],
    ])
  })

  it('skips the tasks after one that opened no PR, naming it', async () => {
    const { run } = await setup(config, ['api'])
    const { ran, report } = await run()
    expect(ran).toEqual([
      ['api', 'failed: '],
      ['web', 'skipped: api opened no PR'],
      ['docs', "skipped: web didn't run"],
    ])
    expect(formatRun(report)).toContain('api opened no PR')
  })

  it("says the dependency didn't run when it never got to, and a dry run where it would clone from", async () => {
    const { run, logs } = await setup()
    expect((await run({ only: 'acme-api-1-web' })).ran).toEqual([
      ['web', "skipped: api didn't run"],
    ])
    const dry = await run({ dryRun: true })
    expect(dry.ran).toEqual([
      ['api', 'prepared: '],
      ['web', 'prepared: '],
      ['docs', 'prepared: '],
    ])
    expect(logs).toContain(
      "acme-api-1-web: prepared from the default branch; a real run clones api's branch",
    )
  })

  it('carries on next run past a cap, stacking on the PR left open, then from main once it merged', async () => {
    const { run, bases, clones, merge } = await setup(configOf('limits: { units: 1 }\n'))
    expect((await run()).ran).toEqual([['api', 'https://github.com/acme/api/pull/11']])
    expect((await run()).ran).toEqual([['web', 'https://github.com/acme/api/pull/12']])
    expect(bases['away/acme-api-1-web']).toBe('away/acme-api-1-api')
    merge('away/acme-api-1-api')
    merge('away/acme-api-1-web')
    // Merged in the forge only: origin's main lacks them, so docs' clone shows where it started.
    expect((await run()).ran).toEqual([['docs', 'https://github.com/acme/api/pull/13']])
    expect(Object.values(clones).at(-1)).toBe('main')
    expect(bases['away/acme-api-1-docs']).toBe('main')
  })
})
