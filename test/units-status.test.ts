import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { builtinSkillsDir } from '../src/config/paths.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Provider } from '../src/core/types.js'
import { summarize } from '../src/format/report.js'
import { GITHUB_ONLY } from '../src/plan/attempts.js'
import { planRun } from '../src/plan/foreman.js'
import { markComment, questionsComment, resultComment } from '../src/posts/comments.js'
import { formatReport } from '../src/posts/report.js'
import { allowance } from '../src/quota/budget.js'
import { runUnits } from '../src/worker/units.js'
import { cardAndPr, githubPr, issue, yours } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'
import { asker, committer, finishedRun, git, looper, originForge } from './fakes/units.js'

it("posts a step's questions once on your item, marked, and ends the chain without moving it", async () => {
  const { report, writes, lines } = await finishedRun(
    '  - { skill: implement, on_done: { move: QA }, then: [review] }',
    [yours(1)],
    asker('1. Per user or per key?\n'),
  )
  expect(writes).toEqual([
    [
      'acme/api#1',
      {
        op: 'comment',
        body: "1. Per user or per key?\n\nReply here to answer: awaywork's next run takes this up again with your reply.\n\n— awaywork",
      },
    ],
  ])
  const [head, review] = report.results
  expect(head?.questions).toEqual({
    step: 'acme-api-1',
    text: '1. Per user or per key?',
    item: 'github:acme/api#1',
    url: 'https://example.com/1',
  })
  expect(head?.made).toBe('questions')
  expect(head?.outcome).toEqual({ kind: 'none', reason: 'asked questions' })
  expect(review).toMatchObject({ status: 'skipped', reason: 'acme-api-1 asked questions' })
  expect(lines).toContain('acme-api-1: questions posted on https://example.com/1')
  const text = formatReport(report)
  expect(text).toContain('- **api#1**: questions posted on https://example.com/1')
  expect(text).toMatch(/\| done, 1 turn \| asked questions \|$/m)
  expect(text).toContain('## Questions\n\n### api#1: Fix the thing (acme-api-1)')
  expect(summarize(report, 'report.md')).toContain('     questions posted on https://example.com/1')
})

it('asks on the item on_done would move, and links the comment when the source returns it', async () => {
  const named = await finishedRun(
    '  - { skill: review, source: tracker, deliver: report }\n  - { skill: review, deliver: report }',
    cardAndPr(),
    asker('Which?'),
  )
  expect(named.writes.map(([key]) => key)).toEqual(['ENG-1'])
  expect(named.report.results[0]?.outcome).toEqual({ kind: 'none', reason: 'asked questions' })
  const commented = async () => ({ url: 'https://example.com/2#issuecomment-9' })
  const unnamed = await finishedRun(
    '  - { skill: review, deliver: report }',
    cardAndPr(),
    asker('Which?'),
    commented,
  )
  expect(unnamed.report.results[0]?.questions).toMatchObject({
    item: 'github:acme/api#2',
    url: 'https://example.com/2#issuecomment-9',
  })
  expect(unnamed.lines).toContain(
    'acme-api-2: questions posted on https://example.com/2#issuecomment-9',
  )
})

it('keeps the questions in the report when the item is not yours or its source cannot write', async () => {
  const someone = await finishedRun('  - skill: implement', [issue(3)], asker('Which?'))
  expect(someone.writes).toEqual([])
  expect(someone.report.results[0]?.questions).toEqual({
    step: 'acme-api-3',
    text: 'Which?',
    unposted: 'acme/api#3 not yours',
  })
  expect(formatReport(someone.report)).toContain(
    'questions not posted: acme/api#3 not yours\n\nWhich?',
  )
  const mute = await finishedRun('  - skill: implement', [yours(1)], asker('Which?'), null)
  expect(mute.report.results[0]?.questions?.unposted).toBe(
    "acme/api#1 github can't write to its items",
  )
})

it("reports a post that failed, its secrets masked, and doesn't fail the unit", async () => {
  const { report, lines } = await finishedRun(
    '  - skill: implement',
    [yours(1)],
    asker('Which?'),
    async () => {
      throw new Error('403 for s3cret')
    },
  )
  expect(report.results[0]?.status).toBe('done')
  expect(report.results[0]?.questions).toMatchObject({
    item: 'github:acme/api#1',
    unposted: '403 for ***',
  })
  expect(lines).toContain(`acme-api-1: couldn't post its questions on acme/api#1: 403 for ***`)
})

it('asks nothing for a step that committed: its questions stay in its out folder', async () => {
  const { report, writes } = await finishedRun(
    '  - skill: implement',
    [yours(1)],
    asker('Which?', true),
  )
  expect(writes).toEqual([])
  expect(report.results[0]?.questions).toBeUndefined()
  expect(report.results[0]?.outcome?.kind).toBe('pr')
})

it('asks for a step that committed when its status says ask: its commits open as a draft that records it', async () => {
  const { report, writes, opened } = await finishedRun(
    '  - { skill: implement, deliver: pr, on_done: { move: QA }, then: [review] }',
    [yours(1)],
    asker('Which?', true, 'ask\n'),
  )
  const [head, review] = report.results
  expect(head?.outcome).toMatchObject({ kind: 'pr', commits: 1, draft: 'asked questions' })
  expect(head?.outcome).not.toHaveProperty('ready')
  expect(opened[0]?.body).toMatch(
    /^Add a\n\nStatus: ask, questions on https:\/\/example\.com\/1\n\n---\n\nDone\.\n/,
  )
  expect(opened[0]?.left).toMatchObject({ status: 'ask', continued: 0 })
  expect(head?.summary).toBe('Done.')
  expect(head?.questions).toMatchObject({ text: 'Which?', url: 'https://example.com/1' })
  expect(head?.made).toBe('1 commit and questions')
  expect(review).toMatchObject({ status: 'skipped', reason: 'acme-api-1 asked questions' })
  // Asking isn't finishing: on_done doesn't run.
  expect(writes.map(([, w]) => w.op)).toEqual(['comment'])
})

it('pushes the commits of a step whose status says ask onto your PR, and asks', async () => {
  const { report, writes } = await finishedRun(
    '  - { skill: fix, deliver: push, on_done: { move: QA } }',
    [{ ...githubPr(2), mine: true }],
    asker('Which?', true, 'ask'),
  )
  const url = 'https://github.com/acme/api/pull/2'
  expect(report.results[0]?.outcome).toMatchObject({
    kind: 'pushed',
    commits: 1,
    text: `Status: ask, questions on ${url}\n\n---\n\nAdd a\n\nDone.`,
  })
  expect(report.results[0]?.summary).toBe('Add a')
  expect(report.results[0]?.questions).toMatchObject({ text: 'Which?', url })
  expect(writes.map(([, w]) => w.op)).toEqual(['comment'])
})

it('opens a ready PR, untouched, when a later step asks without a status file', async () => {
  const builtThenAsked: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      if (job.unit.skill === 'implement')
        yield* asker('', true).run(job, new AbortController().signal)
      else {
        await writeFile(join(job.dir, '.away/out/questions.md'), 'Which?')
        yield { type: 'done', ok: true, turns: 1 }
      }
    },
  }
  const { report, opened } = await finishedRun(
    '  - { skill: implement, deliver: pr, then: [review] }',
    [yours(1)],
    builtThenAsked,
  )
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', ready: true })
  expect(report.results[1]?.questions).toBeUndefined()
  expect(report.results[0]?.questions).toMatchObject({ text: 'Which?' })
  expect(opened[0]?.body).toMatch(/^Add a\n\nDone\./)
  expect(opened[0]?.left).toBeUndefined()
})

it('reads a status it does not know, or ask without questions, as no status file', async () => {
  const unknown = await finishedRun(
    '  - skill: implement',
    [yours(1)],
    asker('Which?', true, 'Maybe\nmore'),
  )
  expect(unknown.report.results[0]?.questions).toBeUndefined()
  expect(unknown.lines).toContain(
    'acme-api-1: status "maybe" isn\'t done, ask or continue, read as none',
  )
  // Going on needs the commits of a draft to keep its count in.
  const idle = await finishedRun('  - skill: implement', [yours(1)], asker('', false, 'continue'))
  expect(idle.lines).toContain(
    'acme-api-1: status continue with nothing to go on from, read as none',
  )
  expect(idle.opened).toEqual([])
  const empty = await finishedRun('  - skill: implement', [yours(1)], asker('', true, 'ask'))
  expect(empty.report.results[0]?.outcome).toMatchObject({ kind: 'pr', commits: 1 })
  expect(empty.report.results[0]?.questions).toBeUndefined()
  expect(empty.lines).toContain('acme-api-1: status ask without questions.md, read as none')
  const done = await finishedRun('  - skill: implement', [yours(1)], asker('Which?', false, 'done'))
  expect(done.report.results[0]?.questions).toMatchObject({ text: 'Which?' })
})

it('stops the chain on continue, its commits opening as a draft whose footer counts it, and writes nothing to the item', async () => {
  const { report, writes, opened } = await finishedRun(
    '  - { skill: implement, deliver: pr, on_done: { comment: result, move: QA }, then: [review] }',
    [yours(1)],
    asker('', true, 'continue\n'),
  )
  const [head, review] = report.results
  expect(head?.outcome).toMatchObject({
    kind: 'pr',
    commits: 1,
    draft: 'the agent will continue',
    held: 'continue',
  })
  expect(opened[0]?.body).toMatch(
    /^Add a\n\nStatus: continue \(1 of 3\): awaywork's next window run goes on here\n\n---\n\nDone\.\n/,
  )
  const pushed = head?.outcome?.kind === 'pr' ? head.outcome.head : ''
  expect(opened[0]?.left).toMatchObject({
    status: 'continue',
    continued: 1,
    head: pushed,
    from: expect.any(String),
  })
  expect(review).toMatchObject({ status: 'skipped', reason: 'acme-api-1 will continue' })
  expect(writes).toEqual([])
  expect(formatReport(report)).toContain('(1 commit, draft: the agent will continue)')
})

it("leaves a draft to you where awaywork can't push onto it, but posts an ask without commits", async () => {
  const queue =
    '  - { skill: implement, deliver: pr, on_done: { comment: result, move: QA }, then: [review] }'
  const byHand = `${GITHUB_ONLY}: finish https://example.com/acme/api/pull/away/acme-api-1 by hand`
  for (const status of ['continue', 'ask'] as const) {
    const asked = status === 'ask' ? 'Which?' : ''
    const { report, writes, opened } = await finishedRun(
      queue,
      [yours(1)],
      asker(asked, true, status),
      undefined,
      GITHUB_ONLY,
    )
    const [head, review] = report.results
    // Its footer still records the status, so dependents wait; no line promises a later run.
    expect(opened.map((o) => [o.head, o.left?.status])).toEqual([['away/acme-api-1', status]])
    expect(opened[0]?.body).toMatch(/^Add a\n\nDone\.\n/)
    expect(head?.outcome).toMatchObject({
      kind: 'pr',
      draft: GITHUB_ONLY,
      held: status,
    })
    if (status === 'ask')
      expect(head?.questions).toMatchObject({ text: 'Which?', unposted: byHand })
    else {
      expect(head?.byHand).toBe(byHand)
      expect(review).toMatchObject({ status: 'skipped', reason: 'acme-api-1 said continue' })
    }
    expect(writes).toEqual([])
  }
  const { report, writes } = await finishedRun(
    queue,
    [yours(1)],
    asker('Which?', false, 'ask'),
    undefined,
    GITHUB_ONLY,
  )
  expect(report.results[0]?.questions).toMatchObject({ text: 'Which?', url: expect.any(String) })
  expect(writes.map(([, w]) => w.op)).toEqual(['comment'])
})

it("posts a report's continue as its result, counted on from the last, with that result as its report", async () => {
  const seen: string[] = []
  const reporter: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      seen.push(await readFile(join(job.dir, '.away/context/previous/report.md'), 'utf8'))
      seen.push(await readFile(join(job.dir, '.away/prompt.md'), 'utf8'))
      await writeFile(join(job.dir, '.away/out/report.md'), 'Two more screens.')
      await writeFile(join(job.dir, '.away/out/status'), 'continue')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const earlier = {
    author: 'me',
    body: markComment(resultComment('Half the screens.', 'continue', 'qa', undefined, 1)),
    at: '2026-10-23T00:00:00Z',
    mine: true as const,
  }
  const { report, writes } = await finishedRun(
    '  - { skill: review, deliver: report, on_done: { comment: result, move: QA } }',
    [{ ...yours(1), comments: [earlier] }],
    reporter,
  )
  expect(seen[0]).toBe('Half the screens.\n')
  expect(seen[1]).toContain(
    'An earlier run of this unit said `continue` (1 of 3 times so far): go on from where its report stopped.',
  )
  expect(writes).toEqual([
    [
      'acme/api#1',
      {
        op: 'comment',
        body: 'Result of review\n\nTwo more screens.\n\nStatus: continue (2 of 3)\n\n— awaywork',
      },
    ],
  ])
  expect(report.results[0]?.moved).toBeUndefined()
})

/** Runs `implement` on your issue whose open draft, on `away/acme-api-1`, awaywork left saying `status` after `continued` continues, answered when it asked; `meanwhile` runs between plan and run, given the PRs marked ready. */
async function resumed(
  status: 'ask' | 'continue',
  provider: Provider,
  meanwhile?: (origin: string, readied: Set<number>) => Promise<unknown>,
  continued = 1,
) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-resume-'))
  const { origin, opened, updated, readied, forge } = await originForge(root)
  const from = (await git(origin, 'rev-parse', 'main')).stdout
  const left = (await git(origin, 'commit-tree', '-p', 'main', '-m', 'Add a', 'main^{tree}')).stdout
  await git(origin, 'update-ref', 'refs/heads/away/acme-api-1', left)
  const url = 'https://github.com/acme/api/pull/7'
  const comments =
    status === 'ask'
      ? [
          {
            author: 'me',
            body: markComment(questionsComment('Which?')),
            at: 't1',
            mine: true as const,
          },
          { author: 'sam', body: 'Per key.', at: 't2' },
        ]
      : []
  const item: Item = {
    ...yours(1),
    comments,
    linkedPrs: [
      {
        repo: 'acme/api',
        number: 7,
        url,
        branch: 'away/acme-api-1',
        head: left,
        ours: true,
        mine: true,
        trusted: true,
        fork: false,
        left: { status, continued, head: left, from, items: ['github:acme/api#1'] },
      },
    ],
  }
  const config = parseConfig(`
providers: [claude: {}]
repos: { acme/*: {} }
sources: { github: {} }
queue:
  - { skill: implement, deliver: pr }
`)
  const plan = planRun({
    config,
    items: [item],
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  await meanwhile?.(origin, readied)
  const runDir = join(root, 'run')
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r2',
    runDir,
    dryRun: false,
    providers: { claude: provider },
    sources: { github: fakeSource() },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const log = (await git(origin, 'log', '--format=%s', 'away/acme-api-1')).stdout.split('\n')
  const prompt = await readFile(join(runDir, 'units/acme-api-1/1-implement/prompt.md'), 'utf8')
  return { report, opened, updated, log, left, from, url, prompt }
}

it('goes on with its own draft once its questions are answered, fast-forwarding it and marking it ready', async () => {
  const { report, opened, updated, log, url, prompt } = await resumed('ask', looper({}))
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', url, commits: 1, ready: true })
  expect(opened).toEqual([])
  expect(log).toEqual(['Work on acme-api-1', 'Add a', 'init'])
  expect(updated).toEqual([
    {
      pr: 7,
      ready: true,
      body: expect.stringMatching(/^Add rate limits\n\nDone\.\n\nCloses acme\/api#1\n$/),
    },
  ])
  expect(prompt).toContain(
    `You are on \`away/acme-api-1\`, the branch of awaywork's own draft ${url} for this unit, which an earlier run left because it asked questions, answered since in the item's comments.`,
  )
})

it('leaves its draft untouched when the forge refuses it mid-run, committed or not', async () => {
  const answered: Provider = {
    ...fakeProvider('claude'),
    async *run(job) {
      await writeFile(join(job.dir, '.away/out/pr.md'), 'Add a\n\nNothing more to do.')
      await writeFile(join(job.dir, '.away/out/status'), 'done')
      yield { type: 'done', ok: true, turns: 1 }
    },
  }
  const commitYours = (origin: string) =>
    git(origin, 'commit-tree', '-p', 'away/acme-api-1', '-m', 'Mine', 'main^{tree}').then(
      ({ stdout }) => git(origin, 'update-ref', 'refs/heads/away/acme-api-1', stdout),
    )
  const markReady = async (_origin: string, readied: Set<number>) => readied.add(7)
  for (const [status, worker, meanwhile, refused, kept] of [
    ['ask', answered, commitYours, 'away/acme-api-1 moved', ['Mine', 'Add a', 'init']],
    ['continue', committer, markReady, '#7 was marked ready', ['Add a', 'init']],
  ] as const) {
    const { report, updated, log } = await resumed(status, worker, meanwhile)
    expect(report.results[0]?.outcome).toEqual({
      kind: 'none',
      reason: `${refused}, not pushed`,
      unpublished: true,
    })
    expect(updated).toEqual([])
    expect(log).toEqual(kept)
  }
})

it('goes on with its own draft on continue, counting it on, a draft while it says continue, and yours at the cap', async () => {
  const again = asker('', true, 'continue')
  const { report, updated, log, from } = await resumed('continue', again)
  expect(report.results[0]?.outcome).toMatchObject({
    kind: 'pr',
    held: 'continue',
    draft: 'the agent will continue',
  })
  expect(log).toEqual(['Add a', 'Add a', 'init'])
  const head = report.results[0]?.outcome?.kind === 'pr' ? report.results[0].outcome.head : ''
  expect(updated).toEqual([
    {
      pr: 7,
      ready: false,
      body: expect.stringMatching(/^Add a\n\nStatus: continue \(2 of 3\)/),
      left: { status: 'continue', continued: 2, head, from },
    },
  ])
  // The third continue reaches the cap: no later run goes on, so the draft is yours, its footer still holding dependents.
  const capped = await resumed('continue', again, undefined, 2)
  const byHand = 'it continued 3 times'
  expect(capped.report.results[0]?.outcome).toMatchObject({ draft: byHand, held: 'continue' })
  expect(capped.report.results[0]?.byHand).toBe(`${byHand}: finish ${capped.url} by hand`)
  expect(capped.updated[0]?.body).toMatch(/^Add a\n\nDone\./)
  expect(capped.updated[0]?.left).toMatchObject({ status: 'continue', continued: 3 })
})

it('posts no questions over the comment limit, and keeps them in the report', async () => {
  const long = 'x'.repeat(30_001)
  const { report, writes } = await finishedRun('  - skill: implement', [yours(1)], asker(long))
  expect(writes).toEqual([])
  expect(report.results[0]?.questions).toEqual({
    step: 'acme-api-1',
    text: long,
    unposted: 'questions.md is over 30000 bytes',
  })
})
