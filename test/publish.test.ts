import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it } from 'vitest'
import { bin } from '../src/config/paths.js'
import type { PrRef, Unit } from '../src/core/types.js'
import { publish } from '../src/worker/publish.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'

const git = async (dir: string, ...args: string[]) =>
  (await execa(bin('git'), ['-C', dir, ...args])).stdout

const trailers = (dir: string) =>
  git(dir, 'log', '--format=%s|%(trailers:key=Awaywork,valueonly)', 'HEAD').then((log) =>
    log.split('\n').filter(Boolean),
  )

/** A fake forge that keeps the history of each HEAD it was handed to push. */
function pushingForge() {
  const forge = fakeForge()
  const pushed: string[][] = []
  const { push, fastForward } = forge
  return Object.assign(forge, {
    pushed,
    push: async (...args: Parameters<typeof push>) => {
      pushed.push(await trailers(args[0]))
      await push(...args)
    },
    fastForward: async (...args: Parameters<typeof fastForward>) => {
      pushed.push(await trailers(args[0]))
      return fastForward(...args)
    },
  })
}

const pr: PrRef = {
  repo: 'acme/api',
  number: 1,
  url: 'https://github.com/acme/api/pull/1',
  branch: 'feature-1',
  ours: false,
  mine: true,
  trusted: true,
  fork: false,
}

const unit = (deliver: Unit['deliver'] = 'draft_pr'): Unit => ({
  id: 'fake-1',
  items: [fakeItem({ linkedPrs: [pr] })],
  repo: 'acme/api',
  base: 'feature-1',
  foreign: false,
  untrusted: false,
  branch: 'away/FAKE-1',
  rule: { skill: 'fix', provider: [], skills: [], instructions: [] },
  skill: 'fix',
  skills: [],
  providers: ['fake'],
  instructions: [],
  deliver,
})

describe('publish', () => {
  let dir: string
  let start: string
  const commit = async (message: string) => {
    await writeFile(join(dir, `${message}.txt`), message)
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', message)
  }
  const body = (text: string) => writeFile(join(dir, '.away/out/pr.md'), text)

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'awaywork-publish-'))
    const origin = join(root, 'origin')
    dir = join(root, 'clone')
    await execa(bin('git'), ['init', '-q', '-b', 'feature-1', origin])
    await git(
      origin,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    )
    await execa(bin('git'), ['clone', '-q', origin, dir])
    await git(dir, 'config', 'user.name', 'Dev')
    await git(dir, 'config', 'user.email', 'dev@example.com')
    await git(dir, 'config', 'core.hooksPath', '.husky')
    await git(dir, 'checkout', '-q', '-b', 'away/FAKE-1')
    await mkdir(join(dir, '.away/out'), { recursive: true })
    start = await git(dir, 'rev-parse', 'HEAD')
  })

  it('pushes the new branch with trailers and opens a draft PR into the base', async () => {
    await commit('first')
    await commit('second')
    await body('Fix the thing\n\nChecked: tests pass.')
    const forge = pushingForge()
    expect(await publish(unit(), dir, forge, '20260925-010000', start)).toEqual({
      kind: 'pr',
      url: 'https://example.com/acme/api/pull/away/FAKE-1',
      commits: 2,
      head: expect.any(String),
    })
    expect(forge.branches).toEqual(new Set(['acme/api:away/FAKE-1']))
    expect(forge.pushed).toEqual([['second|20260925-010000', 'first|20260925-010000', 'init|']])
  })

  it("appends its items' link lines, once each, before the stack note, and names the items to the forge", async () => {
    await commit('first')
    await body('Fix the thing\n\nChecked: tests pass.')
    const forge = fakeForge()
    const drafted: { body: string; items: string[] }[] = []
    forge.draftPr = async (_repo, head, _base, bodyFile, _runId, items) => {
      drafted.push({ body: await readFile(bodyFile, 'utf8'), items: items.map((i) => i.key) })
      return head
    }
    const linked = (key: string) => fakeItem({ source: 'linear', key, link: `Part of ${key}` })
    const items = [linked('ENG-12'), linked('ENG-12'), linked('ENG-13'), fakeItem()]
    const stacked = { ...unit(), items, stackedOn: 'https://github.com/acme/api/pull/9' }
    await publish(stacked, dir, forge, 'r1', start)
    expect(drafted).toEqual([
      {
        body: 'Fix the thing\n\nChecked: tests pass.\n\nPart of ENG-12\n\nPart of ENG-13\n\nStacked on https://github.com/acme/api/pull/9: merge that first.\n',
        items: ['ENG-12', 'ENG-12', 'ENG-13', 'FAKE-1'],
      },
    ])
    expect(forge.stacked).toEqual([['https://github.com/acme/api/pull/9', 'away/FAKE-1']])
  })

  it('closes a GitHub issue only when asked to', async () => {
    await commit('first')
    await body('Fix the thing')
    const forge = fakeForge()
    const bodies: string[] = []
    forge.draftPr = async (_repo, head, _base, bodyFile) => {
      bodies.push(await readFile(bodyFile, 'utf8'))
      return head
    }
    const issue = fakeItem({ source: 'github', type: 'issue', key: 'acme/api#7' })
    const task = fakeItem({ source: 'github', type: 'pr', key: 'acme/api#8' })
    const slice = { ...unit(), items: [issue, task] }
    await publish(slice, dir, forge, 'r1', start, undefined, false)
    expect(bodies[0]).toBe('Fix the thing')
    await body('Fix the thing')
    await publish({ ...slice, branch: 'away/other' }, dir, forge, 'r2', start, undefined, true)
    expect(bodies[1]).toBe('Fix the thing\n\nCloses acme/api#7\n')
  })

  it('still opens the PR when the forge has no stacks for it', async () => {
    await commit('first')
    await body('Fix the thing')
    const forge = fakeForge()
    forge.stack = async () => {
      throw new Error('Stacked PRs are not enabled for this repository')
    }
    const stacked = { ...unit(), stackedOn: 'https://github.com/acme/api/pull/9' }
    expect(await publish(stacked, dir, forge, 'r1', start)).toMatchObject({ kind: 'pr' })
  })

  it('publishes nothing without commits, without a PR body, or onto an existing branch', async () => {
    const forge = fakeForge()
    await body('Title')
    expect(await publish(unit(), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: 'no commits',
    })
    await commit('first')
    await body('')
    expect(await publish(unit(), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: '1 commits but no PR body, not pushed',
      unpublished: true,
    })
    await body('Title')
    forge.branches.add('acme/api:away/FAKE-1')
    expect(await publish(unit(), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: 'away/FAKE-1 already exists on acme/api, not pushed',
      unpublished: true,
    })
  })

  it('fast-forwards the new commits with trailers onto your own PR branch, from where the clone started', async () => {
    const forge = pushingForge()
    await commit('first')
    expect(await publish(unit('push'), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: '1 commits but no summary, not pushed',
      unpublished: true,
    })
    await body('Fixed the flaky test.\n')
    for (const refused of [{ base: '' }, { foreign: true }])
      expect(await publish({ ...unit('push'), ...refused }, dir, forge, 'r1', start)).toEqual({
        kind: 'none',
        reason: "push goes only onto your own PR's branch, not pushed",
        unpublished: true,
      })
    expect(forge.fastForwards).toEqual([])

    expect(await publish(unit('push'), dir, forge, 'r1', start)).toEqual({
      kind: 'pushed',
      branch: 'feature-1',
      commits: 1,
      text: 'Fixed the flaky test.',
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    expect(forge.fastForwards).toEqual([`acme/api:feature-1 (#1) from ${start}`])
    expect(forge.branches.size).toBe(0)
    expect(forge.pushed).toEqual([['first|r1', 'init|']])
  })

  it('leaves a push the forge refuses unpublished, with its reason', async () => {
    const forge = { ...fakeForge(), fastForward: async () => '#1 has auto-merge on' }
    await commit('first')
    await body('Fixed the flaky test.\n')
    expect(await publish(unit('push'), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: '#1 has auto-merge on, not pushed',
      unpublished: true,
    })
  })

  it('refuses commits that include a merge, pushed or as a draft PR', async () => {
    const forge = fakeForge()
    await commit('first')
    await git(dir, 'checkout', '-qb', 'side', start)
    await commit('side')
    await git(dir, 'checkout', '-q', '-')
    await git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
    await body('Title')
    const merged = {
      kind: 'none',
      reason: '3 commits include a merge, not pushed',
      unpublished: true,
    }
    expect(await publish(unit('push'), dir, forge, 'r1', start)).toEqual(merged)
    expect(await publish(unit(), dir, forge, 'r1', start)).toEqual(merged)
    expect(forge.fastForwards).toEqual([])
    expect(forge.branches.size).toBe(0)
  })

  it('refuses a branch that no longer holds the commit the clone started from', async () => {
    const forge = fakeForge()
    await commit('first')
    await git(dir, 'reset', '-q', '--hard', start)
    await git(dir, 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten')
    await commit('rebased')
    await body('Title')
    expect(await publish(unit(), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: `the branch no longer holds ${start.slice(0, 7)}, where the clone started, not pushed`,
      unpublished: true,
    })
    expect(forge.branches.size).toBe(0)
  })

  it('refuses a merge on a push even when the clone has a remote ref past it', async () => {
    const forge = fakeForge()
    await commit('first')
    await git(dir, 'checkout', '-qb', 'side', start)
    await commit('side')
    await git(dir, 'checkout', '-q', '-')
    await git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
    await git(dir, 'update-ref', 'refs/remotes/origin/sneaky', 'HEAD')
    await commit('after')
    await body('Fixed.\n')
    expect(await publish(unit('push'), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: '4 commits include a merge, not pushed',
      unpublished: true,
    })
  })

  it("runs nothing the clone's config names, and diffs only the new commits", async () => {
    const ran = join(dir, '..', 'ran')
    const hook = join(dir, '..', 'hook.sh')
    await writeFile(hook, `#!/bin/sh\necho "$0" >> ${ran}\n`, { mode: 0o755 })
    await commit('first')
    await git(dir, 'config', 'core.fsmonitor', hook)
    await git(dir, 'config', 'diff.external', hook)
    await writeFile(join(dir, 'uncommitted.txt'), 'left behind')
    await body('Title')
    const forge = pushingForge()
    expect(await publish(unit('push'), dir, forge, 'r1', start)).toMatchObject({ kind: 'pushed' })
    await publish(unit(), dir, forge, 'r1', start)
    expect(forge.pushed).toEqual([
      ['first|r1', 'init|'],
      ['first|r1', 'init|'],
    ])
    await expect(readFile(ran, 'utf8')).rejects.toThrow('ENOENT')
    const diff = await readFile(join(dir, '.away/out/diff.patch'), 'utf8')
    expect(diff).toContain('+++ b/first.txt')
    expect(diff).not.toContain('uncommitted')
  })

  it('marks every commit since the clone started, whatever remote refs the clone gained', async () => {
    await commit('first')
    await git(dir, 'update-ref', 'refs/remotes/origin/zzz', 'HEAD')
    await commit('second')
    await body('Title')
    const forge = pushingForge()
    expect(await publish(unit(), dir, forge, 'r1', start)).toMatchObject({ kind: 'pr', commits: 2 })
    expect(forge.pushed).toEqual([['second|r1', 'first|r1', 'init|']])
  })

  it('adds the trailer at the end of a message with a `---` line', async () => {
    await writeFile(join(dir, 'a.txt'), 'a')
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', 'Fix it\n\nBefore\n---\nAfter')
    await body('Title')
    let message = ''
    const forge = fakeForge()
    forge.push = async (repo) => {
      message = await git(repo, 'log', '-1', '--format=%B', 'HEAD')
    }
    await publish(unit(), dir, forge, 'r1', start)
    expect(message).toBe('Fix it\n\nBefore\n---\nAfter\n\nAwaywork: r1')
  })

  it('refuses to write through a symlink in the clone', async () => {
    const outside = join(dir, '..', 'outside')
    await writeFile(outside, 'mine\n')
    await commit('first')
    await body('Title')
    await symlink(outside, join(dir, '.away/out/diff.patch'))
    const forge = fakeForge()
    await expect(publish(unit(), dir, forge, 'r1', start)).rejects.toThrow(
      '.away/out/diff.patch in the clone is a symlink',
    )
    await rm(join(dir, '.away/out/pr.md'))
    await symlink(outside, join(dir, '.away/out/pr.md'))
    await expect(publish(unit(), dir, forge, 'r1', start)).rejects.toThrow(
      '.away/out/pr.md in the clone is a symlink',
    )
    expect(await readFile(outside, 'utf8')).toBe('mine\n')
    expect(forge.branches.size).toBe(0)
  })

  it('reads a FIFO left as the PR body as no body, without waiting on it', async () => {
    await commit('first')
    await mkdir(join(dir, '.away/out'), { recursive: true })
    await execa('mkfifo', [join(dir, '.away/out/pr.md')])
    const forge = fakeForge()
    expect(await publish(unit(), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: '1 commits but no PR body, not pushed',
      unpublished: true,
    })
    expect(forge.branches.size).toBe(0)
  })

  it('returns the report for report delivery and pushes nothing', async () => {
    const forge = fakeForge()
    await commit('stray')
    expect(await publish(unit('report'), dir, forge, 'r1', start)).toEqual({
      kind: 'none',
      reason: 'no report written',
    })
    await writeFile(join(dir, '.away/out/report.md'), 'Approve.\n')
    expect(await publish(unit('report'), dir, forge, 'r1', start)).toEqual({
      kind: 'report',
      text: 'Approve.',
    })
    expect(forge.branches.size).toBe(0)
  })
})
