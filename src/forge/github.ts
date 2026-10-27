import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { isOurs, leftIn } from '../core/footer.js'
import type { Forge, Item, PrRef } from '../core/types.js'
import { type Check, checkContexts, checkResult } from './checks.js'
import { type Exec, exec, graphql, onHost } from './gh.js'
import { byName, linksItem, prText } from './pr.js'
import { pushHead } from './push.js'

/** Who opened a PR and who last edited its body, if anyone. */
export const EDITED = 'viewerDidAuthor author { login } editor { login }'
export type Edited = {
  viewerDidAuthor: boolean
  author: { login: string } | null
  editor: { login: string } | null
}

/** You opened the PR and no one else edited its body since: awaywork edits it as you. */
export const bodyYours = (pr: Edited): boolean =>
  pr.viewerDidAuthor && (!pr.editor || pr.editor.login === pr.author?.login)

const myPrsQuery = `query {
  search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number url title body isDraft ${EDITED} headRefName headRefOid isCrossRepository repository { nameWithOwner } } }
  }
}`

type PrNode = Edited & {
  number: number
  url: string
  title: string
  body: string
  isDraft: boolean
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
      nodes { number url body state isDraft ${EDITED} closedAt headRefOid isCrossRepository }
    }
  }
}`

const tipQuery = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { ... on Commit { message } } }
  }
}`

const checksQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { ${checkContexts} } } }
    }
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
    canFastForward: true,

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
          ...leftIn(pr.body, pr.isDraft, bodyYours(pr)),
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
            nodes: (Edited & {
              number: number
              url: string
              body: string
              state: 'OPEN' | 'CLOSED' | 'MERGED'
              isDraft: boolean
              closedAt: string | null
              headRefOid: string
              isCrossRepository: boolean
            })[]
          }
        }
      }>(run, headPrsQuery, { owner, name, branch })
      return repository.pullRequests.nodes
        .filter((pr) => !pr.isCrossRepository)
        .map((pr) => ({
          url: pr.url,
          number: pr.number,
          body: pr.body,
          head: pr.headRefOid,
          open: pr.state === 'OPEN',
          merged: pr.state === 'MERGED',
          draft: pr.isDraft,
          bodyYours: bodyYours(pr),
          ...(pr.closedAt && { closedAt: pr.closedAt }),
        }))
    },

    async tipMessage(repo, branch) {
      const [owner = '', name = ''] = repo.split('/')
      const { repository } = await graphql<{
        repository: { ref: { target: { message?: string } } | null }
      }>(run, tipQuery, { owner, name, ref: `refs/heads/${branch}` })
      return repository.ref?.target.message ?? ''
    },

    async fileAt(repo, ref, path) {
      const at = path.split('/').map(encodeURIComponent).join('/')
      const out = await run('gh', [
        'api',
        `repos/${repo}/contents/${at}?ref=${encodeURIComponent(ref)}`,
      ]).catch((e: Error) => {
        if (/HTTP 404/.test(e.message)) return undefined
        throw e
      })
      const file = out === undefined ? undefined : JSON.parse(out)
      if (file?.type !== 'file') return undefined
      // The contents API leaves a file over 1 MB out.
      if (file.encoding !== 'base64') throw new Error(`${path} is over 1 MB`)
      return Buffer.from(file.content, 'base64').toString('utf8')
    },

    async checks(repo, number) {
      const [owner = '', name = ''] = repo.split('/')
      const { repository } = await graphql<{
        repository: {
          pullRequest: {
            commits: {
              nodes: { commit: { statusCheckRollup: { contexts: { nodes: Check[] } } | null } }[]
            }
          }
        }
      }>(run, checksQuery, { owner, name, number })
      const [head] = repository.pullRequest.commits.nodes
      return byName((head?.commit.statusCheckRollup?.contexts.nodes ?? []).map(checkResult))
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
      const moved = `${branch} is at ${p.headRefOid.slice(0, 7)}, awaywork left it at ${from.slice(0, 7)}`
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

    async openPr(repo, head, base, bodyFile, runId, items, draft, left) {
      const { title, body } = await prText(bodyFile, head, runId, items, left)
      const into = base ? ['--base', base] : []
      const asDraft = draft ? ['--draft'] : []
      const args = ['pr', 'create', '-R', repo, ...asDraft, '--head', head, ...into]
      const out = await run('gh', [...args, '--title', title, '--body', body])
      return out.trim().split('\n').at(-1) ?? ''
    },

    async updatePr(repo, pr, bodyFile, runId, items, ready, left) {
      const { title, body } = await prText(bodyFile, '', runId, items, left)
      await run('gh', ['pr', 'edit', String(pr), '-R', repo, '--title', title, '--body', body])
      if (ready) await run('gh', ['pr', 'ready', String(pr), '-R', repo])
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

    /** GitHub allows one pending review of yours per PR and refuses a second, saying so. */
    async pendingReview(repo, pr, head, { body, comments }) {
      const reviews = `repos/${repo}/pulls/${pr}/reviews`
      const dir = await mkdtemp(join(tmpdir(), 'awaywork-review-'))
      try {
        const file = join(dir, 'review.json')
        const lines = comments.map((c) => ({ ...c, side: 'RIGHT' }))
        // Without an `event`, the review stays pending.
        await writeFile(file, JSON.stringify({ commit_id: head, body, comments: lines }))
        const out = await run('gh', ['api', '--method', 'POST', reviews, '--input', file]).catch(
          (e: Error) => {
            throw refusal(e)
          },
        )
        return JSON.parse(out).html_url
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
  return forge
}

/** GitHub's own words for a call it refused, from the JSON `gh api` prints. */
function refusal(e: Error & { stdout?: string }): Error {
  try {
    const { message, errors = [] } = JSON.parse(e.stdout ?? '')
    const why = errors.map((x: string | { message?: string }) =>
      typeof x === 'string' ? x : x.message,
    )
    return new Error([message, ...why].filter(Boolean).join(': '))
  } catch {
    return e
  }
}
