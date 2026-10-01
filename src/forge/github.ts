import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { footer, isOurs } from '../core/footer.js'
import type { Forge, Item, PrRef } from '../core/types.js'
import { type Exec, exec, graphql } from './gh.js'

const myPrsQuery = `query {
  search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number url title body headRefName isCrossRepository repository { nameWithOwner } } }
  }
}`

type PrNode = {
  number: number
  url: string
  title: string
  body: string
  headRefName: string
  isCrossRepository: boolean
  repository: { nameWithOwner: string }
}

/** Git uses gh's login only for the command it is passed to; the clone keeps no helper. */
const withGhLogin = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
/** Git in the push repo runs no hooks and sees history as it is, not as replace refs say. */
const pushSafely = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null']

const prStateQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      state isCrossRepository headRefName headRefOid autoMergeRequest { enabledAt }
    }
  }
}`

type PrState = {
  defaultBranchRef: { name: string } | null
  pullRequest: {
    state: string
    isCrossRepository: boolean
    headRefName: string
    headRefOid: string
    autoMergeRequest: unknown
  }
}
const remote = (repo: string) => `https://github.com/${repo}.git`

/**
 * Pushes `dir`'s HEAD from a bare repo of its own, so `dir`'s config, hooks and refs steer neither
 * where the push goes nor what runs. With `from`, only a fast-forward from it.
 */
async function pushHead(run: Exec, dir: string, repo: string, branch: string, from?: string) {
  const bare = await mkdtemp(join(tmpdir(), 'nightshift-push-'))
  const git = (...args: string[]) => run('git', ['-C', bare, ...pushSafely, ...args])
  try {
    await run('git', ['init', '-q', '--bare', bare])
    await git('fetch', '-q', '--no-tags', dir, 'HEAD')
    if (
      from &&
      !(await git('merge-base', '--is-ancestor', from, 'FETCH_HEAD').then(
        () => true,
        () => false,
      ))
    )
      throw new Error(
        `refusing to push onto ${branch} on ${repo}: not a fast-forward from ${from.slice(0, 7)}`,
      )
    await git(...withGhLogin, 'push', remote(repo), `FETCH_HEAD:refs/heads/${branch}`)
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
}

export function githubForge(run: Exec = exec): Forge {
  let myPrs: Promise<PrNode[]> | undefined

  const forge: Forge = {
    async clone(repo, branch, dir) {
      const pick = branch ? ['--branch', branch] : []
      await run('git', [...withGhLogin, 'clone', ...pick, remote(repo), dir])
      await run('git', ['-C', dir, 'config', 'credential.helper', ''])
    },

    /** My open PRs whose branch or title carries the item key. */
    async prsFor(item: Item): Promise<PrRef[]> {
      myPrs ??= graphql<{ search: { nodes: PrNode[] } }>(run, myPrsQuery, {}).then(
        (d) => d.search.nodes,
      )
      const key = new RegExp(`(^|[^a-z0-9])${escapeRegExp(item.key)}($|[^a-z0-9])`, 'i')
      return (await myPrs)
        .filter((pr) => key.test(pr.headRefName) || key.test(pr.title))
        .map((pr) => ({
          repo: pr.repository.nameWithOwner,
          number: pr.number,
          url: pr.url,
          branch: pr.headRefName,
          ours: isOurs(pr.body),
          mine: true,
          trusted: true,
          fork: pr.isCrossRepository,
        }))
    },

    async branchExists(repo, name) {
      const refs = JSON.parse(
        await run('gh', ['api', `repos/${repo}/git/matching-refs/heads/${name}`]),
      )
      return refs.some((r: { ref: string }) => r.ref === `refs/heads/${name}`)
    },

    async push(dir, branch, { repo }) {
      if (await forge.branchExists(repo, branch))
        throw new Error(`refusing to push ${branch}: it already exists on ${repo}`)
      await pushHead(run, dir, repo, branch)
    },

    /** Reads the PR live: hours may have passed since planning. */
    async fastForward(dir, branch, from, { repo, pr }) {
      const [owner = '', name = ''] = repo.split('/')
      const { repository: r } = await graphql<{ repository: PrState }>(run, prStateQuery, {
        owner,
        name,
        number: pr,
      })
      const p = r.pullRequest
      const refused =
        p.state !== 'OPEN'
          ? `#${pr} is ${p.state.toLowerCase()}`
          : p.isCrossRepository
            ? `#${pr}'s branch is on a fork`
            : p.headRefName !== branch
              ? `#${pr}'s branch is ${p.headRefName}`
              : branch === r.defaultBranchRef?.name
                ? `${branch} is the default branch`
                : p.autoMergeRequest
                  ? `#${pr} has auto-merge on`
                  : p.headRefOid !== from
                    ? `it is at ${p.headRefOid.slice(0, 7)}, the clone started from ${from.slice(0, 7)}`
                    : undefined
      if (refused) throw new Error(`refusing to push onto ${branch} on ${repo}: ${refused}`)
      await pushHead(run, dir, repo, branch, from)
    },

    /** The body file's first line is the title; the rest, plus the footer, is the body. */
    async draftPr(repo, head, base, bodyFile, runId) {
      const [first = '', ...rest] = (await readFile(bodyFile, 'utf8')).trimStart().split('\n')
      const title = first.replace(/^#+\s*/, '').trim() || head
      const body = `${rest.join('\n').trim()}\n\n${footer(runId)}`
      const into = base ? ['--base', base] : []
      const args = ['pr', 'create', '-R', repo, '--draft', '--head', head, ...into]
      const out = await run('gh', [...args, '--title', title, '--body', body])
      return out.trim().split('\n').at(-1) ?? ''
    },
  }
  return forge
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
