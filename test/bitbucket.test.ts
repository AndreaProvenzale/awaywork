import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/load.js'
import { footer } from '../src/core/footer.js'
import type { Item } from '../src/core/types.js'
import { bitbucketForge } from '../src/forge/bitbucket.js'
import type { Exec } from '../src/forge/gh.js'
import { forgeFor } from '../src/forge/index.js'
import { recorded } from './fakes/gh.js'
import { fakeItem } from './fakes/items.js'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/twg/${name}`, import.meta.url), 'utf8')

const json = ['-o', 'json', '--output-summary', 'none']
const sandbox = 'andrea89/awaywork-sandbox'
const empty = JSON.stringify({ values: [], page: 1, pagelen: 50, size: 0, hasNextPage: false })

/** A page of my PRs in the workspace, from the recorded one. */
const minePage = (prs: Record<string, unknown>[], page = 1, hasNextPage = false) => {
  const [recorded] = JSON.parse(fixture('prs-me.json')).values
  const values = prs.map((pr, i) => ({
    ...recorded,
    id: 10 * page + i,
    title: 'Some change',
    description: '',
    ...pr,
    source: { ...recorded.source, branch: { name: pr.branch ?? `change-${i}` } },
  }))
  return JSON.stringify({ values, page, pagelen: 50, size: values.length, hasNextPage })
}

describe('bitbucket forge', () => {
  it('clones over SSH with your own keys, and refuses a fork PR it has no pull ref for', async () => {
    const run = recorded([[/^git /, '']])
    const forge = bitbucketForge(['andrea89'], run)
    await forge.clone(sandbox, 'main', '/work/u1')
    expect(run.calls).toEqual([
      [
        'git',
        'clone',
        '--no-local',
        '--branch',
        'main',
        'git@bitbucket.org:andrea89/awaywork-sandbox.git',
        '/work/u1',
      ],
    ])
    await expect(forge.clone(sandbox, 'theirs', '/work/u2', { number: 7 })).rejects.toThrow(
      '#7 on andrea89/awaywork-sandbox is from a fork, which Bitbucket has no pull ref for',
    )
  })

  it('finds my PRs across the workspaces and every page, once per run', async () => {
    const run = recorded([
      [/-w andrea89 -n 50 --page 1 /, fixture('prs-me.json')],
      [/-w acme -n 50 --page 1 /, minePage([{ branch: 'other' }], 1, true)],
      [/-w acme -n 50 --page 2 /, minePage([{ branch: 'away/ENG-12' }], 2)],
    ])
    const forge = bitbucketForge(['andrea89', 'acme'], run)
    expect(await forge.prsFor(fakeItem({ source: 'jira', key: 'SANDBOX-7' }))).toEqual([
      {
        repo: sandbox,
        number: 4,
        url: 'https://bitbucket.org/andrea89/awaywork-sandbox/pull-requests/4',
        branch: 'probe/awaywork-fixture',
        ours: true,
        mine: true,
        trusted: true,
        fork: false,
      },
    ])
    const linked = await forge.prsFor(fakeItem({ source: 'jira', key: 'ENG-12' }))
    expect(linked.map((pr) => [pr.number, pr.branch])).toEqual([[20, 'away/ENG-12']])
    expect(run.calls).toHaveLength(3)
    expect(run.calls[0]).toEqual([
      'twg',
      'bb',
      'prs',
      'query',
      '--scope',
      'me',
      '-w',
      'andrea89',
      '-n',
      '50',
      '--page',
      '1',
      ...json,
    ])
  })

  it('links PRs by the same rules as on GitHub: footer items alone, else key, link line or Asana URL', async () => {
    const run = recorded([
      [
        /--scope me/,
        minePage([
          { title: 'Limits, after ENG-12', description: footerOf('linear', 'ENG-13') },
          { branch: 'eng-12-cache' },
          { title: 'fix: null', description: 'Handles null.\n\npart of eng-12' },
          { description: 'A follow-up to ENG-12.' },
          { description: 'Context: https://app.asana.com/0/1/1205/f' },
          { description: null },
        ]),
      ],
    ])
    const forge = bitbucketForge(['acme'], run)
    const linked = async (item: Partial<Item>) =>
      (await forge.prsFor(fakeItem({ type: 'task', ...item }))).map((pr) => pr.number)
    expect(await linked({ source: 'linear', key: 'ENG-13' })).toEqual([10])
    expect(await linked({ source: 'linear', key: 'ENG-12', link: 'Part of ENG-12' })).toEqual([
      11, 12,
    ])
    const url = 'https://app.asana.com/1/100/project/1/task/1205'
    expect(await linked({ source: 'asana', id: '1205', key: '1205', url })).toEqual([14])
  })

  it('marks a PR whose branch is in another repo as a fork', async () => {
    const [pr] = JSON.parse(fixture('prs-me.json')).values
    pr.source.repository.full_name = 'someone/awaywork-sandbox'
    const page = JSON.stringify({ values: [pr], page: 1, hasNextPage: false })
    const forge = bitbucketForge(['andrea89'], recorded([[/--scope me/, page]]))
    const [found] = await forge.prsFor(fakeItem({ source: 'jira', key: 'SANDBOX-7' }))
    expect(found?.fork).toBe(true)
  })

  it('checks branch existence with git, by exact name', async () => {
    const run = recorded([
      [
        /ls-remote/,
        '58961c892aa5545aad0093ffcbf6f61686d0bcaf\trefs/heads/probe/awaywork-fixture\n',
      ],
    ])
    const forge = bitbucketForge(['andrea89'], run)
    expect(await forge.branchExists(sandbox, 'probe/awaywork-fixture')).toBe(true)
    expect(await forge.branchExists(sandbox, 'awaywork-fixture')).toBe(false)
    expect(run.calls[0]).toEqual([
      'git',
      'ls-remote',
      'git@bitbucket.org:andrea89/awaywork-sandbox.git',
      'refs/heads/probe/awaywork-fixture',
    ])
  })

  it('reads PRs on a branch one state at a time, not the ones from forks', async () => {
    const [fork] = JSON.parse(fixture('prs-on-declined.json')).values
    fork.source.repository.full_name = 'someone/awaywork-sandbox'
    const declined = JSON.parse(fixture('prs-on-declined.json'))
    declined.values.push(fork)
    const run = recorded([
      [/--state OPEN /, fixture('prs-on-open.json')],
      [/--state DECLINED /, JSON.stringify(declined)],
      [/--state (MERGED|SUPERSEDED) /, empty],
    ])
    const prs = await bitbucketForge(['andrea89'], run).prsOn(sandbox, 'probe/awaywork-fixture')
    expect(prs.map(({ url, merged }) => [url, merged])).toEqual([
      ['https://bitbucket.org/andrea89/awaywork-sandbox/pull-requests/4', false],
      ['https://bitbucket.org/andrea89/awaywork-sandbox/pull-requests/1', false],
    ])
    expect(prs[0]?.body).toContain('item=jira:SANDBOX-7')
    expect(prs.map(({ head, closedAt }) => [head, closedAt])).toEqual([
      ['58961c892aa5', undefined],
      ['09db4a1b3c29', '2026-10-18T13:25:48.949282+00:00'],
    ])
    expect(run.calls.map((c) => c.slice(4, 10).join(' '))).toEqual(
      ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].map(
        (s) => `-r ${sandbox} --source probe/awaywork-fixture --state ${s}`,
      ),
    )
  })

  it('reads a file at a ref, and nothing for a missing one', async () => {
    const run = recorded([[/repo file notes\.txt /, fixture('repo-file.json')]])
    const forge = bitbucketForge(['andrea89'], run)
    expect(await forge.fileAt(sandbox, '16fc60339a69', 'notes.txt')).toBe(
      "line one\nline two\nline three\nsmoke from awaywork's Bitbucket forge\n",
    )
    expect(run.calls[0]).toEqual([
      'twg',
      ...['bb', 'repo', 'file', 'notes.txt', '-r', sandbox, '--ref', '16fc60339a69'],
      ...json,
    ])
    const missing: Exec = async () => {
      throw Object.assign(new Error('exit 1'), { stdout: fixture('not-found.json') })
    }
    expect(await bitbucketForge(['andrea89'], missing).fileAt(sandbox, 'x', 'nope')).toBe(undefined)
  })

  it("reads build statuses on a PR's head by name", async () => {
    const recordedPr = JSON.parse(fixture('prs-get-statuses.json'))
    const forge = (statuses: unknown[]) =>
      bitbucketForge(
        ['andrea89'],
        recorded([[/prs get 5 /, JSON.stringify({ ...recordedPr, _statuses: statuses })]]),
      )
    const run = recorded([[/prs get 5 /, fixture('prs-get-statuses.json')]])
    expect(await bitbucketForge(['andrea89'], run).checks(sandbox, 5)).toEqual({})
    expect(run.calls[0]).toEqual([
      'twg',
      ...['bb', 'prs', 'get', '5', '-r', sandbox, '--statuses'],
      ...json,
    ])
    // Shaped as Bitbucket's API documents a build status: the sandbox has none to record.
    const status = (
      name: string,
      state: string,
      commit = '16fc60339a69dc87a10d517ab538573353126772',
    ) => ({
      type: 'build',
      key: name.toLowerCase(),
      name,
      state,
      links: {
        commit: { href: `https://api.bitbucket.org/2.0/repositories/${sandbox}/commit/${commit}` },
      },
    })
    expect(
      await forge([
        status('Pipeline', 'SUCCESSFUL'),
        status('Vercel Preview', 'INPROGRESS'),
        status('Expo Preview', 'FAILED'),
        status('Lint', 'STOPPED'),
        status('Old', 'SUCCESSFUL', '09db4a1b3c29'),
      ]).checks(sandbox, 5),
    ).toEqual({
      Pipeline: 'passed',
      'Vercel Preview': 'pending',
      'Expo Preview': 'failing',
      Lint: 'failing',
    })
  })

  it("reads the message of a branch's tip", async () => {
    const run = recorded([[/commit query/, fixture('commit-tip.json')]])
    const forge = bitbucketForge(['andrea89'], run)
    expect(await forge.tipMessage(sandbox, 'probe/awaywork-fixture')).toBe(
      'Probe for twg fixtures\n\nAwaywork: probe-1\n',
    )
    expect(run.calls[0]).toEqual([
      'twg',
      'bb',
      'commit',
      'query',
      '-r',
      sandbox,
      '--branch',
      'probe/awaywork-fixture',
      '-n',
      '1',
      ...json,
    ])
  })

  it('pushes only absent branches, over SSH with no credential helper, and never onto a PR', async () => {
    const run = recorded([
      [/ls-remote .* refs\/heads\/away\/taken$/, 'f00d000\trefs/heads/away/taken\n'],
      [/ls-remote/, ''],
      [/rev-parse/, 'f00d000\n'],
      [/^git /, ''],
    ])
    const forge = bitbucketForge(['andrea89'], run)
    await expect(forge.push('/work/u1', 'away/taken', { repo: sandbox })).rejects.toThrow(
      'already exists',
    )
    await forge.push('/work/u1', 'away/SANDBOX-7', { repo: sandbox })
    expect(run.calls.at(-1)).toEqual([
      'git',
      '-C',
      expect.stringContaining('awaywork-push-'),
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      'push',
      '--force-with-lease=refs/heads/away/SANDBOX-7:',
      'git@bitbucket.org:andrea89/awaywork-sandbox.git',
      'f00d000:refs/heads/away/SANDBOX-7',
    ])
    const calls = run.calls.length
    expect(
      await forge.fastForward('/work/u1', 'feature-1', 'abc1234', { repo: sandbox, pr: 4 }),
    ).toMatch(/^Bitbucket can't push onto a PR/)
    expect(run.calls).toHaveLength(calls)
  })

  it('opens a PR titled by the body file first line, its body from a file, a draft only when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awaywork-'))
    const bodyFile = join(dir, 'PR_BODY.md')
    await writeFile(bodyFile, '# SANDBOX-7 Probe twg output\n\nProbes twg output for fixtures.\n')
    let description = ''
    const run: Exec & { calls: string[][] } = Object.assign(
      async (cmd: string, args: string[]) => {
        run.calls.push([cmd, ...args])
        description = readFileSync(args[args.indexOf('--description-file') + 1] ?? '', 'utf8')
        return fixture('prs-create.json')
      },
      { calls: [] as string[][] },
    )
    const items = [{ source: 'jira', key: 'SANDBOX-7' }]
    const forge = bitbucketForge(['andrea89'], run)
    const url = await forge.openPr(
      sandbox,
      'probe/awaywork-fixture',
      'main',
      bodyFile,
      'r1',
      items,
      true,
    )
    expect(url).toBe('https://bitbucket.org/andrea89/awaywork-sandbox/pull-requests/4')
    expect(run.calls[0]).toEqual([
      'twg',
      'bb',
      'prs',
      'create',
      '-r',
      sandbox,
      '--draft',
      '--source',
      'probe/awaywork-fixture',
      '--dest',
      'main',
      '--title',
      'SANDBOX-7 Probe twg output',
      '--description-file',
      expect.stringMatching(/awaywork-pr-.*description\.md$/),
      ...json,
    ])
    expect(description).toBe(`Probes twg output for fixtures.\n\n${footer('r1', items)}`)
    await forge.openPr(sandbox, 'away/x', '', bodyFile, 'r1', items, false)
    expect(run.calls[1]).not.toContain('--dest')
    expect(run.calls[1]).not.toContain('--draft')
  })

  it("throws twg's own message, wherever it prints it", async () => {
    const failing =
      (out: { stdout?: string; stderr?: string }): Exec =>
      async () => {
        throw Object.assign(new Error('Command failed with exit code 1'), out)
      }
    const tip = (run: Exec) => bitbucketForge(['andrea89'], run).tipMessage(sandbox, 'x')
    await expect(tip(failing({ stdout: fixture('not-found.json') }))).rejects.toThrow(
      'twg bb commit query: Resource not found. Check that the workspace, repository, and resource exist.',
    )
    await expect(tip(failing({ stderr: fixture('auth-invalid.json') }))).rejects.toThrow(
      'twg bb commit query: Bitbucket Cloud authentication required: no Bitbucket token configured.',
    )
    await expect(tip(failing({ stderr: "error: unknown option '--bogus'\n" }))).rejects.toThrow(
      "twg bb commit query: error: unknown option '--bogus'",
    )
  })
})

describe('bitbucket config', () => {
  const config = (sources: string, queue = '') =>
    `providers: [claude]\nsources:\n${sources}\n${queue}`
  const problems = (text: string) => {
    try {
      parseConfig(text)
      return []
    } catch (e) {
      return (e as { problems: string[] }).problems
    }
  }

  it('picks the Bitbucket forge from sources.bitbucket', async () => {
    const forge = forgeFor(parseConfig(config('  bitbucket: { repos: [andrea89/*] }')))
    expect(await forge.fastForward('/work/u1', 'b', 'abc1234', { repo: sandbox, pr: 4 })).toMatch(
      /^Bitbucket can't push onto a PR/,
    )
  })

  it('takes a literal workspace, one forge, and no push', () => {
    expect(problems(config('  bitbucket: { repos: ["*/api"] }'))).toEqual([
      'sources.bitbucket.repos[0]: expected workspace/repo; * globs the repo, never the workspace',
    ])
    expect(
      problems(config('  bitbucket: { repos: [acme/api] }\n  github: { repos: [acme/*] }')),
    ).toEqual(['sources.bitbucket: one forge per config: github or bitbucket, not both'])
    const push = 'queue:\n  - { skill: fix, deliver: push }'
    expect(problems(config('  bitbucket: { repos: [acme/api] }', push))).toEqual([
      expect.stringMatching(/^queue\[0\]\.deliver: push isn't available on Bitbucket/),
    ])
    expect(problems(config('  github: { repos: [acme/*] }', push))).toEqual([])
    const review = 'queue:\n  - { skill: review, deliver: pending_review }'
    expect(problems(config('  bitbucket: { repos: [acme/api] }', review))).toEqual([
      expect.stringMatching(/^queue\[0\]\.deliver: pending_review isn't available on Bitbucket/),
    ])
  })

  it('leaves no pending review', async () => {
    const run = recorded([])
    const review = { body: 'Fine.', comments: [] }
    await expect(
      bitbucketForge(['andrea89'], run).pendingReview(sandbox, 4, 'abc1234', review),
    ).rejects.toThrow('awaywork leaves pending reviews on GitHub only')
    expect(run.calls).toEqual([])
  })
})

const footerOf = (source: string, key: string) => `Done.\n\n${footer('r0', [{ source, key }])}`
