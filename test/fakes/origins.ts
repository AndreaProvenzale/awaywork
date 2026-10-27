import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../../src/config/paths.js'
import { type Left, leftIn } from '../../src/core/footer.js'
import type { Item } from '../../src/core/types.js'
import { prText } from '../../src/forge/pr.js'
import { fakeForge } from './forge.js'

const git = (dir: string, ...args: string[]) =>
  execa(bin('git'), ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

/** Forges on local origins, one per repo, that take pushes and fast-forwards, open and update PRs on the base they name, as drafts or not, and read files at a ref. */
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
  const drafts: Record<string, boolean> = {}
  const clones: Record<string, string> = {}
  const updated: string[] = []
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
      draft: boolean,
      left?: Left,
    ) => {
      const { body } = await prText(bodyFile, head, runId, items, left)
      const url = `https://github.com/${repo}/pull/${++n}`
      bases[`${repo}:${head}`] = base || 'main'
      drafts[`${repo}:${head}`] = draft
      const sha = (await git(origins[repo] as string, 'rev-parse', head)).stdout
      fake.heads[`${repo}:${head}`] = [{ url, number: n, body, open: true, head: sha }]
      return url
    },
    prsOn: async (repo: string, branch: string) =>
      (await fake.prsOn(repo, branch)).map((pr) => ({
        ...pr,
        ...leftIn(pr.body, pr.open && drafts[`${repo}:${branch}`] === true),
      })),
    /** Refuses unless the PR's branch is still at `from`, and a draft with `draft`, as GitHub's does. */
    fastForward: async (
      dir: string,
      branch: string,
      from: string,
      to: { repo: string; pr: number; draft?: boolean },
    ) => {
      if (to.draft && drafts[`${to.repo}:${branch}`] === false) return `#${to.pr} was marked ready`
      const at = (await git(origins[to.repo] as string, 'rev-parse', branch)).stdout
      if (at !== from)
        return `${branch} is at ${at.slice(0, 7)}, awaywork left it at ${from.slice(0, 7)}`
      await fake.fastForward(dir, branch, from, to)
      await git(dir, 'push', '-q', origins[to.repo] as string, `HEAD:refs/heads/${branch}`)
    },
    updatePr: async (
      repo: string,
      pr: number,
      bodyFile: string,
      runId: string,
      items: Pick<Item, 'source' | 'key'>[],
      ready: boolean,
      left?: Left,
    ) => {
      const [head, [found] = []] =
        Object.entries(fake.heads).find(
          ([key, prs]) => key.startsWith(`${repo}:`) && prs[0]?.number === pr,
        ) ?? []
      if (!head || !found) throw new Error(`no PR #${pr} on ${repo}`)
      const branch = head.slice(repo.length + 1)
      found.body = (await prText(bodyFile, branch, runId, items, left)).body
      found.head = (await git(origins[repo] as string, 'rev-parse', branch)).stdout
      if (ready) drafts[head] = false
      updated.push(`${repo}#${pr}${ready ? ' ready' : ''}`)
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
  /** Commits on `branch` as you would, moving its head. */
  const commitOn = async (repo: string, branch: string) => {
    const origin = origins[repo] as string
    await git(origin, 'commit-tree', '-p', branch, '-m', 'mine', `${branch}^{tree}`).then(
      ({ stdout }) => git(origin, 'update-ref', `refs/heads/${branch}`, stdout),
    )
    const [found] = fake.heads[`${repo}:${branch}`] ?? []
    if (found) found.head = (await git(origin, 'rev-parse', branch)).stdout
  }
  return { forge, bases, drafts, clones, merge, commitOn, updated, stacked: fake.stacked }
}
