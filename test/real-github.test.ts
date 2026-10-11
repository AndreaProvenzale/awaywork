import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import type { Item } from '../src/core/types.js'
import { exec } from '../src/forge/gh.js'
import { github } from '../src/sources/github.js'
import { sourceField } from '../src/sources/index.js'
import { initial, scriptedAsk } from './fakes/ask.js'

let repo = process.env.NIGHTSHIFT_GITHUB_SANDBOX ?? ''
const reviewerToken = process.env.NIGHTSHIFT_GITHUB_REVIEWER_TOKEN ?? ''
const ctx = { env: process.env, log: console.log }
type Gh = (...args: string[]) => Promise<string>
const gh: Gh = (...args) => exec('gh', args)
const reviewerGh: Gh = async (...args) =>
  (await execa(bin('gh'), args, { env: { GH_TOKEN: reviewerToken } })).stdout
/** Calls the repo's REST API with `fields` as string params, e.g. `{ 'labels[]': 'bug' }`. */
const restApi =
  (run: Gh) =>
  (path: string, fields: Record<string, string> = {}, ...args: string[]) =>
    run(
      'api',
      `repos/${repo}/${path}`,
      ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`]),
      ...args,
    )
const api = restApi(gh)
const reviewerApi = restApi(reviewerGh)
const lines = (text: string) => text.replace(/\n$/, '').split('\n').length
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Search indexes new items a few seconds late, so read until `pick` finds them settled. */
async function settled<T>(pick: (items: Item[]) => T | undefined, wait = 90_000): Promise<T> {
  for (let deadline = Date.now() + wait; ; await sleep(5_000)) {
    const items = await github.items({ repos: [repo] }, ctx)
    const found = pick(items)
    if (found) return found
    if (Date.now() > deadline)
      throw new Error(
        `seeded items never settled: ${JSON.stringify(items.map(({ key, fields }) => ({ key, fields })))}`,
      )
  }
}

/** Undoes each seeded thing that was created, then fails naming whatever is left behind. */
async function cleanup(steps: [what: string, undo: false | (() => Promise<unknown>)][]) {
  const left: Error[] = []
  for (const [what, undo] of steps)
    if (undo)
      await undo().catch((cause) => left.push(new Error(`${what} left in ${repo}`, { cause })))
  if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind')
}

/**
 * Seeds an issue and a PR closing it in a sandbox repo, reads them back for real and deletes them;
 * run with NIGHTSHIFT_GITHUB_SANDBOX set to a repo `gh` can delete issues in (owner, or org admin).
 * With NIGHTSHIFT_GITHUB_REVIEWER_TOKEN, a second account with write access also requests my review.
 */
describe.skipIf(!repo)('github source, live', () => {
  const run = Date.now().toString(36)
  const label = 'night-shift-e2e'
  const branch = `night-shift-e2e-${run}`
  const path = `e2e/${run}.md`
  const workflow = '.github/workflows/e2e-fail.yml'
  const failure = `e2e failure ${run}`
  // printf builds the marker, so only the step's output has it, not the command echoed in the log.
  const failing = `name: ${label}
on: pull_request
jobs:
  ${label}:
    runs-on: ubuntu-latest
    steps:
      - run: printf 'e2e failure %s\\n' ${run} && exit 1
`
  const dropped: string[] = []
  let droppedLines = 0
  let login = ''
  let base = ''
  let baseSha = ''
  let issue = 0
  let branched = false
  let pr = 0

  beforeAll(async () => {
    login = (await gh('api', 'user', '--jq', '.login')).trim()
    const sandbox = JSON.parse(await gh('api', `repos/${repo}`))
    repo = sandbox.full_name
    base = sandbox.default_branch
    await gh('label', 'create', label, '-R', repo, '--force')
    const seed = {
      title: `[e2e ${run}] issue`,
      body: 'Seeded.',
      'assignees[]': login,
      'labels[]': label,
    }
    issue = Number(await api('issues', seed, '--jq', '.number'))
    await api(`issues/${issue}/comments`, { body: `e2e comment ${run}` })
    baseSha = (await api(`git/ref/heads/${base}`, {}, '--jq', '.object.sha')).trim()
    await api('git/refs', { ref: `refs/heads/${branch}`, sha: baseSha })
    branched = true
    // The PR runs workflows from its merge commit: dropping the repo's own leaves only the seeded one.
    const own: { path: string; sha: string }[] = JSON.parse(
      await api('contents/.github/workflows').catch(() => '[]'),
    )
    for (const { path: file, sha: blob } of own) {
      droppedLines += lines(atob(await api(`git/blobs/${blob}`, {}, '--jq', '.content')))
      await api(`contents/${file}`, { message: 'Drop CI', sha: blob, branch }, '-X', 'DELETE')
      dropped.push(file)
    }
    const ci = { message: 'Add a failing check', content: btoa(failing), branch }
    await api(`contents/${workflow}`, ci, '-X', 'PUT')
    const file = { message: 'Add e2e probe', content: btoa('probe\n'), branch }
    const sha = (await api(`contents/${path}`, file, '-X', 'PUT', '--jq', '.commit.sha')).trim()
    const opened = { title: `[e2e ${run}] PR`, head: branch, base, body: `Closes #${issue}` }
    pr = Number(await api('pulls', opened, '--jq', '.number'))
    const thread = { body: `e2e thread ${run}`, commit_id: sha, path, side: 'RIGHT' }
    await api(`pulls/${pr}/comments`, thread, '-F', 'line=1')
  }, 60_000)

  /** Waits for the seeded PR's runs to show up, cancels any still going, then deletes them. */
  async function deleteRuns() {
    for (let deadline = Date.now() + 60_000; ; await sleep(5_000)) {
      const runs: { id: number; status: string }[] = JSON.parse(
        await api(`actions/runs?branch=${branch}`, {}, '--jq', '[.workflow_runs[] | {id, status}]'),
      )
      if (runs.length && runs.every((r) => r.status === 'completed')) {
        for (const { id } of runs) await api(`actions/runs/${id}`, {}, '-X', 'DELETE')
        return
      }
      if (Date.now() > deadline)
        throw new Error(`workflow runs on ${branch} never completed: ${JSON.stringify(runs)}`)
      // A run can complete between listing and cancelling, which GitHub refuses.
      for (const { id, status } of runs)
        if (status !== 'completed')
          await api(`actions/runs/${id}/cancel`, {}, '-X', 'POST').catch(() => {})
    }
  }

  afterAll(
    () =>
      cleanup([
        [`PR #${pr} open`, !!pr && (() => api(`pulls/${pr}`, { state: 'closed' }, '-X', 'PATCH'))],
        [`workflow runs of PR #${pr}`, !!pr && deleteRuns],
        [
          `branch ${branch}`,
          branched && (() => api(`git/refs/heads/${branch}`, {}, '-X', 'DELETE')),
        ],
        [
          `issue #${issue}`,
          !!issue && (() => gh('issue', 'delete', String(issue), '-R', repo, '--yes')),
        ],
      ]),
    120_000,
  )

  it('reads the seeded issue and PR with their fields and context', async () => {
    // Waits for the seeded workflow to fail too, which takes a runner.
    const found = await settled((items) => {
      const issueItem = items.find((i) => i.key === `${repo}#${issue}`)
      const prItem = items.find((i) => i.key === `${repo}#${pr}`)
      if (issueItem?.linkedPrs.length && prItem?.fields.checks === 'failing')
        return { issue: issueItem, pr: prItem }
    }, 180_000)
    for (const item of Object.values(found))
      for (const [key, value] of Object.entries(item.fields))
        for (const v of [value].flat())
          expect(sourceField(github.fields, key)?.safeParse(v).success).toBe(true)

    expect(found.issue).toMatchObject({
      type: 'issue',
      assignee: login,
      fields: { repo, mine: true, label: [label], author: login, trusted: true },
      linkedPrs: [
        { repo, number: pr, branch, ours: false, mine: true, trusted: true, fork: false },
      ],
    })
    expect(found.issue.comments.map((c) => c.body)).toEqual([`e2e comment ${run}`])
    expect(found.pr).toMatchObject({
      type: 'pr',
      fields: {
        repo,
        mine: true,
        draft: false,
        ours: false,
        checks: 'failing',
        changed_lines: lines(failing) + 1 + droppedLines,
        unresolved_threads: 1,
        my_unresolved_threads: 1,
        review_requested: false,
      },
    })
    expect(found.pr.fields.files).toEqual([...dropped, workflow, path].sort())

    const issueDir = await mkdtemp(join(tmpdir(), 'nightshift-real-'))
    await github.prefetch(found.issue, issueDir, ctx)
    expect(await readFile(join(issueDir, 'issue.md'), 'utf8')).toContain(`e2e comment ${run}`)

    const prDir = await mkdtemp(join(tmpdir(), 'nightshift-real-'))
    await github.prefetch(found.pr, prDir, ctx)
    expect((await readdir(prDir)).sort()).toEqual([
      'checks.md',
      'diff.patch',
      'pr.md',
      'threads.md',
    ])
    const read = (name: string) => readFile(join(prDir, name), 'utf8')
    expect(await read('diff.patch')).toContain(`+++ b/${path}`)
    expect(await read('threads.md')).toContain(`e2e thread ${run}`)
    expect(await read('checks.md')).toContain(`## ${label}: FAILURE`)
    expect(await read('checks.md')).toContain(failure)
  }, 240_000)

  it('suggests my own repos at init', async () => {
    const setup = await github.init?.(scriptedAsk([[/GitHub repos/, initial]]), ctx)
    expect(setup?.config).toEqual({ repos: [`${login}/*`] })
  }, 30_000)

  describe.skipIf(!reviewerToken)('with my review requested by a collaborator', () => {
    const reviewBranch = `${branch}-review`
    const reviewPath = `e2e/${run}-review.md`
    let reviewer = ''
    let reviewBranched = false
    let reviewPr = 0

    beforeAll(async () => {
      reviewer = (await reviewerGh('api', 'user', '--jq', '.login')).trim()
      await reviewerApi('git/refs', { ref: `refs/heads/${reviewBranch}`, sha: baseSha })
      reviewBranched = true
      // [skip ci] keeps the repo's own CI off a PR that only needs the review request.
      const file = {
        message: 'Add e2e probe [skip ci]',
        content: btoa('probe\n'),
        branch: reviewBranch,
      }
      await reviewerApi(`contents/${reviewPath}`, file, '-X', 'PUT')
      const opened = {
        title: `[e2e ${run}] PR to review`,
        head: reviewBranch,
        base,
        body: 'Seeded.',
      }
      reviewPr = Number(await reviewerApi('pulls', opened, '--jq', '.number'))
      await reviewerApi(`pulls/${reviewPr}/requested_reviewers`, { 'reviewers[]': login })
    }, 60_000)

    afterAll(
      () =>
        cleanup([
          [
            `PR #${reviewPr} open`,
            !!reviewPr &&
              (() => reviewerApi(`pulls/${reviewPr}`, { state: 'closed' }, '-X', 'PATCH')),
          ],
          [
            `branch ${reviewBranch}`,
            reviewBranched &&
              (() => reviewerApi(`git/refs/heads/${reviewBranch}`, {}, '-X', 'DELETE')),
          ],
        ]),
      60_000,
    )

    it('reads a PR awaiting my review', async () => {
      const item = await settled((items) => items.find((i) => i.key === `${repo}#${reviewPr}`))
      expect(item).toMatchObject({
        type: 'pr',
        reviewers: [login],
        fields: {
          repo,
          mine: false,
          author: reviewer,
          trusted: true,
          review_requested: true,
          files: [reviewPath],
          changed_lines: 1,
        },
      })
    }, 120_000)
  })
})
