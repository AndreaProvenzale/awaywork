import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { formatPlan, formatRun, formatWhy, planJson } from '../src/cli/format.js'
import { linkPlanTasks } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { type Attempts, recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { planLimits, taskBranches, taskItem, taskMarkdown } from '../src/core/fanout.js'
import { approveReply, markComment, planComment } from '../src/core/footer.js'
import { planRun } from '../src/core/foreman.js'
import {
  checkPlan,
  contractText,
  openedChain,
  planContract,
  planState,
  planYaml,
} from '../src/core/plan.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Provider, Source, TaskPr, Write } from '../src/core/types.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { originsForge } from './fakes/origins.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const configOf = (extra = '') =>
  parseConfig(`
providers: [claude: {}]
sources: { github: { repos: [acme/*] } }
repos: { other/docs: {} }
${extra}queue:
  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true } }
`)
const config = configOf()
const skills = { builtin: builtinSkills }

const contract = 'openapi: 3.1.0\npaths:\n  /exports/vat:\n    get: {}'
const crossRepo = `contract: .away/out/openapi.yaml
tasks:
  - { id: api, title: VAT export endpoint, ships: [openapi.yaml] }
  - { id: web, title: Export button, repo: acme/web, after: { api: opened } }
`
const at = (n: number) => `2026-10-2${n}T00:00:00Z`
const card = (plan: string, taskPrs: Record<string, TaskPr> = {}, repo = 'acme/backend'): Item =>
  fakeItem({
    source: 'github',
    id: '1',
    key: 'acme/backend#1',
    type: 'issue',
    title: 'VAT export',
    url: 'https://github.com/acme/backend/issues/1',
    mine: true,
    comments: [
      {
        author: 'me',
        body: markComment(
          planComment('Two tasks.', plan, { name: 'openapi.yaml', text: contract }),
        ),
        at: at(1),
        mine: true,
      },
      { author: 'me', body: approveReply(''), at: at(2), mine: true },
    ],
    fields: { repo, updated: at(5) },
    taskPrs,
  })
const pr = (id: string, repo: string, state: TaskPr['state'], number = 12): TaskPr => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  branch: `away/acme-backend-1-${id}`,
  ours: true,
  mine: true,
  trusted: true,
  fork: false,
  state,
})

const allowances = { claude: allowance(config.budget, null, 0, config.windows) }
const plan = (items: Item[], cfg = config, attempts: Attempts = {}) =>
  planRun({ config: cfg, items, allowances, skills, attempts })
const shape = (p: ReturnType<typeof plan>) =>
  p.units.map((u) => [
    u.unit.id,
    u.unit.repo,
    u.unit.base,
    u.after ?? '-',
    u.waitsFor?.join(',') ?? '-',
  ])

describe('repos in a plan', () => {
  const limits = {
    maxTasks: 8,
    repo: 'acme/backend',
    repos: ['acme/*', 'other/docs'],
    skills: ['implement'],
  }
  const problem = (tasks: string, l: Parameters<typeof checkPlan>[1] = limits) => {
    const checked = checkPlan(`tasks:\n${tasks}`, l)
    return 'problem' in checked ? checked.problem : undefined
  }

  it("takes the card's repo, a repo the forge source globs or the config names, and refuses others", () => {
    expect(planLimits(config, config.queue ?? [], card(crossRepo), skills).repos).toEqual([
      'acme/*',
      'other/docs',
    ])
    expect(problem('  - { id: api, title: A }\n')).toBeUndefined()
    expect(problem('  - { id: api, title: A, repo: acme/backend }\n')).toBeUndefined()
    expect(problem('  - { id: web, title: W, repo: acme/web }\n')).toBeUndefined()
    expect(problem('  - { id: docs, title: D, repo: other/docs }\n')).toBeUndefined()
    expect(problem('  - { id: x, title: X, repo: evil/x }\n')).toBe(
      "task x: repo evil/x isn't the card's (acme/backend) or one the config names",
    )
    expect(problem('  - { id: web, title: W, repo: Acme/Web }\n')).toBe(
      "task web: repo Acme/Web isn't acme/* as configured",
    )
    expect(problem('  - { id: docs, title: D, repo: Other/Docs }\n')).toBe(
      "task docs: repo Other/Docs isn't other/docs as configured",
    )
    expect(
      problem('  - { id: api, title: A, repo: ACME/BACKEND }\n', { ...limits, repos: [] }),
    ).toBe("task api: repo ACME/BACKEND isn't acme/backend as configured")
    const noRepo = { ...limits, repo: undefined }
    expect(problem('  - { id: web, title: W, repo: acme/web }\n', noRepo)).toBeUndefined()
    expect(
      problem('  - { id: web, title: W, repo: acme/web }\n  - { id: api, title: A }\n', noRepo),
    ).toBe('task api: no repo, and the card has none: name one on every task')
    expect(planContract(limits)).toContain(
      "a `repo` (this item's, `acme/backend`, when unset, else one of `acme/*`, `other/docs`)",
    )
    expect(planContract(noRepo)).toContain(
      'a `repo` (every task needs one, as this item has none: one of `acme/*`, `other/docs`)',
    )
  })

  it('keeps the one-chain rule to opened tasks in its own repo', () => {
    const tasks = `  - { id: api, title: A }
  - { id: ui, title: U, repo: acme/web }
  - { id: web, title: W, repo: acme/web, after: { api: opened, ui: opened } }
`
    expect(problem(tasks)).toBeUndefined()
    expect(problem(tasks.replace(/repo: acme\/web/g, 'repo: acme/backend'))).toBe(
      "task web: its opened tasks api, ui aren't on one chain: make each after the one before, e.g. ui after api: opened",
    )
    const checked = checkPlan(`tasks:\n${tasks}`, limits)
    const all = 'plan' in checked ? checked.plan.tasks : []
    expect(openedChain(all[2] as (typeof all)[number], all, 'acme/backend')).toEqual(['ui'])
    // ui reaches schema only through api in another repo, so its branch lacks schema's work.
    expect(
      problem(`  - { id: schema, title: S }
  - { id: api, title: A, repo: acme/web, after: { schema: opened } }
  - { id: ui, title: U, after: { api: opened } }
  - { id: web, title: W, after: { schema: opened, ui: opened } }
`),
    ).toBe(
      "task web: its opened tasks schema, ui aren't on one chain: make each after the one before, e.g. ui after schema: opened",
    )
  })

  it('takes only relative paths without .. in ships', () => {
    expect(problem('  - { id: api, title: A, ships: [openapi.yaml, gen/client.ts] }\n')).toBe(
      undefined,
    )
    for (const path of ['/etc/passwd', '../x', 'a/../b', './a', 'a//b', ''])
      expect(problem(`  - { id: api, title: A, ships: ["${path}"] }\n`)).toBe(
        `task api: ships ${path}, which isn't a relative path without ..`,
      )
  })
})

describe('tasks in other repos', () => {
  it('makes each task an item in its own repo, and looks its PR up there', () => {
    const tasks = checkPlan(crossRepo, { maxTasks: 8, repo: 'acme/backend', repos: ['acme/*'] })
    const all = 'plan' in tasks ? tasks.plan.tasks : []
    const web = taskItem(card(crossRepo), all[1] as (typeof all)[number], all)
    expect(web.fields.repo).toBe('acme/web')
    expect(web.task?.plan).toEqual([
      {
        id: 'api',
        title: 'VAT export endpoint',
        after: {},
        repo: 'acme/backend',
        ships: ['openapi.yaml'],
      },
      { id: 'web', title: 'Export button', after: { api: 'opened' }, repo: 'acme/web' },
    ])
    expect(web.task?.onto).toBeUndefined()
    expect(taskMarkdown(web)).toContain(
      '- `web`: Export button in acme/web (this task), after api opened',
    )
    expect(
      taskBranches([card(crossRepo)], config, config.queue ?? [], skills).map((t) => [
        t.id,
        t.repo,
        t.branch,
      ]),
    ).toEqual([
      ['api', 'acme/backend', 'away/acme-backend-1-api'],
      ['web', 'acme/web', 'away/acme-backend-1-web'],
    ])
  })

  it('waits for a task in another repo opening its PR in this run, without stacking on it', () => {
    const p = plan([card(crossRepo)])
    expect(shape(p)).toEqual([
      ['acme-backend-1-api', 'acme/backend', '', '-', '-'],
      ['acme-backend-1-web', 'acme/web', '', '-', 'api'],
    ])
    const text = formatPlan(p)
    expect(text).toContain("     in acme/web\n     waits for api's PR in acme/backend")
    expect(text).not.toContain('stacks on')
    const web = p.units[1]?.unit.items[0] as Item
    expect(formatWhy(p, web)).toContain('  task web of the plan on acme/backend#1, in acme/web')
    expect(formatWhy(p, web)).toContain('  after api opened in acme/backend (no PR yet)')
    expect(formatWhy(p, web)).toContain("waits     for api's PR in acme/backend")
    expect(planJson(p)).toContain('"repo": "acme/web"')
  })

  it("starts once the other repo's PR is open, and waits for one that won't run", () => {
    const open = plan([card(crossRepo, { api: pr('api', 'acme/backend', 'open') })])
    expect(shape(open)).toEqual([['acme-backend-1-web', 'acme/web', '', '-', '-']])
    expect(formatPlan(open)).not.toContain('waits for')
    const held = plan([card(crossRepo)], config, {
      'github:acme/backend#1/api': { runId: 'r1', skill: 'implement', updated: at(5) },
    })
    expect(held.skipped.filter((s) => s.item.task).map((s) => [s.item.key, s.reason])).toEqual([
      ['acme/backend#1/api', 'unchanged since run r1'],
      ['acme/backend#1/web', "waiting for task api's PR to open"],
    ])
  })

  it('stacks on an opened task in its own repo and waits for one in another', () => {
    const tasks = `tasks:
  - { id: api, title: A }
  - { id: ui, title: U, repo: acme/web }
  - { id: web, title: W, repo: acme/web, after: { api: opened, ui: opened } }
`
    const p = plan([card(tasks)])
    expect(shape(p)).toEqual([
      ['acme-backend-1-api', 'acme/backend', '', '-', '-'],
      ['acme-backend-1-ui', 'acme/web', '', '-', '-'],
      ['acme-backend-1-web', 'acme/web', '', 'acme-backend-1-ui', 'api'],
    ])
    expect(formatPlan(p)).toContain(
      "     in acme/web\n     after ui, stacks on its PR\n     waits for api's PR in acme/backend",
    )
  })
})

describe('the contract', () => {
  const posted = (text: string, plan = crossRepo) =>
    planComment('Two tasks.', plan, { name: 'openapi.yaml', text })

  it('posts it fenced under its heading before plan.yml, and reads both back', () => {
    const body = posted(contract)
    expect(body).toBe(
      `Two tasks.\n\n### Contract: openapi.yaml\n\n\`\`\`yaml\n${contract}\n\`\`\`\n\n\`\`\`yaml\n${crossRepo.trim()}\n\`\`\`\n\nTo approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.`,
    )
    expect(planYaml(body)).toBe(crossRepo.trim())
    expect(contractText(body, 'openapi.yaml')).toBe(contract)
  })

  it('fences a contract with fences in it longer, so neither it nor plan.yml is cut', () => {
    const fenced = 'Use it like this:\n\n````yaml\ntasks: []\n```\n````\n\n```yaml\nx: 1\n```'
    const body = posted(fenced)
    expect(body).toContain('### Contract: openapi.yaml\n\n`````yaml\n')
    expect(contractText(body, 'openapi.yaml')).toBe(fenced)
    expect(planYaml(body)).toBe(crossRepo.trim())
    expect(contractText(body.replace(/\r?\n/g, '\r\n'), 'openapi.yaml')).toBe(fenced)
  })

  it('refuses a contract outside .away/out/, and a plan whose comment lost it', () => {
    const limits = { maxTasks: 8, repo: 'acme/backend', repos: ['acme/*'] }
    for (const path of ['openapi.yaml', '.away/out/', '.away/out/../x', '/tmp/x'])
      expect(checkPlan(`contract: ${path}\ntasks:\n  - { id: api, title: A }`, limits)).toEqual({
        problem: `contract ${path} isn't a file under .away/out/`,
      })
    expect(planState(card(crossRepo), limits)).toMatchObject({
      state: 'approved',
      contract: { name: 'openapi.yaml', text: contract },
    })
    const edited = card(crossRepo)
    const [comment] = edited.comments
    if (comment) comment.body = comment.body.replace('### Contract: openapi.yaml', 'The contract:')
    expect(planState(edited, limits)).toEqual({
      state: 'invalid',
      problem: "contract .away/out/openapi.yaml isn't in the plan comment",
    })
  })

  const planner = (files: Record<string, string>): Provider => ({
    ...fakeProvider('claude'),
    async *run(job) {
      await writeFile(join(job.dir, '.away/out/report.md'), 'Two tasks.')
      for (const [name, text] of Object.entries(files))
        await writeFile(join(job.dir, '.away/out', name), text)
      yield { type: 'done', ok: true, turns: 1 }
    },
  })
  const postRun = async (provider: Provider) => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-contract-'))
    const origin = join(root, 'origin')
    await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
    const forge = {
      ...fakeForge(),
      clone: async (_repo: string, _branch: string, dir: string) => {
        await execa(bin('git'), ['clone', '-q', origin, dir])
      },
    }
    const writes: Write[] = []
    const source = {
      ...fakeSource(),
      write: async (_cfg: unknown, _item: Item, w: Write) => {
        writes.push(w)
        return {}
      },
    } as Source
    const item = fakeItem({
      source: 'github',
      key: 'acme/backend#1',
      type: 'issue',
      mine: true,
      fields: { repo: 'acme/backend' },
    })
    const report = await runUnits({
      config,
      configDir: root,
      plan: plan([item]),
      runId: 'r1',
      runDir: join(root, 'run'),
      dryRun: false,
      providers: { claude: provider },
      sources: { github: source },
      forge,
      ctx: { env: { PATH: process.env.PATH }, log: () => {} },
      watch: () => ({ stop: async () => {} }),
      shortage: async () => undefined,
      skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
    })
    return { writes, posted: report.results[0]?.plan }
  }

  it('posts the file the plan names with it, CRLF folded, and refuses one missing or over the size guard', async () => {
    const ok = await postRun(planner({ 'plan.yml': crossRepo, 'openapi.yaml': `${contract}\n` }))
    expect(ok.writes).toEqual([{ op: 'comment', body: markComment(posted(contract)) }])
    const missing = await postRun(planner({ 'plan.yml': crossRepo }))
    expect(missing.writes).toEqual([])
    expect(missing.posted?.unposted).toBe(
      'plan.yml: contract .away/out/openapi.yaml is missing or empty',
    )
    const crlf = await postRun(
      planner({ 'plan.yml': crossRepo, 'openapi.yaml': `${contract.replace(/\n/g, '\r\n')}\r\n` }),
    )
    expect(crlf.writes).toEqual([{ op: 'comment', body: markComment(posted(contract)) }])
    const big = await postRun(
      planner({ 'plan.yml': crossRepo, 'openapi.yaml': 'x'.repeat(30_001) }),
    )
    expect(big.writes).toEqual([])
    expect(big.posted?.unposted).toBe('the plan comment is over 30000 bytes')
  })
})

describe('a cross-repo feature run by run', () => {
  const setup = async (cfg = config, ships = true) => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-cross-'))
    const origins = await originsForge(root, ['acme/backend', 'acme/web'])
    const item = card(crossRepo)
    const source = { ...fakeSource(), items: async () => [item] } as Source
    const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
    // What each task's context held when its worker started.
    const found: Record<string, Record<string, string>> = {}
    const worker: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        const id = job.unit.id.replace('acme-backend-1-', '')
        const context = join(job.dir, '.away/context', job.unit.id)
        found[id] = {}
        for (const file of ['contract/openapi.yaml', 'shipped/api/openapi.yaml'])
          if (existsSync(join(context, file)))
            found[id][file] = await readFile(join(context, file), 'utf8')
        if (job.prompt.includes('shipped/api/openapi.yaml')) found[id].prompt = 'names shipped'
        if (ships || id !== 'api') await writeFile(join(job.dir, 'openapi.yaml'), `# ${id}'s\n`)
        await writeFile(join(job.dir, `${id}.txt`), 'done')
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${id}`)
        await writeFile(join(job.dir, '.away/out/pr.md'), `Implement ${id}\n\nDone.`)
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    let attempts: Attempts = {}
    let runs = 0
    let last = ''
    const run = async () => {
      const n = ++runs
      const cardNow = { ...item }
      await linkPlanTasks([cardNow], cfg, skills, origins.forge, ctx)
      const report = await runUnits({
        config: cfg,
        configDir: root,
        plan: plan([cardNow], cfg, attempts),
        runId: `r${n}`,
        runDir: join(root, `run-${n}`),
        dryRun: false,
        providers: { claude: worker },
        sources: { github: source },
        forge: origins.forge,
        ctx,
        watch: () => ({ stop: async () => {} }),
        shortage: async () => undefined,
        skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
      })
      attempts = recordAttempts(attempts, report)
      last = formatRun(report)
      return report.results.map((r) => [
        r.planned.unit.id.replace('acme-backend-1-', ''),
        r.outcome?.kind === 'pr' ? r.outcome.url : `${r.status}: ${r.reason ?? ''}`,
      ])
    }
    return { ...origins, found, run, attempts: () => attempts, report: () => last }
  }

  it("cuts web from its own repo's main in the same run, with the contract and api's shipped file", async () => {
    const { run, found, bases, clones, stacked } = await setup()
    expect(await run()).toEqual([
      ['api', 'https://github.com/acme/backend/pull/11'],
      ['web', 'https://github.com/acme/web/pull/12'],
    ])
    expect(Object.entries(clones).map(([k, v]) => [k.split(':')[0], v])).toEqual([
      ['acme/backend', 'main'],
      ['acme/web', 'main'],
    ])
    expect(bases).toEqual({
      'acme/backend:away/acme-backend-1-api': 'main',
      'acme/web:away/acme-backend-1-web': 'main',
    })
    expect(stacked).toEqual([])
    expect(found.api).toEqual({ 'contract/openapi.yaml': `${contract}\n` })
    expect(found.web).toEqual({
      'contract/openapi.yaml': `${contract}\n`,
      'shipped/api/openapi.yaml': "# api's\n",
      prompt: 'names shipped',
    })
  })

  it("skips web when api's PR lacks the file it ships, counting no attempt", async () => {
    const { run, found, attempts, report } = await setup(config, false)
    expect(await run()).toEqual([
      ['api', 'https://github.com/acme/backend/pull/11'],
      ['web', "skipped: api's PR has no openapi.yaml"],
    ])
    expect(found.web).toBeUndefined()
    expect(attempts()['github:acme/backend#1/web']).toBeUndefined()
    expect(report()).toMatch(/web +implement +skipped +api's PR has no openapi\.yaml$/m)
  })

  it('reads the file from a PR merged in an earlier run, its branch deleted', async () => {
    const { run, found, merge } = await setup(configOf('limits: { units: 1 }\n'))
    expect(await run()).toEqual([['api', 'https://github.com/acme/backend/pull/11']])
    await merge('acme/backend', 'away/acme-backend-1-api')
    expect(await run()).toEqual([['web', 'https://github.com/acme/web/pull/12']])
    expect(found.web?.['shipped/api/openapi.yaml']).toBe("# api's\n")
  })
})
