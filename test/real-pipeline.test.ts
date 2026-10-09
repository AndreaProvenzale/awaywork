import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { footer } from '../src/core/footer.js'
import { type NightPlan, slug } from '../src/core/foreman.js'
import type { Item } from '../src/core/types.js'
import { exec } from '../src/forge/gh.js'
import { API } from '../src/sources/asana.js'

let repo = process.env.NIGHTSHIFT_GITHUB_SANDBOX ?? ''
const token = process.env.ASANA_TOKEN
const workspace = process.env.NIGHTSHIFT_ASANA_WORKSPACE ?? ''
const project = process.env.NIGHTSHIFT_ASANA_PROJECT ?? ''
const root = fileURLToPath(new URL('..', import.meta.url))
const gh = (...args: string[]) => exec('gh', args)
const api = (path: string, fields: Record<string, string> = {}, ...args: string[]) =>
  gh(
    'api',
    `repos/${repo}/${path}`,
    ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`]),
    ...args,
  )
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Calls Asana's REST API as the token's user and returns the response's `data`. */
async function asana<T>(method: string, path: string, data?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: data && JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${body.errors?.[0]?.message}`)
  return body.data
}

/**
 * Seeds a GitHub issue and an Asana task, then runs the CLI from source on a config over them:
 * `plan --json`, `run --dry-run --unit`, and `plan` again once a PR of mine links the task.
 * A fake `claude` on PATH answers the quota probe, so no provider binary runs; HOME is a temp dir,
 * so no state is shared with the developer's. Needs the GitHub and Asana live tests' env.
 */
describe.skipIf(!repo || !token || !workspace || !project)('pipeline, live, no quota', () => {
  const run = Date.now().toString(36)
  const label = 'night-shift-e2e'
  const branch = `night-shift-e2e-${run}`
  const section = 'Current sprint'
  const env: NodeJS.ProcessEnv = {}
  let config = ''
  let fakeArgv = ''
  let issueKey = ''
  let issue = 0
  const taskName = `[e2e ${run}] task`
  let task = ''
  let link = ''
  let branched = false
  let pr = 0

  const nightshift = async (...args: string[]) =>
    (
      await execa(
        'node',
        [
          '--experimental-transform-types',
          '--disable-warning=ExperimentalWarning',
          '--import',
          './scripts/ts-resolve.mjs',
          'src/cli/index.ts',
          '--config',
          config,
          ...args,
        ],
        { cwd: root, env },
      )
    ).stdout

  /** Plans until `pick` finds the seeded items settled: search indexes new issues and PRs late. */
  async function settled<T>(pick: (plan: NightPlan) => T | undefined): Promise<T> {
    for (let deadline = Date.now() + 120_000; ; await sleep(5_000)) {
      const plan = JSON.parse(await nightshift('plan', '--json'))
      const found = pick(plan)
      if (found) return found
      if (Date.now() > deadline)
        throw new Error(`seeded items never settled: ${JSON.stringify(plan.warnings)}`)
    }
  }

  const unitOf = (plan: NightPlan, key: string) =>
    plan.units.find((p) => p.unit.items.some((i) => i.key === key))

  beforeAll(async () => {
    const home = await mkdtemp(join(tmpdir(), 'nightshift-pipeline-'))
    const fakes = join(home, 'bin')
    await mkdir(fakes)
    await symlink(join(root, 'test', 'fakes', 'claude.mjs'), join(fakes, 'claude'))
    fakeArgv = join(home, 'argv.json')
    Object.assign(env, process.env, {
      HOME: home,
      PATH: `${fakes}${delimiter}${process.env.PATH}`,
      // gh keeps its login under the real HOME.
      GH_TOKEN: (await gh('auth', 'token')).trim(),
      FAKE_ARGV: fakeArgv,
    })

    const login = (await gh('api', 'user', '--jq', '.login')).trim()
    repo = JSON.parse(await gh('api', `repos/${repo}`)).full_name
    await gh('label', 'create', label, '-R', repo, '--force')
    const opened = { title: `[e2e ${run}] issue`, body: 'Seeded.', 'assignees[]': login }
    issue = Number(await api('issues', { ...opened, 'labels[]': label }, '--jq', '.number'))
    issueKey = `${repo}#${issue}`

    const sections = await asana<{ gid: string; name: string }[]>(
      'GET',
      `/projects/${project}/sections`,
    )
    const sprint = sections.find((s) => s.name === section)
    if (!sprint) throw new Error(`no section "${section}" in Asana project ${project}`)
    const seed = { name: taskName, notes: 'Seeded.', assignee: 'me', projects: [project] }
    task = (await asana<{ gid: string }>('POST', '/tasks', seed)).gid
    await asana('POST', `/sections/${sprint.gid}/addTask`, { task })

    config = join(home, 'config.yml')
    const cfg = {
      providers: ['claude'],
      sources: {
        github: { repos: [repo] },
        asana: { workspace, projects: [project], project_repos: { [project]: repo } },
      },
      queue: [
        { skill: 'implement', source: 'github', where: { type: 'issue', label } },
        { skill: 'plan', source: 'asana', where: { section } },
      ],
    }
    await writeFile(config, JSON.stringify(cfg))
  }, 60_000)

  afterAll(async () => {
    const steps: [string, false | (() => Promise<unknown>)][] = [
      [`PR #${pr} open`, !!pr && (() => api(`pulls/${pr}`, { state: 'closed' }, '-X', 'PATCH'))],
      [`branch ${branch}`, branched && (() => api(`git/refs/heads/${branch}`, {}, '-X', 'DELETE'))],
      [
        `issue #${issue}`,
        !!issue && (() => gh('issue', 'delete', String(issue), '-R', repo, '--yes')),
      ],
      [`Asana task ${task}`, !!task && (() => asana('DELETE', `/tasks/${task}`))],
    ]
    const left: Error[] = []
    for (const [what, undo] of steps)
      if (undo) await undo().catch((cause) => left.push(new Error(`${what} left`, { cause })))
    if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind')
  }, 60_000)

  it('plans each item as its unit and prepares it with its context', async () => {
    const plan = await settled((p) => unitOf(p, issueKey) && unitOf(p, task) && p)
    // The fake answered the quota probe, so the real binary never ran.
    expect(JSON.parse(await readFile(fakeArgv, 'utf8'))).toContain('claude-haiku-4-5-20251001')
    const units = [
      {
        key: issueKey,
        title: `[e2e ${run}] issue`,
        skill: 'implement',
        deliver: 'draft_pr',
        file: 'issue.md',
      },
      { key: task, title: taskName, skill: 'plan', deliver: 'report', file: 'task.md' },
    ]
    for (const { key, title, skill, deliver, file } of units) {
      const id = slug(key)
      expect(unitOf(plan, key)).toMatchObject({
        provider: 'claude',
        unit: { id, repo, skill, deliver, items: [{ key, title }] },
      })
      const out = await nightshift('run', '--dry-run', '--unit', key)
      expect(out).toContain(`${id}: ${skill} on claude`)
      const runDir = out.match(/state in (\S+)/)?.[1] ?? ''
      const work = join(runDir, 'work', id, '.nightshift')
      const context = join(work, 'context', id)
      expect(await readdir(context)).toEqual([file])
      expect(await readFile(join(context, file), 'utf8')).toContain(title)
      expect(await readFile(join(work, 'prompt.md'), 'utf8')).toContain(`- ${key}: ${title}`)
      expect(await readdir(join(runDir, 'plugins', id, 'skills'))).toEqual([skill])
    }
    link = unitOf(plan, task)?.unit.items[0]?.link ?? ''
    expect(link).toMatch(new RegExp(`^https://app\\.asana\\.com/.*${task}`))
  }, 300_000)

  it("links the task to my PR carrying its link, and skips it once that PR is night-shift's", async () => {
    const base = JSON.parse(await gh('api', `repos/${repo}`)).default_branch
    const sha = (await api(`git/ref/heads/${base}`, {}, '--jq', '.object.sha')).trim()
    await api('git/refs', { ref: `refs/heads/${branch}`, sha })
    branched = true
    const file = { message: 'Add e2e probe [skip ci]', content: btoa('probe\n'), branch }
    await api(`contents/e2e/${run}.md`, file, '-X', 'PUT')
    const opened = { title: `[e2e ${run}] PR`, head: branch, base, body: link }
    pr = Number(await api('pulls', opened, '--jq', '.number'))

    const linked = await settled((p) =>
      unitOf(p, task)?.unit.items[0]?.linkedPrs.find((l) => l.number === pr),
    )
    expect(linked).toMatchObject({ repo, branch, ours: false, mine: true })

    const item: Pick<Item, 'source' | 'key'> = { source: 'asana', key: task }
    const published = `Seeded.\n\n${link}\n\n${footer(run, [item])}`
    await api(`pulls/${pr}`, { body: published }, '-X', 'PATCH')
    const plan: NightPlan = JSON.parse(await nightshift('plan', '--json'))
    expect(unitOf(plan, task)).toBeUndefined()
    expect(plan.skipped.find((s) => s.item.key === task)?.reason).toBe(
      `waiting for review: night-shift PR https://github.com/${repo}/pull/${pr} is open`,
    )
  }, 300_000)
})
