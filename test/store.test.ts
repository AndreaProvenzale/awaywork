import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { bin, builtinSkillsDir } from '../src/config/paths.js'
import { allowance } from '../src/core/budget.js'
import {
  commentKind,
  footer,
  footerPins,
  leanPlanComment,
  markComment,
  type Pin,
  pinBlock,
  pinsOf,
  planComment,
  resultComment,
  resultOf,
} from '../src/core/footer.js'
import { planRun } from '../src/core/foreman.js'
import { planState } from '../src/core/plan.js'
import { postAnswer, readBackPosts, reportPost, withApproved } from '../src/core/posts.js'
import { formatReport } from '../src/core/report.js'
import { builtinSkills } from '../src/core/skills.js'
import type { Item, Provider, Source, Write } from '../src/core/types.js'
import { checkPins, type Store } from '../src/worker/store.js'
import { runUnits } from '../src/worker/units.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'
import { fakeProvider } from './fakes/provider.js'
import { fakeSource } from './fakes/source.js'

process.env.GIT_COMMITTER_NAME ??= 't'
process.env.GIT_COMMITTER_EMAIL ??= 't@t'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** The guide's example store: files in a folder next to it, at file:// URLs; this one refuses to put fail.bin. */
const storeScript = `import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const op = JSON.parse(readFileSync(0, 'utf8'))
if (op.op === 'put') {
  if (basename(op.path) === 'fail.bin') throw new Error('bucket full')
  const to = join(dirname(fileURLToPath(import.meta.url)), 'files', randomUUID(), basename(op.path))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(op.path, to)
  console.log(JSON.stringify({ url: pathToFileURL(to).href }))
} else process.stdout.write(readFileSync(fileURLToPath(op.url)))
`

async function folderStore(): Promise<{ config: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'awaywork-store-'))
  await writeFile(join(dir, 'store.mjs'), storeScript)
  return { config: `store: { command: 'node ${join(dir, 'store.mjs')}' }`, dir }
}

const shared = await folderStore()

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** A file in a folder of its own, pinned by its file:// URL. */
async function pinned(name: string, text: string, hash = sha(text)): Promise<Pin> {
  const path = join(await mkdtemp(join(tmpdir(), 'awaywork-pinned-')), name.replaceAll('/', '_'))
  await writeFile(path, text)
  return { name, url: pathToFileURL(path).href, sha256: hash }
}

const yours = (n: number, comments: Item['comments'] = []) =>
  fakeItem({
    source: 'github',
    id: String(n),
    key: `acme/api#${n}`,
    type: 'issue',
    mine: true,
    comments,
    fields: { repo: 'acme/api', updated: '2026-10-24T00:00:00Z' },
  })

const post = (body: string, at = '2026-10-24T01:00:00Z') => ({
  author: 'me',
  at,
  mine: true as const,
  body,
})

/** A step that writes `files` to `.away/out/` and keeps each prompt and what its context's `files/` held. */
const writer = (files: Record<string, string>, seen: { prompts: string[]; read: string[] }) =>
  ({
    ...fakeProvider('claude'),
    async *run(job: { dir: string; prompt: string }) {
      seen.prompts.push(job.prompt)
      const context = join(job.dir, '.away/context')
      const all = await readdir(context, { recursive: true })
      seen.read.push(...all.filter((p) => p.includes('/files/')).sort())
      for (const [name, text] of Object.entries(files)) {
        await mkdir(join(job.dir, '.away/out', name, '..'), { recursive: true })
        await writeFile(join(job.dir, '.away/out', name), text)
      }
      yield { type: 'done', ok: true, turns: 1 }
    },
  }) as Provider

/** Runs `queue` under `top` on `items`, recording what awaywork writes to them and the pins a PR's footer gets. */
async function run(top: string, queue: string, items: Item[], provider: Provider) {
  const root = await mkdtemp(join(tmpdir(), 'awaywork-store-run-'))
  const origin = join(root, 'origin')
  await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
  const footers: Pin[][] = []
  const forge = {
    ...fakeForge(),
    clone: async (_repo: string, _branch: string, dir: string) => {
      await execa(bin('git'), ['clone', '-q', origin, dir])
    },
    openPr: async (...args: unknown[]) => {
      footers.push((args[8] as Pin[] | undefined) ?? [])
      return 'https://example.com/acme/api/pull/9'
    },
  }
  const config = parseConfig(
    `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\n${top}\nqueue:\n${queue}\n`,
  )
  const plan = planRun({
    config,
    items,
    allowances: { claude: allowance(config.budget, null, 0, config.windows) },
    skills: { builtin: builtinSkills },
  })
  const writes: [string, Write][] = []
  const source = {
    ...fakeSource(),
    write: async (_cfg: unknown, item: Item, w: Write) => {
      writes.push([item.key, w])
      return {}
    },
  } as Source
  const report = await runUnits({
    config,
    configDir: root,
    plan,
    runId: 'r1',
    runDir: join(root, 'run'),
    dryRun: false,
    providers: { claude: provider },
    sources: { github: source },
    forge,
    ctx: { env: { PATH: process.env.PATH }, log: () => {} },
    watch: () => ({ stop: async () => {} }),
    shortage: async () => undefined,
    skillDirs: { user: join(root, 'none'), builtin: builtinSkillsDir },
  })
  const body = (n = 0) => {
    const w = writes[n]?.[1]
    return w?.op === 'comment' ? w.body : ''
  }
  return { report, writes, body, footers, plan, root }
}

const report = '  - { skill: review, deliver: report, on_done: { comment: result } }'

describe('pins', () => {
  it('reads pins from above the mark only, and still tells the post by the line above them', async () => {
    const pins = [await pinned('plan.yml', 'tasks: []'), await pinned('shots/a b.png', 'png')]
    const result = post(
      markComment(`${resultComment('Done.', 'done', 'qa')}${pinBlock(pins)}`, {
        waits: true,
      }),
    )
    expect(pinsOf(result)).toEqual(pins)
    expect(result.body).toContain('Pinned shots/a%20b.png: file://')
    expect(commentKind(result)).toBe('result')
    expect(resultOf(result)).toMatchObject({ status: 'done', text: 'Done.' })
    const plan = post(
      markComment(`${leanPlanComment('Two.', [{ id: 'api', title: 'A' }])}${pinBlock(pins)}`),
    )
    expect(commentKind(plan)).toBe('plan')
    // A model's text above awaywork's lines pins nothing.
    const faked = post(
      markComment(resultComment(`Pinned x: http://evil (sha256 ${'a'.repeat(64)})`, 'done', 'qa')),
    )
    expect(pinsOf(faked)).toEqual([])
    expect(pinsOf({ ...result, mine: undefined })).toEqual([])
    const body = `Pinned y: http://evil (sha256 ${'b'.repeat(64)})\n\n${footer('r1', [], undefined, pins)}`
    expect(footerPins(body)).toEqual(pins)
    expect(footerPins(footer('r1', []))).toEqual([])
  })
})

describe('lean posts', () => {
  it("posts a report's summary with a pin per out file, and asks the step for summary.md", async () => {
    const store = await folderStore()
    const seen = { prompts: [], read: [] }
    const files = {
      'report.md': 'Long report.',
      'summary.md': 'Looks fine.',
      'shots/home.png': 'png',
    }
    const { body, report: r } = await run(store.config, report, [yours(1)], writer(files, seen))
    expect(seen.prompts[0]).toContain('Also write `.away/out/summary.md`')
    const pins = pinsOf(post(body()))
    expect(pins.map((p) => [p.name, p.sha256])).toEqual([
      ['report.md', sha('Long report.\n')],
      ['shots/home.png', sha('png')],
    ])
    expect(body()).toBe(
      markComment(`${resultComment('Looks fine.', 'done', 'review')}${pinBlock(pins)}`),
    )
    for (const p of pins) expect(existsSync(new URL(p.url))).toBe(true)
    expect(r.results[0]?.store).toBeUndefined()
  })

  it("falls back to the report's first lines without summary.md, and says so", async () => {
    const store = await folderStore()
    const files = { 'report.md': 'One.\nTwo.\nThree.\nFour.\nFive.\nSix.' }
    const { body, report: r } = await run(
      store.config,
      report,
      [yours(1)],
      writer(files, { prompts: [], read: [] }),
    )
    expect(resultOf(post(body()))?.text).toBe('One.\nTwo.\nThree.\nFour.\nFive.')
    expect(formatReport(r)).toContain("no summary.md: the post shows the report's first lines")
  })

  it('posts a full report with only its other files pinned, and the post without a failed put', async () => {
    const store = await folderStore()
    const files = { 'report.md': 'The report.', 'notes.txt': 'n', 'fail.bin': 'x' }
    const { body, report: r } = await run(
      store.config,
      '  - { skill: review, deliver: report, post: full, on_done: { comment: result } }',
      [yours(1)],
      writer(files, { prompts: [], read: [] }),
    )
    const pins = pinsOf(post(body()))
    expect(pins.map((p) => p.name)).toEqual(['notes.txt'])
    expect(body()).toBe(
      markComment(`${resultComment('The report.', 'done', 'review')}${pinBlock(pins)}`),
    )
    expect(r.results[0]?.store).toEqual([
      expect.stringMatching(/^fail\.bin not stored: Command failed/),
    ])
  })

  it('posts no store and no pins without a store, as before', async () => {
    const files = { 'report.md': 'The report.', 'notes.txt': 'n' }
    const seen = { prompts: [], read: [] }
    const { body } = await run('', report, [yours(1)], writer(files, seen))
    expect(body()).toBe(markComment(resultComment('The report.', 'done', 'review')))
    expect(seen.prompts[0]).not.toContain('summary.md')
  })

  it("posts a lean plan's summary and tasks, its plan.yml and report pinned, which planning reads back", async () => {
    const store = await folderStore()
    const yaml = 'tasks:\n  - { id: api, title: VAT endpoint }\n'
    const files = { 'report.md': 'Narrative.', 'summary.md': 'One task.', 'plan.yml': yaml }
    const { body, report: r } = await run(
      store.config,
      '  - { skill: plan, deliver: plan }\n  - { skill: implement, where: { planned: true } }',
      [yours(1)],
      writer(files, { prompts: [], read: [] }),
    )
    const pins = pinsOf(post(body()))
    expect(pins.map((p) => p.name)).toEqual(['plan.yml', 'report.md'])
    expect(body()).toBe(
      markComment(
        `${leanPlanComment('One task.', [{ id: 'api', title: 'VAT endpoint' }])}${pinBlock(pins)}`,
      ),
    )
    expect(r.results[0]?.plan).toMatchObject({ tasks: ['api'], post: { waits: true } })
    const config = parseConfig(
      `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\n${store.config}\n`,
    )
    const card = yours(1, [post(body()), post('approve', '2026-10-24T02:00:00Z')])
    await checkPins([card], config.store as Store, process.env)
    expect(planState(card, { maxTasks: 8, repo: 'acme/api' })).toMatchObject({
      state: 'approved',
      plan: { tasks: [{ id: 'api', title: 'VAT endpoint' }] },
    })
  })
})

describe('read-back', () => {
  const store = shared.config
  const files = (pins: Pin[]) =>
    markComment(`${resultComment('Shots.', 'done', 'qa')}${pinBlock(pins)}`)

  it('brings the files of posts newer than its own last one into context, and the approved post they cover', async () => {
    const qa = await pinned('home.png', 'png')
    const story = await pinned('report.md', 'the story')
    const old = await pinned('old.png', 'old')
    const card = yours(1, [
      post(
        markComment(
          `${resultComment('Story.', 'done', 'story', undefined, 0, true)}${pinBlock([story])}`,
          { waits: true },
        ),
      ),
      post('approve', '2026-10-24T02:00:00Z'),
      post(files([old]), '2026-10-24T03:00:00Z'),
      post(markComment(resultComment('Built.', 'done', 'review')), '2026-10-24T04:00:00Z'),
      post(files([qa]), '2026-10-24T05:00:00Z'),
    ])
    expect(
      readBackPosts(
        { ...card, fields: { ...card.fields, approved: 'story' } },
        'review',
        false,
      ).map((p) => p.name),
    ).toEqual(['1-story', '5-qa'])
    const seen = { prompts: [], read: [] as string[] }
    const { report: r } = await run(
      store.replace(' }', ', read: { max_mb: 0.00001 } }'),
      '  - { skill: review, deliver: report, where: { approved: story } }',
      [withApproved(card)],
      writer({ 'report.md': 'ok' }, seen),
    )
    expect(seen.read).toEqual([
      'acme-api-1/files/1-story',
      'acme-api-1/files/1-story/report.md',
      'acme-api-1/files/5-qa',
    ])
    expect(seen.prompts[0]).toContain('`.away/context/acme-api-1/files/`')
    expect(r.results[0]?.store).toEqual([
      "over the store's read.max_mb, left as links: home.png of awaywork's post of 2026-10-24T05:00:00Z",
    ])
  })

  it('says which file changed since it was pinned, leaves out those the filter skips, and skips the unit when a get fails', async () => {
    const edited = await pinned('report.md', 'edited', sha('as posted'))
    const log = await pinned('run.log', 'log')
    const card = yours(1, [post(files([edited, log]))])
    const seen = { prompts: [], read: [] as string[] }
    const { report: r } = await run(
      store.replace(' }', ', read: { files: ["*.md"] } }'),
      '  - { skill: review, deliver: report }',
      [card],
      writer({ 'report.md': 'ok' }, seen),
    )
    expect(seen.read).toEqual(['acme-api-1/files/1-qa', 'acme-api-1/files/1-qa/report.md'])
    expect(r.results[0]?.store).toEqual([
      "report.md of awaywork's post of 2026-10-24T01:00:00Z changed in the store since awaywork pinned it",
    ])
    const gone = { ...edited, url: 'file:///nowhere/report.md' }
    const failed = await run(
      store,
      '  - { skill: review, deliver: report }',
      [yours(1, [post(files([gone]))])],
      writer({}, seen),
    )
    expect(failed.report.results[0]).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/^couldn't read report\.md from the store: /),
    })
  })

  it('pins what a PR step leaves besides its body in the footer', async () => {
    const s = await folderStore()
    const provider = {
      ...fakeProvider('claude'),
      async *run(job: { dir: string }) {
        await writeFile(join(job.dir, 'a.txt'), 'a')
        await git(job.dir, 'add', 'a.txt')
        await git(job.dir, 'commit', '-qm', 'a')
        await writeFile(join(job.dir, '.away/out/pr.md'), 'Add a\n\nDone.')
        await writeFile(join(job.dir, '.away/out/shot.png'), 'png')
        yield { type: 'done', ok: true, turns: 1 }
      },
    } as Provider
    const { footers } = await run(s.config, '  - { skill: implement }', [yours(1)], provider)
    expect(footers.map((pins) => pins.map((p) => [p.name, p.sha256]))).toEqual([
      [['shot.png', sha('png')]],
    ])
  })
})

describe('stale posts', () => {
  const config = parseConfig(
    `providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\n${shared.config}\nqueue:\n  - { skill: story, deliver: report, wait: true }\n  - { skill: prototype, deliver: report, where: { approved: story } }\n`,
  )
  const waiting = (pins: Pin[]) =>
    post(
      markComment(
        `${resultComment('Story.', 'done', 'story', undefined, 0, true)}${pinBlock(pins)}`,
        { waits: true },
      ),
    )

  it('counts an edited file as feedback: the rule runs again though the card is unchanged, and approve needs a fresh post', async () => {
    const edited = await pinned('report.md', 'edited', sha('as posted'))
    const card = yours(1, [waiting([edited]), post('approve', '2026-10-24T02:00:00Z')])
    await checkPins([card], config.store as Store, process.env)
    expect(card.comments[0]?.pinned).toEqual({ files: {}, stale: 'report.md' })
    expect(postAnswer(reportPost(card, 'story') as never)).toBe('feedback')
    const attempts = {
      'github:acme/api#1': { runId: 'r0', skill: 'story', updated: '2026-10-24T00:00:00Z' },
    }
    const plan = planRun({
      config,
      items: [withApproved(card)],
      allowances: { claude: allowance(config.budget, null, 0, config.windows) },
      skills: { builtin: builtinSkills },
      attempts,
    })
    expect(plan.units.map((u) => [u.unit.skill, u.unit.waits])).toEqual([['story', true]])
  })

  it('skips the item the approved post hands on, counting no attempt, when a get fails while planning', async () => {
    const gone = { name: 'report.md', url: 'file:///nowhere/report.md', sha256: sha('x') }
    const card = yours(1, [waiting([gone]), post('approve', '2026-10-24T02:00:00Z')])
    await checkPins([card], config.store as Store, process.env)
    const plan = planRun({
      config,
      items: [withApproved(card)],
      allowances: { claude: allowance(config.budget, null, 0, config.windows) },
      skills: { builtin: builtinSkills },
    })
    expect(plan.skipped.map((s) => [s.kind, s.reason.split(':')[0]])).toEqual([
      ['store_failed', "couldn't read report.md from the store"],
    ])
  })

  it('keeps a full plan as it was: its comment is the plan, its pins only extras', () => {
    const body = planComment('Narrative.', 'tasks:\n  - { id: api, title: A }\n')
    const card = yours(1, [post(markComment(body)), post('approve', '2026-10-24T02:00:00Z')])
    expect(planState(card, { maxTasks: 8, repo: 'acme/api' })).toMatchObject({ state: 'approved' })
  })
})

describe('store config', () => {
  it('refuses post on a PR rule and post: summary without a store', () => {
    const base = 'providers: [claude: {}]\nsources: { github: { repos: [acme/*] } }\n'
    expect(() => parseConfig(`${base}queue:\n  - { skill: implement, post: full }\n`)).toThrow(
      'post needs deliver: plan or report',
    )
    expect(() =>
      parseConfig(`${base}queue:\n  - { skill: review, deliver: report, post: summary }\n`),
    ).toThrow('post: summary pins files in a store')
    const config = parseConfig(`${base}store: { command: ./store.sh, secrets: [STORE_TOKEN] }\n`)
    expect(config.store).toEqual({
      command: './store.sh',
      secrets: ['STORE_TOKEN'],
      get: true,
      read: { max_mb: 10, files: [] },
    })
  })
})
