import type { Config } from '../config/schema.js'
import { isOurs } from '../core/footer.js'
import type { Forge, Item, PrRef } from '../core/types.js'
import { type Exec, exec, graphql, onHost } from './gh.js'
import { linksItem, prText } from './pr.js'
import { pushHead } from './push.js'

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

export const githubHost = (config: Config) =>
  (config.sources.github as { host?: string } | undefined)?.host

export function githubForge(base: Exec = exec, host = 'github.com'): Forge {
  const run = onHost(base, host === 'github.com' ? undefined : host)
  const remote = (repo: string) => `https://${host}/${repo}.git`
  let myPrs: Promise<PrNode[]> | undefined

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

    /** My open PRs for the item, as `linksItem` matches them. */
    async prsFor(item: Item): Promise<PrRef[]> {
      myPrs ??= graphql<{ search: { nodes: PrNode[] } }>(run, myPrsQuery, {}).then(
        (d) => d.search.nodes,
      )
      const links = linksItem(item)
      return (await myPrs)
        .filter((pr) => links({ branch: pr.headRefName, title: pr.title, body: pr.body }))
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
      const [owner = '', name = ''] = repo.split('/')
      const { repository } = await graphql<{
        repository: { ref: { target: { message?: string } } | null }
      }>(run, tipQuery, { owner, name, ref: `refs/heads/${branch}` })
      return repository.ref?.target.message ?? ''
    },

    async push(dir, branch, { repo }) {
      if (await forge.branchExists(repo, branch))
        throw new Error(`refusing to push ${branch}: it already exists on ${repo}`)
      await pushHead(run, withGhLogin, remote(repo), dir, repo, branch)
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
      await pushHead(run, withGhLogin, remote(repo), dir, repo, branch, from)
    },

    async openPr(repo, head, base, bodyFile, runId, items, draft) {
      const { title, body } = await prText(bodyFile, head, runId, items)
      const into = base ? ['--base', base] : []
      const asDraft = draft ? ['--draft'] : []
      const args = ['pr', 'create', '-R', repo, ...asDraft, '--head', head, ...into]
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
