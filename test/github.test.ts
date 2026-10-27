import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import { NOT_YOURS } from '../src/core/continue.js'
import {
  awaitsAnswer,
  footer,
  footerItems,
  footerLeft,
  isAwayworkComment,
  isOurs,
  markComment,
} from '../src/core/footer.js'
import type { Ctx, Item, Write } from '../src/core/types.js'
import { type Exec, exec } from '../src/forge/gh.js'
import { githubForge } from '../src/forge/github.js'
import { githubSource } from '../src/sources/github.js'
import { writeItem } from '../src/sources/index.js'
import { fixture, githubRoutes, recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'
import { expectPlanBack, roundTripComment } from './fakes/plan.js'

const log: string[] = []
const ctx: Ctx = { env: {}, log: (line) => log.push(line) }
const tmp = () => mkdtemp(join(tmpdir(), 'awaywork-'))

/** A search for my PRs on acme/api, numbered from 1. */
const authored = (...prs: Record<string, unknown>[]) =>
  JSON.stringify({
    data: {
      search: {
        nodes: prs.map((pr, i) => ({
          number: i + 1,
          url: `https://github.com/acme/api/pull/${i + 1}`,
          title: 'Some change',
          body: '',
          isDraft: false,
          headRefName: `change-${i + 1}`,
          headRefOid: 'abc1234',
          isCrossRepository: false,
          viewerDidAuthor: true,
          author: { login: 'dev' },
          editor: null,
          repository: { nameWithOwner: 'acme/api' },
          ...pr,
        })),
      },
    },
  })

const ours = (source: string, key: string) => `Done.\n\n${footer('r0', [{ source, key }])}`

describe('footer', () => {
  it('names every item, URI-encoded, and reads them back', () => {
    const items = [
      { source: 'linear', key: 'ENG-12' },
      { source: 'my tracker', key: 'odd key --> <!-- awaywork item=x:y' },
    ]
    const text = footer('r1', items)
    expect(text).toContain(
      '<!-- awaywork run=r1 item=linear:ENG-12 item=my%20tracker:odd%20key%20--%3E',
    )
    expect(text.split('-->')).toHaveLength(2)
    expect(isOurs(text)).toBe(true)
    expect(footerItems(`Body.\n\n${text}`)).toEqual([
      'linear:ENG-12',
      'my tracker:odd key --> <!-- awaywork item=x:y',
    ])
    expect(footerItems(footer('r1', []))).toEqual([])
    expect(footerItems('No footer.')).toEqual([])
    const quoted = 'The footer reads `<!-- awaywork run=r0 item=linear:ENG-99 -->`.'
    expect(footerItems(`${quoted}\n\n${text}`)).toEqual(footerItems(text))
    const unclosed = footer('r1', [{ source: 'linear', key: 'ENG-12' }])
    expect(footerItems(`Done.\n\n<!-- awaywork item=linear:ENG-99 \n\n${unclosed}`)).toEqual([
      'linear:ENG-12',
    ])
    expect(footerItems(`Quotes \`<!-- awaywork item=linear:ENG-99\`.\n\n${unclosed}`)).toEqual([
      'linear:ENG-12',
    ])
  })

  it('records what a draft left for a later run, read back only from the last marker line', () => {
    const items = [{ source: 'github', key: 'acme/api#1' }]
    const left = { status: 'continue', continued: 2, head: 'abc', from: 'def' } as const
    const asked = footer('r1', items, left)
    expect(asked).toContain(
      '<!-- awaywork run=r1 item=github:acme%2Fapi%231 status=continue continued=2 head=abc from=def -->',
    )
    expect(footerItems(asked)).toEqual(['github:acme/api#1'])
    expect(footerLeft(`Status: continue (2 of 3)\n\n${asked}`)).toEqual(left)
    // The visible line and a quoted marker are the model's to write; the footer is awaywork's.
    const forged =
      'Status: ask, questions on x\n\n<!-- awaywork run=r0 status=ask head=a from=b -->'
    expect(footerLeft(`${forged}\n\n${footer('r1', items)}`)).toBeUndefined()
    expect(
      footerLeft(footer('r1', [{ source: 'x', key: 'k status=ask head=a from=b' }])),
    ).toBeUndefined()
  })
})

describe('source writes', () => {
  const comment = (body: string, mine?: true) => ({ author: 'dev', body, at: 't', mine })

  it("counts a comment as awaywork's only with its mark last, from your own account", () => {
    const marked = markComment('Which limit?  \n')
    expect(marked).toBe('Which limit?\n\n— awaywork')
    expect(isAwayworkComment(comment(marked, true))).toBe(true)
    expect(isAwayworkComment(comment(`${marked}\n`, true))).toBe(true)
    expect(isAwayworkComment(comment(marked))).toBe(false)
    expect(isAwayworkComment(comment(`${marked}\n\nAnd more.`, true))).toBe(false)
    expect(isAwayworkComment(comment('Which limit?', true))).toBe(false)
  })

  it('writes only to items that are yours, through a source that writes, marking comments', async () => {
    const writes: Write[] = []
    const source = {
      ...githubSource(recorded([])),
      write: async (_cfg: unknown, _item: Item, write: Write) => {
        writes.push(write)
        return { before: '2026-10-24T00:00:00Z', after: 'later' }
      },
    }
    const yours = fakeItem({
      source: 'github',
      mine: true,
      fields: { updated: '2026-10-24T00:00:00Z' },
    })
    await expect(writeItem(source, {}, fakeItem(), { op: 'move', to: 'QA' }, ctx)).rejects.toThrow(
      'not yours',
    )
    await expect(
      writeItem({ ...source, write: undefined }, {}, yours, { op: 'move', to: 'QA' }, ctx),
    ).rejects.toThrow("github can't write to its items")
    expect(await writeItem(source, {}, yours, { op: 'comment', body: 'Q?' }, ctx)).toEqual({
      updated: 'later',
    })
    expect(writes).toEqual([{ op: 'comment', body: 'Q?\n\n— awaywork' }])
  })

  it('returns no updated time when someone changed the item after it was read', async () => {
    const source = {
      ...githubSource(recorded([])),
      write: async () => ({ before: '2026-10-24T00:30:00Z', after: '2026-10-24T01:00:00Z' }),
    }
    const read = fakeItem({
      source: 'github',
      mine: true,
      fields: { updated: '2026-10-24T00:00:00Z' },
    })
    expect(await writeItem(source, {}, read, { op: 'move', to: 'QA' }, ctx)).toEqual({})
    const same = { ...read, fields: { updated: '2026-10-24T00:30:00.000Z' } }
    expect(await writeItem(source, {}, same, { op: 'move', to: 'QA' }, ctx)).toEqual({
      updated: '2026-10-24T01:00:00Z',
    })
  })
})

describe('github source', () => {
  const source = githubSource(recorded(githubRoutes()))
  const items = () => source.items({ repos: ['acme/*'] }, ctx)

  it('reads my PRs, requested reviews and assigned issues in the configured repos', async () => {
    const found = await items()
    expect(found.map((i) => [i.key, i.type])).toEqual([
      ['acme/api#1', 'pr'],
      ['acme/web#3', 'pr'],
      ['acme/api#2', 'pr'],
      ['acme/api#5', 'issue'],
      ['acme/web#6', 'issue'],
    ])
    const narrow = await source.items({ repos: ['acme/web'] }, ctx)
    expect(narrow.map((i) => i.key)).toEqual(['acme/web#3', 'acme/web#6'])
  })

  it('states the facts rules match on', async () => {
    const [pr1, pr3, pr2, issue5] = await items()
    expect(pr1?.fields).toEqual({
      repo: 'acme/api',
      label: ['backend'],
      author: 'dev',
      trusted: true,
      mine: true,
      draft: false,
      ours: false,
      checks: 'failing',
      unresolved_threads: 2,
      my_unresolved_threads: 1,
      files: ['src/auth/token.ts', 'README.md'],
      changed_lines: 42,
      review_requested: false,
      created: '2026-01-03T08:00:00Z',
      updated: '2026-02-03T08:00:00Z',
      state: 'open',
    })
    expect(pr3?.fields).toMatchObject({ draft: true, mine: true })
    expect(pr3?.fields).not.toHaveProperty('checks')
    expect(pr2?.fields).toMatchObject({
      mine: false,
      trusted: false,
      review_requested: true,
      checks: 'pending',
    })
    expect(pr2?.reviewers).toEqual(['dev', 'backend'])
    expect(issue5?.fields).toEqual({
      repo: 'acme/api',
      label: ['awaywork', 'backend'],
      author: 'lead',
      trusted: true,
      mine: true,
      created: '2026-01-01T08:00:00Z',
      updated: '2026-02-01T08:00:00Z',
      state: 'open',
    })
    expect(issue5?.comments).toEqual([
      {
        author: 'dev',
        body: 'Start with the public routes.',
        at: '2026-01-01T10:00:00Z',
        mine: true,
      },
    ])
  })

  it('keeps comments by you, apps and people with write access, and hides the rest', async () => {
    const assigned = JSON.parse(fixture('search-assigned.json'))
    const by = (
      login: string,
      __typename: string,
      authorAssociation: string,
      viewerDidAuthor = false,
    ) => ({
      author: { login, __typename },
      authorAssociation,
      viewerDidAuthor,
      body: login,
      createdAt: '2026-01-01T09:00:00Z',
    })
    assigned.data.search.nodes[0].comments.nodes = [
      by('me', 'User', 'NONE', true),
      by('ci-bot', 'Bot', 'NONE'),
      by('maintainer', 'User', 'COLLABORATOR'),
      by('teammate', 'User', 'MEMBER'),
      by('merged-once', 'User', 'CONTRIBUTOR'),
      by('newcomer', 'User', 'FIRST_TIME_CONTRIBUTOR'),
      by('imported', 'Mannequin', 'MANNEQUIN'),
      { ...by('ghost', 'User', 'OWNER'), author: null },
    ]
    const run = recorded([[/assignee:@me/, JSON.stringify(assigned)], ...githubRoutes()])
    const [, , , issue5] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(issue5?.comments.map((c) => c.author)).toEqual([
      'me',
      'ci-bot',
      'maintainer',
      'teammate',
    ])
    const dir = await tmp()
    await source.prefetch(issue5 as never, dir, ctx)
    expect(await readFile(join(dir, 'item.md'), 'utf8')).toContain(
      "\n_Hidden: 4 comments from outside the repo's owners, members and collaborators._\n",
    )
  })

  it("counts only the unresolved threads a trusted author started, so a stranger's starts no fix", async () => {
    const stranger = (isResolved: boolean) => ({
      isResolved,
      comments: {
        nodes: [
          { author: { __typename: 'User' }, authorAssociation: 'NONE', viewerDidAuthor: false },
        ],
      },
    })
    const starters = JSON.parse(fixture('threads.json'))
    starters.data.nodes[0].reviewThreads.nodes = [stranger(false), stranger(true)]
    const run = recorded([[/nodes\(ids:/, JSON.stringify(starters)], ...githubRoutes()])
    const [pr1] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(pr1?.fields).toMatchObject({ unresolved_threads: 0, my_unresolved_threads: 0 })
  })

  it('follows the files of a large PR page by page and stops at the cap', async () => {
    const authored = JSON.parse(fixture('search-authored.json'))
    const [pr] = authored.data.search.nodes
    pr.files = {
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
      nodes: Array.from({ length: 100 }, (_, i) => ({ path: `a/${i}` })),
    }
    const more = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            files: {
              pageInfo: { hasNextPage: true, endCursor: 'c2' },
              nodes: Array.from({ length: 100 }, (_, i) => ({ path: `b/${i}` })),
            },
          },
        },
      },
    })
    const run = recorded([
      [/author:@me/, JSON.stringify(authored)],
      [/name=api -F number=1 -f after=c\d/, more],
      ...githubRoutes(),
    ])
    const [pr1] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    const calls = run.calls.filter((call) => call.join(' ').includes('after='))
    expect(calls).toHaveLength(4)
    expect(pr1?.fields.files).toHaveLength(500)
  })

  it('keeps the paths read when a later page of files fails', async () => {
    const authored = JSON.parse(fixture('search-authored.json'))
    authored.data.search.nodes[0].files.pageInfo.hasNextPage = true
    const run = recorded([[/author:@me/, JSON.stringify(authored)], ...githubRoutes()])
    log.length = 0
    const [pr1] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(pr1?.fields.files).toEqual(['src/auth/token.ts', 'README.md'])
    expect(log[0]).toMatch(/^github: couldn't read every file of acme\/api#1: /)
  })

  it('marks a PR awaywork opened as ours', async () => {
    const authored = fixture('search-authored.json').replace(
      '"body": "Adds a token bucket per client."',
      `"body": ${JSON.stringify(footer('r0', []))}`,
    )
    const [pr1] = await githubSource(recorded([[/author:@me/, authored], ...githubRoutes()])).items(
      { repos: ['acme/*'] },
      ctx,
    )
    expect(pr1?.fields.ours).toBe(true)
    expect(pr1?.linkedPrs[0]?.ours).toBe(true)
  })

  it("reads what awaywork's draft closing an issue left for a later run, nothing once it's ready, and not as yours once someone else edited it", async () => {
    const left = { status: 'continue', continued: 1, head: 'abc1234', from: 'def5678' } as const
    const linked = async (isDraft: boolean, editor: { login: string } | null = null) => {
      const assigned = JSON.parse(fixture('search-assigned.json'))
      Object.assign(assigned.data.search.nodes[0].closedByPullRequestsReferences.nodes[0], {
        isDraft,
        editor,
        body: `Half.\n\n${footer('r1', [{ source: 'github', key: 'acme/api#5' }], left)}`,
      })
      const run = recorded([[/assignee:@me/, JSON.stringify(assigned)], ...githubRoutes()])
      const [, , , issue5] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
      return issue5?.linkedPrs[0]
    }
    const items = ['github:acme/api#5']
    expect((await linked(true))?.left).toEqual({ ...left, items })
    expect((await linked(false))?.left).toBeUndefined()
    expect((await linked(true, { login: 'teammate' }))?.left).toEqual({
      ...left,
      items,
      refused: NOT_YOURS,
    })
  })

  it('links a PR to itself and an issue to the PR that closes it', async () => {
    const [pr1, , pr2, issue5, issue6] = await items()
    const link = {
      repo: 'acme/api',
      number: 1,
      url: 'https://github.com/acme/api/pull/1',
      branch: 'rate-limits',
      head: 'abc1234',
      ours: false,
      mine: true,
      trusted: true,
    }
    expect(pr1?.linkedPrs).toEqual([link])
    expect(issue5?.linkedPrs).toEqual([link])
    expect(issue6?.linkedPrs).toEqual([])
    expect(pr2?.linkedPrs[0]).toMatchObject({ mine: false, trusted: false })
  })

  it('runs each extra search ANDed with open and unarchived, without marking its items', async () => {
    const mentioned = JSON.parse(fixture('search-assigned.json'))
    mentioned.data.search.nodes = [{ ...mentioned.data.search.nodes[0], id: 'I_new', number: 9 }]
    const run = recorded([
      [/q=is:open archived:false mentions:@me/, JSON.stringify(mentioned)],
      ...githubRoutes(),
    ])
    const found = await githubSource(run).items(
      { repos: ['acme/*'], search: ['mentions:@me'] },
      ctx,
    )
    expect(found.find((i) => i.id === 'I_new')?.fields.mine).toBe(false)
  })

  it('warns when a search has more results than one page', async () => {
    const many = fixture('search-assigned.json').replace('"issueCount": 2', '"issueCount": 150')
    const run = recorded([[/assignee:@me/, many], ...githubRoutes()])
    log.length = 0
    await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(log).toEqual([
      'github: "is:issue is:open archived:false assignee:@me" found 150, reading the first 100',
    ])
  })

  it('counts every unresolved thread, none mine, when reading who started them fails', async () => {
    const routes = githubRoutes()
    const failing = async (cmd: string, args: string[]) => {
      if (args.join(' ').includes('nodes(ids:')) throw new Error('gh: Could not resolve to a node')
      return recorded(routes)(cmd, args)
    }
    log.length = 0
    const found = await githubSource(failing).items({ repos: ['acme/*'] }, ctx)
    expect(found).toHaveLength(5)
    expect(found[0]?.fields).toMatchObject({ unresolved_threads: 3, my_unresolved_threads: 0 })
    expect(log).toEqual([
      "github: couldn't read who started PR threads, counting all, none as yours: gh: Could not resolve to a node",
    ])

    const missing = recorded([[/nodes\(ids:/, '{ "data": { "nodes": [null] } }'], ...routes])
    const [pr1] = await githubSource(missing).items({ repos: ['acme/*'] }, ctx)
    expect(pr1?.fields).toMatchObject({ unresolved_threads: 3, my_unresolved_threads: 0 })
  })

  it('reads who started the threads in pages of 100 PRs', async () => {
    const authored = JSON.parse(fixture('search-authored.json'))
    const [pr] = authored.data.search.nodes
    authored.data.search.nodes = Array.from({ length: 101 }, (_, i) => ({
      ...pr,
      id: `PR_${i}`,
      number: i + 1,
    }))
    const run = recorded([
      [/author:@me/, JSON.stringify(authored)],
      [/nodes\(ids:/, '{ "data": { "nodes": [] } }'],
      ...githubRoutes(),
    ])
    await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    const pages = run.calls.filter((call) => call.join(' ').includes('nodes(ids:'))
    expect(pages.map((call) => call.join(' ').match(/PR_\d+/g)?.length)).toEqual([100, 1])
  })

  it('prefetches a PR: view, diff, deduped trusted threads, failed-check logs', async () => {
    const [pr1] = await items()
    const dir = await tmp()
    await source.prefetch(pr1 as never, dir, ctx)
    const read = (f: string) => readFile(join(dir, f), 'utf8')

    const pr = await read('item.md')
    expect(pr).toContain('# Add rate limits to the public API')
    expect(pr).toContain('### qa, 2026-01-01T10:00:00Z\n\nStill returns 500 on burst.')
    expect(pr).toContain('### lead, CHANGES_REQUESTED')
    expect(pr).not.toContain('review-bot')
    expect(pr).not.toContain('GH_TOKEN')
    expect(pr).toContain(
      "\n_Hidden: 1 review from outside the repo's owners, members and collaborators._\n",
    )
    expect(await read('diff.patch')).toContain('+export const burst = 20')

    const threads = await read('threads.md')
    expect(threads.match(/^## /gm)).toHaveLength(2)
    expect(threads).toContain(
      '## 🛑 Requirement: Reset the bucket on window change\n\n2 unresolved copies:\n' +
        '- src/limit.ts:12 https://github.com/acme/api/pull/1#discussion_r1\n' +
        '- src/limit.ts:30 https://github.com/acme/api/pull/1#discussion_r2',
    )
    expect(threads).toContain('- src/server.ts:? ')
    expect(threads).toContain(
      '**dev**, 2026-01-01T11:30:00Z:\n\n429 is the standard for rate limits.\n',
    )
    expect(threads).not.toContain('Typo.')
    expect(threads).not.toContain('stranger')
    expect(threads).toContain(
      "\n_Hidden: 1 reply from outside the repo's owners, members and collaborators._\n",
    )
    expect(threads).toMatch(
      /\n_Hidden: 1 unresolved thread from outside the repo's owners, members and collaborators\._\n$/,
    )

    const checks = await read('checks.md')
    expect(checks).not.toContain('## lint')
    expect(checks).toContain('FAIL src/limit.test.ts > refills after the window')
    expect(checks).not.toContain('line 51\n')
    expect(checks).toContain('line 52\n')
    expect(checks).toContain('## sonar: FAILURE\n\nhttps://sonar.example.com/acme-api/1')
    expect(checks).toContain('## deploy: CANCELLED\n\nhttps://deploy.example.com/acme-api/1')
    expect(checks).toContain('not a GitHub Actions job')
    expect(checks).toContain('## ci/legacy: ERROR\n\nBuild errored')
  })

  it('hides ghost reviews and replies, and every thread when no one trusted started any', async () => {
    const [pr1] = await items()
    const ghost = { author: null, authorAssociation: 'OWNER', viewerDidAuthor: false }
    type Details = {
      reviews: { nodes: object[] }
      reviewThreads: { nodes: { comments: { nodes: object[] } }[] }
    }
    const prefetch = async (edit: (pr: Details) => void) => {
      const details = JSON.parse(fixture('pr-1.json'))
      edit(details.data.repository.pullRequest)
      const view: [RegExp, string] = [
        /owner=acme -f name=api -F number=1 /,
        JSON.stringify(details),
      ]
      const dir = await tmp()
      await githubSource(recorded([view, ...githubRoutes()])).prefetch(pr1 as never, dir, ctx)
      return (f: string) => readFile(join(dir, f), 'utf8')
    }

    const ghosts = await prefetch((pr) => {
      Object.assign(pr.reviews.nodes[0] ?? {}, ghost)
      Object.assign(pr.reviewThreads.nodes[2]?.comments.nodes[1] ?? {}, ghost)
    })
    expect(await ghosts('item.md')).not.toContain('Needs a test for the burst case.')
    expect(await ghosts('item.md')).toContain('_Hidden: 2 reviews from outside')
    expect(await ghosts('threads.md')).not.toContain('429 is the standard')
    expect(await ghosts('threads.md')).toContain('_Hidden: 2 replies from outside')

    const strangers = await prefetch((pr) => {
      for (const t of pr.reviewThreads.nodes) Object.assign(t.comments.nodes[0] ?? {}, ghost)
    })
    expect(await strangers('threads.md')).toBe(
      "No unresolved review threads.\n\n_Hidden: 4 unresolved threads from outside the repo's owners, members and collaborators._\n",
    )
  })

  it('prefetches an issue with its comments', async () => {
    const [, , , issue5] = await items()
    const dir = await tmp()
    await source.prefetch(issue5 as never, dir, ctx)
    expect(await readFile(join(dir, 'item.md'), 'utf8')).toBe(
      '# Rate limit the public API\n\nhttps://github.com/acme/api/issues/5\n\n' +
        'Clients can flood us.\n\n## Comments\n\n### dev, 2026-01-01T10:00:00Z\n\n' +
        "Start with the public routes.\n\n_Hidden: 1 comment from outside the repo's owners, members and collaborators._\n",
    )
  })

  it('marks as yours only your PRs and issues assigned to you, not requested reviews or extra searches', async () => {
    const mentioned = JSON.parse(fixture('search-assigned.json'))
    mentioned.data.search.nodes = [{ ...mentioned.data.search.nodes[0], id: 'I_new', number: 9 }]
    const run = recorded([
      [/q=is:open archived:false mentions:@me/, JSON.stringify(mentioned)],
      ...githubRoutes(),
    ])
    const found = await githubSource(run).items(
      { repos: ['acme/*'], search: ['mentions:@me'] },
      ctx,
    )
    expect(found.map((i) => [i.key, i.mine ?? false])).toEqual([
      ['acme/api#1', true],
      ['acme/web#3', true],
      ['acme/api#2', false],
      ['acme/api#5', true],
      ['acme/web#6', true],
      ['acme/api#9', false],
    ])
  })

  it('takes your comment as yours only while nobody else edited it last', async () => {
    const assigned = JSON.parse(fixture('search-assigned.json'))
    const yours = assigned.data.search.nodes[0].comments.nodes[1]
    assigned.data.search.nodes[0].comments.nodes = [
      { ...yours, body: 'mine', editor: null },
      { ...yours, body: 'edited by me', editor: { login: 'dev' } },
      { ...yours, body: `edited by lead\n\n${markComment('')}`, editor: { login: 'lead' } },
    ]
    const run = recorded([[/assignee:@me/, JSON.stringify(assigned)], ...githubRoutes()])
    const [, , , issue5] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(issue5?.comments.map((c) => [c.body.split('\n')[0], c.mine])).toEqual([
      ['mine', true],
      ['edited by me', true],
      ['edited by lead', undefined],
    ])
    expect(issue5?.comments.some(isAwayworkComment)).toBe(false)
  })

  it("keeps waiting for an answer when a bot comments after awaywork's questions", async () => {
    const assigned = JSON.parse(fixture('search-assigned.json'))
    const yours = assigned.data.search.nodes[0].comments.nodes[1]
    const bot = { login: 'codecov', __typename: 'Bot' }
    assigned.data.search.nodes[0].comments.nodes = [
      { ...yours, body: markComment('Per user or per key?') },
      { ...yours, author: bot, authorAssociation: 'NONE', viewerDidAuthor: false, body: '91.2%' },
    ]
    const run = recorded([[/assignee:@me/, JSON.stringify(assigned)], ...githubRoutes()])
    const [, , , issue5] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(issue5?.comments.map((c) => [c.author, c.bot])).toEqual([
      ['dev', undefined],
      ['codecov', true],
    ])
    expect(issue5 && awaitsAnswer(issue5)).toBe(true)
  })

  it('reads a long thread back past its last 50 comments, keeping what it read when a page fails', async () => {
    const assigned = JSON.parse(fixture('search-assigned.json'))
    const yours = assigned.data.search.nodes[0].comments.nodes[1]
    const page = (bodies: string[], before?: string) => ({
      pageInfo: { hasPreviousPage: !!before, startCursor: before ?? null },
      nodes: bodies.map((body) => ({ ...yours, body })),
    })
    assigned.data.search.nodes[0].comments = page(['newest'], 'c2')
    const older = (bodies: string[], before?: string) =>
      JSON.stringify({ data: { node: { comments: page(bodies, before) } } })
    const routes: [RegExp, string][] = [
      [/assignee:@me/, JSON.stringify(assigned)],
      [/-f id=I_kwDOAAAAAc4AAAA5 -f before=c2 /, older([roundTripComment, 'middle'], 'c1')],
      ...githubRoutes(),
    ]
    const whole = recorded([[/-f before=c1 /, older(['oldest'])], ...routes])
    const [, , , issue5] = await githubSource(whole).items({ repos: ['acme/*'] }, ctx)
    expect(issue5?.comments.map((c) => c.body.split('\n')[0])).toEqual([
      'oldest',
      'Two tasks: the **API** first, then the button.',
      'middle',
      'newest',
    ])
    expect(whole.calls.filter((c) => c.join(' ').includes(' before=')).length).toBe(2)
    log.length = 0
    const [, , , cut] = await githubSource(recorded(routes)).items({ repos: ['acme/*'] }, ctx)
    expect(cut?.comments.map((c) => c.body.split('\n')[0])).toEqual([
      'Two tasks: the **API** first, then the button.',
      'middle',
      'newest',
    ])
    expect(log).toEqual([
      expect.stringMatching(
        /^github: couldn't read every comment of acme\/api#5: no recorded output/,
      ),
    ])
  })

  const read = (assignees?: string[]) =>
    JSON.stringify({
      data: {
        viewer: { login: 'dev' },
        repository: {
          issueOrPullRequest: {
            updatedAt: '2026-02-02T08:00:00Z',
            ...(assignees && { assignees: { nodes: assignees.map((login) => ({ login })) } }),
          },
        },
      },
    })
  const issue5 = fakeItem({
    source: 'github',
    key: 'acme/api#5',
    type: 'issue',
    url: 'https://git.acme.com/acme/api/issues/5',
    fields: { repo: 'acme/api' },
  })

  it('comments on an item and moves it by adding a label, through the issues API on its host', async () => {
    const seen: (string | undefined)[] = []
    const replay = recorded([
      [/^gh api repos\/acme\/api\/issues\/5\/labels -f /, '{}'],
      [
        /^gh api repos\/acme\/api\/issues\/5\/comments -f /,
        'https://git.acme.com/acme/api/issues/5#issuecomment-9\n',
      ],
      [
        /^gh api graphql -f owner=acme -f name=api -F number=5 .*issueOrPullRequest/s,
        read(['dev']),
      ],
    ])
    const run: Exec = (cmd, args, env) => {
      seen.push(env?.GH_HOST)
      return replay(cmd, args, env)
    }
    const item = issue5
    const write = githubSource(run).write
    expect(await write?.({ repos: ['acme/*'] }, item, { op: 'move', to: 'In QA' }, ctx)).toEqual({
      before: '2026-02-02T08:00:00Z',
      after: '2026-02-02T08:00:00Z',
    })
    expect(
      await write?.({ repos: ['acme/*'] }, item, { op: 'comment', body: 'Why `@here`?' }, ctx),
    ).toMatchObject({ url: 'https://git.acme.com/acme/api/issues/5#issuecomment-9' })
    const updated = ['api', 'graphql', '-f', 'owner=acme', '-f', 'name=api', '-F', 'number=5']
    expect(replay.calls.map((c) => (c[2] === 'graphql' ? c.slice(1, 9) : c.slice(1)))).toEqual([
      updated,
      ['api', 'repos/acme/api/issues/5/labels', '-f', 'labels[]=In QA'],
      updated,
      updated,
      ['api', 'repos/acme/api/issues/5/comments', '-f', 'body=Why `@here`?', '--jq', '.html_url'],
      updated,
    ])
    expect(new Set(seen)).toEqual(new Set(['git.acme.com']))
  })

  it('reads the plan comment it wrote back as the same plan', async () => {
    const replay = recorded([
      [/issueOrPullRequest/, read(['dev'])],
      [/issues\/5\/comments -f /, 'https://github.com/acme/api/issues/5#issuecomment-9\n'],
    ])
    const write = { op: 'comment', body: roundTripComment } as const
    await githubSource(replay).write?.({ repos: ['acme/*'] }, issue5, write, ctx)
    const sent = replay.calls.find((c) => c[1] === 'api' && c[2]?.endsWith('/comments'))
    const assigned = JSON.parse(fixture('search-assigned.json'))
    const yours = assigned.data.search.nodes[0].comments.nodes[1]
    assigned.data.search.nodes[0].comments.nodes = [
      { ...yours, body: sent?.[4]?.slice('body='.length) },
    ]
    const run = recorded([[/assignee:@me/, JSON.stringify(assigned)], ...githubRoutes()])
    const [, , , issue] = await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expectPlanBack(issue)
  })

  it('refuses an issue no longer assigned to you, but not your PR, whose author is fixed', async () => {
    for (const assignees of [['lead'], []]) {
      const run = recorded([[/issueOrPullRequest/, read(assignees)]])
      for (const write of [
        { op: 'move', to: 'QA' },
        { op: 'comment', body: 'Q?' },
      ] as const)
        await expect(
          githubSource(run).write?.({ repos: ['acme/*'] }, issue5, write, ctx),
        ).rejects.toThrow('acme/api#5 is no longer yours: not assigned to you')
      expect(run.calls.filter((c) => c[2] !== 'graphql')).toEqual([])
    }
    const run = recorded([
      [/issueOrPullRequest/, read()],
      [/labels -f /, '{}'],
    ])
    const pr = { ...issue5, type: 'pr' as const }
    expect(
      await githubSource(run).write?.({ repos: ['acme/*'] }, pr, { op: 'move', to: 'QA' }, ctx),
    ).toEqual({ before: '2026-02-02T08:00:00Z', after: '2026-02-02T08:00:00Z' })
  })
})

describe('github source, finished items', () => {
  const since = new Date('2026-10-11T09:30:00Z')
  const closedAt = '2026-10-20T08:00:00Z'
  const end = { hasNextPage: false, endCursor: '' }
  const none = JSON.stringify({ data: { search: { issueCount: 0, pageInfo: end, nodes: [] } } })
  /** A recorded search's first node, finished and numbered `n`, on a page that may lead to another. */
  const finished = (name: string, state: string, n: number, next = '') => {
    const page = JSON.parse(fixture(name))
    const [node] = page.data.search.nodes
    page.data.search.pageInfo = { hasNextPage: !!next, endCursor: next }
    page.data.search.nodes = [{ ...node, id: `done-${n}`, number: n, state, closedAt }]
    if (node.reviewThreads) page.data.search.nodes[0].reviewThreads = { nodes: [] }
    return JSON.stringify(page)
  }
  const run = () =>
    recorded([
      [
        /author:@me closed:>=2026-10-11 -F first=50 -f after=c2/,
        finished('search-authored.json', 'CLOSED', 12),
      ],
      [
        /q=is:pr is:closed archived:false author:@me closed:>=2026-10-11 -F first=50 -f query/,
        finished('search-authored.json', 'MERGED', 11, 'c2'),
      ],
      [
        /q=is:issue is:closed archived:false assignee:@me closed:>=2026-10-11 -F first=50/,
        finished('search-assigned.json', 'CLOSED', 15),
      ],
      [/q=is:(open|closed) archived:false label:awaywork/, none],
      ...githubRoutes(),
    ])
  const searches = (calls: string[][]) =>
    calls.flatMap((c) => c.find((a) => a.startsWith('q='))?.slice(2) ?? [])
  const cfg = { repos: ['acme/*'], search: ['label:awaywork'] }

  it('searches for nothing finished unless asked', async () => {
    const exec = run()
    await githubSource(exec).items(cfg, ctx)
    expect(searches(exec.calls)).toEqual([
      'is:pr is:open archived:false author:@me',
      'is:pr is:open archived:false review-requested:@me',
      'is:issue is:open archived:false assignee:@me',
      'is:open archived:false label:awaywork',
    ])
  })

  it('reads every page of my PRs and issues closed since the day asked, extra searches too, linking no PR', async () => {
    const exec = run()
    const found = await githubSource(exec).items(cfg, ctx, since)
    expect(searches(exec.calls).slice(4)).toEqual([
      'is:pr is:closed archived:false author:@me closed:>=2026-10-11',
      'is:pr is:closed archived:false author:@me closed:>=2026-10-11',
      'is:issue is:closed archived:false assignee:@me closed:>=2026-10-11',
      'is:closed archived:false label:awaywork closed:>=2026-10-11',
    ])
    const done = found.filter((i) => i.fields.state !== 'open')
    expect(done.map((i) => [i.key, i.fields.state, i.fields.closed, i.fields.mine])).toEqual([
      ['acme/api#11', 'merged', closedAt, true],
      ['acme/api#12', 'closed', closedAt, true],
      ['acme/api#15', 'closed', closedAt, true],
    ])
    // The issue's recorded PR #1 is open, and stays linked to the open issue only.
    expect(done.map((i) => i.linkedPrs)).toEqual([[], [], []])
    expect(found.find((i) => i.key === 'acme/api#5')?.linkedPrs).toHaveLength(1)
  })

  it("warns when a finished search hits GitHub's cap", async () => {
    const capped = none.replace('"issueCount":0', '"issueCount":1500')
    const exec = recorded([
      [/q=is:issue is:closed/, capped],
      [/is:closed/, none],
      ...githubRoutes(),
    ])
    log.length = 0
    await githubSource(exec).items({ repos: ['acme/*'] }, ctx, since)
    expect(log).toEqual([
      'github: "is:issue is:closed archived:false assignee:@me closed:>=2026-10-11" found 1500, GitHub returns the first 1000',
    ])
  })
})

describe('github enterprise host', () => {
  const hosted = () => {
    const seen: (string | undefined)[] = []
    const run: Exec = async (cmd, _args, env) => {
      seen.push(`${cmd}:${env?.GH_HOST}`)
      return cmd === 'gh' ? '[]' : ''
    }
    return Object.assign(run, { seen })
  }

  it('points gh at the host and clones from it', async () => {
    const calls: string[][] = []
    const run: Exec = async (cmd, args, env) => {
      calls.push([cmd, env?.GH_HOST ?? '', ...args])
      return '[]'
    }
    const forge = githubForge(run, 'git.acme.com')
    await forge.branchExists('acme/api', 'x')
    await forge.clone('acme/api', '', '/work/u1')
    expect(calls[0]?.slice(0, 2)).toEqual(['gh', 'git.acme.com'])
    expect(calls[1]).toContain('https://git.acme.com/acme/api.git')
    expect(calls[1]?.[1]).toBe('')
  })

  it('reads the source through the host, and leaves gh alone without one', async () => {
    const run = hosted()
    await githubSource(run)
      .items({ repos: ['acme/*'], host: 'git.acme.com' }, ctx)
      .catch(() => {})
    expect(new Set(run.seen)).toEqual(new Set(['gh:git.acme.com']))
    const plain = hosted()
    await githubSource(plain)
      .items({ repos: ['acme/*'] }, ctx)
      .catch(() => {})
    expect(new Set(plain.seen)).toEqual(new Set(['gh:undefined']))
  })
})

describe('github forge', () => {
  it('clones through gh login and leaves no credential helper in the clone', async () => {
    const run = recorded([[/^git /, '']])
    await githubForge(run).clone('acme/api', 'rate-limits', '/work/u1')
    expect(run.calls).toEqual([
      [
        'git',
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        'clone',
        '--no-local',
        '--branch',
        'rate-limits',
        'https://github.com/acme/api.git',
        '/work/u1',
      ],
      ['git', '-C', '/work/u1', 'config', 'credential.helper', ''],
    ])
    await githubForge(run).clone('acme/api', '', '/work/u2')
    expect(run.calls[2]).not.toContain('--branch')
  })

  it("clones a fork PR at its head from the repo's pull ref, not the repo's same-named branch", async () => {
    const root = await tmp()
    const [origin, work] = [join(root, 'origin'), join(root, 'work')]
    const git = (dir: string, ...args: string[]) =>
      execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    await execa(bin('git'), ['init', '-q', '-b', 'main', work])
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'base main')
    await git(work, 'checkout', '-q', '-b', 'theirs')
    await git(work, 'commit', '-q', '--allow-empty', '-m', 'fork main')
    const head = (await git(work, 'rev-parse', 'HEAD')).stdout
    await execa(bin('git'), ['clone', '-q', '--bare', work, origin])
    await git(origin, 'update-ref', 'refs/pull/7/head', head)
    await git(origin, 'branch', '-D', 'theirs')
    const run: Exec = (cmd, args) =>
      exec(
        cmd,
        args.map((a) => (a === 'https://github.com/acme/api.git' ? origin : a)),
      )
    const forge = githubForge(run)
    const dir = join(root, 'clone')
    await forge.clone('acme/api', 'main', dir, { number: 7, head })
    expect((await git(dir, 'rev-parse', 'HEAD')).stdout).toBe(head)
    expect((await git(dir, 'config', 'credential.helper')).stdout).toBe('')
    // A chown of the clone would hand the worker a local origin's objects through their hardlinks.
    const objects = join(dir, '.git', 'objects')
    expect((await execa('find', [objects, '-type', 'f', '-links', '+1'])).stdout).toBe('')
    const moved = forge.clone('acme/api', 'main', join(root, 'moved'), {
      number: 7,
      head: 'abc1234',
    })
    await expect(moved).rejects.toThrow(
      `#7 on acme/api is at ${head.slice(0, 7)}, not abc1234: it moved since it was read`,
    )
  })

  it('finds my PRs whose branch or title carries the key, and marks awaywork ones', async () => {
    const authored = fixture('search-authored.json')
      .replace('"headRefName": "rate-limits"', '"headRefName": "t-12-rate-limits"')
      .replace(
        '"body": "Adds a token bucket per client."',
        `"body": ${JSON.stringify(footer('r0', [{ source: 'fake', key: 'T-12' }]))}`,
      )
      .replace('"title": "WIP: new billing page"', '"title": "WIP: billing (T-12)"')
    const run = recorded([[/author:@me/, authored]])
    const forge = githubForge(run)
    const prs = await forge.prsFor(fakeItem({ key: 'T-12' }))
    expect(prs.map((p) => [p.repo, p.number, p.branch, p.head, p.ours, p.mine])).toEqual([
      ['acme/api', 1, 't-12-rate-limits', 'abc1234', true, true],
      ['acme/web', 3, 'billing', undefined, false, true],
    ])
    expect(await forge.prsFor(fakeItem({ key: 'T-1' }))).toEqual([])
    expect(run.calls).toHaveLength(1)
  })

  it('links PRs whose footer names items by those alone, and the others by the key in branch or title or the link line in the body', async () => {
    const run = recorded([
      [
        /author:@me/,
        authored(
          {
            headRefName: 'feat/add-limits',
            title: 'Limits, after ENG-12',
            body: ours('linear', 'ENG-13'),
          },
          { headRefName: 'eng-12-cache' },
          { title: 'fix(api): handle null', body: 'Handles null.\n\npart of eng-12' },
          { body: 'A follow-up to ENG-12.' },
          { body: 'Part of ENG-123' },
          { body: 'Context: https://app.asana.com/0/1/1205/f' },
          { body: 'Context: https://app.asana.com/0/1/12050' },
          { headRefName: 'eng-13-extra', body: ours('jira', 'ENG-13') },
          { headRefName: 'eng-12-footer', body: 'Adds `<!-- awaywork run=<id> -->`.' },
          { title: 'ENG-12: older', body: 'Done.\n\n---\n<!-- awaywork run=r0 -->' },
        ),
      ],
    ])
    const forge = githubForge(run)
    const linked = async (item: Partial<Item>) =>
      (await forge.prsFor(fakeItem({ type: 'task', ...item }))).map((pr) => pr.number)
    const linear = (key: string) => ({ source: 'linear', key, link: `Part of ${key}` })
    expect(await linked(linear('ENG-13'))).toEqual([1])
    expect(await linked(linear('ENG-12'))).toEqual([2, 3, 9, 10])
    const url = 'https://app.asana.com/1/100/project/1/task/1205'
    expect(await linked({ source: 'asana', id: '1205', key: '1205', url, link: url })).toEqual([6])
    expect(await linked({ source: 'jira', key: 'ENG-12' })).toEqual([2, 9, 10])
  })

  it("reads what awaywork's draft left only while it's a draft, as yours while you edited its body last", async () => {
    const left = { status: 'ask', continued: 0, head: 'abc1234', from: 'def5678' } as const
    const body = `Half.\n\n${footer('r1', [{ source: 'linear', key: 'ENG-12' }], left)}`
    const run = recorded([
      [
        /author:@me/,
        authored(
          { body, isDraft: true },
          { body, isDraft: false },
          { body, isDraft: true, editor: { login: 'dev' } },
          { body, isDraft: true, editor: { login: 'teammate' } },
        ),
      ],
    ])
    const prs = await githubForge(run).prsFor(fakeItem({ source: 'linear', key: 'ENG-12' }))
    const kept = { ...left, items: ['linear:ENG-12'] }
    expect(prs.map((pr) => pr.left)).toEqual([
      kept,
      undefined,
      kept,
      { ...kept, refused: NOT_YOURS },
    ])
  })

  it('reads PRs on a branch in any state, not the ones from forks, and what an open draft left', async () => {
    const left = { status: 'continue', continued: 1, head: 'abc1234', from: 'def5678' } as const
    const body = `Half.\n\n${footer('r1', [{ source: 'linear', key: 'ENG-12' }], left)}`
    const pr = (number: number, state: string, closedAt: string | null, fork = false) => ({
      number,
      url: `https://github.com/acme/api/pull/${number}`,
      body,
      state,
      isDraft: true,
      viewerDidAuthor: true,
      author: { login: 'dev' },
      editor: null as { login: string } | null,
      closedAt,
      isCrossRepository: fork,
    })
    const nodes = [
      pr(7, 'MERGED', '2026-10-20T10:00:00Z'),
      pr(8, 'OPEN', null, true),
      pr(9, 'CLOSED', '2026-10-21T10:00:00Z'),
      { ...pr(10, 'OPEN', null), editor: { login: 'dev' } },
      { ...pr(11, 'OPEN', null), editor: { login: 'teammate' } },
    ]
    const run = recorded([
      [
        /headRefName: \$branch, states: \[OPEN, CLOSED, MERGED\]/,
        JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }),
      ],
    ])
    const url = (n: number) => `https://github.com/acme/api/pull/${n}`
    const kept = { ...left, items: ['linear:ENG-12'] }
    expect(await githubForge(run).prsOn('acme/api', 'away/eng-12')).toEqual([
      { number: 7, url: url(7), body, open: false, merged: true, closedAt: '2026-10-20T10:00:00Z' },
      {
        number: 9,
        url: url(9),
        body,
        open: false,
        merged: false,
        closedAt: '2026-10-21T10:00:00Z',
      },
      { number: 10, url: url(10), body, open: true, merged: false, left: kept },
      {
        number: 11,
        url: url(11),
        body,
        open: true,
        merged: false,
        left: { ...kept, refused: NOT_YOURS },
      },
    ])
    expect(run.calls[0]).toEqual(
      expect.arrayContaining(['owner=acme', 'name=api', 'branch=away/eng-12']),
    )
  })

  it("reads the message of a branch's tip", async () => {
    const target = { message: 'Fix it\n\nAwaywork: r0' }
    const run = recorded([
      [
        /ref\(qualifiedName: \$ref\)/,
        JSON.stringify({ data: { repository: { ref: { target } } } }),
      ],
    ])
    expect(await githubForge(run).tipMessage('acme/api', 'away/eng-12')).toBe(target.message)
    expect(run.calls[0]).toEqual(expect.arrayContaining(['ref=refs/heads/away/eng-12']))
  })

  it('reads a file at a ref, and nothing for a missing path or a folder', async () => {
    const calls: string[][] = []
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      const path = args[1] ?? ''
      if (path.includes('missing')) throw new Error('gh: Not Found (HTTP 404)')
      if (path.includes('gen?')) return JSON.stringify([{ type: 'file' }])
      const content = Buffer.from('openapi: 3.1.0\n').toString('base64')
      return JSON.stringify({ type: 'file', encoding: 'base64', content })
    }
    const forge = githubForge(run)
    expect(await forge.fileAt('acme/api', 'away/eng 12', 'api/openapi.yaml')).toBe(
      'openapi: 3.1.0\n',
    )
    expect(calls[0]).toEqual([
      'gh',
      'api',
      'repos/acme/api/contents/api/openapi.yaml?ref=away%2Feng%2012',
    ])
    expect(await forge.fileAt('acme/api', 'abc123', 'missing.yaml')).toBeUndefined()
    expect(await forge.fileAt('acme/api', 'abc123', 'gen')).toBeUndefined()
  })

  it("reads the checks on a PR's head by name: runs and statuses, the worse of a name reported twice", async () => {
    const recordedChecks = JSON.parse(fixture('pr-checks.json'))
    const nodes =
      recordedChecks.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts
        .nodes
    const run = recorded([[/-F number=347 /, JSON.stringify(recordedChecks)]])
    expect(await githubForge(run).checks('AndreaProvenzale/awaywork', 347)).toEqual({
      check: 'passed',
      isolation: 'passed',
      container: 'passed',
    })
    nodes.push(
      { __typename: 'CheckRun', name: 'Expo Preview', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'StatusContext', context: 'Vercel Preview', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'Netlify', state: 'ERROR' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    )
    const mixed = recorded([[/-F number=347 /, JSON.stringify(recordedChecks)]])
    expect(await githubForge(mixed).checks('AndreaProvenzale/awaywork', 347)).toEqual({
      check: 'failing',
      isolation: 'passed',
      container: 'passed',
      'Expo Preview': 'pending',
      docs: 'passed',
      'Vercel Preview': 'pending',
      Netlify: 'failing',
      'ci/legacy': 'passed',
    })
  })

  it('checks branch existence by exact name, not prefix', async () => {
    const run = recorded([
      [/heads\/away\/acme-api-1$/, fixture('matching-refs-prefix.json')],
      [/heads\/away\/acme-api-1-old$/, fixture('matching-refs-prefix.json')],
    ])
    const forge = githubForge(run)
    expect(await forge.branchExists('acme/api', 'away/acme-api-1')).toBe(false)
    expect(await forge.branchExists('acme/api', 'away/acme-api-1-old')).toBe(true)
  })

  it('pushes only branches absent on the remote, and only while they are', async () => {
    const run = recorded([
      [/heads\/away\/acme-api-1-old$/, fixture('matching-refs-prefix.json')],
      [/matching-refs/, '[]'],
      [/rev-parse/, 'f00d000\n'],
      [/^git /, ''],
    ])
    const forge = githubForge(run)
    await expect(
      forge.push('/work/u1', 'away/acme-api-1-old', { repo: 'acme/api' }),
    ).rejects.toThrow('already exists')
    await forge.push('/work/u1', 'away/acme-api-1', { repo: 'acme/api' })
    const push = run.calls.at(-1) ?? []
    expect(push).toEqual([
      'git',
      '-C',
      expect.stringContaining('awaywork-push-'),
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--force-with-lease=refs/heads/away/acme-api-1:',
      'https://github.com/acme/api.git',
      'f00d000:refs/heads/away/acme-api-1',
    ])
    expect(push.join(' ')).not.toMatch(/\+/)
  })

  it('fast-forwards only your open PR in the repo, without auto-merge, still where the clone started', async () => {
    const theirs = { number: 12, isCrossRepository: false, viewerDidAuthor: false }
    const fork = { number: 13, isCrossRepository: true, viewerDidAuthor: false }
    const item = { source: 'github', key: 'acme/api#1' }
    const left = { status: 'continue', continued: 1, head: 'abc1234', from: 'f00' } as const
    const body = footer('r0', [item], left)
    const me = { login: 'me' }
    const draft = { isDraft: true, body, author: me, editor: me }
    const state = (pr: Record<string, unknown>, others = [fork]) =>
      JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            pullRequest: {
              state: 'OPEN',
              isDraft: false,
              viewerDidAuthor: true,
              isCrossRepository: false,
              headRefName: 'feature-1',
              headRefOid: 'abc1234',
              autoMergeRequest: null,
              ...pr,
            },
            pullRequests: { nodes: others },
          },
        },
      })
    const run = recorded([
      [/number=2 /, state({ state: 'MERGED' })],
      [/number=3 /, state({ isCrossRepository: true })],
      [/number=4 /, state({ headRefName: 'main' })],
      [/number=5 /, state({ autoMergeRequest: { enabledAt: '2026-01-01T00:00:00Z' } })],
      [/number=6 /, state({ headRefOid: 'def5678' })],
      [/number=7 /, state({ viewerDidAuthor: false })],
      [/number=8 /, state({}, [theirs])],
      [/number=9 /, state({ headRefName: 'release/9' })],
      [/number=10 /, state({})],
      [/number=11 /, state({ ...draft, editor: { login: 'sam' } })],
      [/number=14 /, state({ ...draft, body: body.replace('acme%2Fapi%231', 'acme%2Fapi%232') })],
      [/number=1 /, state(draft)],
      [/branches\/release\/9$/, '{ "protected": true }'],
      [/branches\/feature-1$/, '{ "protected": false }'],
      [/rev-parse/, 'f00d000\n'],
      [/^git /, ''],
    ])
    const forge = githubForge(run)
    const push = (branch: string, pr: number) =>
      forge.fastForward('/work/u1', branch, 'abc1234', { repo: 'acme/api', pr })
    expect(await push('feature-1', 2)).toBe('#2 is merged')
    expect(await push('feature-1', 3)).toBe("#3's branch is on a fork")
    expect(await push('main', 4)).toBe('main is the default branch')
    expect(await push('feature-1', 4)).toBe("#4's branch is main")
    expect(await push('feature-1', 5)).toBe('#5 has auto-merge on')
    expect(await push('feature-1', 6)).toBe('feature-1 is at def5678, awaywork left it at abc1234')
    expect(await push('feature-1', 7)).toBe("#7 isn't yours")
    expect(await push('feature-1', 8)).toBe(
      "feature-1 is also the branch of #12, which isn't yours",
    )
    expect(await push('release/9', 9)).toBe('release/9 is protected')
    const resume = (pr: number) =>
      forge.fastForward('/work/u1', 'feature-1', 'abc1234', { repo: 'acme/api', pr, draft: [item] })
    expect(await resume(10)).toBe('#10 was marked ready')
    expect(await resume(11)).toBe("someone else edited #11's body last")
    expect(await resume(14)).toBe("#14's footer no longer says awaywork left it for this unit")
    expect(run.calls.some(([cmd]) => cmd === 'git')).toBe(false)
    expect(await resume(1)).toBeUndefined()
    expect(await push('feature-1', 1)).toBeUndefined()
    expect(run.calls.at(-1)).toEqual([
      'git',
      '-C',
      expect.stringContaining('awaywork-push-'),
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--force-with-lease=refs/heads/feature-1:abc1234',
      'https://github.com/acme/api.git',
      'f00d000:refs/heads/feature-1',
    ])
  })

  it("pushes from a repo of its own, which the clone's config can't redirect, and only a fast-forward", async () => {
    const root = await tmp()
    const origin = join(root, 'origin')
    const elsewhere = join(root, 'elsewhere')
    const clone = join(root, 'clone')
    const git = (dir: string, ...args: string[]) =>
      execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    for (const bare of [origin, elsewhere]) await execa(bin('git'), ['init', '-q', '--bare', bare])
    await execa(bin('git'), ['init', '-q', clone])
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init')
    await git(clone, 'config', `url.${elsewhere}.pushInsteadOf`, origin)
    let head = ''
    let branch = 'away/acme-api-1'
    const pullRequest = () => ({
      state: 'OPEN',
      viewerDidAuthor: true,
      isCrossRepository: false,
      headRefName: branch,
      headRefOid: head,
      autoMergeRequest: null,
    })
    const run: Exec = async (cmd, args) =>
      cmd !== 'gh'
        ? exec(
            cmd,
            args.map((a) => (a === 'https://github.com/acme/api.git' ? origin : a)),
          )
        : args.includes('graphql')
          ? JSON.stringify({
              data: {
                repository: {
                  defaultBranchRef: null,
                  pullRequest: pullRequest(),
                  pullRequests: { nodes: [] },
                },
              },
            })
          : '[]'
    const forge = githubForge(run)
    await forge.push(clone, 'away/acme-api-1', { repo: 'acme/api' })
    const refs = async (dir: string) =>
      (await git(dir, 'for-each-ref', '--format=%(refname)')).stdout
    expect(await refs(origin)).toBe('refs/heads/away/acme-api-1')
    expect(await refs(elsewhere)).toBe('')

    head = (await git(origin, 'rev-parse', 'away/acme-api-1')).stdout
    await git(clone, 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten')
    const onto = forge.fastForward(clone, 'away/acme-api-1', head, { repo: 'acme/api', pr: 1 })
    await expect(onto).rejects.toThrow(`not a fast-forward from ${head.slice(0, 7)}`)

    // The branch moved back after the PR was read: the push would bring back what was dropped.
    const rewritten = (await git(clone, 'rev-parse', 'HEAD')).stdout
    branch = 'away/acme-api-2'
    head = rewritten
    await forge.push(clone, branch, { repo: 'acme/api' })
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'dropped')
    await forge.fastForward(clone, branch, rewritten, { repo: 'acme/api', pr: 1 })
    head = (await git(clone, 'rev-parse', 'HEAD')).stdout
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'tonight')
    await git(origin, 'update-ref', 'refs/heads/away/acme-api-2', rewritten)
    const back = forge.fastForward(clone, 'away/acme-api-2', head, { repo: 'acme/api', pr: 1 })
    await expect(back).rejects.toThrow()
    expect((await git(origin, 'rev-parse', 'away/acme-api-2')).stdout).toBe(rewritten)
    await expect(forge.push(clone, 'away/acme-api-2', { repo: 'acme/api' })).rejects.toThrow()
  }, 30_000)

  it('opens a PR titled by the body file first line, a draft only when asked', async () => {
    const dir = await tmp()
    const body = join(dir, 'PR_BODY.md')
    await writeFile(body, '# Refill the rate-limit bucket\n\nChecked: src/limit.test.ts passes.\n')
    const run = recorded([[/^gh pr create/, 'https://github.com/acme/api/pull/10\n']])
    const items = [fakeItem({ source: 'linear', key: 'ENG-12' })]
    const url = await githubForge(run).openPr(
      'acme/api',
      'away/acme-api-1',
      'rate-limits',
      body,
      'r1',
      items,
      true,
    )
    expect(url).toBe('https://github.com/acme/api/pull/10')
    expect(run.calls[0]).toEqual([
      'gh',
      'pr',
      'create',
      '-R',
      'acme/api',
      '--draft',
      '--head',
      'away/acme-api-1',
      '--base',
      'rate-limits',
      '--title',
      'Refill the rate-limit bucket',
      '--body',
      `Checked: src/limit.test.ts passes.\n\n${footer('r1', items)}`,
    ])
    expect(footerItems(run.calls[0]?.at(-1))).toEqual(['linear:ENG-12'])
    await githubForge(run).openPr('acme/api', 'away/x', '', body, 'r1', items, false)
    expect(run.calls[1]).not.toContain('--base')
    expect(run.calls[1]).not.toContain('--draft')
  })

  it("rewrites a draft's title and body with the footer it left, and marks it ready only when asked", async () => {
    const dir = await tmp()
    const body = join(dir, 'PR_BODY.md')
    await writeFile(body, 'Export screen\n\nDone.\n')
    const run = recorded([[/^gh pr (edit|ready)/, '']])
    const items = [fakeItem({ source: 'github', key: 'acme/web#3' })]
    const left = { status: 'continue', continued: 2, head: 'abc', from: 'def' } as const
    await githubForge(run).updatePr('acme/web', 13, body, 'r2', items, false, left)
    expect(run.calls).toEqual([
      [
        'gh',
        'pr',
        'edit',
        '13',
        '-R',
        'acme/web',
        '--title',
        'Export screen',
        '--body',
        `Done.\n\n${footer('r2', items, left)}`,
      ],
    ])
    await githubForge(run).updatePr('acme/web', 13, body, 'r3', items, true)
    expect(run.calls.at(-1)).toEqual(['gh', 'pr', 'ready', '13', '-R', 'acme/web'])
  })

  it('stacks a PR on the one below it: a new stack, the top of its stack, never mid-stack', async () => {
    const stack = (prs: number[]) =>
      JSON.stringify([{ number: 7, pull_requests: prs.map((number) => ({ number })) }])
    const stackOn = async (found: string) => {
      const run = recorded([
        [/stacks\?pull_request=9$/, found],
        [/--method POST/, '{}'],
      ])
      const pr = (n: number) => `https://github.com/acme/api/pull/${n}`
      await githubForge(run).stack('acme/api', pr(9), pr(10))
      return run.calls.slice(1)
    }
    expect(await stackOn('[]')).toEqual([
      [
        'gh',
        'api',
        '--method',
        'POST',
        'repos/acme/api/stacks',
        '-F',
        'pull_requests[]=9',
        '-F',
        'pull_requests[]=10',
      ],
    ])
    expect(await stackOn(stack([8, 9]))).toEqual([
      ['gh', 'api', '--method', 'POST', 'repos/acme/api/stacks/7/add', '-F', 'pull_requests[]=10'],
    ])
    expect(await stackOn(stack([9, 11]))).toEqual([])
  })

  it('leaves a pending review at the given commit, refused in GitHub words', async () => {
    const reviews = 'repos/acme/api/pulls/1/reviews'
    const url = 'https://github.com/acme/api/pull/1#pullrequestreview-5'
    const sent: unknown[] = []
    const answering = (post: () => string): Exec & { calls: string[][] } => {
      const calls: string[][] = []
      const run = async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        sent.push(JSON.parse(await readFile(args.at(-1) as string, 'utf8')))
        return post()
      }
      return Object.assign(run, { calls })
    }
    const review = { body: 'Looks fine.', comments: [{ path: 'a.ts', line: 2, body: 'Why?' }] }
    const run = answering(() => JSON.stringify({ html_url: url, state: 'PENDING' }))
    expect(await githubForge(run).pendingReview('acme/api', 1, 'abc1234', review)).toBe(url)
    expect(run.calls.map((c) => c.slice(0, 5))).toEqual([
      ['gh', 'api', '--method', 'POST', reviews],
    ])
    expect(sent).toEqual([
      {
        commit_id: 'abc1234',
        body: 'Looks fine.',
        comments: [{ path: 'a.ts', line: 2, body: 'Why?', side: 'RIGHT' }],
      },
    ])

    const stdout = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['User can only have one pending review per pull request'],
      status: '422',
    })
    const refused = answering(() => {
      throw Object.assign(new Error('Command failed with exit code 1: gh api'), { stdout })
    })
    await expect(githubForge(refused).pendingReview('acme/api', 1, 'abc', review)).rejects.toThrow(
      /^Unprocessable Entity: User can only have one pending review per pull request$/,
    )
  })
})
