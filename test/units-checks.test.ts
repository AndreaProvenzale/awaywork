import { existsSync } from 'node:fs'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { expect, it, vi } from 'vitest'
import { bin } from '../src/config/paths.js'
import { recordAttempts } from '../src/core/attempts.js'
import { formatReport, runLine } from '../src/core/report.js'
import type { Provider, PrRef } from '../src/core/types.js'
import { fakeItem, githubPr, issue } from './fakes/items.js'
import { looper, loopRun } from './fakes/units.js'

it("doesn't run a check on an untrusted author's PR, or end a loop while the clone has uncommitted changes", async () => {
  const provider = looper({})
  const env = { ctx: { env: { PATH: process.env.PATH }, log: () => {} } }
  const untrusted = (then: string) =>
    loopRun(
      `queue: [{ skill: review, deliver: report, then: ${then} }]\n`,
      [githubPr(4, { mine: false, trusted: false })],
      provider,
      env,
    )
  const refused = "not run on an untrusted author's PR"
  const step = await untrusted(`{ skill: plan, when: { command: 'true' } }`)
  expect(step.report.results[1]).toMatchObject({
    status: 'skipped',
    reason: `when \`true\` passes didn't hold (${refused})`,
    passedOver: true,
  })
  const loop = await untrusted(`{ loop: [fix], until: { command: 'true' }, max: 3 }`)
  expect(loop.report.results[0]?.loop).toBe(
    `1 round of fix; until \`true\` passes not checked: ${refused}`,
  )

  const dirty = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix], until: { command: 'test -e fixed.txt' }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await writeFile(join(job.dir, 'fixed.txt'), 'uncommitted')
      },
    },
    env,
  )
  expect(dirty.report.results[0]?.loop).toBe('1 round of fix; max 1 round reached')
  expect(dirty.opened[0]?.body).toContain('failed: uncommitted changes in the clone')

  const leftForNextStep = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [fix, { skill: implement, when: { command: 'test -e fixed.txt' } }]
      until: { verdict: approve }
      max: 1
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await writeFile(join(job.dir, 'fixed.txt'), 'uncommitted')
      },
    },
    env,
  )
  expect(leftForNextStep.report.results[2]).toMatchObject({
    planned: { unit: { id: 'acme-api-1-implement-1' } },
    status: 'done',
  })
})

it("fences a failed check's output in the PR body past any backticks in it", async () => {
  const { opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix], until: { command: "echo '\`\`\`\`'; false" }, max: 1 }
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(opened[0]?.body).toContain("`````\n$ echo '````'; false\n````\nfailed:")
})

it("matches changed against the chain's own commits, not another chain's", async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { skill: review, when: { changed: acme-api-1.txt } }
`,
    [issue(1), issue(2)],
    looper({}),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review', 'done', undefined],
    ['acme-api-2', 'done', undefined],
    ['acme-api-2-review', 'skipped', "when the branch changes acme-api-1.txt didn't hold"],
  ])
})

it('matches changed against where the chain started, after a report step', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then:
      - review
      - { skill: fix, when: { changed: acme-api-1.txt } }
`,
    [issue(1)],
    looper({}),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review', 'done'],
    ['acme-api-1-fix', 'done'],
  ])
})

it('ends a loop on a round where every step was passed over, and says so in the PR body', async () => {
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [{ skill: fix, when: { command: 'false' } }]
      until: { command: 'true' }
      max: 3
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix-1', 'skipped'],
  ])
  expect(report.results[0]?.loop).toBe("0 rounds of fix; no step's when held")
  expect(opened[0]?.body).toContain(
    "## Awaywork chain\n\nLoop: 0 rounds of fix; no step's when held.",
  )

  const fixedOnce = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [{ skill: fix, when: { command: 'test ! -e acme-api-1-fix-1.txt' } }]
      until: { command: 'false' }
      max: 3
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )
  expect(fixedOnce.report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-fix-1', 'done'],
    ['acme-api-1-fix-2', 'skipped'],
  ])
  expect(fixedOnce.report.results[0]?.loop).toBe("1 round of fix; no step's when held")
})

it('checks a clone for uncommitted changes beyond what setup and earlier checks left', async () => {
  const { report } = await loopRun(
    `repos: { acme/api: { setup: 'echo x > setup.out' } }
queue:
  - skill: implement
    then:
      - review
      - loop: [fix]
        until: { command: 'touch artifact.out; test -e acme-api-1-fix-2.txt' }
        max: 3
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-1-review', 'done'],
    ['acme-api-1-fix-1', 'done'],
    ['acme-api-1-fix-2', 'done'],
  ])
  expect(report.results[0]?.loop).toMatch(/^2 rounds of fix; until held/)
})

it("doesn't run a nested repo's filter when it checks the clone for uncommitted changes", async () => {
  const ran = join(await mkdtemp(join(tmpdir(), 'awaywork-filter-')), 'ran')
  const provider = looper({})
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [fix], until: { command: 'test ! -e ${ran}' }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id !== 'acme-api-1-fix-1') return
        const sub = join(job.dir, 'sub')
        const git = (dir: string, ...args: string[]) => execa(bin('git'), ['-C', dir, ...args])
        await git(job.dir, 'init', '-q', 'sub')
        await writeFile(join(sub, 'f'), 'a')
        await git(sub, 'add', 'f')
        await git(sub, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'sub')
        await git(job.dir, 'add', 'sub')
        await git(job.dir, '-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'sub')
        await writeFile(join(sub, '.gitattributes'), '* filter=evil')
        await git(sub, 'config', 'filter.evil.clean', `touch ${ran}; cat`)
        await writeFile(join(sub, 'f'), 'b')
      },
    },
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results[0]?.loop).toMatch(/^1 round of fix; until held/)
})

it('skips a when step whose check was interrupted without passing over it, so the chain retries', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { skill: review, when: { command: 'touch ${started}; sleep 5' } }
`,
    [item],
    looper({}),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[1]).toMatchObject({
    status: 'skipped',
    reason: `when \`touch ${started}; sleep 5\` passes not checked: interrupted`,
  })
  expect(report.results[1]?.passedOver).toBeUndefined()
  expect(recordAttempts({}, report)).toEqual({})
})

it('skips a when step whose check timed out without passing over it, so the chain retries', async () => {
  const real = AbortSignal.timeout.bind(AbortSignal)
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(200))
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  try {
    const { report } = await loopRun(
      `queue:
  - skill: implement
    then: { skill: review, when: { command: '! sleep 30' } }
`,
      [item],
      looper({}),
      { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
    )

    expect(report.results[1]).toMatchObject({
      status: 'skipped',
      reason: 'when `! sleep 30` passes not checked: timed out after 15 min',
    })
    expect(report.results[1]?.passedOver).toBeUndefined()
    expect(recordAttempts({}, report)).toEqual({})
  } finally {
    spy.mockRestore()
  }
})

it("ends a loop at a refused when, instead of repeating its other steps on code that can't change", async () => {
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    deliver: report
    then:
      loop: [review, { skill: fix, when: { command: '! false' } }]
      until: { verdict: approve }
      max: 3
`,
    [githubPr(1, { mine: false, trusted: false })],
    looper({
      'acme-api-1-review-1': 'changes',
      'acme-api-1-review-2': 'changes',
      'acme-api-1-review-3': 'changes',
    }),
  )

  const refused = `when \`! false\` passes didn't hold (not run on an untrusted author's PR)`
  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.reason])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'skipped', refused],
  ])
  expect(report.results[0]?.loop).toBe(`1 round of review ⇄ fix; ${refused}`)
  expect(opened).toEqual([])
})

it("doesn't run a loop whose first step after a report has a refused when, and finishes the chain", async () => {
  const item = githubPr(1, { mine: false, trusted: false, updated: '2026-09-01T00:00:00Z' })
  const { report, opened } = await loopRun(
    `queue:
  - skill: plan
    deliver: report
    then: { loop: [{ skill: review, when: { command: 'true' } }, implement], until: { verdict: approve }, max: 2 }
`,
    [item],
    looper({}),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.passedOver])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'skipped', true],
  ])
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'plan',
    updated: '2026-09-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-1', step: '1-plan', skill: 'plan' },
  })
})

it('reports a loop that a refused when ended, and counts the chain finished', async () => {
  const item = githubPr(1, { mine: false, trusted: false, updated: '2026-09-01T00:00:00Z' })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    deliver: report
    then:
      loop: [review, { skill: fix, when: { command: 'true' } }]
      until: { verdict: approve }
      max: 2
`,
    [item],
    looper({ 'acme-api-1-review-1': 'changes' }),
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status, u.passedOver])).toEqual([
    ['acme-api-1', 'done', undefined],
    ['acme-api-1-review-1', 'done', undefined],
    ['acme-api-1-fix-1', 'skipped', true],
  ])
  expect(report.results[0]?.outcome).toMatchObject({ kind: 'report' })
  expect(recordAttempts({}, report)['github:acme/api#1']).toEqual({
    runId: 'r1',
    skill: 'plan',
    updated: '2026-09-01T00:00:00Z',
    report: { runId: 'r1', unit: 'acme-api-1', step: '2-review', skill: 'review' },
  })
})

it('ends a loop whose when check was interrupted, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then:
      loop: [review, { skill: fix, when: { command: 'touch ${started}; sleep 5' } }]
      until: { verdict: approve }
      max: 2
`,
    [item],
    looper({ 'acme-api-1-review-1': 'changes' }),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[2]).toMatchObject({
    status: 'skipped',
    reason: `when \`touch ${started}; sleep 5\` passes not checked: interrupted`,
  })
  expect(report.results[2]?.passedOver).toBeUndefined()
  expect(report.results[0]?.outcome).toMatchObject({ reason: 'interrupted', unpublished: true })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it('ends a loop whose until check was interrupted, and retries its chain without counting a failure', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report, opened } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review], until: { command: 'touch ${started}; sleep 5' }, max: 2 }
`,
    [item],
    looper({}),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[1]).toMatchObject({
    planned: { unit: { id: 'acme-api-1-review-1' } },
    status: 'done',
  })
  expect(report.results[0]?.outcome).toMatchObject({ reason: 'interrupted', unpublished: true })
  expect(opened).toEqual([])
  expect(recordAttempts({}, report)).toEqual({})
})

it('publishes nothing from a report chain whose last until check was interrupted', async () => {
  const stop = new AbortController()
  const started = join(await mkdtemp(join(tmpdir(), 'awaywork-check-')), 'started')
  const watch = setInterval(() => existsSync(started) && stop.abort(), 20)
  const item = fakeItem({
    ...issue(1),
    fields: { repo: 'acme/api', updated: '2026-09-01T00:00:00Z' },
  })
  const { report } = await loopRun(
    `queue:
  - skill: plan
    then: { loop: [review], until: { command: 'touch ${started}; sleep 5' }, max: 1 }
`,
    [item],
    looper({}),
    { signal: stop.signal, ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  ).finally(() => clearInterval(watch))

  expect(report.results[0]?.outcome).toMatchObject({ reason: 'interrupted', unpublished: true })
  expect(recordAttempts({}, report)).toEqual({})
})

it("runs every step of a chain on the rule's base, whatever steps were passed over", async () => {
  const bases: Record<string, string> = {}
  const inner = looper({})
  const provider: Provider = {
    ...inner,
    async *run(job, signal) {
      bases[job.unit.id] = job.unit.base
      yield* inner.run(job, signal)
    },
  }
  const item = (n: number, label: string) =>
    fakeItem({ ...issue(n), fields: { repo: 'acme/api', label: [label] } })
  const { report, opened } = await loopRun(
    `queue:
  - { skill: implement, where: { label: first } }
  - skill: review
    deliver: report
    where: { label: second }
    then:
      - { skill: fix, when: { verdict: go } }
      - plan
`,
    [item(1, 'first'), item(2, 'second')],
    provider,
  )

  expect(report.results.map((u) => [u.planned.unit.id, u.status])).toEqual([
    ['acme-api-1', 'done'],
    ['acme-api-2', 'done'],
    ['acme-api-2-fix', 'skipped'],
    ['acme-api-2-plan', 'done'],
  ])
  expect(opened.map((pr) => pr.head)).toEqual(['away/acme-api-1'])
  expect(bases['acme-api-2-plan']).toBe('')
})

it('escapes a pipe in a check command, so the report table keeps its cells', async () => {
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { skill: review, when: { command: "git log | grep -q nothing-like-this" } }
`,
    [issue(1)],
    looper({}),
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  const text = formatReport(report)
  const row = text.split('\n').find((line) => line.startsWith('|  | └ acme-api-1-review |'))
  expect(row).toBe(
    "|  | └ acme-api-1-review | review | claude | skipped | when `git log \\| grep -q nothing-like-this` passes didn't hold (Command failed with exit code 1: 'git log \\| grep -q nothing-like-this') |",
  )
  expect(runLine('r1', text)).toBe('r1  1 unit, 1 draft PR, 0 reports')
})

it("doesn't write a check's log through a symlink a round left in the clone", async () => {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-outside-'))
  const outside = join(root, 'outside')
  await writeFile(outside, 'mine\n')
  const provider = looper({})
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: fix, until: { command: 'true' }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        yield* provider.run(job, signal)
        if (job.unit.id === 'acme-api-1-fix-1')
          await symlink(outside, join(job.dir, '.away/out/check.log'))
      },
    },
    { ctx: { env: { PATH: process.env.PATH }, log: () => {} } },
  )

  expect(report.results[1]?.status).toBe('error')
  expect(report.results[1]?.reason).toBe('.away/out/check.log in the clone is a symlink')
  expect(await readFile(outside, 'utf8')).toBe('mine\n')
})

it("stacks a chain's draft PR on an awaywork PR a rule took up, whichever step committed", async () => {
  const pr = githubPr(9, { ours: true })
  const link = { ...pr.linkedPrs[0], branch: 'away/acme-api-5', ours: true } as PrRef
  const stackedOn = async (then: string) => {
    const { opened } = await loopRun(
      `queue: [{ skill: review, where: { type: pr, ours: true }, then: ${then} }]`,
      [{ ...pr, linkedPrs: [link] }],
      looper({ 'acme-api-9-review-1': 'approve' }),
    )
    return opened.map((o) => [o.head, o.base, o.body.includes(`Stacked on ${link.url}`)])
  }

  expect(await stackedOn('[{ skill: fix, when: { verdict: changes } }, implement]')).toEqual([
    ['away/acme-api-9', 'away/acme-api-5', true],
  ])
  expect(
    await stackedOn('[{ loop: [review, fix], until: { verdict: approve }, max: 1 }, implement]'),
  ).toEqual([['away/acme-api-9', 'away/acme-api-5', true]])
})

it("puts back a loop clone's git config after each worker, and refuses a borrowed object store", async () => {
  const provider = looper({})
  const seen: Record<string, string> = {}
  const { report } = await loopRun(
    `queue:
  - skill: implement
    then: { loop: [review, fix], until: { verdict: approve }, max: 1 }
`,
    [issue(1)],
    {
      ...provider,
      async *run(job, signal) {
        const config = join(job.dir, '.git', 'config')
        seen[job.unit.id] = await readFile(config, 'utf8')
        if (job.unit.id === 'acme-api-1-review-1')
          await writeFile(config, '[core]\n\tsshCommand = touch pwned\n', { flag: 'a' })
        if (job.unit.id === 'acme-api-1-fix-1')
          await writeFile(join(job.dir, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n')
        yield* provider.run(job, signal)
      },
    },
  )

  expect(seen['acme-api-1-fix-1']).toBe(seen['acme-api-1-review-1'])
  expect(report.results[0]?.loop).toBe(
    '1 round of review ⇄ fix; acme-api-1-fix-1 error: .git/objects/info/alternates in the clone points elsewhere',
  )
})
