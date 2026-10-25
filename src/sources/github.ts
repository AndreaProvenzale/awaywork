import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { commentMarkdown, isOurs } from '../core/footer.js'
import { globToRegExp } from '../core/glob.js'
import type { Item, PrRef, Source } from '../core/types.js'
import { type Exec, exec, graphql, onHost } from '../forge/gh.js'

const config = z
  .strictObject({
    repos: z.array(z.string()).min(1).describe('Repos to read, owner/name; * globs, e.g. acme/*'),
    host: z
      .string()
      .regex(/^[^/\s]+$/, 'host only, no scheme or path')
      .optional()
      .describe('GitHub Enterprise host, e.g. github.acme.com; github.com by default'),
    search: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Extra GitHub search qualifiers, each ANDed with is:open archived:false, e.g. label:awaywork or mentions:@me; items they find are neither mine nor review-requested',
      ),
  })
  .describe(
    'My PRs, PRs awaiting my review and issues assigned to me, plus any extra searches; also the forge',
  )
type Config = z.infer<typeof config>

const PAGE = 100
const LOG_TAIL = 200
/** Paths read per PR: a rule routes on where a change lands, and a huge one is huge wherever it lands. */
const MAX_FILES = 500
/** Author associations with write access or org membership; the rest can be anyone. */
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR']
const BY = 'author { login __typename } authorAssociation viewerDidAuthor'

const common = `
  id number title body url state createdAt updatedAt
  repository { nameWithOwner }
  author { login } authorAssociation
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name } }
  comments(last: 50) { nodes { ${BY} body createdAt } }`

const searchQuery = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${PAGE}) {
    issueCount
    nodes {
      __typename
      ... on Issue { ${common}
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
          nodes { number url headRefName headRefOid isCrossRepository body viewerDidAuthor authorAssociation repository { nameWithOwner } }
        }
      }
      ... on PullRequest { ${common}
        isDraft headRefName headRefOid isCrossRepository viewerDidAuthor
        additions deletions
        files(first: ${PAGE}) { pageInfo { hasNextPage endCursor } nodes { path } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

/** Who started each thread; nested in every search, it would cost each one ~100 points instead of ~6. */
const threadStartersQuery = (ids: string[]) => `{
  nodes(ids: ${JSON.stringify(ids)}) {
    ... on PullRequest {
      id
      reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { ${BY} } } } }
    }
  }
}`

const filesQuery = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { path } }
    }
  }
}`

const prQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50) { nodes { ${BY} state body submittedAt } }
      reviewThreads(first: 100) {
        nodes {
          isResolved path line
          comments(first: 50) { nodes { ${BY} body createdAt url } }
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
type Files = Nodes<{ path: string }> & { pageInfo: { hasNextPage: boolean; endCursor: string } }
type Login = { login: string } | null
type By = {
  author: { login: string; __typename: string } | null
  authorAssociation: string
  viewerDidAuthor: boolean
}
type Comment = By & { body: string; createdAt: string }
type PrLink = {
  number: number
  url: string
  headRefName: string
  headRefOid: string
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
  additions?: number
  deletions?: number
  files?: Files
  reviewRequests?: Nodes<{ requestedReviewer: { login?: string; slug?: string } | null }>
  reviewThreads?: Nodes<{ isResolved: boolean }>
  commits?: Nodes<{ commit: { statusCheckRollup: { state: string } | null } }>
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
  reviews: Nodes<By & { state: string; body: string; submittedAt: string }>
  reviewThreads: Nodes<Thread>
  commits: Nodes<{ commit: { statusCheckRollup: { contexts: Nodes<Check> } | null } }>
}

const searches: { q: string; fields: Record<string, boolean> }[] = [
  { q: 'is:pr is:open archived:false author:@me', fields: { mine: true } },
  { q: 'is:pr is:open archived:false review-requested:@me', fields: { review_requested: true } },
  { q: 'is:issue is:open archived:false assignee:@me', fields: { mine: true } },
]

export function githubSource(base: Exec = exec): Source<Config> {
  return {
    id: 'github',
    configSchema: config,
    // PRs and issues link their PRs themselves.
    link: false,
    fields: {
      repo: z.string(),
      label: z.string(),
      author: z.string(),
      trusted: z.boolean(),
      mine: z.boolean(),
      draft: z.boolean(),
      ours: z.boolean(),
      checks: z.enum(['failing', 'pending', 'passing']),
      unresolved_threads: z.number().int().min(0),
      files: z.string(),
      changed_lines: z.number().int().min(0),
      my_unresolved_threads: z.number().int().min(0),
      review_requested: z.boolean(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
    },
    secrets: () => [],

    /** My open PRs, PRs awaiting my review and issues assigned to me, in the configured repos. */
    async items(cfg, ctx) {
      const run = onHost(base, cfg.host)
      const inScope = (repo: string) => cfg.repos.some((glob) => globToRegExp(glob).test(repo))
      const byId = new Map<string, Item>()
      const extra = (cfg.search ?? []).map((q) => ({
        q: `is:open archived:false ${q}`,
        fields: {},
      }))
      for (const { q, fields } of [...searches, ...extra]) {
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
          if (item.fields.mine) item.mine = true
          byId.set(node.id, item)
        }
      }
      await countThreads(run, byId, ctx.log)
      await readFiles(run, byId, ctx.log)
      return [...byId.values()]
    },

    /** Writes item.md, plus diff.patch, threads.md and checks.md for a PR. */
    async prefetch(item, dir) {
      const run = onHost(base, URL.canParse(item.url) ? new URL(item.url).host : undefined)
      if (item.type !== 'pr') return writeFile(join(dir, 'item.md'), itemMarkdown(item))
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
        writeFile(join(dir, 'item.md'), itemMarkdown(item) + reviewsMarkdown(pr)),
        writeFile(join(dir, 'diff.patch'), diff),
        writeFile(join(dir, 'threads.md'), threadsMarkdown(pr.reviewThreads.nodes)),
        writeFile(join(dir, 'checks.md'), await checksMarkdown(run, repo, checks)),
      ])
    },

    /** Suggests my own repos and names my orgs, which `owner/*` can cover. */
    async init(ask) {
      const login = (await base('gh', ['api', 'user', '--jq', '.login'])).trim()
      const orgs = (await base('gh', ['api', 'user/orgs', '--jq', '.[].login']))
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

    /** Comments on the issue or PR, or moves it by adding the label `to`, which GitHub makes when the repo has none. */
    async write(_cfg, item, write) {
      const run = onHost(base, URL.canParse(item.url) ? new URL(item.url).host : undefined)
      // A PR is an issue too: its labels and conversation comments go through the issues API.
      const path = `repos/${item.fields.repo}/issues/${item.key.split('#')[1]}`
      if (write.op === 'comment')
        await run('gh', ['api', `${path}/comments`, '-f', `body=${write.body}`])
      else await run('gh', ['api', `${path}/labels`, '-f', `labels[]=${write.to}`])
      return (await run('gh', ['api', path, '--jq', '.updated_at'])).trim()
    },
  }
}

export const github = githubSource()

/**
 * Sets `unresolved_threads` and `my_unresolved_threads` on the PRs that have unresolved threads,
 * counting only those a trusted author started, in one query per page.
 * A page that fails keeps the raw count and none as yours rather than losing every item;
 * threads.md filters on its own.
 */
async function countThreads(
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
        reviewThreads: Nodes<{ isResolved: boolean; comments: Nodes<By> }>
      } | null)[]
    }>(run, threadStartersQuery(ids.slice(i, i + PAGE)), {}).catch((e: Error) => {
      log(`github: couldn't read who started PR threads, counting all, none as yours: ${e.message}`)
    })
    for (const node of page?.nodes ?? []) {
      const item = node && byId.get(node.id)
      if (!item) continue
      const visible = node.reviewThreads.nodes.filter((t) => !t.isResolved && startedByTrusted(t))
      item.fields.unresolved_threads = visible.length
      item.fields.my_unresolved_threads = visible.filter(
        (t) => t.comments.nodes[0]?.viewerDidAuthor,
      ).length
    }
  }
}

/** Sets `files` on each PR, following pages past the first until MAX_FILES; a PR whose next page fails keeps the paths read. */
async function readFiles(
  run: Exec,
  byId: Map<string, Item>,
  log: (line: string) => void,
): Promise<void> {
  for (const item of byId.values()) {
    const first = (item.raw as Node).files
    if (!first) continue
    const paths = first.nodes.map((f) => f.path)
    let page = first.pageInfo
    const [owner = '', name = ''] = (item.fields.repo as string).split('/')
    const number = Number(item.key.split('#')[1])
    try {
      while (page.hasNextPage && paths.length < MAX_FILES) {
        const next = await graphql<{ repository: { pullRequest: { files: Files } } }>(
          run,
          filesQuery,
          { owner, name, number, after: page.endCursor },
        )
        paths.push(...next.repository.pullRequest.files.nodes.map((f) => f.path))
        page = next.repository.pullRequest.files.pageInfo
      }
    } catch (e) {
      log(`github: couldn't read every file of ${item.key}: ${(e as Error).message}`)
    }
    item.fields.files = paths.slice(0, MAX_FILES)
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
      unresolved_threads: node.reviewThreads?.nodes.filter((t) => !t.isResolved).length ?? 0,
      my_unresolved_threads: 0,
      review_requested: false,
      ...(node.additions !== undefined && {
        changed_lines: node.additions + (node.deletions ?? 0),
      }),
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
    comments: node.comments.nodes.filter(isTrusted).map(toComment),
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
  head: pr.headRefOid,
  ours: isOurs(pr.body),
  mine: pr.viewerDidAuthor,
  trusted: pr.viewerDidAuthor || TRUSTED.includes(pr.authorAssociation),
  fork: pr.isCrossRepository,
})

/** You, an app installed on the repo, or someone with write access or org membership. */
const isTrusted = (c: By) =>
  c.author !== null &&
  (c.viewerDidAuthor || c.author.__typename === 'Bot' || TRUSTED.includes(c.authorAssociation))

const startedByTrusted = (t: { comments: Nodes<By> }) => {
  const first = t.comments.nodes[0]
  return first !== undefined && isTrusted(first)
}

/** Where text from someone else was left out, so the agent and you know. */
const hiddenNote = (count: number, one: string, many: string) =>
  count
    ? `\n_Hidden: ${count} ${count > 1 ? many : one} from outside the repo's owners, members and collaborators._\n`
    : ''

const toComment = (c: Comment) => ({
  author: c.author?.login ?? 'ghost',
  body: c.body,
  at: c.createdAt,
  ...(c.viewerDidAuthor && { mine: true as const }),
})

function checkState(state: string | undefined): string | undefined {
  if (state === 'SUCCESS') return 'passing'
  if (state === 'FAILURE' || state === 'ERROR') return 'failing'
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
}

function itemMarkdown(item: Item): string {
  const comments = item.comments.map(commentMarkdown)
  const hidden = (item.raw as Node).comments.nodes.length - comments.length
  return [
    `# ${item.title}\n\n${item.url}\n\n${item.description}\n`,
    ...(comments.length || hidden ? ['\n## Comments\n', ...comments] : []),
    hiddenNote(hidden, 'comment', 'comments'),
  ].join('')
}

function reviewsMarkdown(pr: PrDetails): string {
  const written = pr.reviews.nodes.filter((r) => r.body.trim())
  if (!written.length) return ''
  const reviews = written.filter(isTrusted)
  const shown = reviews.map(
    (r) => `\n### ${r.author?.login}, ${r.state}, ${r.submittedAt}\n\n${r.body}\n`,
  )
  return `\n## Reviews\n${shown.join('')}${hiddenNote(written.length - reviews.length, 'review', 'reviews')}`
}

/** Unresolved threads grouped by title (a comment's first line), since bot findings repeat per run. */
function threadsMarkdown(threads: Thread[]): string {
  const unresolved = threads.filter((t) => !t.isResolved)
  const visible = unresolved.filter(startedByTrusted)
  const note = hiddenNote(
    unresolved.length - visible.length,
    'unresolved thread',
    'unresolved threads',
  )
  const groups = new Map<string, Thread[]>()
  for (const t of visible) {
    const title = t.comments.nodes[0]?.body.trim().split('\n')[0] ?? ''
    groups.set(title, [...(groups.get(title) ?? []), t])
  }
  if (!groups.size) return `No unresolved review threads.\n${note}`
  const sections = [...groups].map(([title, copies]) => {
    const where = copies.map((t) => `- ${t.path}:${t.line ?? '?'} ${t.comments.nodes[0]?.url}`)
    const comments = (copies[0] as Thread).comments.nodes
    const discussion = comments
      .filter(isTrusted)
      .map((c) => `**${c.author?.login}**, ${c.createdAt}:\n\n${c.body}\n`)
    const replies = hiddenNote(comments.length - discussion.length, 'reply', 'replies')
    return `## ${title}\n\n${copies.length} unresolved ${copies.length > 1 ? 'copies' : 'copy'}:\n${where.join('\n')}\n\n${discussion.join('\n')}${replies}`
  })
  return sections.join('\n') + note
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
