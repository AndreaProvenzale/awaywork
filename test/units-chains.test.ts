import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import { recordAttempts } from '../src/core/attempts.js'
import { unitStats } from '../src/core/stats.js'
import type { Provider } from '../src/core/types.js'
import { fakeItem, githubPr, issue } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { git, looper, loopRun } from './fakes/units.js'

it('tells a step to write the PR body until one wrote it, and to keep it after', async () => {
  const provider = looper({ 'acme-api-1-review-2': 'approve' })
  const prompts: Record<string, string> = {}
  await loopRun(
    `queue:
  - skill: plan
    then: { loop: [implement, review], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      run(job, signal) {
        prompts[job.unit.id] = job.prompt
        return provider.run(job, signal)
      },
    },
  )

  const first = prompts['acme-api-1-implement-1']
  expect(first).toContain('Commit on this branch and write `.away/out/pr.md`, the PR body.')
  expect(first).toContain('The step before, `plan`, left its output in `.away/context/previous/`')
  expect(prompts['acme-api-1-implement-2']).toContain(
    'Commit on this branch and keep `.away/out/pr.md` current: it holds what the chain did so far, the PR body.',
  )
})

it('publishes nothing when interrupted, and retries the chain without counting a failure', async () => {
  const stop = new AbortController()
  const provider = looper({})
  const item = fakeItem({
    source: 'github',
    id: '1',
    key: 'acme/api#1',
    type: 'issue',
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [implement, review], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      run(job, signal) {
        if (job.unit.id === 'acme-api-1-review-1') stop.abort()
        return provider.run(job, signal)
      },
    },
    { signal: stop.signal },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-implement-1', 'done'],
    ['acme-api-1-review-1', 'stopped: aborted'],
  ])
  expect(report.results[0]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it('lists and sums up the joined report a committing chain published when it committed nothing', async () => {
  const provider = looper({})
  const { report } = await loopRun('queue: [{ skill: plan, then: [implement] }]', [issue(1)], {
    ...provider,
    async *run(job, signal) {
      if (job.unit.deliver === 'report') yield* provider.run(job, signal)
      else {
        await writeFile(
          join(job.dir, '.away/out/pr.md'),
          'No change\n\nThe plan was already done upstream.',
        )
        yield { type: 'done', ok: true, turns: 1 }
      }
    },
  })

  expect(report.results[0]).toMatchObject({
    outcome: { kind: 'report', text: 'acme-api-1 says nothing.' },
    summary: 'acme-api-1 says nothing.',
  })
  expect(report.results[0]?.files?.sliceBody).toBe('units/acme-api-1/out/report.md')
})

it('ends a chain at a step that failed, still reports what it has, and counts a failure', async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-fix-1') yield { type: 'done', ok: false, turns: 1 }
        else yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'report' })
  expect(report.results[0]?.loop).toBe('1 round of review ⇄ fix; acme-api-1-fix-1 failed')
  expect(Object.values(recordAttempts({}, report))).toEqual([
    expect.objectContaining({ skill: 'plan', failed: 1 }),
  ])
})

it("publishes what a chain has at the window's end, and retries it without counting a failure", async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1') until.setTime(0)
      },
    },
    { until },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'report' })
  expect(report.results[2]).toMatchObject({ status: 'skipped', reason: 'the window ended' })
  expect(recordAttempts({}, report)).toEqual({})
})

it("turns the chain's first step into an error when its publish fails, and counts a failure", async () => {
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - { skill: implement, then: review }
`,
    [item],
    looper({}),
    { forge: { push: async () => Promise.reject(new Error('push refused')) } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'error', 'push refused'],
    ['acme-api-1-review', 'done', undefined],
  ])
  expect(unitStats(report.results).map((s) => s.status)).toEqual(['failed', 'done'])
  expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
})

it('counts a failure for a loop host whose publish was refused, though a round reached the window end', async () => {
  const provider = looper({})
  const until = new Date(Date.now() + 60 * 60 * 1000)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review], until: { verdict: approve }, max: 1 }
`,
    [item],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        await rm(join(job.dir, '.away/out/pr.md'), { force: true })
        until.setTime(0)
      },
    },
    { until },
  )

  expect(report.results[0]?.outcome).toMatchObject({ kind: 'none', unpublished: true })
  expect(report.results[1]).toMatchObject({ status: 'skipped', reason: 'the window ended' })
  expect(recordAttempts({}, report)['github:acme/api#1']).toMatchObject({ failed: 1 })
})

it('runs the whole loop for a step after it that --unit names', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 2 }
      - plan
`,
    [issue(1), issue(2)],
    looper({ 'acme-api-1-review-1': 'approve' }),
    { only: 'acme-api-1-plan' },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review-1', 'done'],
    ['acme-api-1-plan', 'done'],
  ])
})

it('ends a chain at a step that threw, naming it, and publishes what it has', async () => {
  const provider = looper({})
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1') throw new Error('crashed')
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'error', 'crashed'],
    ['acme-api-1-review-1', 'skipped', 'acme-api-1 error: crashed'],
    ['acme-api-1-fix-1', 'skipped', 'acme-api-1 error: crashed'],
  ])
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', commits: 1 })
})

it('runs a loop right after a loop, and the steps after a loop that a step left nothing in', async () => {
  const provider = looper({})
  const { report, opened } = await loopRun(
    `queue:
  - skill: plan
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 3 }
      - { loop: implement, until: { verdict: approve }, max: 2 }
      - review
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-fix-1') yield { type: 'done', ok: true, turns: 1 }
        else yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.made])).toEqual([
    ['acme-api-1', 'done', 'a report'],
    ['acme-api-1-review-1', 'done', 'a report'],
    ['acme-api-1-fix-1', 'done', 'nothing'],
    ['acme-api-1-implement-1', 'done', '1 commit'],
    ['acme-api-1-implement-2', 'done', '1 commit'],
    ['acme-api-1-review', 'done', 'a report'],
  ])
  expect(report.results[0]?.loop).toBe(
    '1 round of review ⇄ fix; acme-api-1-fix-1 committed nothing; 2 rounds of implement; max 2 rounds reached',
  )
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'pr', commits: 2 })
  expect(opened[0]?.body).toContain(
    'Loop: 1 round of review ⇄ fix; acme-api-1-fix-1 committed nothing.\n\nLoop: 2 rounds of implement; max 2 rounds reached.',
  )
})

it('waits for a verdict written in the loop before `until: { verdict: { not } }` holds', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix, review], until: { verdict: { not: changes } }, max: 2 }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'approve' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.loop])).toEqual([
    ['acme-api-1', 'done', '1 round of fix ⇄ review; until held: verdict not changes'],
    ['acme-api-1-fix-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
  ])
})

it('ends a chain whose clone a step broke, fails its publish, and still finishes the run', async () => {
  const provider = looper({})
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-review-1')
          await git(job.dir, 'checkout', '-q', '--orphan', 'gone')
        yield* provider.run(job, signal)
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'error'],
    ['acme-api-1-review-1', 'error'],
  ])
  expect(report.results[0]?.loop).toMatch(/^1 round of review ⇄ fix; acme-api-1-review-1 error: /)
  expect(report.results[0]?.reason).toMatch(/unknown revision/)
  expect(opened).toEqual([])
})

it("hands a round off without running the clone's diff command or writing through its symlinks", async () => {
  const stop = new AbortController()
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  const marker = join(root, 'ran')
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        if (job.unit.id === 'acme-api-1-review-1') {
          await writeFile(join(root, 'diff.sh'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
          await git(job.dir, 'config', 'diff.external', join(root, 'diff.sh'))
        }
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await symlink(outside, join(job.dir, '.away/out/diff.patch'))
      },
    },
    {
      runDir: join(root, 'run'),
      signal: stop.signal,
      ctx: {
        env: {},
        log: (line) => {
          if (line === 'acme-api-1-fix-1: done') stop.abort()
        },
      },
    },
  )

  expect(existsSync(marker)).toBe(false)
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
  const patch = join(root, 'run/units/acme-api-1/3-fix/out/diff.patch')
  expect(await readFile(patch, 'utf8')).toContain('+++ b/acme-api-1-fix-1.txt')
})

it('refuses to publish a loop whose PR body a round turned into a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1') {
          const body = join(job.dir, '.away/out/pr.md')
          await rm(body)
          await symlink(outside, body)
        }
      },
    },
  )

  expect(report.results[0]?.status).toBe('error')
  expect(report.results[0]?.reason).toBe('.away/out/pr.md in the clone is a symlink')
  expect(opened).toEqual([])
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
})

it("ends a loop whose clone a round symlinked, before the next round's workspace touches it", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  await mkdir(join(root, 'previous'))
  await writeFile(join(root, 'previous', 'keep'), 'mine\n')
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1') {
          await rm(join(job.dir, '.away/context'), { recursive: true })
          await symlink(root, join(job.dir, '.away/context'))
        }
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'error', '.away/context in the clone is a symlink'],
  ])
  expect(await readFile(join(root, 'previous', 'keep'), 'utf8')).toBe('mine\n')
})

it("keeps awaywork's replay.json and worker.log in the unit dir over the ones a worker wrote", async () => {
  const runDir = join(await mkdtemp(join(tmpdir(), 'awaywork-forged-')), 'run')
  const provider = looper({})
  await loopRun(
    'queue:\n  - skill: implement\n',
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        await writeFile(join(job.dir, '.away/replay.json'), '{"forged":true}')
        await writeFile(join(job.dir, '.away/worker.log'), 'FORGED LOG')
      },
    },
    { runDir },
  )

  const unitDir = join(runDir, 'units/acme-api-1/1-implement')
  const state = JSON.parse(await readFile(join(unitDir, 'replay.json'), 'utf8'))
  expect(state.unit.id).toBe('acme-api-1')
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).not.toContain('FORGED')
  expect(existsSync(join(unitDir, 'out/pr.md'))).toBe(true)
})

it("leaves an agent's own HOME in the clone, out of the unit dir", async () => {
  const runDir = join(await mkdtemp(join(tmpdir(), 'awaywork-agent-home-')), 'run')
  const provider = looper({})
  await loopRun(
    'queue:\n  - skill: implement\n',
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        await mkdir(join(job.dir, '.away/agent-home/.cursor'), { recursive: true })
        await writeFile(join(job.dir, '.away/agent-home/.cursor/chats'), 'TRANSCRIPT')
      },
    },
    { runDir },
  )

  const unitDir = join(runDir, 'units/acme-api-1/1-implement')
  expect(existsSync(join(unitDir, 'out/pr.md'))).toBe(true)
  expect(existsSync(join(unitDir, 'agent-home'))).toBe(false)
})

it('copies nothing from the .away a branch ships into the unit dir', async () => {
  const runDir = join(await mkdtemp(join(tmpdir(), 'awaywork-forged-')), 'run')
  const { report } = await loopRun('queue:\n  - skill: implement\n', [issue(1)], looper({}), {
    runDir,
    forge: {
      clone: async (_repo, _branch, dir) => {
        await execa(bin('git'), ['init', '-q', '-b', 'main', dir])
        await mkdir(join(dir, '.away/out'), { recursive: true })
        for (const file of ['replay.json', 'worker.log', 'out/pr.md'])
          await writeFile(join(dir, '.away', file), 'FORGED')
        await git(dir, 'add', '.')
        await git(dir, 'commit', '-qm', 'init')
      },
    },
  })

  expect(report.results.map((u) => [u.status, u.reason])).toEqual([
    ['error', '.away in the clone comes from the branch, not awaywork'],
  ])
  const unitDir = join(runDir, 'units/acme-api-1/1-implement')
  expect(await readdir(unitDir)).toEqual(['worker.log'])
  expect(await readFile(join(unitDir, 'worker.log'), 'utf8')).toContain('comes from the branch')
})

it('reads past FIFOs a round left as its verdict or report, and finishes the run', async () => {
  const provider = looper({ 'acme-api-1-review-1': 'changes' })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-review-1')
          for (const name of ['verdict', 'report.md']) {
            const file = join(job.dir, '.away/out', name)
            await rm(file, { force: true })
            await execa('mkfifo', [file])
          }
      },
    },
  )

  const round = report.results.find((u) => u.planned.unit.id === 'acme-api-1-review-1')
  expect(round?.verdict).toBeUndefined()
  expect(round?.made).toBe('nothing')
  expect(report.results[0]?.loop).toBe(
    '1 round of review ⇄ fix; acme-api-1-review-1 wrote no report',
  )
  expect(opened).toHaveLength(1)
}, 60_000)

it('ends a loop interrupted between rounds, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 2 }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'changes' }),
    {
      signal: stop.signal,
      ctx: {
        env: {},
        log: (line) => {
          if (line === 'acme-api-1-review-1: done') stop.abort()
        },
      },
    },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'skipped', 'interrupted'],
  ])
  expect(report.results[0]?.loop).toBe('1 round of review ⇄ fix; interrupted')
  expect(report.results[0]?.outcome).toEqual({
    kind: 'none',
    reason: 'interrupted',
    unpublished: true,
  })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it("reads a loop's last verdict in the when of the step after it", async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 2 }
      - { skill: plan, when: { verdict: approve } }
`,
    [issue(1)],
    looper({ 'acme-api-1-review-1': 'approve' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.verdict])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', 'approve'],
    ['acme-api-1-plan', 'done', undefined],
  ])
})

/** Pushes two steps onto PR 1, reports on issue 2, and runs a failing notify. */
const notifyQueue = (out: string) => `queue:
  - { skill: fix, deliver: push, where: { type: pr }, then: implement }
  - { skill: plan, where: { type: issue } }
notify:
  command: echo "$AWAYWORK_EVENT $AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL|$AWAYWORK_REPORT" >> '${out}'; exit 3
`

/** Commits unless it reports, and writes a PR body or a report as its unit delivers. */
const pusher: Provider = {
  ...fakeProvider('claude'),
  async *run(job) {
    if (job.unit.deliver !== 'report') {
      await writeFile(join(job.dir, `${job.unit.id}.txt`), 'done')
      await git(job.dir, 'add', `${job.unit.id}.txt`)
      await git(job.dir, 'commit', '-qm', `Work on ${job.unit.id}`)
    }
    const file = job.unit.deliver === 'report' ? 'report.md' : 'pr.md'
    await writeFile(join(job.dir, '.away/out', file), `Work on ${job.unit.id}\n\nDone.`)
    yield { type: 'done', ok: true, turns: 1 }
  },
}

it("runs notify's unit event once per step with its own output and its chain's PR, and goes on past a failing one", async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-')), 'out.txt')
  const logs: string[] = []
  const { report } = await loopRun(notifyQueue(out), [githubPr(1), issue(2)], pusher, {
    ctx: { env: { PATH: process.env.PATH }, log: (line) => logs.push(line) },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.outcome?.kind])).toEqual([
    ['acme-api-1', 'pushed'],
    ['acme-api-1-implement', undefined],
    ['acme-api-2', 'report'],
  ])
  expect((await readFile(out, 'utf8')).split('\n')).toEqual([
    expect.stringMatching(
      /^unit acme-api-1 done \|\/.+\/run\/units\/acme-api-1\/1-fix\/out\/pr\.md$/,
    ),
    expect.stringMatching(
      /^unit acme-api-1-implement done \|\/.+\/run\/units\/acme-api-1\/2-implement\/out\/pr\.md$/,
    ),
    expect.stringMatching(
      /^unit acme-api-2 done \|\/.+\/run\/units\/acme-api-2\/1-plan\/out\/report\.md$/,
    ),
    '',
  ])
  expect(logs.filter((line) => line.startsWith('notify'))).toEqual([
    expect.stringMatching(/^notify failed for acme-api-1: .*exit code 3/),
    expect.stringMatching(/^notify failed for acme-api-1-implement: /),
    expect.stringMatching(/^notify failed for acme-api-2: /),
  ])
})

it('runs no notify unit event on a dry run, nor once interrupted, past those of the chains that finished', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-')), 'out.txt')
  const items = [githubPr(1), issue(2)]
  await loopRun(notifyQueue(out), items, pusher, { dryRun: true })
  const stop = new AbortController()
  const { report } = await loopRun(notifyQueue(out), items, pusher, {
    signal: stop.signal,
    ctx: {
      env: { PATH: process.env.PATH },
      log: (line) => {
        if (line.startsWith('acme-api-2: ')) stop.abort()
      },
    },
  })

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-implement', 'done'],
    ['acme-api-2', 'stopped: aborted'],
  ])
  expect(await readFile(out, 'utf8')).toMatch(
    /^unit acme-api-1 done \|[^\n]+\nunit acme-api-1-implement done \|[^\n]+\n$/,
  )
})

it('runs no notify unit event in a soon run for a step its when passed over, but does for one whose setup failed', async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-soon-')), 'out.txt')
  const hook = `notify: { command: 'echo "$AWAYWORK_UNIT $AWAYWORK_STATUS" >> ${out}' }`
  const passed = await loopRun(
    `queue: [{ skill: plan, when: { runs_until_reset: 1 } }]\n${hook}`,
    [issue(1)],
    pusher,
    { soon: true },
  )
  const broken = await loopRun(
    `repos: { acme/api: { setup: 'exit 3' } }\nqueue: [{ skill: plan }]\n${hook}`,
    [issue(2)],
    pusher,
    { soon: true },
  )

  expect(passed.report.results[0]).toMatchObject({ status: 'skipped', passedOver: true })
  expect(broken.report.results[0]?.reason).toMatch(/^setup failed: /)
  expect(await readFile(out, 'utf8')).toBe('acme-api-2 skipped\n')
})

it("runs a chain's notify unit events once it published, with its PR and each step's own output, before the next chain runs", async () => {
  const out = join(await mkdtemp(join(tmpdir(), 'awaywork-notify-loop-')), 'out.txt')
  const yaml = `queue:
  - skill: implement
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 3 }
      - plan
notify:
  command: echo "$AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL|$AWAYWORK_REPORT|$AWAYWORK_VERDICT|$AWAYWORK_OUT_DIR|$AWAYWORK_ITEM_KEY" >> '${out}'
`
  const provider = looper({ 'acme-api-1-review-1': 'changes', 'acme-api-1-review-2': 'approve' })
  const firedBefore: Record<string, number> = {}
  await loopRun(yaml, [issue(1), issue(2)], {
    ...provider,
    async *run(job, signal) {
      const lines = await readFile(out, 'utf8').catch(() => '')
      firedBefore[job.unit.id] = lines.split('\n').filter(Boolean).length
      yield* provider.run(job, signal)
    },
  })

  expect(firedBefore).toMatchObject({
    'acme-api-1': 0,
    'acme-api-1-review-1': 0,
    'acme-api-1-fix-1': 0,
    'acme-api-1-review-2': 0,
    'acme-api-1-plan': 0,
    'acme-api-2': 5,
  })
  const pr = 'https://example.com/acme/api/pull/away/acme-api-1'
  const lines = (await readFile(out, 'utf8')).trim().split('\n').slice(0, 5)
  expect(lines).toEqual([
    expect.stringMatching(
      `^acme-api-1 done ${pr}\\|/.+/units/acme-api-1/1-implement/out/pr\\.md\\|\\|/.+/units/acme-api-1/1-implement/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-review-1 done ${pr}\\|/.+/units/acme-api-1/2-review/out/report\\.md\\|changes\\|/.+/units/acme-api-1/2-review/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-fix-1 done ${pr}\\|/.+/units/acme-api-1/3-fix/out/pr\\.md\\|\\|/.+/units/acme-api-1/3-fix/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-review-2 done ${pr}\\|/.+/units/acme-api-1/4-review/out/report\\.md\\|approve\\|/.+/units/acme-api-1/4-review/out\\|acme/api#1$`,
    ),
    expect.stringMatching(
      `^acme-api-1-plan done ${pr}\\|/.+/units/acme-api-1/5-plan/out/report\\.md\\|\\|/.+/units/acme-api-1/5-plan/out\\|acme/api#1$`,
    ),
  ])
  const reports = lines.flatMap((line) =>
    line.split('|')[1]?.match(/report\.md$/) ? [line.split('|')[1] as string] : [],
  )
  expect(await Promise.all(reports.map((file) => readFile(file, 'utf8')))).toEqual([
    'acme-api-1-review-1 says changes.',
    'acme-api-1-review-2 says approve.',
    'acme-api-1-plan says nothing.',
  ])
})
