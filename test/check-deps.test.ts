import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { formatPlan, formatWhy, planJson } from '../src/cli/format.js'
import { linkPlanTasks } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { type Attempts, recordAttempts } from '../src/core/attempts.js'
import { allowance } from '../src/core/budget.js'
import { approveReply, footer, markComment, planComment } from '../src/core/footer.js'
import { planRun } from '../src/core/foreman.js'
import { checkPlan, openedChain } from '../src/core/plan.js'
import { builtinSkills } from '../src/core/skills.js'
import type { CheckState, Forge, Item, Provider, Source, TaskPr } from '../src/core/types.js'
import { bitbucketForge } from '../src/forge/bitbucket.js'
import type { Exec } from '../src/forge/gh.js'
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

const configOf = (sources = 'github: { repos: [acme/*] }') =>
  parseConfig(`
providers: [claude: {}]
sources: { ${sources} }
queue:
  - { skill: plan, deliver: plan }
  - { skill: implement, where: { planned: true } }
`)
const config = configOf()
const skills = { builtin: builtinSkills }
const allowances = { claude: allowance(config.budget, null, 0, config.windows) }
const plan = (items: Item[], cfg = config, attempts: Attempts = {}) =>
  planRun({ config: cfg, items, allowances, skills, attempts })

const sameRepo = `tasks:
  - { id: api, title: VAT export endpoint }
  - { id: web, title: Export button, after: { api: Vercel Preview } }
`
const crossRepo = `tasks:
  - { id: api, title: VAT export endpoint, ships: [openapi.yaml] }
  - { id: web, title: Export button, repo: acme/web, after: { api: Vercel Preview } }
`
const at = (n: number) => `2026-10-2${n}T00:00:00Z`
const card = (yaml: string, taskPrs: Record<string, TaskPr> = {}, source = 'github'): Item =>
  fakeItem({
    source,
    id: '1',
    key: 'acme/backend#1',
    type: 'issue',
    title: 'VAT export',
    url: 'https://github.com/acme/backend/issues/1',
    mine: true,
    comments: [
      { author: 'me', body: markComment(planComment('Two tasks.', yaml)), at: at(1), mine: true },
      { author: 'me', body: approveReply(''), at: at(2), mine: true },
    ],
    fields: { repo: 'acme/backend', updated: at(5) },
    taskPrs,
  })
const pr = (state: TaskPr['state'], checks?: Record<string, CheckState>): TaskPr => ({
  repo: 'acme/backend',
  number: 41,
  url: 'https://github.com/acme/backend/pull/41',
  branch: 'away/acme-backend-1-api',
  ours: true,
  mine: true,
  trusted: true,
  fork: false,
  state,
  ...(checks && { checks }),
})
const skips = (p: ReturnType<typeof plan>) =>
  p.skipped.map((s) => [s.item.key, s.kind, s.reason, s.url ?? '-'])

describe('a check name in after', () => {
  const limits = { maxTasks: 8, repo: 'acme/backend', repos: ['acme/*'], skills: ['implement'] }
  const problem = (tasks: string) => {
    const checked = checkPlan(`tasks:\n${tasks}`, limits)
    return 'problem' in checked ? checked.problem : undefined
  }

  it('takes any name, and counts it with opened toward the one chain in its own repo only', () => {
    expect(
      problem(
        '  - { id: api, title: A }\n  - { id: web, title: W, after: { api: "Expo Preview" } }\n',
      ),
    ).toBeUndefined()
    expect(
      problem('  - { id: api, title: A }\n  - { id: web, title: W, after: { api: "" } }\n'),
    ).toMatch(/^tasks\.1\.after\.api: /)
    const tasks = `  - { id: api, title: A }
  - { id: ui, title: U }
  - { id: web, title: W, after: { api: Vercel Preview, ui: opened } }
`
    expect(problem(tasks)).toBe(
      "task web: its opened tasks api, ui aren't on one chain: make each after the one before, e.g. ui after api: opened",
    )
    expect(problem(tasks.replace('id: api, title: A', 'id: api, title: A, repo: acme/web'))).toBe(
      undefined,
    )
    const checked = checkPlan(
      `tasks:\n${tasks.replace('{ id: ui, title: U }', '{ id: ui, title: U, after: { api: opened } }')}`,
      limits,
    )
    const all = 'plan' in checked ? checked.plan.tasks : []
    expect(openedChain(all[2] as (typeof all)[number], all, 'acme/backend')).toEqual(['api', 'ui'])
  })

  it('waits while the check is pending, failing, not reported or has no PR, each saying so', () => {
    const waiting = (taskPrs: Record<string, TaskPr>) => {
      const p = plan([card(sameRepo, taskPrs)])
      return [p.units.map((u) => u.unit.id), skips(p).slice(0, 2)]
    }
    const reason = (state: string) => `waiting for api's check Vercel Preview (${state})`
    const fannedOut = "fanned out: api PR open, web waits for api's check Vercel Preview"
    expect(waiting({ api: pr('open', { 'Vercel Preview': 'pending' }) })).toEqual([
      [],
      [
        ['acme/backend#1', 'fanned_out', fannedOut, 'https://github.com/acme/backend/issues/1'],
        ['acme/backend#1/web', 'waiting_for_task', reason('pending'), pr('open').url],
      ],
    ])
    expect(waiting({ api: pr('open', { 'Vercel Preview': 'failing' }) })[1]?.[1]?.[2]).toBe(
      reason('failing'),
    )
    expect(waiting({ api: pr('open', { 'vercel preview': 'passed' }) })[1]?.[1]?.[2]).toBe(
      reason('not reported'),
    )
    expect(waiting({ api: pr('open') })[1]?.[1]?.[2]).toBe(reason('not reported'))
  })

  it("never joins the block from a PR opened this run: a check there hasn't passed yet", () => {
    const p = plan([card(sameRepo)])
    expect(p.units.map((u) => [u.unit.id, u.after ?? '-'])).toEqual([['acme-backend-1-api', '-']])
    expect(skips(p)[1]).toEqual([
      'acme/backend#1/web',
      'waiting_for_task',
      "waiting for api's check Vercel Preview (no PR yet)",
      '-',
    ])
  })

  it('stacks on the PR once its check passed, and counts a merged PR as passed', () => {
    const passed = plan([card(sameRepo, { api: pr('open', { 'Vercel Preview': 'passed' }) })])
    expect(passed.units.map((u) => [u.unit.id, u.unit.base, u.unit.stackedOn ?? '-'])).toEqual([
      ['acme-backend-1-web', 'away/acme-backend-1-api', pr('open').url],
    ])
    expect(formatPlan(passed)).toContain(
      "     after api's check Vercel Preview (passed), stacks on #41\n\n",
    )
    const web = passed.units[0]?.unit.items[0] as Item
    expect(formatWhy(passed, web)).toContain(
      "  after api's check Vercel Preview (PR #41 open, passed)",
    )
    expect(formatWhy(passed, web)).toContain(
      "stack     after api's check Vercel Preview (passed), stacks on #41",
    )
    expect(formatWhy(passed, web)).not.toContain('check     ')
    expect(planJson(passed)).toContain('"Vercel Preview": "passed"')
    const merged = plan([card(sameRepo, { api: pr('merged') })])
    expect(merged.units.map((u) => [u.unit.id, u.unit.base])).toEqual([['acme-backend-1-web', '']])
    expect(formatPlan(merged)).toContain("     after api's check Vercel Preview (api merged)")
    const cross = plan([card(crossRepo, { api: pr('open', { 'Vercel Preview': 'passed' }) })])
    expect(cross.units.map((u) => [u.unit.id, u.unit.repo, u.unit.base])).toEqual([
      ['acme-backend-1-web', 'acme/web', ''],
    ])
  })
})

describe('reading checks', () => {
  const linked = async (yaml: string, forge: Forge) => {
    const item = card(yaml)
    const log: string[] = []
    await linkPlanTasks([item], config, skills, forge, { env: {}, log: (l) => log.push(l) })
    return { taskPrs: item.taskPrs, log }
  }
  const withPr = () => {
    const forge = fakeForge()
    const body = `Done.\n\n${footer('r1', [{ source: 'github', key: 'acme/backend#1/api' }])}`
    forge.heads['acme/backend:away/acme-backend-1-api'] = [
      { url: pr('open').url, number: 41, body },
    ]
    return forge
  }

  it('reads only the checks a task names, on open task PRs, and none for a plan without check names', async () => {
    const forge = withPr()
    forge.states['acme/backend#41'] = { 'Vercel Preview': 'pending', lint: 'failing' }
    let reads = 0
    const counting = {
      ...forge,
      checks: (r: string, n: number) => {
        reads++
        return forge.checks(r, n)
      },
    }
    expect((await linked(sameRepo, counting)).taskPrs?.api?.checks).toEqual({
      'Vercel Preview': 'pending',
    })
    expect(reads).toBe(1)
    await linked(sameRepo.replace('Vercel Preview', 'opened'), counting)
    expect(reads).toBe(1)
    Object.assign(forge.heads['acme/backend:away/acme-backend-1-api']?.[0] ?? {}, { merged: true })
    expect((await linked(sameRepo, counting)).taskPrs?.api).toMatchObject({ state: 'merged' })
    expect(reads).toBe(1)
  })

  it('skips the card when a read fails, as a failed PR lookup does', async () => {
    const forge = withPr()
    const failing = {
      ...forge,
      checks: async () => {
        throw new Error('HTTP 502')
      },
    }
    const { taskPrs, log } = await linked(sameRepo, failing)
    expect(taskPrs).toBeNull()
    expect(log).toEqual(["reading acme/backend#1/api's PR on away/acme-backend-1-api: HTTP 502"])
  })
})

describe('a check dependency run by run', () => {
  const setup = async (yaml: string) => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-checks-'))
    const origins = await originsForge(root, ['acme/backend', 'acme/web'])
    const item = card(yaml)
    const source = { ...fakeSource(), items: async () => [item] } as Source
    const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
    const shipped: Record<string, string> = {}
    const worker: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        const id = job.unit.id.replace('acme-backend-1-', '')
        const file = join(job.dir, '.away/context', job.unit.id, 'shipped/api/openapi.yaml')
        await readFile(file, 'utf8').then(
          (text) => (shipped[id] = text),
          () => {},
        )
        await writeFile(join(job.dir, id === 'api' ? 'openapi.yaml' : `${id}.txt`), `# ${id}'s\n`)
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${id}`)
        await writeFile(join(job.dir, '.away/out/pr.md'), `Implement ${id}\n\nDone.`)
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    let attempts: Attempts = {}
    let runs = 0
    const run = async () => {
      const n = ++runs
      const cardNow = { ...item }
      await linkPlanTasks([cardNow], config, skills, origins.forge, ctx)
      const planned = plan([cardNow], config, attempts)
      const report = await runUnits({
        config,
        configDir: root,
        plan: planned,
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
      const waits = planned.skipped
        .filter((s) => s.kind === 'waiting_for_task')
        .map((s) => [s.item.key.replace('acme/backend#1/', ''), s.reason])
      const ran = report.results.map((r) => [
        r.planned.unit.id.replace('acme-backend-1-', ''),
        r.outcome?.kind === 'pr' ? r.outcome.url : `${r.status}: ${r.reason ?? ''}`,
      ])
      return [...ran, ...waits]
    }
    const check = (state: CheckState) => {
      origins.forge.states['acme/backend#11'] = { 'Vercel Preview': state }
    }
    return { ...origins, run, check, shipped }
  }

  it('stacks a same-repo task on the PR once its check passed', async () => {
    const { run, check, bases } = await setup(sameRepo)
    expect(await run()).toEqual([
      ['api', 'https://github.com/acme/backend/pull/11'],
      ['web', "waiting for api's check Vercel Preview (no PR yet)"],
    ])
    check('pending')
    expect(await run()).toEqual([['web', "waiting for api's check Vercel Preview (pending)"]])
    check('passed')
    expect(await run()).toEqual([['web', 'https://github.com/acme/backend/pull/12']])
    expect(bases['acme/backend:away/acme-backend-1-web']).toBe('away/acme-backend-1-api')
  }, 30_000)

  it('runs a cross-repo task from its own main once the check passed, with the shipped file', async () => {
    const { run, check, bases, shipped } = await setup(crossRepo)
    expect(await run()).toEqual([
      ['api', 'https://github.com/acme/backend/pull/11'],
      ['web', "waiting for api's check Vercel Preview (no PR yet)"],
    ])
    check('failing')
    expect(await run()).toEqual([['web', "waiting for api's check Vercel Preview (failing)"]])
    check('passed')
    expect(await run()).toEqual([['web', 'https://github.com/acme/web/pull/12']])
    expect(bases['acme/web:away/acme-backend-1-web']).toBe('main')
    expect(shipped.web).toBe("# api's\n")
  }, 30_000)
})

const twgFixture = (name: string) =>
  readFileSync(new URL(`./fixtures/twg/${name}`, import.meta.url), 'utf8')

/**
 * twg and git over local origins: git's Bitbucket remotes point at them, and twg's PR commands
 * keep PRs in memory, shaped like the recorded output.
 */
async function fakeBitbucket(root: string, repos: string[]) {
  const origins: Record<string, string> = {}
  for (const repo of repos) {
    const origin = join(root, repo.replace('/', '-'))
    await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
    origins[repo] = origin
  }
  const [shape] = JSON.parse(twgFixture('prs-on-open.json')).values
  const prs: Record<string, unknown>[] = []
  const statuses: Record<number, { name: string; state: string }[]> = {}
  const created: string[][] = []
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? ''
  const run: Exec = async (cmd, args, env) => {
    if (cmd === 'git') {
      const local = args.map((a) =>
        a.replace(/^git@bitbucket\.org:(.+)\.git$/, (_, r) => origins[r] ?? a),
      )
      return (await execa(bin('git'), local, { env })).stdout
    }
    const [, what, verb] = args
    const repo = flag(args, '-r')
    const sha = async (branch: string) =>
      (await git(origins[repo] as string, 'rev-parse', branch)).stdout.slice(0, 12)
    if (what === 'prs' && verb === 'create') {
      created.push(args)
      const id = prs.length + 1
      const side = (branch: string, hash: string) => ({
        branch: { name: branch },
        commit: { hash },
        repository: { full_name: repo },
      })
      const pr = {
        ...shape,
        id,
        state: 'OPEN',
        description: readFileSync(flag(args, '--description-file'), 'utf8'),
        source: side(flag(args, '--source'), await sha(flag(args, '--source'))),
        destination: side(args.includes('--dest') ? flag(args, '--dest') : 'main', ''),
        links: { html: { href: `https://bitbucket.org/${repo}/pull-requests/${id}` } },
      }
      prs.push(pr)
      return JSON.stringify(pr)
    }
    if (what === 'prs' && verb === 'query') {
      const values = prs.filter(
        (p) =>
          (p.source as { branch: { name: string } }).branch.name === flag(args, '--source') &&
          p.state === flag(args, '--state') &&
          (p.destination as { repository: { full_name: string } }).repository.full_name === repo,
      )
      return JSON.stringify({
        values,
        page: 1,
        pagelen: 50,
        size: values.length,
        hasNextPage: false,
      })
    }
    if (what === 'prs' && verb === 'get') {
      const pr = prs.find((p) => p.id === Number(args[3]))
      return JSON.stringify({ ...pr, _statuses: statuses[Number(args[3])] ?? [] })
    }
    if (what === 'repo' && verb === 'file') {
      const shown = await execa(
        bin('git'),
        ['-C', origins[repo] as string, 'show', `${flag(args, '--ref')}:${args[3]}`],
        { reject: false, stripFinalNewline: false },
      )
      if (shown.exitCode !== 0)
        throw Object.assign(new Error('exit 1'), { stdout: twgFixture('not-found.json') })
      return JSON.stringify({ path: args[3], ref: flag(args, '--ref'), content: shown.stdout })
    }
    throw new Error(`no fake for twg ${args.join(' ')}`)
  }
  return { forge: bitbucketForge(['acme'], run), origins, statuses, created }
}

describe('a plan fanned out on Bitbucket', () => {
  it('stacks by PR destination, waits for a build status, and reads shipped files through twg', async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-bb-'))
    const bb = await fakeBitbucket(root, ['acme/backend', 'acme/web'])
    const cfg = configOf(
      "bitbucket: { repos: [acme/*] }, tracker: { command: 'echo []', write: 'cat' }",
    )
    const yaml = `tasks:
  - { id: api, title: VAT export endpoint, ships: [openapi.yaml] }
  - { id: ui, title: Export page, after: { api: opened } }
  - { id: web, title: Export button, repo: acme/web, after: { api: Pipeline } }
`
    const item = card(yaml, {}, 'tracker')
    const tracker = { ...fakeSource(), items: async () => [item] } as Source
    const shipped: Record<string, string> = {}
    const worker: Provider = {
      ...fakeProvider('claude'),
      async *run(job) {
        const id = job.unit.id.replace('acme-backend-1-', '')
        const file = join(job.dir, '.away/context', job.unit.id, 'shipped/api/openapi.yaml')
        await readFile(file, 'utf8').then(
          (text) => (shipped[id] = text),
          () => {},
        )
        await writeFile(join(job.dir, id === 'api' ? 'openapi.yaml' : `${id}.txt`), `# ${id}'s\n`)
        await git(job.dir, 'add', '.')
        await git(job.dir, 'commit', '-qm', `Implement ${id}`)
        await writeFile(join(job.dir, '.away/out/pr.md'), `Implement ${id}\n\nDone.`)
        yield { type: 'done', ok: true, turns: 1 }
      },
    }
    const ctx = { env: { PATH: process.env.PATH }, log: () => {} }
    let attempts: Attempts = {}
    const run = async (n: number) => {
      const cardNow = { ...item }
      await linkPlanTasks([cardNow], cfg, skills, bb.forge, ctx)
      const planned = plan([cardNow], cfg, attempts)
      const report = await runUnits({
        config: cfg,
        configDir: root,
        plan: planned,
        runId: `r${n}`,
        runDir: join(root, `run-${n}`),
        dryRun: false,
        providers: { claude: worker },
        sources: { tracker },
        forge: bb.forge,
        ctx,
        watch: () => ({ stop: async () => {} }),
        shortage: async () => undefined,
        skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
      })
      attempts = recordAttempts(attempts, report)
      return [
        ...report.results.map((r) => [
          r.planned.unit.id.replace('acme-backend-1-', ''),
          r.outcome?.kind === 'pr' ? r.outcome.url : `${r.status}: ${r.reason ?? ''}`,
        ]),
        ...planned.skipped
          .filter((s) => s.kind === 'waiting_for_task')
          .map((s) => [s.item.key.replace('acme/backend#1/', ''), s.reason]),
      ]
    }
    expect(await run(1)).toEqual([
      ['api', 'https://bitbucket.org/acme/backend/pull-requests/1'],
      ['ui', 'https://bitbucket.org/acme/backend/pull-requests/2'],
      ['web', "waiting for api's check Pipeline (no PR yet)"],
    ])
    expect(
      bb.created.map((args) => [
        args[4],
        args.includes('--dest') ? args[args.indexOf('--dest') + 1] : 'main',
      ]),
    ).toEqual([
      ['acme/backend', 'main'],
      ['acme/backend', 'away/acme-backend-1-api'],
    ])
    bb.statuses[1] = [{ name: 'Pipeline', state: 'INPROGRESS' }]
    expect(await run(2)).toEqual([['web', "waiting for api's check Pipeline (pending)"]])
    bb.statuses[1] = [{ name: 'Pipeline', state: 'SUCCESSFUL' }]
    expect(await run(3)).toEqual([['web', 'https://bitbucket.org/acme/web/pull-requests/3']])
    expect(shipped).toEqual({ web: "# api's\n" })
  }, 30_000)
})
