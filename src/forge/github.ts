import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { footer, footerItems, isOurs } from '../core/footer.js'
import type { Forge, Item, PrRef } from '../core/types.js'
import { type Exec, exec, graphql } from './gh.js'

const myPrsQuery = `query {
  search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number url title body headRefName headRefOid isCrossRepository repository { nameWithOwner } } }
  }
}`

type PrNode = {
  number: number
  url: string
  title: string
  body: string
  headRefName: string
  headRefOid: string
  isCrossRepository: boolean
  repository: { nameWithOwner: string }
}

/** Git uses gh's login only for the command it is passed to; the clone keeps no helper. */
const withGhLogin = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
/** Git in the push repo runs no hooks and sees history as it is, not as replace refs say. */
const pushSafely = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null']

const prStateQuery = `query($owner: String!, $name: String!, $number: Int!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      state viewerDidAuthor isCrossRepository headRefName headRefOid autoMergeRequest { enabledAt }
    }
    pullRequests(headRefName: $branch, states: OPEN, first: 100) {
      nodes { number isCrossRepository viewerDidAuthor }
    }
  }
}`

type PrState = {
  defaultBranchRef: { name: string } | null
  pullRequest: {
    state: string
    viewerDidAuthor: boolean
    isCrossRepository: boolean
    headRefName: string
    headRefOid: string
    autoMergeRequest: unknown
  }
  /** Open PRs whose head has the branch's name; the fork ones live elsewhere. */
  pullRequests: {
    nodes: { number: number; isCrossRepository: boolean; viewerDidAuthor: boolean }[]
  }
}

const headPrsQuery = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, CLOSED, MERGED], first: 100) {
      nodes { url body }
    }
  }
}`

const remote = (repo: string) => `https://github.com/${repo}.git`

/**
 * Pushes `dir`'s HEAD from a bare repo of its own, so `dir`'s config, hooks and refs steer neither
 * where the push goes nor what runs. With `from`, only a descendant of it, while the branch is
 * still at it; without, only while the branch doesn't exist. The lease makes that a compare-and-swap
 * but lifts git's own fast-forward check, so the ancestry check here is what keeps history intact.
 */
async function pushHead(run: Exec, dir: string, repo: string, branch: string, from?: string) {
  const bare = await mkdtemp(join(tmpdir(), 'nightshift-push-'))
  const git = (...args: string[]) => run('git', ['-C', bare, ...pushSafely, ...args])
  try {
    await run('git', ['init', '-q', '--bare', bare])
    await git('fetch', '-q', '--no-tags', dir, 'HEAD')
    // One commit, checked and pushed: nothing can move a ref in between.
    const head = (await git('rev-parse', '--verify', 'FETCH_HEAD^{commit}')).trim()
    if (
      from &&
      !(await git('merge-base', '--is-ancestor', from, head).then(
        () => true,
        () => false,
      ))
    )
      throw new Error(
        `refusing to push onto ${branch} on ${repo}: not a fast-forward from ${from.slice(0, 7)}`,
      )
    const lease = `--force-with-lease=refs/heads/${branch}:${from ?? ''}`
    await git(...withGhLogin, 'push', lease, remote(repo), `${head}:refs/heads/${branch}`)
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
}

export function githubForge(run: Exec = exec): Forge {
  let myPrs: Promise<(PrNode & { items: string[] })[]> | undefined

  const forge: Forge = {
    async clone(repo, branch, dir) {
      const pick = branch ? ['--branch', branch] : []
      await run('git', [...withGhLogin, 'clone', ...pick, remote(repo), dir])
      await run('git', ['-C', dir, 'config', 'credential.helper', ''])
    },

    /**
     * My open PRs for the item: those whose footer names items by those items, whatever their names;
     * the others by the key in their branch or title, or the item's link line in their body.
     */
    async prsFor(item: Item): Promise<PrRef[]> {
      myPrs ??= graphql<{ search: { nodes: PrNode[] } }>(run, myPrsQuery, {}).then((d) =>
        d.search.nodes.map((pr) => ({ ...pr, items: footerItems(pr.body) })),
      )
      const key = bounded(item.key)
      const link = item.link ? bounded(item.link) : undefined
      return (await myPrs)
        .filter((pr) =>
          pr.items.length
            ? pr.items.includes(`${item.source}:${item.key}`)
            : key.test(pr.headRefName) || key.test(pr.title) || !!link?.test(pr.body),
        )
        .map((pr) => ({
          repo: pr.repository.nameWithOwner,
          number: pr.number,
          url: pr.url,
          branch: pr.headRefName,
          head: pr.headRefOid,
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

    async prsOn(repo, branch) {
      const [owner = '', name = ''] = repo.split('/')
      const { repository } = await graphql<{
        repository: { pullRequests: { nodes: { url: string; body: string }[] } }
      }>(run, headPrsQuery, { owner, name, branch })
      return repository.pullRequests.nodes
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
        branch,
      })
      const p = r.pullRequest
      const shared = r.pullRequests.nodes.find((o) => !o.isCrossRepository && !o.viewerDidAuthor)
      const moved = `it is at ${p.headRefOid.slice(0, 7)}, the clone started from ${from.slice(0, 7)}`
      const checks: [boolean, string][] = [
        [p.state !== 'OPEN', `#${pr} is ${p.state.toLowerCase()}`],
        [!p.viewerDidAuthor, `#${pr} isn't yours`],
        [p.isCrossRepository, `#${pr}'s branch is on a fork`],
        [p.headRefName !== branch, `#${pr}'s branch is ${p.headRefName}`],
        [branch === r.defaultBranchRef?.name, `${branch} is the default branch`],
        [!!shared, `${branch} is also the branch of #${shared?.number}, which isn't yours`],
        [!!p.autoMergeRequest, `#${pr} has auto-merge on`],
        [p.headRefOid !== from, moved],
      ]
      const path = `repos/${repo}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`
      const refused =
        checks.find(([no]) => no)?.[1] ??
        (JSON.parse(await run('gh', ['api', path])).protected
          ? `${branch} is protected`
          : undefined)
      if (refused) throw new Error(`refusing to push onto ${branch} on ${repo}: ${refused}`)
      await pushHead(run, dir, repo, branch, from)
    },

    /** The body file's first line is the title; the rest, plus the footer, is the body. */
    async draftPr(repo, head, base, bodyFile, runId, items) {
      const [first = '', ...rest] = (await readFile(bodyFile, 'utf8')).trimStart().split('\n')
      const title = first.replace(/^#+\s*/, '').trim() || head
      const body = `${rest.join('\n').trim()}\n\n${footer(runId, items)}`
      const into = base ? ['--base', base] : []
      const args = ['pr', 'create', '-R', repo, '--draft', '--head', head, ...into]
      const out = await run('gh', [...args, '--title', title, '--body', body])
      return out.trim().split('\n').at(-1) ?? ''
    },
  }
  return forge
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` anywhere, in any case, but not inside a longer word or number. */
const bounded = (text: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(text)}($|[^a-z0-9])`, 'i')
