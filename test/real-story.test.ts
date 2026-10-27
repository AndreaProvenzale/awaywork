import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import { defaultBranch, renderBranch } from '../src/core/branch.js'
import { type RunPlan, slug } from '../src/core/foreman.js'
import { exec } from '../src/forge/gh.js'

let repo = process.env.AWAYWORK_GITHUB_SANDBOX ?? ''
const otherToken = process.env.AWAYWORK_GITHUB_REVIEWER_TOKEN ?? ''
const root = fileURLToPath(new URL('..', import.meta.url))
type Gh = (...args: string[]) => Promise<string>
const gh: Gh = (...args) => exec('gh', args)
const otherGh: Gh = async (...args) =>
  (await execa(bin('gh'), args, { env: { GH_TOKEN: otherToken } })).stdout
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Pr {
  number: number
  html_url: string
  state: string
  draft: boolean
  body: string
  base: { ref: string }
  head: { ref: string; sha: string }
}

/**
 * The offline pipeline story, shorter, against the GitHub sandbox: a card is planned, approved and fanned out
 * by `awaywork run` from source, with real clones, pushes, PRs, comments and labels. A fake `claude` first on PATH
 * answers the quota probe and plays each task's part, so no quota is spent; HOME is a temp dir, so no state is
 * shared with the developer's. One step waits for the sandbox's own CI, a few minutes. Needs
 * AWAYWORK_GITHUB_SANDBOX; with AWAYWORK_GITHUB_REVIEWER_TOKEN, a collaborator also edits one of awaywork's drafts.
 */
describe.skipIf(!repo)('the pipeline story, live on the sandbox', () => {
  const run = Date.now().toString(36)
  const label = `awaywork-story-${run}`
  const moved = `${label}-review`
  const tasks = ['api', 'web', 'fix', 'qa', 'docs', ...(otherToken ? ['notes'] : [])]
  const planYml = `tasks:
  - { id: api, title: Export endpoint and its table }
  - { id: web, title: Export button, after: { api: opened } }
  - { id: fix, title: Export fix, after: { api: check } }
  - { id: qa, title: QA evidence, skill: qa-evidence, after: { web: opened } }
  - { id: docs, title: Export docs }
${otherToken ? '  - { id: notes, title: Release notes }\n' : ''}`
  const env: NodeJS.ProcessEnv = {}
  let home = ''
  let config = ''
  let owner = ''
  let issue = 0
  let cardKey = ''
  let cardUrl = ''
  const taskKey = (task: string) => `${cardKey}/${task}`
  const branchOf = (task: string) => renderBranch(defaultBranch, { key: taskKey(task), title: '' })
  const before: Record<string, Pr> = {}

  const awaywork = async (...args: string[]) => {
    const { stdout, stderr } = await execa(
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
    console.log(`$ awaywork ${args.join(' ')}\n${stdout}\n${stderr}`)
    return stdout
  }
  const planJson = async (): Promise<RunPlan> => JSON.parse(await awaywork('plan', '--json'))
  const reasonOf = (plan: RunPlan, key: string) =>
    plan.skipped.find((s) => s.item.key === key)?.reason
  const unitOf = (plan: RunPlan, key: string) =>
    plan.units.find((p) => p.unit.items.some((i) => i.key === key))

  /** Plans until `pick` finds what it waits for: search indexes a new issue late. */
  async function settled<T>(pick: (plan: RunPlan) => T | undefined): Promise<T> {
    for (let deadline = Date.now() + 120_000; ; await sleep(5_000)) {
      const plan = await planJson()
      const found = pick(plan)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`never settled: ${JSON.stringify(plan.skipped)}`)
    }
  }

  /** Every PR, in any state, from the task's branch. */
  const prsOf = async (task: string): Promise<Pr[]> =>
    JSON.parse(await api(`pulls?state=all&head=${owner}:${branchOf(task)}`))
  const prOf = async (task: string) => (await prsOf(task))[0]
  const comments = async (): Promise<string[]> =>
    JSON.parse(await api(`issues/${issue}/comments`, {}, '--jq', '[.[].body]'))

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'awaywork-story-'))
    const fakes = join(home, 'bin')
    await mkdir(fakes)
    await symlink(join(root, 'test', 'fakes', 'story-claude.mjs'), join(fakes, 'claude'))
    // The worker commits as the developer's git identity, read under this HOME.
    await writeFile(
      join(home, '.gitconfig'),
      '[user]\n\tname = awaywork story\n\temail = story@e2e\n',
    )
    Object.assign(env, process.env, {
      HOME: home,
      PATH: `${fakes}${delimiter}${process.env.PATH}`,
      // gh keeps its login under the real HOME.
      GH_TOKEN: (await gh('auth', 'token')).trim(),
      FAKE_PLAN: planYml,
      FAKE_CONTINUE: 'api,docs,notes',
    })

    const login = (await gh('api', 'user', '--jq', '.login')).trim()
    repo = JSON.parse(await gh('api', `repos/${repo}`)).full_name
    owner = repo.split('/')[0] ?? ''
    await gh('label', 'create', label, '-R', repo, '--force')
    const seed = {
      title: `[story ${run}] VAT export`,
      body: 'Accountants want a VAT export.',
      'assignees[]': login,
      'labels[]': label,
    }
    issue = Number(await api('issues', seed, '--jq', '.number'))
    cardKey = `${repo}#${issue}`
    cardUrl = `https://github.com/${repo}/issues/${issue}`

    config = join(home, 'config.yml')
    await writeFile(
      config,
      `providers: [claude]
windows: []
sources: { github: { repos: [${repo}] } }
gates: { schema: { changed: ["**/migrations/**"] } }
queue:
  - skill: plan
    where: { type: issue, label: ${label} }
    deliver: plan
    on_done: { move: ${moved} }
  - skill: implement
    where: { planned: true }
    deliver: pr
  - skill: qa-evidence
    where: { planned: true }
    deliver: report
`,
    )
    await mkdir(join(home, 'skills/qa-evidence'), { recursive: true })
    await writeFile(
      join(home, 'skills/qa-evidence/SKILL.md'),
      '---\nname: qa-evidence\ndescription: Collect QA evidence for a task. Use when a task needs checking by hand.\n---\n\nCheck the task and report the evidence.\n',
    )
  }, 60_000)

  /** Cancels the branch's workflow runs still going, waits for them to stop, then deletes them. */
  async function deleteRuns(branch: string) {
    for (let deadline = Date.now() + 120_000; ; await sleep(5_000)) {
      const runs: { id: number; status: string }[] = JSON.parse(
        await api(
          `actions/runs?branch=${encodeURIComponent(branch)}`,
          {},
          '--jq',
          '[.workflow_runs[] | {id, status}]',
        ),
      )
      if (runs.every((r) => r.status === 'completed')) {
        for (const { id } of runs) await api(`actions/runs/${id}`, {}, '-X', 'DELETE')
        return
      }
      if (Date.now() > deadline) throw new Error(`runs on ${branch} never stopped`)
      for (const { id, status } of runs)
        if (status !== 'completed')
          await api(`actions/runs/${id}/cancel`, {}, '-X', 'POST').catch(() => {})
    }
  }

  afterAll(async () => {
    const left: Error[] = []
    const undo = (what: string, step: () => Promise<unknown>) =>
      step().then(
        () => true,
        (cause) => {
          left.push(new Error(`${what} left in ${repo}`, { cause }))
          return false
        },
      )
    if (issue) {
      // Only names this run made: its card's task branches and the PRs from them.
      const unclosed = new Set<string>()
      for (const task of tasks) {
        const closed = await undo(`PRs from ${branchOf(task)}`, async () => {
          for (const pr of await prsOf(task))
            if (pr.state === 'open')
              await api(`pulls/${pr.number}`, { state: 'closed' }, '-X', 'PATCH')
        })
        if (!closed) unclosed.add(task)
      }
      for (const task of tasks) {
        const branch = branchOf(task)
        if (unclosed.has(task)) {
          left.push(new Error(`branch ${branch} left in ${repo}: its PRs may still be open`))
          continue
        }
        const pushed = await api(`branches/${encodeURIComponent(branch)}`).then(
          () => true,
          () => false,
        )
        await undo(`workflow runs on ${branch}`, () => deleteRuns(branch))
        if (pushed)
          await undo(`branch ${branch}`, () => api(`git/refs/heads/${branch}`, {}, '-X', 'DELETE'))
      }
      await undo(`issue #${issue}`, () => gh('issue', 'delete', String(issue), '-R', repo, '--yes'))
    }
    for (const name of [label, moved])
      await undo(`label ${name}`, () =>
        gh('label', 'delete', name, '-R', repo, '--yes').catch((e) => {
          if (!String(e.stderr).startsWith('HTTP 404')) throw e
        }),
      )
    if (home) await rm(home, { recursive: true, force: true })
    if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind')
  }, 600_000)

  it('plans the card, posting the plan and moving the label, then waits for your approval', async () => {
    const card = await settled((p) => unitOf(p, cardKey))
    expect(card.unit).toMatchObject({ skill: 'plan', deliver: 'plan' })
    await awaywork('run')

    const [plan, ...rest] = await comments()
    expect(rest).toEqual([])
    expect(plan).toMatch(/^The story: an endpoint with its migration, then the rest around it\.\n/)
    expect(plan).toContain(`\`\`\`yaml\n${planYml.trim()}\n\`\`\``)
    expect(plan).toMatch(/\n\n— awaywork$/)
    const labels = JSON.parse(await api(`issues/${issue}`, {}, '--jq', '[.labels[].name]'))
    expect(labels).toEqual(expect.arrayContaining([label, moved]))
    expect(reasonOf(await planJson(), cardKey)).toBe(
      `waiting for your approval of the plan on ${cardUrl}`,
    )
  }, 300_000)

  it('approves the plan as your reply on the card', async () => {
    expect(await awaywork('approve', `github:${cardKey}`)).toContain(
      `plan approved: replied approve on ${cardUrl}`,
    )
    expect((await comments()).at(-1)).toMatch(/^approve\n\n— awaywork$/)
  }, 60_000)

  it("fans out: api opens a gated draft that says continue, web waits on it, fix on api's check", async () => {
    const out = await awaywork('run')
    const apiPr = await prOf('api')
    expect(apiPr).toMatchObject({ state: 'open', draft: true, base: { ref: 'main' } })
    const body = apiPr?.body ?? ''
    expect(body).toMatch(
      new RegExp(
        `^Status: continue \\(1 of 3\\): awaywork's next window run goes on here\\n\\n## Needs a decision\\n\\n### Gates \\(from scripts\\)\\n\\n- schema: migrations/${slug(taskKey('api'))}\\.sql\\n`,
      ),
    )
    expect(body).toContain(`Part of ${cardUrl}`)
    expect(body).not.toMatch(/closes/i)
    expect(body).toContain(`item=github:${encodeURIComponent(taskKey('api'))}`)
    expect(body).toContain(`status=continue continued=1 head=${apiPr?.head.sha} from=`)

    const docs = await prOf('docs')
    expect(docs).toMatchObject({ state: 'open', draft: true })
    expect(docs?.body).toMatch(
      /^Status: continue \(1 of 3\)[^\n]*\n\nGates: none fired \(schema\)\n/,
    )

    expect(await prOf('web')).toBeUndefined()
    expect(out).toContain('api left a draft that says continue')
    const plan = await planJson()
    expect(reasonOf(plan, taskKey('fix'))).toBe(
      "waiting for api's check check (its draft says continue)",
    )
    for (const task of tasks) if (task !== 'qa') before[task] = (await prOf(task)) as Pr
  }, 300_000)

  it.skipIf(!otherToken)(
    'leaves a draft someone else edited to you, and says why',
    async () => {
      const notes = before.notes as Pr
      await restApi(otherGh)(
        `pulls/${notes.number}`,
        { body: `${notes.body}\n\nEdited by a teammate.` },
        '-X',
        'PATCH',
      )
      expect(reasonOf(await planJson(), taskKey('notes'))).toBe(
        `awaywork's draft ${notes.html_url} says continue, but someone else opened or edited it last: finish it by hand, or mark it ready`,
      )
    },
    60_000,
  )

  it('goes on with api on its own draft, which the gate keeps a draft, stacks web on it, docs turns ready and qa reports', async () => {
    const plan = await planJson()
    expect(unitOf(plan, taskKey('api'))?.unit.resume?.url).toBe(before.api?.html_url)
    await awaywork('run')

    const apiPrs = await prsOf('api')
    expect(apiPrs).toHaveLength(1)
    const apiPr = apiPrs[0] as Pr
    expect(apiPr).toMatchObject({ number: before.api?.number, state: 'open', draft: true })
    expect(apiPr.head.sha).not.toBe(before.api?.head.sha)
    const compare = await api(
      `compare/${before.api?.head.sha}...${apiPr.head.sha}`,
      {},
      '--jq',
      '.status',
    )
    expect(compare.trim()).toBe('ahead')
    expect(apiPr.body).toMatch(/^## Needs a decision\n/)
    expect(apiPr.body).not.toContain('status=')

    const docs = (await prsOf('docs')) as Pr[]
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ number: before.docs?.number, state: 'open', draft: false })
    expect(docs[0]?.body).toMatch(/^Gates: none fired \(schema\)\n/)

    const web = await prOf('web')
    expect(web).toMatchObject({ state: 'open', draft: false, base: { ref: branchOf('api') } })
    expect(web?.body).toContain(`Stacked on ${apiPr.html_url}: merge that first.`)

    expect((await comments()).at(-1)).toBe(
      'Result of task qa\n\nExport screen: CSV downloads, 3 screenshots attached.\n\nStatus: done\n\n— awaywork',
    )

    if (otherToken) {
      const notes = await prOf('notes')
      expect(notes).toMatchObject({ draft: true, head: { sha: before.notes?.head.sha } })
      expect(notes?.body).toMatch(/Edited by a teammate\.$/)
    }
  }, 300_000)

  it("runs fix once the sandbox's check passed on api's head", async () => {
    const head = (await prOf('api'))?.head.sha
    for (let deadline = Date.now() + 600_000; ; await sleep(15_000)) {
      const runs: { status: string; conclusion: string | null }[] = JSON.parse(
        await api(
          `commits/${head}/check-runs?check_name=check`,
          {},
          '--jq',
          '[.check_runs[] | {status, conclusion}]',
        ),
      )
      const done = runs.find((r) => r.status === 'completed')
      if (done) {
        expect(done.conclusion).toBe('success')
        break
      }
      if (Date.now() > deadline) throw new Error(`check never completed on ${head}`)
    }
    await settled((p) => unitOf(p, taskKey('fix')))
    await awaywork('run')
    const fix = await prOf('fix')
    expect(fix).toMatchObject({ state: 'open', draft: false, base: { ref: branchOf('api') } })
    expect(reasonOf(await planJson(), cardKey)).toMatch(/^fanned out: /)
  }, 900_000)
})
