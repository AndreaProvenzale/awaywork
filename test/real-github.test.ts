import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Item } from '../src/core/types.js'
import { exec } from '../src/forge/gh.js'
import { github } from '../src/sources/github.js'
import { sourceField } from '../src/sources/index.js'
import { initial, scriptedAsk } from './fakes/ask.js'

let repo = process.env.NIGHTSHIFT_GITHUB_SANDBOX ?? ''
const ctx = { env: process.env, log: console.log }
const gh = (...args: string[]) => exec('gh', args)
/** Calls the repo's REST API with `fields` as string params, e.g. `{ 'labels[]': 'bug' }`. */
const api = (path: string, fields: Record<string, string> = {}, ...args: string[]) =>
  gh(
    'api',
    `repos/${repo}/${path}`,
    ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`]),
    ...args,
  )

/**
 * Seeds an issue and a PR closing it in a sandbox repo, reads them back for real and deletes them;
 * run with NIGHTSHIFT_GITHUB_SANDBOX set to a repo `gh` can delete issues in (owner, or org admin).
 */
describe.skipIf(!repo)('github source, live', () => {
  const run = Date.now().toString(36)
  const label = 'night-shift-e2e'
  const branch = `night-shift-e2e-${run}`
  const path = `e2e/${run}.md`
  let login = ''
  let issue = 0
  let branched = false
  let pr = 0

  beforeAll(async () => {
    login = (await gh('api', 'user', '--jq', '.login')).trim()
    const sandbox = JSON.parse(await gh('api', `repos/${repo}`))
    repo = sandbox.full_name
    const base = sandbox.default_branch
    await gh('label', 'create', label, '-R', repo, '--force')
    const seed = {
      title: `[e2e ${run}] issue`,
      body: 'Seeded.',
      'assignees[]': login,
      'labels[]': label,
    }
    issue = Number(await api('issues', seed, '--jq', '.number'))
    await api(`issues/${issue}/comments`, { body: `e2e comment ${run}` })
    const baseSha = (await api(`git/ref/heads/${base}`, {}, '--jq', '.object.sha')).trim()
    await api('git/refs', { ref: `refs/heads/${branch}`, sha: baseSha })
    branched = true
    // [skip ci] keeps the repo's own CI off, so the seeded status alone sets the checks.
    const file = { message: 'Add e2e probe [skip ci]', content: btoa('probe\n'), branch }
    const sha = (await api(`contents/${path}`, file, '-X', 'PUT', '--jq', '.commit.sha')).trim()
    await api(`statuses/${sha}`, {
      state: 'failure',
      context: label,
      description: 'Seeded failure',
    })
    const opened = { title: `[e2e ${run}] PR`, head: branch, base, body: `Closes #${issue}` }
    pr = Number(await api('pulls', opened, '--jq', '.number'))
    const thread = { body: `e2e thread ${run}`, commit_id: sha, path, side: 'RIGHT' }
    await api(`pulls/${pr}/comments`, thread, '-F', 'line=1')
  }, 60_000)

  /** Undoes each seeded thing that was created, then fails naming whatever is left behind. */
  afterAll(async () => {
    const left: Error[] = []
    const undo = (what: string, step: Promise<unknown>) =>
      step.catch((cause) => left.push(new Error(`${what} left in ${repo}`, { cause })))
    if (pr) await undo(`PR #${pr} open`, api(`pulls/${pr}`, { state: 'closed' }, '-X', 'PATCH'))
    if (branched)
      await undo(`branch ${branch}`, api(`git/refs/heads/${branch}`, {}, '-X', 'DELETE'))
    if (issue)
      await undo(`issue #${issue}`, gh('issue', 'delete', String(issue), '-R', repo, '--yes'))
    if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind')
  }, 60_000)

  /** Search indexes new items a few seconds late, so read until both show up settled. */
  async function seeded(): Promise<{ issue: Item; pr: Item }> {
    for (let deadline = Date.now() + 90_000; ; await new Promise((r) => setTimeout(r, 5_000))) {
      const items = await github.items({ repos: [repo] }, ctx)
      const found = {
        issue: items.find((i) => i.key === `${repo}#${issue}`),
        pr: items.find((i) => i.key === `${repo}#${pr}`),
      }
      if (found.issue?.linkedPrs.length && found.pr?.fields.checks)
        return found as { issue: Item; pr: Item }
      if (Date.now() > deadline)
        throw new Error(`seeded items never showed up: ${JSON.stringify(found)}`)
    }
  }

  it('reads the seeded issue and PR with their fields and context', async () => {
    const found = await seeded()
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
        files: [path],
        changed_lines: 1,
        unresolved_threads: 1,
        my_unresolved_threads: 1,
        review_requested: false,
      },
    })

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
  }, 120_000)

  it('suggests my own repos at init', async () => {
    const setup = await github.init?.(scriptedAsk([[/GitHub repos/, initial]]), ctx)
    expect(setup?.config).toEqual({ repos: [`${login}/*`] })
  }, 30_000)
})
