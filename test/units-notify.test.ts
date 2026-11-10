import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Provider } from '../src/core/types.js'
import { githubPr, issue } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { git, looper, loopRun } from './fakes/units.js'

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
