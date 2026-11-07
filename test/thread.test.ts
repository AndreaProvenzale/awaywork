import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approveItem } from '../src/cli/approve.js'
import { finishedSince, linkThreads, probeAndPlan } from '../src/cli/plan.js'
import { parseConfig } from '../src/config/load.js'
import { markComment, planComment, threadBody, threadMarker, threadOf } from '../src/core/footer.js'
import type { Forge, Item, Thread } from '../src/core/types.js'
import { githubSource, githubThreads } from '../src/sources/github.js'
import { sourceFor, writeItem } from '../src/sources/index.js'
import { fakeForge } from './fakes/forge.js'
import { fixture, recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'

type Found = { item: string; thread: Thread; comments: Item['comments'] }

/** A forge whose thread issues live in memory: what it opened, commented and closed, in order. */
function threadForge(found: Found[] = []): Forge & { calls: string[] } {
  const calls: string[] = []
  return Object.assign(fakeForge(), {
    calls,
    byRepo: true,
    threads: async (repo?: string) => {
      calls.push(`threads ${repo}`)
      return found.filter((t) => t.thread.key.startsWith(`${repo}#`))
    },
    openThread: async (repo: string | undefined, item: Pick<Item, 'source' | 'key'>) => {
      calls.push(`open ${repo} for ${item.source}:${item.key}`)
      return { host: 'github', key: `${repo}#57`, url: `https://github.com/${repo}/issues/57` }
    },
    threadComment: async (t: Thread, body: string) => {
      calls.push(`comment ${t.key}: ${body.split('\n')[0]}`)
      return `${t.url}#issuecomment-1`
    },
    closeThread: async (t: Thread, body: string) => {
      calls.push(`close ${t.key}: ${body.split('\n')[0]}`)
    },
  })
}

const thread57: Thread = {
  host: 'github',
  key: 'acme/api#57',
  url: 'https://github.com/acme/api/issues/57',
}
const plan = markComment(
  planComment('Two tasks.', 'tasks:\n  - id: api\n    title: The endpoint\n'),
)
const ctx = () => ({ env: process.env, log: () => {} })

describe('the thread marker', () => {
  it("names the item an issue is awaywork's thread of, and nothing else carries it", () => {
    const item = { source: 'jira', key: 'ENG 7', title: 'Export VAT', url: 'https://jira/ENG-7' }
    expect(threadMarker(item)).toBe('<!-- awaywork thread item=jira:ENG%207 -->')
    expect(threadOf(threadBody(item))).toBe('jira:ENG 7')
    expect(threadOf('Opened by hand\n<!-- awaywork run=1 item=jira:ENG-7 -->')).toBeUndefined()
    expect(threadOf(undefined)).toBeUndefined()
  })
})

describe('a comment on an item with a thread', () => {
  const card = (over: Partial<Item> = {}) =>
    fakeItem({
      source: 'jira',
      key: 'ENG-7',
      type: 'task',
      mine: true,
      fields: { repo: 'acme/api', updated: '2026-11-01T00:00:00Z' },
      ...over,
    })

  it("opens the thread issue once, on a source that can't write, and posts there after", async () => {
    const forge = threadForge()
    const item = card()
    const write = { op: 'comment', body: 'Two tasks.' } as const
    const first = await writeItem(undefined, {}, item, write, ctx(), undefined, {
      forge,
      open: 'github',
    })
    const second = await writeItem(undefined, {}, item, write, ctx(), undefined, { forge })
    expect(first).toEqual({ url: 'https://github.com/acme/api/issues/57#issuecomment-1' })
    expect(second).toEqual(first)
    expect(forge.calls).toEqual([
      'open acme/api for jira:ENG-7',
      'comment acme/api#57: Two tasks.',
      'comment acme/api#57: Two tasks.',
    ])
    // A move still goes to the card, which can't take it.
    await expect(
      writeItem(undefined, {}, item, { op: 'move', to: 'Done' }, ctx(), undefined, { forge }),
    ).rejects.toThrow("jira can't write to its items")
  })

  it("refuses an item that isn't yours", async () => {
    const forge = threadForge()
    const write = { op: 'comment', body: 'Hi' } as const
    const open = { forge, open: 'github' }
    await expect(
      writeItem(undefined, {}, card({ mine: undefined }), write, ctx(), undefined, open),
    ).rejects.toThrow('not yours')
    expect(forge.calls).toEqual([])
  })

  it("posts a task's comment on its card's thread", async () => {
    const forge = threadForge()
    const parent = card({ thread: thread57 })
    const task = fakeItem({ mine: true, task: { parent } as Item['task'] })
    await writeItem(undefined, {}, task, { op: 'comment', body: 'Done' }, ctx(), undefined, {
      forge,
    })
    expect(forge.calls).toEqual(['comment acme/api#57: Done'])
  })
})

describe('linking threads', () => {
  const config = parseConfig(`
providers: [claude]
sources: { tracker: { command: 'echo []' }, other: { command: 'echo []' } }
queue:
  - { skill: plan, source: tracker, deliver: plan, thread: github }
  - { skill: implement, where: { planned: true } }
`)
  const item = (key: string, over: Partial<Item> = {}) =>
    fakeItem({
      source: 'tracker',
      key,
      type: 'task',
      mine: true,
      fields: { repo: 'acme/api', updated: '2026-11-01T00:00:00Z' },
      ...over,
    })

  it("finds your items' threads by marker, their comments after the card's, a reply there standing for the card's updated time", async () => {
    const reply = {
      author: 'me',
      body: 'split it',
      at: '2026-11-03T00:00:00Z',
      mine: true as const,
    }
    const own = { author: 'me', body: plan, at: '2026-11-04T00:00:00Z', mine: true as const }
    const forge = threadForge([
      { item: 'tracker:ENG-7', thread: thread57, comments: [own, reply] },
      { item: 'tracker:ENG-8', thread: { ...thread57, key: 'acme/api#58' }, comments: [own] },
    ])
    const onCard = { author: 'bob', body: 'Looks big', at: '2026-10-30T00:00:00Z' }
    const items = [
      item('ENG-7', { comments: [onCard] }),
      item('ENG-8'),
      // Reassigned: its thread neither fans out nor takes answers.
      item('ENG-9', { mine: undefined }),
      item('ENG-10', { source: 'other' }),
    ]
    const linked = await linkThreads(items, config, forge, ctx())
    expect(forge.calls).toEqual(['threads acme/api'])
    expect(linked.map((i) => [i.key, i.thread?.key, i.comments.length, i.fields.updated])).toEqual([
      ['ENG-7', 'acme/api#57', 3, '2026-11-03T00:00:00Z'],
      // awaywork's own post there changes nothing.
      ['ENG-8', 'acme/api#58', 1, '2026-11-01T00:00:00Z'],
      ['ENG-9', undefined, 0, '2026-11-01T00:00:00Z'],
      ['ENG-10', undefined, 0, '2026-11-01T00:00:00Z'],
    ])
    expect(linked[0]?.thread?.card).toBe('2026-11-01T00:00:00Z')
    expect(linked[0]?.comments[0]).toBe(onCard)
  })

  it("leaves out the items whose repo's threads it couldn't read, saying so", async () => {
    const forge = Object.assign(threadForge(), {
      threads: async () => {
        throw new Error('HTTP 502')
      },
    })
    const lines: string[] = []
    const linked = await linkThreads([item('ENG-7')], config, forge, {
      env: {},
      log: (l) => lines.push(l),
    })
    expect(linked).toEqual([])
    expect(lines).toEqual([
      "couldn't read awaywork's threads in acme/api, so left out ENG-7: HTTP 502",
    ])
  })

  it("reads the week's finished items of a source a thread rule takes, to close their threads", () => {
    const since = finishedSince(config.queue ?? [], 'tracker')
    expect(Date.now() - (since?.getTime() ?? 0)).toBeGreaterThan(6.9 * 24 * 3600_000)
    expect(finishedSince(config.queue ?? [], 'other')).toBeUndefined()
  })
})

describe('planning a card whose rule talks on a thread', () => {
  let root: string
  const cwd = process.cwd()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awaywork-thread-'))
    process.chdir(root)
  })
  afterEach(() => process.chdir(cwd))

  const config = parseConfig(`
providers: [claude]
sources: { tracker: { command: 'cat items.json' } }
queue:
  - { skill: plan, source: tracker, deliver: plan, thread: github }
  - { skill: implement, where: { planned: true } }
`)
  const card = (state = 'open') => ({
    id: '7',
    key: 'ENG-7',
    title: 'Export VAT',
    url: 'https://tracker/ENG-7',
    state,
    fields: { repo: 'acme/api', updated: '2026-11-01T00:00:00Z' },
  })
  const posted = { author: 'me', body: plan, at: '2026-11-02T00:00:00Z', mine: true as const }
  const planOn = async (forge: Forge, dryRun = false) => {
    const lines: string[] = []
    const { plan, warnings } = await probeAndPlan(config, root, {
      probe: false,
      retry: true,
      forge,
      moves: { dryRun, log: (l) => lines.push(l) },
    })
    return { plan, warnings, lines }
  }

  it("waits on the thread for your approve, a teammate's there being context, then fans out", async () => {
    await writeFile(join(root, 'items.json'), JSON.stringify([card()]))
    const teammate = { author: 'bob', body: 'approve', at: '2026-11-03T00:00:00Z' }
    const waiting = await planOn(
      threadForge([{ item: 'tracker:ENG-7', thread: thread57, comments: [posted, teammate] }]),
    )
    expect(waiting.plan.skipped.map((s) => [s.kind, s.url])).toEqual([
      ['waiting_for_approval', thread57.url],
    ])
    const yours = { author: 'me', body: 'approve', at: '2026-11-04T00:00:00Z', mine: true as const }
    const approved = await planOn(
      threadForge([
        { item: 'tracker:ENG-7', thread: thread57, comments: [posted, teammate, yours] },
      ]),
    )
    expect(approved.plan.units.map((p) => [p.unit.skill, p.unit.items[0]?.key])).toEqual([
      ['implement', 'ENG-7/api'],
    ])
  })

  it('closes the thread once the card is done, a dry run only saying so', async () => {
    await writeFile(join(root, 'items.json'), JSON.stringify([card('closed')]))
    const found = [{ item: 'tracker:ENG-7', thread: thread57, comments: [posted] }]
    const dry = threadForge(found)
    expect((await planOn(dry, true)).lines).toEqual([
      `would close ${thread57.url}, ENG-7's thread: the card is closed`,
    ])
    expect(dry.calls).toEqual(['threads acme/api'])
    const real = threadForge(found)
    expect((await planOn(real)).lines).toEqual([
      `closed ${thread57.url}, ENG-7's thread: the card is closed`,
    ])
    expect(real.calls).toEqual([
      'threads acme/api',
      'close acme/api#57: The card is done, so awaywork closes its thread.',
    ])
    // An open card keeps its thread.
    await writeFile(join(root, 'items.json'), JSON.stringify([card()]))
    const open = threadForge(found)
    await planOn(open)
    expect(open.calls).toEqual(['threads acme/api'])
  })

  it("approves on the thread by the card's key or the thread's", async () => {
    await writeFile(join(root, 'items.json'), JSON.stringify([card()]))
    for (const key of ['tracker:ENG-7', 'github:acme/api#57']) {
      const forge = threadForge([{ item: 'tracker:ENG-7', thread: thread57, comments: [posted] }])
      expect(await approveItem(key, config, '', { forge, ctx: ctx() })).toBe(
        `plan approved: replied approve on ${thread57.url}#issuecomment-1`,
      )
      expect(forge.calls).toEqual(['threads acme/api', 'comment acme/api#57: approve'])
    }
  })
})

describe("GitHub's thread issues", () => {
  const issue = (number: number, body: string) => ({
    __typename: 'Issue',
    id: `I_${number}`,
    number,
    title: `ENG-${number}: Export VAT`,
    body,
    url: `https://github.com/acme/api/issues/${number}`,
    state: 'OPEN',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    repository: { nameWithOwner: 'acme/api' },
    author: { login: 'me' },
    authorAssociation: 'OWNER',
    assignees: { nodes: [{ login: 'me' }] },
    labels: { nodes: [] },
    comments: {
      pageInfo: { hasPreviousPage: false, startCursor: null },
      nodes: [
        {
          author: { login: 'me', __typename: 'User' },
          authorAssociation: 'OWNER',
          viewerDidAuthor: true,
          body: 'approve',
          createdAt: '2026-11-02T00:00:00Z',
          editor: null,
        },
      ],
    },
  })
  const marked = (key: string) => `awaywork posts here\n\n${threadMarker({ source: 'jira', key })}`

  it('lists the open issues you opened carrying the marker, with their comments, and opens and closes one as you', async () => {
    const page = {
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [issue(57, marked('ENG-7')), issue(3, 'A bug of mine')],
          },
        },
      },
    }
    const run = recorded([
      [/^gh api user --jq .login$/, 'me\n'],
      [/filterBy: \{ createdBy: \$login \}/, JSON.stringify(page)],
      [/^gh api repos\/acme\/api\/issues -f title=/, '58\thttps://github.com/acme/api/issues/58\n'],
      [
        /^gh api repos\/acme\/api\/issues\/58\/comments/,
        'https://github.com/acme/api/issues/58#c1\n',
      ],
      [/^gh api -X PATCH/, '{}'],
    ])
    const threads = githubThreads(run)
    expect(await threads.threads('acme/api')).toEqual([
      {
        item: 'jira:ENG-7',
        thread: thread57,
        comments: [{ author: 'me', body: 'approve', at: '2026-11-02T00:00:00Z', mine: true }],
      },
    ])
    const item = { source: 'jira', key: 'ENG-8', title: 'Export VAT', url: 'https://jira/ENG-8' }
    const opened = await threads.openThread('acme/api', item)
    expect(opened).toEqual({
      host: 'github',
      key: 'acme/api#58',
      url: 'https://github.com/acme/api/issues/58',
    })
    await expect(threads.openThread(undefined, item)).rejects.toThrow(
      'ENG-8 has no repo to open its thread in',
    )
    await threads.closeThread(opened, 'done')
    expect(run.calls.slice(2).map((c) => c.join(' '))).toEqual([
      `gh api repos/acme/api/issues -f title=ENG-8: Export VAT -f body=${threadBody(item)} -f assignees[]=me --jq [.number, .html_url] | @tsv`,
      'gh api repos/acme/api/issues/58/comments -f body=done --jq .html_url',
      'gh api -X PATCH repos/acme/api/issues/58 -f state=closed -f state_reason=completed',
    ])
  })

  it("leaves awaywork's thread issues out of the GitHub source's items", async () => {
    const assigned = JSON.parse(fixture('search-assigned.json'))
    assigned.data.search.nodes.push(issue(57, marked('ENG-7')))
    const run = recorded([
      [/q=is:issue is:open archived:false assignee:@me/, JSON.stringify(assigned)],
      [
        /q=is:pr /,
        JSON.stringify({ data: { search: { issueCount: 0, pageInfo: {}, nodes: [] } } }),
      ],
    ])
    const items = await githubSource(run).items({ repos: ['acme/*'] }, ctx())
    expect(items.length).toBeGreaterThan(0)
    expect(items.map((i) => i.key)).not.toContain('acme/api#57')
  })
})

describe('a custom thread host', () => {
  let root: string
  const cwd = process.cwd()
  // Keeps its threads in threads.json, each write's op in writes.log.
  const host = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const threads = JSON.parse(readFileSync('threads.json', 'utf8'))
if (process.argv[2] !== 'write') {
  console.log(JSON.stringify(threads))
  process.exit(0)
}
let input = ''
for await (const chunk of process.stdin) input += chunk
const w = JSON.parse(input)
appendFileSync('writes.log', w.op + ' ' + w.item + '\\n')
if (w.op === 'open') {
  const key = 'thread-' + w.item
  threads.push({ id: key, key, title: w.title, url: 'file://' + key, description: w.body })
  console.log(JSON.stringify({ key, url: 'file://' + key }))
}
const thread = threads.find((t) => t.key === w.item)
if (w.op === 'comment') (thread.comments ??= []).push({ author: 'me', body: w.body, at: new Date().toISOString(), mine: true })
writeFileSync('threads.json', JSON.stringify(threads))
`
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awaywork-host-'))
    process.chdir(root)
    await writeFile(join(root, 'threads.json'), '[]')
    await writeFile(join(root, 'writes.log'), '')
    await writeFile(join(root, 'host.mjs'), host)
  })
  afterEach(() => process.chdir(cwd))

  const config = parseConfig(`
providers: [claude]
sources:
  tracker: { command: 'cat items.json' }
  notes: { command: 'node host.mjs', write: 'node host.mjs write', thread: true }
queue:
  - { skill: plan, source: tracker, deliver: plan, thread: notes }
  - { skill: implement, where: { planned: true } }
`)
  const card = (state = 'open') => ({
    id: '7',
    key: 'ENG-7',
    title: 'Export VAT',
    url: 'https://tracker/ENG-7',
    state,
    fields: { repo: 'acme/api', updated: '2026-11-01T00:00:00Z' },
  })
  const threadOn = (comments: Item['comments']) => [
    {
      id: 'thread-ENG-7',
      key: 'thread-ENG-7',
      title: 'ENG-7: Export VAT',
      url: 'file://thread-ENG-7',
      description: threadBody({ source: 'tracker', ...card() }),
      comments,
    },
  ]
  const posted = { author: 'me', body: plan, at: '2026-11-02T00:00:00Z', mine: true as const }
  const planOn = async (dryRun = false) => {
    const lines: string[] = []
    const { plan, warnings } = await probeAndPlan(config, root, {
      probe: false,
      retry: true,
      forge: fakeForge(),
      moves: { dryRun, log: (l) => lines.push(l) },
    })
    return { plan, warnings, lines }
  }
  const writes = async () => (await readFile(join(root, 'writes.log'), 'utf8')).trim().split('\n')

  it('opens the thread through its write, the card needing no repo, and posts there', async () => {
    const item = fakeItem({ source: 'tracker', key: 'ENG-7', type: 'task', mine: true })
    const threads = { forge: fakeForge(), sources: config.sources, open: 'notes' }
    const write = { op: 'comment', body: 'Two tasks.' } as const
    const first = await writeItem(undefined, {}, item, write, ctx(), undefined, threads)
    expect(first).toEqual({ url: 'file://thread-ENG-7' })
    expect(item.thread).toEqual({ host: 'notes', key: 'thread-ENG-7', url: 'file://thread-ENG-7' })
    expect(await writes()).toEqual(['open ENG-7', 'comment thread-ENG-7'])
    const [opened] = JSON.parse(await readFile(join(root, 'threads.json'), 'utf8'))
    expect(threadOf(opened.description)).toBe('tracker:ENG-7')
    expect(opened.comments.map((c: { body: string }) => c.body)).toEqual([
      markComment('Two tasks.'),
    ])
  })

  it("isn't an item, and waits for your approve there, a teammate's being context, then fans out", async () => {
    await writeFile(join(root, 'items.json'), JSON.stringify([card()]))
    const teammate = { author: 'bob', body: 'approve', at: '2026-11-03T00:00:00Z' }
    await writeFile(join(root, 'threads.json'), JSON.stringify(threadOn([posted, teammate])))
    const notes = config.sources.notes
    expect(await sourceFor('notes', notes)?.items(notes, ctx())).toEqual([])
    const waiting = await planOn()
    expect(waiting.plan.skipped.map((s) => [s.item.key, s.kind, s.url])).toEqual([
      ['ENG-7', 'waiting_for_approval', 'file://thread-ENG-7'],
    ])
    const yours = { author: 'me', body: 'approve', at: '2026-11-04T00:00:00Z', mine: true }
    const approved = threadOn([posted, teammate, yours])
    await writeFile(join(root, 'threads.json'), JSON.stringify(approved))
    expect((await planOn()).plan.units.map((p) => [p.unit.skill, p.unit.items[0]?.key])).toEqual([
      ['implement', 'ENG-7/api'],
    ])
  })

  it("approves by the card's key or the thread's, through the host's write", async () => {
    await writeFile(join(root, 'items.json'), JSON.stringify([card()]))
    for (const key of ['tracker:ENG-7', 'notes:thread-ENG-7']) {
      await writeFile(join(root, 'threads.json'), JSON.stringify(threadOn([posted])))
      expect(await approveItem(key, config, '', { forge: fakeForge(), ctx: ctx() })).toBe(
        'plan approved: replied approve on file://thread-ENG-7',
      )
    }
    expect(await writes()).toEqual(['comment thread-ENG-7', 'comment thread-ENG-7'])
  })

  it('sends close once the card is done, which a host may ignore', async () => {
    await writeFile(join(root, 'items.json'), JSON.stringify([card('closed')]))
    await writeFile(join(root, 'threads.json'), JSON.stringify(threadOn([posted])))
    expect((await planOn(true)).lines).toEqual([
      "would close file://thread-ENG-7, ENG-7's thread: the card is closed",
    ])
    expect((await planOn()).lines).toEqual([
      "closed file://thread-ENG-7, ENG-7's thread: the card is closed",
    ])
    expect(await writes()).toEqual(['close thread-ENG-7'])
  })
})
