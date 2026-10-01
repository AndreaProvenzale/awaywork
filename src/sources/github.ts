import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isOurs, isPushedCommit } from '../core/footer.js'
import type { Item, PrRef, Source } from '../core/types.js'
import { type Exec, exec, graphql } from '../forge/gh.js'

const config = z
  .strictObject({
    repos: z.array(z.string()).min(1).describe('Repos to read, owner/name; * globs, e.g. acme/*'),
  })
  .describe('My PRs, PRs awaiting my review and issues assigned to me; also the forge')
type Config = z.infer<typeof config>

const PAGE = 100
const LOG_TAIL = 200
/** Author associations with write access or org membership; the rest can be anyone. */
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR']

const common = `
  id number title body url state createdAt updatedAt
  repository { nameWithOwner }
  author { login } authorAssociation
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name } }
  comments(last: 50) { nodes { author { login } body createdAt } }`

const searchQuery = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${PAGE}) {
    issueCount
    nodes {
      __typename
      ... on Issue { ${common}
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
          nodes { number url headRefName isCrossRepository body viewerDidAuthor authorAssociation repository { nameWithOwner } }
        }
      }
      ... on PullRequest { ${common}
        isDraft headRefName isCrossRepository viewerDidAuthor
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { message statusCheckRollup { state } } } }
      }
    }
  }
}`

/** Who started each thread; nested in every search, it would cost each one ~100 points instead of ~6. */
const threadStartersQuery = (ids: string[]) => `{
  nodes(ids: ${JSON.stringify(ids)}) {
    ... on PullRequest {
      id
      reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { viewerDidAuthor } } } }
    }
  }
}`

const prQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50) { nodes { author { login } state body submittedAt } }
      reviewThreads(first: 100) {
        nodes {
          isResolved path line
          comments(first: 50) { nodes { author { login } body createdAt url } }
        }
      }
      commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name conclusion detailsUrl }
          ... on StatusContext { context state targetUrl description }
        } } } } }
      }
    }
  }
}`

type Nodes<T> = { nodes: T[] }
type Login = { login: string } | null
type Comment = { author: Login; body: string; createdAt: string }
type PrLink = {
  number: number
  url: string
  headRefName: string
  isCrossRepository: boolean
  body: string
  viewerDidAuthor: boolean
  authorAssociation: string
  repository: { nameWithOwner: string }
}
interface Node extends PrLink {
  __typename: 'Issue' | 'PullRequest'
  id: string
  title: string
  body: string
  state: string
  createdAt: string
  updatedAt: string
  author: Login
  assignees: Nodes<{ login: string }>
  labels: Nodes<{ name: string }>
  comments: Nodes<Comment>
  closedByPullRequestsReferences?: Nodes<PrLink>
  isDraft?: boolean
  reviewRequests?: Nodes<{ requestedReviewer: { login?: string; slug?: string } | null }>
  reviewThreads?: Nodes<{ isResolved: boolean }>
  commits?: Nodes<{ commit: { message: string; statusCheckRollup: { state: string } | null } }>
}
interface Thread {
  isResolved: boolean
  path: string
  line: number | null
  comments: Nodes<Comment & { url: string }>
}
type Check =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; detailsUrl: string }
  | {
      __typename: 'StatusContext'
      context: string
      state: string
      targetUrl: string | null
      description: string | null
    }
interface PrDetails {
  reviews: Nodes<{ author: Login; state: string; body: string; submittedAt: string }>
  reviewThreads: Nodes<Thread>
  commits: Nodes<{ commit: { statusCheckRollup: { contexts: Nodes<Check> } | null } }>
}

const searches: { q: string; fields: Record<string, boolean> }[] = [
  { q: 'is:pr is:open archived:false author:@me', fields: { mine: true } },
  { q: 'is:pr is:open archived:false review-requested:@me', fields: { review_requested: true } },
  { q: 'is:issue is:open archived:false assignee:@me', fields: { mine: true } },
]

export function githubSource(run: Exec = exec): Source<Config> {
  return {
    id: 'github',
    configSchema: config,
    fields: {
      repo: z.string(),
      label: z.string(),
      author: z.string(),
      trusted: z.boolean(),
      mine: z.boolean(),
      draft: z.boolean(),
      ours: z.boolean(),
      pushed: z.boolean(),
      checks: z.enum(['failing', 'pending', 'passing']),
      unresolved_threads: z.number().int().min(0),
      my_unresolved_threads: z.number().int().min(0),
      review_requested: z.boolean(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
    },
    secrets: () => [],

    /** My open PRs, PRs awaiting my review and issues assigned to me, in the configured repos. */
    async items(cfg, ctx) {
      const inScope = (repo: string) => cfg.repos.some((glob) => globToRegExp(glob).test(repo))
      const byId = new Map<string, Item>()
      for (const { q, fields } of searches) {
        const { search } = await graphql<{ search: { issueCount: number; nodes: Node[] } }>(
          run,
          searchQuery,
          { q },
        )
        if (search.issueCount > PAGE)
          ctx.log(`github: "${q}" found ${search.issueCount}, reading the first ${PAGE}`)
        for (const node of search.nodes) {
          if (!inScope(node.repository.nameWithOwner)) continue
          const item = byId.get(node.id) ?? toItem(node)
          Object.assign(item.fields, fields)
          byId.set(node.id, item)
        }
      }
      await countMyThreads(run, byId, ctx.log)
      return [...byId.values()]
    },

    /** Writes pr.md, diff.patch, threads.md and checks.md for a PR; issue.md for an issue. */
    async prefetch(item, dir) {
      if (item.type !== 'pr') return writeFile(join(dir, 'issue.md'), itemMarkdown(item))
      const repo = item.fields.repo as string
      const [owner = '', name = ''] = repo.split('/')
      const number = Number(item.key.split('#')[1])
      const { repository } = await graphql<{ repository: { pullRequest: PrDetails } }>(
        run,
        prQuery,
        { owner, name, number },
      )
      const pr = repository.pullRequest
      const diff = await run('gh', ['pr', 'diff', String(number), '-R', repo])
      const checks = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
      await Promise.all([
        writeFile(join(dir, 'pr.md'), itemMarkdown(item) + reviewsMarkdown(pr)),
        writeFile(join(dir, 'diff.patch'), diff),
        writeFile(join(dir, 'threads.md'), threadsMarkdown(pr.reviewThreads.nodes)),
        writeFile(join(dir, 'checks.md'), await checksMarkdown(run, repo, checks)),
      ])
    },

    /** Suggests my own repos and names my orgs, which `owner/*` can cover. */
    async init(ask) {
      const login = (await run('gh', ['api', 'user', '--jq', '.login'])).trim()
      const orgs = (await run('gh', ['api', 'user/orgs', '--jq', '.[].login']))
        .split('\n')
        .filter(Boolean)
      const hint = orgs.length > 0 ? `; your orgs: ${orgs.join(', ')}` : ''
      const answer = await ask.text(
        `GitHub repos to watch, comma-separated (owner/name or owner/*${hint})`,
        { initial: `${login}/*` },
      )
      const repos = answer
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
      return { config: { repos: repos.length > 0 ? repos : [`${login}/*`] } }
    },
  }
}

export const github = githubSource()

/**
 * Sets `my_unresolved_threads` on the PRs that have unresolved threads, in one query per page.
 * A page that fails leaves its PRs at 0 rather than losing every item.
 */
async function countMyThreads(
  run: Exec,
  byId: Map<string, Item>,
  log: (line: string) => void,
): Promise<void> {
  const ids = [...byId]
    .filter(([, item]) => Number(item.fields.unresolved_threads) > 0)
    .map(([id]) => id)
  for (let i = 0; i < ids.length; i += PAGE) {
    const page = await graphql<{
      nodes: ({
        id: string
        reviewThreads: Nodes<{ isResolved: boolean; comments: Nodes<{ viewerDidAuthor: boolean }> }>
      } | null)[]
    }>(run, threadStartersQuery(ids.slice(i, i + PAGE)), {}).catch((e: Error) => {
      log(`github: couldn't read who started PR threads, counting none: ${e.message}`)
    })
    for (const node of page?.nodes ?? []) {
      const item = node && byId.get(node.id)
      if (item)
        item.fields.my_unresolved_threads = node.reviewThreads.nodes.filter(
          (t) => !t.isResolved && t.comments.nodes[0]?.viewerDidAuthor,
        ).length
    }
  }
}

function toItem(node: Node): Item {
  const repo = node.repository.nameWithOwner
  const isPr = node.__typename === 'PullRequest'
  const labels = node.labels.nodes.map((l) => l.name)
  const fields: Record<string, unknown> = {
    repo,
    label: labels,
    author: node.author?.login,
    trusted: TRUSTED.includes(node.authorAssociation),
    mine: false,
    created: node.createdAt,
    updated: node.updatedAt,
  }
  if (isPr) {
    const checks = checkState(node.commits?.nodes[0]?.commit.statusCheckRollup?.state)
    Object.assign(fields, {
      draft: node.isDraft,
      ours: isOurs(node.body),
      pushed: isPushedCommit(node.commits?.nodes[0]?.commit.message, node.body),
      unresolved_threads: node.reviewThreads?.nodes.filter((t) => !t.isResolved).length ?? 0,
      my_unresolved_threads: 0,
      review_requested: false,
      ...(checks && { checks }),
    })
  }
  const links = isPr ? [node] : (node.closedByPullRequestsReferences?.nodes ?? [])
  return {
    source: 'github',
    id: node.id,
    key: `${repo}#${node.number}`,
    type: isPr ? 'pr' : 'issue',
    title: node.title,
    description: node.body,
    url: node.url,
    status: node.state.toLowerCase(),
    assignee: node.assignees.nodes[0]?.login,
    reviewers: (node.reviewRequests?.nodes ?? []).flatMap((r) => {
      const who = r.requestedReviewer?.login ?? r.requestedReviewer?.slug
      return who ? [who] : []
    }),
    labels,
    comments: node.comments.nodes.map(toComment),
    linkedPrs: links.map(toPrRef),
    fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    raw: node,
  }
}

const toPrRef = (pr: PrLink): PrRef => ({
  repo: pr.repository.nameWithOwner,
  number: pr.number,
  url: pr.url,
  branch: pr.headRefName,
  ours: isOurs(pr.body),
  mine: pr.viewerDidAuthor,
  trusted: pr.viewerDidAuthor || TRUSTED.includes(pr.authorAssociation),
  fork: pr.isCrossRepository,
})

const toComment = (c: Comment) => ({
  author: c.author?.login ?? 'ghost',
  body: c.body,
  at: c.createdAt,
})

function checkState(state: string | undefined): string | undefined {
  if (state === 'SUCCESS') return 'passing'
  if (state === 'FAILURE' || state === 'ERROR') return 'failing'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`, 'i')
}

function itemMarkdown(item: Item): string {
  const comments = item.comments.map((c) => `\n### ${c.author}, ${c.at}\n\n${c.body}\n`)
  return [
    `# ${item.title}\n\n${item.url}\n\n${item.description}\n`,
    ...(comments.length ? ['\n## Comments\n', ...comments] : []),
  ].join('')
}

function reviewsMarkdown(pr: PrDetails): string {
  const reviews = pr.reviews.nodes.filter((r) => r.body.trim())
  if (!reviews.length) return ''
  return `\n## Reviews\n${reviews.map((r) => `\n### ${r.author?.login ?? 'ghost'}, ${r.state}, ${r.submittedAt}\n\n${r.body}\n`).join('')}`
}

/** Unresolved threads grouped by title (a comment's first line), since bot findings repeat per run. */
function threadsMarkdown(threads: Thread[]): string {
  const groups = new Map<string, Thread[]>()
  for (const t of threads.filter((t) => !t.isResolved)) {
    const title = t.comments.nodes[0]?.body.trim().split('\n')[0] ?? ''
    groups.set(title, [...(groups.get(title) ?? []), t])
  }
  if (!groups.size) return 'No unresolved review threads.\n'
  return [...groups]
    .map(([title, copies]) => {
      const where = copies.map((t) => `- ${t.path}:${t.line ?? '?'} ${t.comments.nodes[0]?.url}`)
      const discussion = (copies[0] as Thread).comments.nodes.map(
        (c) => `**${c.author?.login ?? 'ghost'}**, ${c.createdAt}:\n\n${c.body}\n`,
      )
      return `## ${title}\n\n${copies.length} unresolved ${copies.length > 1 ? 'copies' : 'copy'}:\n${where.join('\n')}\n\n${discussion.join('\n')}`
    })
    .join('\n')
}

async function checksMarkdown(run: Exec, repo: string, checks: Check[]): Promise<string> {
  const failed = checks.filter((c) =>
    c.__typename === 'CheckRun'
      ? ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion ?? '')
      : ['FAILURE', 'ERROR'].includes(c.state),
  )
  if (!failed.length) return 'No failing checks.\n'
  const sections = await Promise.all(
    failed.map(async (c) => {
      if (c.__typename === 'StatusContext')
        return `## ${c.context}: ${c.state}\n\n${c.description ?? ''}\n${c.targetUrl ?? ''}\n`
      const job = c.detailsUrl.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1]
      const log = job
        ? await run('gh', ['run', 'view', '-R', repo, '--job', job, '--log-failed']).then(
            (out) => out.trimEnd().split('\n').slice(-LOG_TAIL).join('\n'),
            (e: Error) => `log unavailable: ${e.message}`,
          )
        : 'not a GitHub Actions job; open the link'
      return `## ${c.name}: ${c.conclusion}\n\n${c.detailsUrl}\n\n\`\`\`\n${log}\n\`\`\`\n`
    }),
  )
  return sections.join('\n')
}
