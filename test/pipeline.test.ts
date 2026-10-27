import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execa } from 'execa'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { executeRun, newRunId } from '../src/cli/run.js'
import { watch } from '../src/cli/watch.js'
import { loadConfig } from '../src/config/load.js'
import { bin, runsDir, watchLogPath } from '../src/config/paths.js'
import { commentKind } from '../src/core/footer.js'
import type { Forge, Item, Job, Provider, Write } from '../src/core/types.js'
import { github } from '../src/sources/github.js'
import { originsForge } from './fakes/origins.js'
import { fakeProvider } from './fakes/provider.js'

/** What the mocked registries hand out: the story's forge and agent. */
const the = vi.hoisted(() => ({
  forge: undefined as unknown as Forge,
  agent: undefined as unknown as Provider,
}))

vi.mock('../src/providers/index.js', async () => {
  const { fakeProvider } = await import('./fakes/provider.js')
  const claude: Provider = {
    ...fakeProvider('claude'),
    run: (job: Job, signal: AbortSignal) => the.agent.run(job, signal),
  }
  const providers: Record<string, Provider> = { claude }
  return { providers, providerFor: (id: string) => providers[id], providersOf: () => providers }
})
vi.mock('../src/forge/index.js', () => ({ forgeFor: () => the.forge }))
vi.mock('../src/scheduler/wake.js', async (original) => ({
  ...(await original<typeof import('../src/scheduler/wake.js')>()),
  holdAwake: async () => () => {},
}))
vi.mock('../src/config/paths.js', async (original) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const state = await mkdtemp(`${tmpdir()}/awaywork-state-`)
  return {
    ...(await original<typeof import('../src/config/paths.js')>()),
    stateDir: state,
    runsDir: `${state}/runs`,
    remoteDir: `${state}/remote`,
    attemptsPath: `${state}/attempts.json`,
    runLockPath: `${state}/run.lock`,
    watchLockPath: `${state}/watch.lock`,
    watchStatePath: `${state}/watch.json`,
    watchLogPath: `${state}/watch.log`,
    skipsPath: `${state}/skips.json`,
    approvalsPath: `${state}/approvals.json`,
  }
})

process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

const configYaml = (events: string) => `providers: [claude]
windows: []
sources: { github: { repos: [acme/api, acme/web] } }
gates: { schema: { changed: ["**/migrations/**"] } }
notify: { command: 'echo "$AWAYWORK_EVENT $AWAYWORK_UNIT $AWAYWORK_STATUS" >> ${events}' }
queue:
  - skill: plan
    where: { label: feature }
    deliver: plan
    on_done: { move: plan-review }
  - skill: implement
    where: { planned: true }
    deliver: pr
    run: soon
    then: [{ loop: [review, fix], until: { verdict: approve }, max: 2 }]
  - skill: qa-evidence
    where: { planned: true }
    deliver: report
    run: soon
`

const contract = `openapi: 3.1.0
paths:
  /exports/vat: { get: { responses: { '200': { content: { text/csv: {} } } } } }
`
const shipped = `# as built\n${contract}`
const planYml = `contract: .away/out/openapi.yaml
tasks:
  - { id: api, title: VAT export endpoint, ships: [openapi.yaml] }
  - { id: web, title: Export button, after: { api: opened } }
  - { id: app, title: Export screen, repo: acme/web, after: { api: CI } }
  - { id: qa, title: QA evidence, skill: qa-evidence, repo: acme/web, after: { app: opened } }
`
const cardUrl = 'https://github.com/acme/api/issues/1'
const apiPr = 'https://github.com/acme/api/pull/11'
const appPr = 'https://github.com/acme/web/pull/13'

let minute = 0
const tick = () => `2026-10-26T08:${String(++minute).padStart(2, '0')}:00Z`

/** The feature's card as the GitHub source reads it: an issue assigned to you, labelled feature. */
const card: Item = {
  source: 'github',
  id: 'I_1',
  key: 'acme/api#1',
  type: 'issue',
  title: 'VAT export',
  description: 'Accountants want a VAT export, from the API and in the web app.',
  url: cardUrl,
  status: 'open',
  assignee: 'me',
  reviewers: [],
  labels: ['feature'],
  comments: [],
  linkedPrs: [],
  mine: true,
  fields: { repo: 'acme/api', label: ['feature'], mine: true, updated: tick(), state: 'open' },
  raw: null,
}

/** Your comment on the card, which bumps its updated time as GitHub does. */
const reply = (body: string) => {
  const at = tick()
  card.comments.push({ author: 'me', body, at, mine: true })
  card.fields.updated = at
}

// The real GitHub source's schema and fields, over the card kept in memory.
vi.spyOn(github, 'items').mockImplementation(async () => {
  const comments = [...card.comments]
  // Its prefetch counts the comments GitHub returned in `raw` against those it shows.
  return [{ ...card, comments, fields: { ...card.fields }, raw: { comments: { nodes: comments } } }]
})
vi.spyOn(github, 'write').mockImplementation(async (_cfg, _item, w: Write) => {
  const before = card.fields.updated as string
  if (w.op === 'comment') reply(w.body)
  else card.fields = { ...card.fields, label: [card.fields.label, w.to].flat(), updated: tick() }
  return { before, after: card.fields.updated as string }
})

/** The steps the agent took, as `<task> <skill>`, and what each task's implement step found in its context. */
const steps: string[] = []
const context: Record<string, Record<string, string>> = {}
const asked = new Set<string>()
const continued = new Set<string>()
const reviewed = new Set<string>()

/** The agent, scripted per skill: web asks before it builds, app goes on in a second run, api's first review wants changes, and qa reports its evidence. */
the.agent = {
  ...fakeProvider('claude'),
  async *run(job) {
    const task = /^acme-api-1-(api|web|app|qa)/.exec(job.unit.id)?.[1] ?? 'card'
    const { skill } = job.unit
    steps.push(`${task} ${skill}`)
    const out = (file: string, text: string) => writeFile(join(job.dir, '.away/out', file), text)
    const commit = async (files: Record<string, string>) => {
      for (const [file, text] of Object.entries(files)) {
        await mkdir(dirname(join(job.dir, file)), { recursive: true })
        await writeFile(join(job.dir, file), text)
      }
      await git(job.dir, 'add', '.')
      await git(job.dir, 'commit', '-qm', `${skill} ${task}`)
      await out('pr.md', `${skill} ${task}\n\nDone.`)
    }
    if (skill === 'plan') {
      await out('report.md', 'VAT export: the endpoint, its button, then the web screen.')
      await out('plan.yml', planYml)
      await out('openapi.yaml', contract)
    } else if (skill === 'implement') {
      const dir = join(job.dir, '.away/context', job.unit.id)
      context[task] = {}
      for (const file of ['item.md', 'contract/openapi.yaml', 'shipped/api/openapi.yaml'])
        if (existsSync(join(dir, file)))
          context[task][file] = await readFile(join(dir, file), 'utf8')
      const previous = join(job.dir, '.away/context/previous/report.md')
      if (existsSync(previous)) context[task].previous = await readFile(previous, 'utf8')
      if (task === 'web' && !asked.has(task)) {
        asked.add(task)
        await out('questions.md', 'Per user or per key?')
        await out('status', 'ask\n')
      } else if (task === 'api')
        await commit({
          'migrations/001.sql': 'create table vat_exports ();\n',
          'openapi.yaml': shipped,
        })
      else if (task === 'app' && !continued.has(task)) {
        continued.add(task)
        await commit({ 'app.txt': 'the screen\n' })
        await out('status', 'continue\n')
      } else if (task === 'app') {
        context.app = { ...context.app, log: (await git(job.dir, 'log', '--format=%s')).stdout }
        await commit({ 'app-export.txt': 'its export\n' })
        await out('status', 'done\n')
      } else await commit({ [`${task}.txt`]: 'done\n' })
    } else if (skill === 'review') {
      const changes = task === 'api' && !reviewed.has(task)
      reviewed.add(task)
      await out('verdict', changes ? 'changes\n' : 'approve\n')
      await out('report.md', changes ? 'Page the export.' : 'Looks good.')
    } else if (skill === 'qa-evidence') {
      await out('report.md', 'Export screen: CSV downloads, 3 screenshots attached.')
      await out('status', 'done\n')
    } else await commit({ [`${task}-paged.txt`]: 'paged\n' })
    yield { type: 'done', ok: true, turns: 1 }
  },
}

let root = ''
let path = ''
let lastRun = ''
let origins: Awaited<ReturnType<typeof originsForge>>

const daemonLog = () => readFile(watchLogPath, 'utf8').catch(() => '')
const eventsFile = () => join(root, 'events.txt')

/** Waits for a second past the last run's: a run's id is its start, and two would share a dir. */
async function nextRunId() {
  while (newRunId() <= lastRun) await sleep(100)
  return newRunId()
}

/** What a run left: its plan, its morning report's lines, the agent's steps and the notify events. */
async function ran(id: string) {
  const read = (file: string) => readFile(join(runsDir, id, file), 'utf8')
  const events = (await readFile(eventsFile(), 'utf8')).split('\n').filter(Boolean)
  await writeFile(eventsFile(), '')
  lastRun = id
  return {
    plan: await read('plan.txt'),
    report: (await read('report.md')).split('\n'),
    steps: steps.splice(0),
    events,
  }
}

/** A window run, as the daemon starts one when a window opens. */
async function windowRun() {
  const runId = await nextRunId()
  const config = await loadConfig(path)
  const log = { info: () => {}, error: () => {} }
  const signal = () => new AbortController().signal
  await executeRun({ path, config, runId, now: new Date(), present: false, log, signal })
  return ran(runId)
}

/** Starts `awaywork watch`, whose first poll starts a soon run for what's due, and stops it once that run ended. */
async function soonRun() {
  await nextRunId()
  const before = (await daemonLog()).length
  const stop = new AbortController()
  const done = watch(path, stop.signal)
  await vi.waitFor(async () => expect((await daemonLog()).slice(before)).toContain('Report: '), {
    timeout: 20_000,
  })
  stop.abort()
  await done
  const started = /soon run (\d{8}-\d{6}) started for (.*)\n/.exec(
    (await daemonLog()).slice(before),
  )
  return { ...(await ran(started?.[1] ?? '')), for: started?.[2] }
}

/** The task's PR, and whether it opened as a draft. */
const prOf = (repo: string, task: string) => {
  const head = `${repo}:away/acme-api-1-${task}`
  const [found] = origins.forge.heads[head] ?? []
  return found && { ...found, draft: origins.drafts[head] }
}

beforeAll(async () => {
  vi.stubEnv('GITHUB_OUTPUT', '')
  // CI's own hosted runner has no worker user.
  vi.stubEnv('RUNNER_ENVIRONMENT', '')
  root = await mkdtemp(join(tmpdir(), 'awaywork-pipeline-'))
  origins = await originsForge(root, ['acme/api', 'acme/web'])
  the.forge = origins.forge
  path = join(root, 'config.yml')
  await writeFile(path, configYaml(eventsFile()))
  await mkdir(join(root, 'skills/qa-evidence'), { recursive: true })
  await writeFile(
    join(root, 'skills/qa-evidence/SKILL.md'),
    '---\nname: qa-evidence\ndescription: Collect QA evidence for a task. Use when a task needs checking by hand.\n---\n\nCheck the task and report the evidence.\n',
  )
  await writeFile(eventsFile(), '')
})

// One card, run by run: each step takes the card, the forge and the state dir as the last one left them.
describe('a feature card through the whole pipeline', () => {
  it('plans in a window run, posting the plan with its contract and moving the card, then waits for your approval', async () => {
    const run = await windowRun()
    expect(run.steps).toEqual(['card plan'])
    expect(run.events.at(-1)).toMatch(/^run\b/)
    expect(run.report).toEqual(
      expect.arrayContaining([
        `- **api#1**: plan posted on ${cardUrl}, tasks api, web, app, qa`,
        '- **api#1**: on_done moved acme/api#1 to "plan-review"',
      ]),
    )
    expect(card.comments.map(commentKind)).toEqual(['plan'])
    const plan = card.comments[0]?.body
    expect(plan).toMatch(/^VAT export: the endpoint, its button, then the web screen\.\n/)
    expect(plan).toContain(`### Contract: openapi.yaml\n\n\`\`\`yaml\n${contract}\`\`\``)
    expect(plan).toContain(`\`\`\`yaml\n${planYml}\`\`\``)
    expect(card.fields.label).toEqual(['feature', 'plan-review'])

    const next = await windowRun()
    expect(next.steps).toEqual([])
    expect(next.plan).toContain(`  api#1: waiting for your approval of the plan on ${cardUrl}\n`)
  })

  it('approves the plan with your notes, as your reply on the card', async () => {
    const config = await loadConfig(path)
    expect(await approveItem('github:acme/api#1', config, 'Keep the old route.')).toBe(
      `plan approved: replied approve, with your notes, on ${cardUrl}`,
    )
    expect(card.comments.map(commentKind)).toEqual(['plan', 'approve'])
    expect(card.comments.at(-1)?.body).toMatch(/^approve\nKeep the old route\.\n/)
  })

  it('fans out in a soon run: api opens a gated draft after its review loop, web says ask, app waits for the check', async () => {
    const run = await soonRun()
    expect(run.for).toBe('acme-api-1-api, acme-api-1-web')
    expect(run.steps).toEqual([
      'api implement',
      'api review',
      'api fix',
      'api review',
      'web implement',
    ])
    expect(context.api?.['contract/openapi.yaml']).toBe(contract)
    expect(context.api?.['item.md']).toContain('Your notes on approving it:\n\nKeep the old route.')

    const api = prOf('acme/api', 'api')
    expect(api?.draft).toBe(true)
    expect(api?.body).toMatch(
      /^## Needs a decision\n\n### Gates \(from scripts\)\n\n- schema: migrations\/001\.sql\n\n---\n\nDone\.\n/,
    )
    expect(api?.body).toContain('Loop: 2 rounds of review ⇄ fix; until held: verdict approve')
    expect(api?.body).toContain(`Part of ${cardUrl}`)
    expect(api?.body).not.toMatch(/closes/i)

    expect(prOf('acme/api', 'web')).toBeUndefined()
    // api's PR is its result; web's step said ask, so its questions follow.
    expect(card.comments.map(commentKind)).toEqual(['plan', 'approve', 'questions'])
    expect(card.comments.at(-1)?.body).toMatch(
      /^Questions from task web\n\nPer user or per key\?\n/,
    )
    expect(run.plan).toContain("  acme/api#1/app: waiting for api's check CI (no PR yet)\n")

    expect(run.report).toEqual(
      expect.arrayContaining([
        `| 1 | [acme/api#1/api VAT export endpoint](${cardUrl}) | implement → loop(review ⇄ fix) | claude | done, 4 turns (loop: 2 rounds of review ⇄ fix; until held: verdict approve) | ${apiPr} (2 commits, draft: gate schema fired), verdict approve |`,
        `| 2 | [acme/api#1/web Export button](${cardUrl}) | implement → loop(review ⇄ fix) | claude | done, 1 turn (loop: 0 rounds of review ⇄ fix; nothing ran) | asked questions |`,
        '- **acme/api#1/api**: - schema: migrations/001.sql',
        `- **acme/api#1/web**: questions posted on ${cardUrl}`,
        "- api#1: fanned out: api no PR yet, web no PR yet, app waits for api's check CI, qa no result yet",
      ]),
    )
    // A soon run notifies each step, never the run's end.
    expect(run.events).toEqual([
      'unit acme-api-1-api done',
      'unit acme-api-1-api-review-1 done',
      'unit acme-api-1-api-fix-1 done',
      'unit acme-api-1-api-review-2 done',
      'unit acme-api-1-web done',
      'unit acme-api-1-web-review-1 skipped',
      'unit acme-api-1-web-fix-1 skipped',
    ])
  }, 30_000)

  it("holds the whole feature while web's questions wait", async () => {
    const run = await windowRun()
    expect(run.steps).toEqual([])
    for (const task of ['api', 'web', 'app', 'qa'])
      expect(run.plan).toContain(
        `  acme/api#1/${task}: waiting for your answer to task web's questions on ${cardUrl}\n`,
      )
    expect(run.plan).toContain(
      '  api#1: fanned out: api waits for your answer, web waits for your answer, app waits for your answer, qa waits for your answer\n',
    )
  })

  it("resumes web on your answer, while app waits for api's unreported check", async () => {
    reply('Per key.')
    const run = await soonRun()
    expect(run.for).toBe('acme-api-1-web')
    expect(run.steps).toEqual(['web implement', 'web review'])
    expect(run.plan).toContain('     after api, stacks on #11\n')
    expect(run.plan).toContain("  acme/api#1/app: waiting for api's check CI (not reported)\n")
    expect(context.web?.['item.md']).toMatch(/\n### me, \S+\n\nPer key\.\n$/)
    const web = prOf('acme/api', 'web')
    expect(origins.bases['acme/api:away/acme-api-1-web']).toBe('away/acme-api-1-api')
    expect(origins.stacked).toEqual([[apiPr, web?.url]])
    expect(web?.draft).toBe(false)
    expect(web?.body).toMatch(/^Gates: none fired \(schema\)\n\n---\n\nDone\.\n/)
    expect(web?.body).toContain(`Stacked on ${apiPr}: merge that first.`)
    expect(run.events).toEqual(['unit acme-api-1-web done', 'unit acme-api-1-web-review-1 done'])
  }, 30_000)

  it('runs app once CI passed, in acme/web with what api ships: it says continue, so its draft records it and qa waits', async () => {
    origins.forge.states['acme/api#11'] = { CI: 'passed' }
    const run = await soonRun()
    expect(run.for).toBe('acme-api-1-app, acme-api-1-qa')
    expect(run.steps).toEqual(['app implement'])
    expect(run.plan).toContain("     after api's check CI (passed)\n")

    expect(context.app).toMatchObject({
      'contract/openapi.yaml': contract,
      'shipped/api/openapi.yaml': shipped,
    })
    const app = prOf('acme/web', 'app')
    expect(origins.bases['acme/web:away/acme-api-1-app']).toBe('main')
    expect(app?.draft).toBe(true)
    expect(app?.body).toMatch(
      /^Status: continue \(1 of 3\): awaywork's next window run goes on here\n\nGates: none fired \(schema\)\n\n---\n\nDone\.\n/,
    )
    expect(app?.body).toContain(`status=continue continued=1 head=${app?.head} from=`)
    // A PR task's PR is its result, and qa stacks on no half-done work.
    expect(card.comments.map(commentKind)).toEqual(['plan', 'approve', 'questions', undefined])
    expect(run.report).toEqual(
      expect.arrayContaining([
        `| 1 | [acme/api#1/app Export screen](${cardUrl}) | implement → loop(review ⇄ fix) | claude | done, 1 turn (loop: 0 rounds of review ⇄ fix; nothing ran) | ${appPr} (1 commit, draft: the agent will continue) |`,
        `| 2 | [acme/api#1/qa QA evidence](${cardUrl}) | qa-evidence | - | skipped | app left a draft that says continue |`,
      ]),
    )
    expect(run.events).toEqual([
      'unit acme-api-1-app done',
      'unit acme-api-1-app-review-1 skipped',
      'unit acme-api-1-app-fix-1 skipped',
      'unit acme-api-1-qa skipped',
    ])
  }, 30_000)

  it("goes on with app in the next window run on its own draft, which turns ready once it's done, and qa reports on it", async () => {
    const before = prOf('acme/web', 'app')
    const run = await windowRun()
    expect(run.plan).toContain(
      `     goes on with its draft ${appPr}, which said continue (1 of 3)\n`,
    )
    expect(run.plan).toContain('     after app, stacks on its PR\n')
    expect(run.steps).toEqual(['app implement', 'app review', 'qa qa-evidence'])
    // The same branch and PR, from where the first run left it, with that run's draft body as its report.
    expect(context.app?.log).toBe('implement app\ninit')
    expect(context.app?.previous).toMatch(/^Status: continue \(1 of 3\)/)
    const app = prOf('acme/web', 'app')
    expect(app?.url).toBe(before?.url)
    expect(origins.forge.heads['acme/web:away/acme-api-1-app']).toHaveLength(1)
    expect(origins.updated).toEqual(['acme/web#13 ready'])
    expect(app?.draft).toBe(false)
    expect(app?.body).toMatch(/^Gates: none fired \(schema\)\n\n---\n\nDone\.\n/)
    expect(app?.body).not.toContain('status=')
    expect(app?.head).not.toBe(before?.head)

    // qa opens no PR: its report is its result on the card, and that result says it's done.
    expect(card.comments.map(commentKind)).toEqual([
      'plan',
      'approve',
      'questions',
      undefined,
      'result',
    ])
    expect(card.comments.at(-1)?.body).toBe(
      'Result of task qa\n\nExport screen: CSV downloads, 3 screenshots attached.\n\nStatus: done\n\n— awaywork',
    )
    expect(run.report).toEqual(
      expect.arrayContaining([
        `| 1 | [acme/api#1/app Export screen](${cardUrl}) | implement → loop(review ⇄ fix) | claude | done, 2 turns (loop: 1 round of review ⇄ fix; until held: verdict approve) | ${appPr} (1 commit, ready for review), verdict approve |`,
        `- **acme/api#1/qa**: result posted on ${cardUrl}`,
      ]),
    )
    expect(run.events).toEqual([
      'unit acme-api-1-app done',
      'unit acme-api-1-app-review-1 done',
      'unit acme-api-1-qa done',
      expect.stringMatching(/^run\b/),
    ])
  }, 30_000)

  it('needs you once every PR merged, api first, then the stack, then app, and qa reported done', async () => {
    const waiting = await windowRun()
    expect(waiting.plan).toContain(`  acme/api#1/qa: done: its result is on ${cardUrl}\n`)
    expect(waiting.plan).toContain(
      '  api#1: fanned out: api PR open, web PR open, app PR open, qa done\n',
    )
    await origins.merge('acme/api', 'away/acme-api-1-api')
    await origins.merge('acme/api', 'away/acme-api-1-web')
    await origins.merge('acme/web', 'away/acme-api-1-app')
    const run = await windowRun()
    expect(run.steps).toEqual([])
    expect(run.plan).toContain('  api#1: all tasks done: close or move the card\n')
    expect(run.plan).toContain('  acme/api#1/app: merged in https://github.com/acme/web/pull/13\n')
    expect(run.plan).toContain(`  acme/api#1/qa: done: its result is on ${cardUrl}\n`)
  })
})
