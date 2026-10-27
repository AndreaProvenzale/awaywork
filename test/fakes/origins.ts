import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../../src/config/paths.js'
import type { Item } from '../../src/core/types.js'
import { prText } from '../../src/forge/pr.js'
import { fakeForge } from './forge.js'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** Forges on local origins, one per repo, that take pushes, open PRs on the base they name and read files at a ref. */
export async function originsForge(root: string, repos: string[]) {
  const origins: Record<string, string> = {}
  for (const repo of repos) {
    const origin = join(root, repo.replace('/', '-'))
    await execa(bin('git'), ['init', '-q', '-b', 'main', origin])
    await git(origin, 'commit', '-q', '--allow-empty', '-m', 'init')
    origins[repo] = origin
  }
  const fake = fakeForge()
  const bases: Record<string, string> = {}
  const clones: Record<string, string> = {}
  let n = 10
  const forge = {
    ...fake,
    clone: async (repo: string, branch: string, dir: string) => {
      clones[`${repo}:${dir}`] = branch || 'main'
      await execa(bin('git'), [
        'clone',
        '-q',
        ...(branch ? ['--branch', branch] : []),
        origins[repo] as string,
        dir,
      ])
    },
    push: async (dir: string, branch: string, to: { repo: string }) => {
      await fake.push(dir, branch, to)
      await git(dir, 'push', '-q', origins[to.repo] as string, `HEAD:refs/heads/${branch}`)
    },
    openPr: async (
      repo: string,
      head: string,
      base: string,
      bodyFile: string,
      runId: string,
      items: Pick<Item, 'source' | 'key'>[],
    ) => {
      const { body } = await prText(bodyFile, head, runId, items)
      const url = `https://github.com/${repo}/pull/${++n}`
      bases[`${repo}:${head}`] = base || 'main'
      const sha = (await git(origins[repo] as string, 'rev-parse', head)).stdout
      fake.heads[`${repo}:${head}`] = [{ url, number: n, body, open: true, head: sha }]
      return url
    },
    fileAt: async (repo: string, ref: string, path: string) => {
      const shown = await execa(
        bin('git'),
        ['-C', origins[repo] as string, 'show', `${ref}:${path}`],
        {
          reject: false,
          stripFinalNewline: false,
        },
      )
      return shown.exitCode === 0 ? shown.stdout : undefined
    },
  }
  /** Merges the PR on `branch` and deletes the branch, as GitHub does. */
  const merge = async (repo: string, branch: string) => {
    const [found] = fake.heads[`${repo}:${branch}`] ?? []
    if (found) Object.assign(found, { open: false, merged: true, closedAt: '2026-10-29T00:00:00Z' })
    await git(origins[repo] as string, 'branch', '-D', branch)
  }
  return { forge, bases, clones, merge, stacked: fake.stacked }
}
