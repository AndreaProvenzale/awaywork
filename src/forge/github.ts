import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { footer, footerItems, isOurs } from '../core/footer.js'
import type { Forge, Item, PrRef } from '../core/types.js'
import { type Exec, exec, graphql, onHost } from './gh.js'

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
      nodes { url body merged isCrossRepository }
    }
  }
}`

const tipQuery = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { ... on Commit { message } } }
  }
}`

type Stack = {
  number: number
  pull_requests: { number: number }[]
}

/**
 * Pushes `dir`'s HEAD from a bare repo of its own, so `dir`'s config, hooks and refs steer neither
 * where the push goes nor what runs. With `from`, only a descendant of it, while the branch is
 * still at it; without, only while the branch doesn't exist. The lease makes that a compare-and-swap
 * but lifts git's own fast-forward check, so the ancestry check here is what keeps history intact.
 */
async function pushHead(
  run: Exec,
  remote: (repo: string) => string,
  dir: string,
  repo: string,
  branch: string,
  from?: string,
) {
  const bare = await mkdtemp(join(tmpdir(), 'awaywork-push-'))
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

/** GitHub has no nested groups: a longer path is another forge's, not a repo to cut short. */
function ownerAndName(repo: string) {
  const [owner, name, ...rest] = repo.split('/')
  if (!owner || !name || rest.length)
    throw new Error(`${repo} isn't a GitHub repo: expected owner/name`)
  return { owner, name }
}

export const githubHost = (config: Config) =>
  (config.sources.github as { host?: string } | undefined)?.host

export function githubForge(base: Exec = exec, host = 'github.com'): Forge {
  const run = onHost(base, host === 'github.com' ? undefined : host)
  const remote = (repo: string) => `https://${host}/${repo}.git`
  let myPrs: Promise<(PrNode & { items: string[] })[]> | undefined

  const forge: Forge = {
    async clone(repo, branch, dir, fork) {
      const pick = fork ? ['--no-checkout'] : branch ? ['--branch', branch] : []
      // An origin rewritten to a local path would hardlink its objects, and the chown hand them to the worker.
      await run('git', [...withGhLogin, 'clone', '--no-local', ...pick, remote(repo), dir])
      await run('git', ['-C', dir, 'config', 'credential.helper', ''])
      if (!fork) return
      // The fork's branch isn't in the repo; a same-named one there is other code.
      const ref = `refs/pull/${fork.number}/head`
      await run('git', ['-C', dir, ...withGhLogin, 'fetch', '-q', '--no-tags', remote(repo), ref])
      const head = (await run('git', ['-C', dir, 'rev-parse', 'FETCH_HEAD'])).trim()
      if (fork.head && head !== fork.head)
        throw new Error(
          `#${fork.number} on ${repo} is at ${head.slice(0, 7)}, not ${fork.head.slice(0, 7)}: it moved since it was read`,
        )
      await run('git', ['-C', dir, 'checkout', '-q', '--detach', head])
    },

    /**
     * My open PRs for the item: those whose footer names items by those items, whatever their names;
     * the others by the key in their branch or title, or the item's link line in their body,
     * or for Asana any URL to the task: its app writes `/0/0/<gid>`, not the permalink.
     */
    async prsFor(item: Item): Promise<PrRef[]> {
      myPrs ??= graphql<{ search: { nodes: PrNode[] } }>(run, myPrsQuery, {}).then((d) =>
        d.search.nodes.map((pr) => ({ ...pr, items: footerItems(pr.body) })),
      )
      const key = bounded(item.key)
      const link = item.link ? bounded(item.link) : undefined
      const asanaUrl =
        item.source === 'asana'
          ? new RegExp(`app\\.asana\\.com/\\S*/${escapeRegExp(item.id)}(?!\\d)`)
          : undefined
      return (await myPrs)
        .filter((pr) =>
          pr.items.length
            ? pr.items.includes(`${item.source}:${item.key}`)
            : key.test(pr.headRefName) ||
              key.test(pr.title) ||
              !!link?.test(pr.body) ||
              !!asanaUrl?.test(pr.body),
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
      const { owner, name } = ownerAndName(repo)
      const { repository } = await graphql<{
        repository: {
          pullRequests: {
            nodes: { url: string; body: string; merged: boolean; isCrossRepository: boolean }[]
          }
        }
      }>(run, headPrsQuery, { owner, name, branch })
      return repository.pullRequests.nodes
        .filter((pr) => !pr.isCrossRepository)
        .map(({ url, body, merged }) => ({ url, body, merged }))
    },

    async tipMessage(repo, branch) {
      const { owner, name } = ownerAndName(repo)
      const { repository } = await graphql<{
        repository: { ref: { target: { message?: string } } | null }
      }>(run, tipQuery, { owner, name, ref: `refs/heads/${branch}` })
      return repository.ref?.target.message ?? ''
    },

    async push(dir, branch, { repo }) {
      if (await forge.branchExists(repo, branch))
        throw new Error(`refusing to push ${branch}: it already exists on ${repo}`)
      await pushHead(run, remote, dir, repo, branch)
    },

    /** Reads the PR live: hours may have passed since planning. */
    async fastForward(dir, branch, from, { repo, pr }) {
      const { owner, name } = ownerAndName(repo)
      const { repository: r } = await graphql<{ repository: PrState }>(run, prStateQuery, {
        owner,
        name,
        number: pr,
        branch,
      })
      const p = r.pullRequest
      const shared = r.pullRequests.nodes.find((o) => !o.isCrossRepository && !o.viewerDidAuthor)
      const moved = `${branch} is at ${p.headRefOid.slice(0, 7)}, the clone started from ${from.slice(0, 7)}`
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
      if (refused) return refused
      await pushHead(run, remote, dir, repo, branch, from)
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

    /** Starts a stack of the two, or adds `pr` to `below`'s while `below` is its top; a stack can't fork. */
    async stack(repo, below, pr) {
      const number = (url: string) => Number(url.split('/').at(-1))
      const [lower, upper] = [number(below), number(pr)]
      const stacks: Stack[] = JSON.parse(
        await run('gh', ['api', `repos/${repo}/stacks?pull_request=${lower}`]),
      )
      const [found] = stacks
      if (found && found.pull_requests.at(-1)?.number !== lower) return
      const [path, prs] = found
        ? [`repos/${repo}/stacks/${found.number}/add`, [upper]]
        : [`repos/${repo}/stacks`, [lower, upper]]
      const fields = prs.flatMap((n) => ['-F', `pull_requests[]=${n}`])
      await run('gh', ['api', '--method', 'POST', path, ...fields])
    },
  }
  return forge
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` anywhere, in any case, but not inside a longer word or number. */
const bounded = (text: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(text)}($|[^a-z0-9])`, 'i')
