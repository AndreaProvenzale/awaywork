import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import { footer, footerItems, isOurs } from '../src/core/footer.js'
import type { Ctx, Item } from '../src/core/types.js'
import { type Exec, exec } from '../src/forge/gh.js'
import { githubForge } from '../src/forge/github.js'
import { githubSource } from '../src/sources/github.js'
import { fixture, githubRoutes, recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'

const log: string[] = []
const ctx: Ctx = { env: {}, log: (line) => log.push(line) }
const tmp = () => mkdtemp(join(tmpdir(), 'awaywork-'))

/** A search for my PRs on acme/api, numbered from 1. */
const authored = (...prs: Record<string, string>[]) =>
  JSON.stringify({
    data: {
      search: {
        nodes: prs.map((pr, i) => ({
          number: i + 1,
          url: `https://github.com/acme/api/pull/${i + 1}`,
          title: 'Some change',
          body: '',
          headRefName: `change-${i + 1}`,
          headRefOid: 'abc1234',
          isCrossRepository: false,
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
    })
    expect(issue5?.comments).toEqual([{ author: 'ghost', body: '+1', at: '2026-01-01T09:00:00Z' }])
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

  it('warns when a search has more results than one page', async () => {
    const many = fixture('search-assigned.json').replace('"issueCount": 2', '"issueCount": 150')
    const run = recorded([[/assignee:@me/, many], ...githubRoutes()])
    log.length = 0
    await githubSource(run).items({ repos: ['acme/*'] }, ctx)
    expect(log).toEqual([
      'github: "is:issue is:open archived:false assignee:@me" found 150, reading the first 100',
    ])
  })

  it('counts no threads of mine when reading who started them fails, and keeps every item', async () => {
    const routes = githubRoutes()
    const failing = async (cmd: string, args: string[]) => {
      if (args.join(' ').includes('nodes(ids:')) throw new Error('gh: Could not resolve to a node')
      return recorded(routes)(cmd, args)
    }
    log.length = 0
    const found = await githubSource(failing).items({ repos: ['acme/*'] }, ctx)
    expect(found).toHaveLength(5)
    expect(found[0]?.fields.my_unresolved_threads).toBe(0)
    expect(log).toEqual([
      "github: couldn't read who started PR threads, counting none: gh: Could not resolve to a node",
    ])

    const missing = recorded([[/nodes\(ids:/, '{ "data": { "nodes": [null] } }'], ...routes])
    const [pr1] = await githubSource(missing).items({ repos: ['acme/*'] }, ctx)
    expect(pr1?.fields.my_unresolved_threads).toBe(0)
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

  it('prefetches a PR: view, diff, deduped threads, failed-check logs', async () => {
    const [pr1] = await items()
    const dir = await tmp()
    await source.prefetch(pr1 as never, dir, ctx)
    const read = (f: string) => readFile(join(dir, f), 'utf8')

    const pr = await read('item.md')
    expect(pr).toContain('# Add rate limits to the public API')
    expect(pr).toContain('### qa, 2026-01-01T10:00:00Z\n\nStill returns 500 on burst.')
    expect(pr).toContain('### lead, CHANGES_REQUESTED')
    expect(pr).not.toContain('review-bot')
    expect(await read('diff.patch')).toContain('+export const burst = 20')

    const threads = await read('threads.md')
    expect(threads.match(/^## /gm)).toHaveLength(2)
    expect(threads).toContain(
      '## 🛑 Requirement: Reset the bucket on window change\n\n2 unresolved copies:\n' +
        '- src/limit.ts:12 https://github.com/acme/api/pull/1#discussion_r1\n' +
        '- src/limit.ts:30 https://github.com/acme/api/pull/1#discussion_r2',
    )
    expect(threads).toContain('- src/server.ts:? ')
    expect(threads).not.toContain('Typo.')

    const checks = await read('checks.md')
    expect(checks).not.toContain('## lint')
    expect(checks).toContain('FAIL src/limit.test.ts > refills after the window')
    expect(checks).not.toContain('line 51\n')
    expect(checks).toContain('line 52\n')
    expect(checks).toContain('## sonar: FAILURE\n\nhttps://sonar.example.com/acme-api/1')
    expect(checks).toContain('not a GitHub Actions job')
    expect(checks).toContain('## ci/legacy: ERROR\n\nBuild errored')
  })

  it('prefetches an issue with its comments', async () => {
    const [, , , issue5] = await items()
    const dir = await tmp()
    await source.prefetch(issue5 as never, dir, ctx)
    expect(await readFile(join(dir, 'item.md'), 'utf8')).toBe(
      '# Rate limit the public API\n\nhttps://github.com/acme/api/issues/5\n\n' +
        'Clients can flood us.\n\n## Comments\n\n### ghost, 2026-01-01T09:00:00Z\n\n+1\n',
    )
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
    const url = 'https://app.asana.com/0/1/1205/f'
    expect(await linked({ source: 'asana', id: '1205', key: '1205', url, link: url })).toEqual([6])
    expect(await linked({ source: 'jira', key: 'ENG-12' })).toEqual([2, 9, 10])
  })

  it('reads PRs on a branch in any state, not the ones from forks', async () => {
    const nodes = [
      {
        url: 'https://github.com/acme/api/pull/7',
        body: 'Closed.',
        merged: true,
        isCrossRepository: false,
      },
      { url: 'https://github.com/acme/api/pull/8', body: 'Fork.', isCrossRepository: true },
    ]
    const run = recorded([
      [
        /headRefName: \$branch, states: \[OPEN, CLOSED, MERGED\]/,
        JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }),
      ],
    ])
    expect(await githubForge(run).prsOn('acme/api', 'away/eng-12')).toEqual([
      { url: 'https://github.com/acme/api/pull/7', body: 'Closed.', merged: true },
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
    const state = (pr: Record<string, unknown>, others = [fork]) =>
      JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            pullRequest: {
              state: 'OPEN',
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
      [/number=1 /, state({})],
      [/branches\/release\/9$/, '{ "protected": true }'],
      [/branches\/feature-1$/, '{ "protected": false }'],
      [/rev-parse/, 'f00d000\n'],
      [/^git /, ''],
    ])
    const forge = githubForge(run)
    const push = (branch: string, pr: number) =>
      forge.fastForward('/work/u1', branch, 'abc1234', { repo: 'acme/api', pr })
    await expect(push('feature-1', 2)).rejects.toThrow(
      'refusing to push onto feature-1 on acme/api: #2 is merged',
    )
    await expect(push('feature-1', 3)).rejects.toThrow("#3's branch is on a fork")
    await expect(push('main', 4)).rejects.toThrow('main is the default branch')
    await expect(push('feature-1', 4)).rejects.toThrow("#4's branch is main")
    await expect(push('feature-1', 5)).rejects.toThrow('#5 has auto-merge on')
    await expect(push('feature-1', 6)).rejects.toThrow(
      'it is at def5678, the clone started from abc1234',
    )
    await expect(push('feature-1', 7)).rejects.toThrow("#7 isn't yours")
    await expect(push('feature-1', 8)).rejects.toThrow(
      "feature-1 is also the branch of #12, which isn't yours",
    )
    await expect(push('release/9', 9)).rejects.toThrow('release/9 is protected')
    expect(run.calls.some(([cmd]) => cmd === 'git')).toBe(false)
    await push('feature-1', 1)
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

  it('opens a draft PR titled by the body file first line', async () => {
    const dir = await tmp()
    const body = join(dir, 'PR_BODY.md')
    await writeFile(body, '# Refill the rate-limit bucket\n\nChecked: src/limit.test.ts passes.\n')
    const run = recorded([[/^gh pr create/, 'https://github.com/acme/api/pull/10\n']])
    const items = [fakeItem({ source: 'linear', key: 'ENG-12' })]
    const url = await githubForge(run).draftPr(
      'acme/api',
      'away/acme-api-1',
      'rate-limits',
      body,
      'r1',
      items,
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
    await githubForge(run).draftPr('acme/api', 'away/x', '', body, 'r1', items)
    expect(run.calls[1]).not.toContain('--base')
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
})
