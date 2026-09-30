import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Unit } from '../src/core/types.js'
import { publish } from '../src/worker/publish.js'
import { fakeForge } from './fakes/forge.js'
import { fakeItem } from './fakes/items.js'

const git = async (dir: string, ...args: string[]) =>
  (await execa('git', ['-C', dir, ...args])).stdout

const unit = (deliver: Unit['deliver'] = 'draft_pr'): Unit => ({
  id: 'fake-1',
  items: [fakeItem()],
  repo: 'acme/api',
  base: 'feature-1',
  foreign: false,
  network: true,
  untrusted: false,
  branch: 'night/FAKE-1',
  rule: { skill: 'fix-ci', provider: [], skills: [], instructions: [] },
  skill: 'fix-ci',
  skills: [],
  providers: ['fake'],
  instructions: [],
  deliver,
})

describe('publish', () => {
  let dir: string
  const commit = async (message: string) => {
    await writeFile(join(dir, `${message}.txt`), message)
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-qm', message)
  }
  const body = (text: string) => writeFile(join(dir, '.nightshift/out/pr.md'), text)

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'nightshift-publish-'))
    const origin = join(root, 'origin')
    dir = join(root, 'clone')
    await execa('git', ['init', '-q', '-b', 'feature-1', origin])
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
    await execa('git', ['clone', '-q', origin, dir])
    await git(dir, 'config', 'user.name', 'Dev')
    await git(dir, 'config', 'user.email', 'dev@example.com')
    await git(dir, 'config', 'core.hooksPath', '.husky')
    await git(dir, 'checkout', '-q', '-b', 'night/FAKE-1')
    await mkdir(join(dir, '.nightshift/out'), { recursive: true })
  })

  it('pushes the new branch with trailers and opens a draft PR into the base', async () => {
    await commit('first')
    await commit('second')
    await body('Fix the thing\n\nChecked: tests pass.')
    const forge = fakeForge()
    expect(await publish(unit(), dir, forge, '20260925-010000')).toEqual({
      kind: 'pr',
      url: 'https://example.com/acme/api/pull/night/FAKE-1',
      commits: 2,
    })
    expect(forge.branches).toEqual(new Set(['acme/api:night/FAKE-1']))
    const trailers = await git(
      dir,
      'log',
      '--format=%s|%(trailers:key=Night-shift,valueonly)',
      'origin/feature-1..HEAD',
    )
    expect(trailers.split('\n').filter(Boolean)).toEqual([
      'second|20260925-010000',
      'first|20260925-010000',
    ])
  })

  it('publishes nothing without commits, without a PR body, or onto an existing branch', async () => {
    const forge = fakeForge()
    await body('Title')
    expect(await publish(unit(), dir, forge, 'r1')).toEqual({ kind: 'none', reason: 'no commits' })
    await commit('first')
    await body('')
    expect(await publish(unit(), dir, forge, 'r1')).toEqual({
      kind: 'none',
      reason: '1 commits but no PR body, not pushed',
      unpublished: true,
    })
    await body('Title')
    forge.branches.add('acme/api:night/FAKE-1')
    expect(await publish(unit(), dir, forge, 'r1')).toEqual({
      kind: 'none',
      reason: 'night/FAKE-1 already exists on acme/api, not pushed',
      unpublished: true,
    })
  })

  it('fast-forwards the new commits with trailers onto your own PR branch, from where the clone started', async () => {
    const report = (text: string) => writeFile(join(dir, '.nightshift/out/report.md'), text)
    const forge = fakeForge()
    const start = await git(dir, 'rev-parse', 'HEAD')
    await commit('first')
    expect(await publish(unit('push'), dir, forge, 'r1')).toEqual({
      kind: 'none',
      reason: '1 commits but no report, not pushed',
      unpublished: true,
    })
    await report('Fixed the flaky test.\n')
    for (const refused of [{ base: '' }, { foreign: true }])
      expect(await publish({ ...unit('push'), ...refused }, dir, forge, 'r1')).toEqual({
        kind: 'none',
        reason: "push goes only onto your own PR's branch, not pushed",
        unpublished: true,
      })
    expect(forge.fastForwards).toEqual([])

    expect(await publish(unit('push'), dir, forge, 'r1')).toEqual({
      kind: 'pushed',
      branch: 'feature-1',
      commits: 1,
      text: 'Fixed the flaky test.',
    })
    expect(forge.fastForwards).toEqual([`acme/api:feature-1 from ${start}`])
    expect(forge.branches.size).toBe(0)
    const trailers = await git(
      dir,
      'log',
      '--format=%s|%(trailers:key=Night-shift,valueonly)',
      'origin/feature-1..HEAD',
    )
    expect(trailers.trim()).toBe('first|r1')
    expect(await git(dir, 'log', '-1', '--format=%(trailers:key=Night-shift)', start)).toBe('')
  })

  it('returns the report for report delivery and pushes nothing', async () => {
    const forge = fakeForge()
    await commit('stray')
    expect(await publish(unit('report'), dir, forge, 'r1')).toEqual({
      kind: 'none',
      reason: 'no report written',
    })
    await writeFile(join(dir, '.nightshift/out/report.md'), 'Approve.\n')
    expect(await publish(unit('report'), dir, forge, 'r1')).toEqual({
      kind: 'report',
      text: 'Approve.',
    })
    expect(forge.branches.size).toBe(0)
  })
})
