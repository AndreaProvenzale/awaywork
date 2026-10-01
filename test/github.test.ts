import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { footer } from '../src/core/footer.js'
import type { Ctx } from '../src/core/types.js'
import { type Exec, exec } from '../src/forge/gh.js'
import { githubForge } from '../src/forge/github.js'
import { githubSource } from '../src/sources/github.js'
import { fixture, githubRoutes, recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'

const log: string[] = []
const ctx: Ctx = { env: {}, log: (line) => log.push(line) }
const tmp = () => mkdtemp(join(tmpdir(), 'nightshift-'))

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
      label: ['night-shift', 'backend'],
      author: 'lead',
      trusted: true,
      mine: true,
      created: '2026-01-01T08:00:00Z',
      updated: '2026-02-01T08:00:00Z',
    })
    expect(issue5?.comments).toEqual([{ author: 'ghost', body: '+1', at: '2026-01-01T09:00:00Z' }])
  })

  it('marks a PR night-shift opened as ours', async () => {
    const authored = fixture('search-authored.json').replace(
      '"body": "Adds a token bucket per client."',
      `"body": ${JSON.stringify(footer('r0'))}`,
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

    const pr = await read('pr.md')
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
    expect(await readFile(join(dir, 'issue.md'), 'utf8')).toBe(
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

  it('finds my PRs whose branch or title carries the key, and marks night-shift ones', async () => {
    const authored = fixture('search-authored.json')
      .replace('"headRefName": "rate-limits"', '"headRefName": "t-12-rate-limits"')
      .replace(
        '"body": "Adds a token bucket per client."',
        `"body": ${JSON.stringify(footer('r0'))}`,
      )
      .replace('"title": "WIP: new billing page"', '"title": "WIP: billing (T-12)"')
    const run = recorded([[/author:@me/, authored]])
    const forge = githubForge(run)
    const prs = await forge.prsFor(fakeItem({ key: 'T-12' }))
    expect(prs.map((p) => [p.repo, p.number, p.branch, p.ours, p.mine])).toEqual([
      ['acme/api', 1, 't-12-rate-limits', true, true],
      ['acme/web', 3, 'billing', false, true],
    ])
    expect(await forge.prsFor(fakeItem({ key: 'T-1' }))).toEqual([])
    expect(run.calls).toHaveLength(1)
  })

  it('checks branch existence by exact name, not prefix', async () => {
    const run = recorded([
      [/heads\/night\/acme-api-1$/, fixture('matching-refs-prefix.json')],
      [/heads\/night\/acme-api-1-old$/, fixture('matching-refs-prefix.json')],
    ])
    const forge = githubForge(run)
    expect(await forge.branchExists('acme/api', 'night/acme-api-1')).toBe(false)
    expect(await forge.branchExists('acme/api', 'night/acme-api-1-old')).toBe(true)
  })

  it('pushes only branches absent on the remote, never forced', async () => {
    const run = recorded([
      [/heads\/night\/acme-api-1-old$/, fixture('matching-refs-prefix.json')],
      [/matching-refs/, '[]'],
      [/^git /, ''],
    ])
    const forge = githubForge(run)
    await expect(
      forge.push('/work/u1', 'night/acme-api-1-old', { repo: 'acme/api' }),
    ).rejects.toThrow('already exists')
    await forge.push('/work/u1', 'night/acme-api-1', { repo: 'acme/api' })
    const push = run.calls.at(-1) ?? []
    expect(push).toEqual([
      'git',
      '-C',
      expect.stringContaining('nightshift-push-'),
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      'https://github.com/acme/api.git',
      'FETCH_HEAD:refs/heads/night/acme-api-1',
    ])
    expect(push.join(' ')).not.toMatch(/force|\+/)
  })

  it('fast-forwards only your open PR in the repo, without auto-merge, still where the clone started', async () => {
    const state = (pr: Record<string, unknown>) =>
      JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: 'main' },
            pullRequest: {
              state: 'OPEN',
              isCrossRepository: false,
              headRefName: 'feature-1',
              headRefOid: 'abc1234',
              autoMergeRequest: null,
              ...pr,
            },
          },
        },
      })
    const run = recorded([
      [/number=2 /, state({ state: 'MERGED' })],
      [/number=3 /, state({ isCrossRepository: true })],
      [/number=4 /, state({ headRefName: 'main' })],
      [/number=5 /, state({ autoMergeRequest: { enabledAt: '2026-01-01T00:00:00Z' } })],
      [/number=6 /, state({ headRefOid: 'def5678' })],
      [/number=1 /, state({})],
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
    expect(run.calls.some(([cmd]) => cmd === 'git')).toBe(false)
    await push('feature-1', 1)
    expect(run.calls.at(-1)).toEqual([
      'git',
      '-C',
      expect.stringContaining('nightshift-push-'),
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      'https://github.com/acme/api.git',
      'FETCH_HEAD:refs/heads/feature-1',
    ])
  })

  it("pushes from a repo of its own, which the clone's config can't redirect, and only a fast-forward", async () => {
    const root = await tmp()
    const origin = join(root, 'origin')
    const elsewhere = join(root, 'elsewhere')
    const clone = join(root, 'clone')
    const git = (dir: string, ...args: string[]) =>
      execa('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    for (const bare of [origin, elsewhere]) await execa('git', ['init', '-q', '--bare', bare])
    await execa('git', ['init', '-q', clone])
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init')
    await git(clone, 'config', `url.${elsewhere}.pushInsteadOf`, origin)
    let head = ''
    const pullRequest = () => ({
      state: 'OPEN',
      isCrossRepository: false,
      headRefName: 'night/acme-api-1',
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
              data: { repository: { defaultBranchRef: null, pullRequest: pullRequest() } },
            })
          : '[]'
    const forge = githubForge(run)
    await forge.push(clone, 'night/acme-api-1', { repo: 'acme/api' })
    const refs = async (dir: string) =>
      (await git(dir, 'for-each-ref', '--format=%(refname)')).stdout
    expect(await refs(origin)).toBe('refs/heads/night/acme-api-1')
    expect(await refs(elsewhere)).toBe('')

    head = (await git(origin, 'rev-parse', 'night/acme-api-1')).stdout
    await git(clone, 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten')
    const onto = forge.fastForward(clone, 'night/acme-api-1', head, { repo: 'acme/api', pr: 1 })
    await expect(onto).rejects.toThrow(`not a fast-forward from ${head.slice(0, 7)}`)
  })

  it('opens a draft PR titled by the body file first line', async () => {
    const dir = await tmp()
    const body = join(dir, 'PR_BODY.md')
    await writeFile(body, '# Refill the rate-limit bucket\n\nChecked: src/limit.test.ts passes.\n')
    const run = recorded([[/^gh pr create/, 'https://github.com/acme/api/pull/10\n']])
    const url = await githubForge(run).draftPr(
      'acme/api',
      'night/acme-api-1',
      'rate-limits',
      body,
      'r1',
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
      'night/acme-api-1',
      '--base',
      'rate-limits',
      '--title',
      'Refill the rate-limit bucket',
      '--body',
      `Checked: src/limit.test.ts passes.\n\n${footer('r1')}`,
    ])
    await githubForge(run).draftPr('acme/api', 'night/x', '', body, 'r1')
    expect(run.calls[1]).not.toContain('--base')
  })
})
