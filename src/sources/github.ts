import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { commentMarkdown } from '../core/comments.js'
import { isOurs, leftIn, threadBody, threadOf } from '../core/footer.js'
import { globToRegExp } from '../core/glob.js'
import type { Item, Thread as ItemThread, PrRef, Source, ThreadHost } from '../core/types.js'
import { type Check, checkContexts, checkResult } from '../forge/checks.js'
import { type Exec, exec, graphql, onHost } from '../forge/gh.js'
import { EDITED, type Edited, notYours } from '../forge/github.js'

const config = z
  .strictObject({
    repos: z.array(z.string()).min(1).describe('Repos to read, owner/name; * globs, e.g. acme/*'),
    host: z
      .string()
      .regex(/^[^/\s]+$/, 'host only, no scheme or path')
      .optional()
      .describe('GitHub Enterprise host, e.g. github.acme.com; github.com by default'),
    user: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/, 'expected a GitHub login')
      .optional()
      .describe(
        "The gh account awaywork acts as, e.g. octocat: its `gh auth token` becomes GH_TOKEN (GH_ENTERPRISE_TOKEN with a host) for everything awaywork does on GitHub; default gh's active account. A token already in the environment wins",
      ),
    search: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Extra GitHub search qualifiers, each ANDed with is:open archived:false (and with is:closed when a rule reads finished items), e.g. label:awaywork or mentions:@me; items they find are neither mine nor review-requested',
      ),
  })
  .describe(
    'My PRs, PRs awaiting my review and issues assigned to me, plus any extra searches; also the forge',
  )
type Config = z.infer<typeof config>

const PAGE = 100
/** Finished PRs come in pages this small: a page of 100 with their files timed out on GitHub. */
const FINISHED_PAGE = 50
/** GitHub search returns no result past this many, however many pages. */
const SEARCH_CAP = 1000
const LOG_TAIL = 200
/** Paths read per PR: a rule routes on where a change lands, and a huge one is huge wherever it lands. */
const MAX_FILES = 500
/** Author associations with write access or org membership; the rest can be anyone. */
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR']
const BY = 'author { login __typename } authorAssociation viewerDidAuthor'
const COMMENTS = `pageInfo { hasPreviousPage startCursor } nodes { ${BY} body createdAt editor { login } }`

const common = `
  id number title body url state createdAt updatedAt closedAt
  repository { nameWithOwner }
  author { login } authorAssociation
  assignees(first: 10) { nodes { login } }
  labels(first: 20) { nodes { name } }
  comments(last: 50) { ${COMMENTS} }`

const searchQuery = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { ${common} viewerDidAuthor
        closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
          nodes { number url isDraft headRefName headRefOid baseRefName baseRef { target { oid } } isCrossRepository body ${EDITED} authorAssociation repository { nameWithOwner } }
        }
      }
      ... on PullRequest { ${common}
        isDraft headRefName headRefOid baseRefName baseRef { target { oid } } isCrossRepository viewerDidAuthor editor { login }
        additions deletions mergeable
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

/** The commits each PR's base has that its head doesn't, which `headRef.compare` counts as `aheadBy`. */
const behindQuery = (prs: { id: string; base: string }[]) => `{
  ${prs.map((p, i) => `pr${i}: node(id: ${JSON.stringify(p.id)}) { ... on PullRequest { id headRef { compare(headRef: ${JSON.stringify(p.base)}) { aheadBy } } } }`).join('\n  ')}
}`

/** An issue's or PR's comments before `before`: a plan awaywork posted can sit far up a long thread. */
const commentsQuery = `query($id: ID!, $before: String!) {
  node(id: $id) {
    ... on Issue { comments(last: ${PAGE}, before: $before) { ${COMMENTS} } }
    ... on PullRequest { comments(last: ${PAGE}, before: $before) { ${COMMENTS} } }
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
      commits(last: 1) { nodes { commit { ${checkContexts} } } }
    }
  }
}`

/** Your open issues in a repo, a page at a time: the threads awaywork opened are among them. */
const openedQuery = `query($owner: String!, $name: String!, $login: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, states: OPEN, filterBy: { createdBy: $login }) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename ${common} }
    }
  }
}`

/** An issue or PR right before and after a write, and who you are. */
const writeQuery = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { updatedAt assignees(first: 10) { nodes { login } } }
      ... on PullRequest { updatedAt }
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
type Comment = By & { body: string; createdAt: string; editor?: { login: string } | null }
type Comments = Nodes<Comment> & {
  pageInfo?: { hasPreviousPage: boolean; startCursor: string | null }
}
type PrLink = Edited & {
  number: number
  url: string
  isDraft: boolean
  headRefName: string
  headRefOid: string
  baseRefName?: string
  baseRef?: { target: { oid: string } | null } | null
  isCrossRepository: boolean
  body: string
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
  closedAt: string | null
  author: Login
  assignees: Nodes<{ login: string }>
  labels: Nodes<{ name: string }>
  comments: Comments
  closedByPullRequestsReferences?: Nodes<PrLink>
  additions?: number
  deletions?: number
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
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
interface PrDetails {
  reviews: Nodes<By & { state: string; body: string; submittedAt: string }>
  reviewThreads: Nodes<Thread>
  commits: Nodes<{ commit: { statusCheckRollup: { contexts: Nodes<Check> } | null } }>
}

/** A search and the fields every item it finds gets; a finished one is bounded by a date. */
type Query = { q: string; fields: Record<string, boolean>; finished?: boolean }

const searches: Query[] = [
  { q: 'is:pr is:open archived:false author:@me', fields: { mine: true } },
  { q: 'is:pr is:open archived:false review-requested:@me', fields: { review_requested: true } },
  { q: 'is:issue is:open archived:false assignee:@me', fields: { mine: true } },
]

const finishedSearches: Query[] = [
  { q: 'is:pr is:closed archived:false author:@me', fields: { mine: true } },
  { q: 'is:issue is:closed archived:false assignee:@me', fields: { mine: true } },
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
      conflicts: z.boolean(),
      behind: z.number().int().min(0),
      my_unresolved_threads: z.number().int().min(0),
      review_requested: z.boolean(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
    },
    secrets: () => [],

    /** My open PRs, PRs awaiting my review and issues assigned to me, in the configured repos; since `since`, my PRs and issues closed too. */
    async items(cfg, ctx, since) {
      const run = onHost(base, cfg.host)
      const inScope = (repo: string) => cfg.repos.some((glob) => globToRegExp(glob).test(repo))
      const byId = new Map<string, Item>()
      const extra = (cfg.search ?? []).map((q) => ({
        q: `is:open archived:false ${q}`,
        fields: {},
      }))
      // A merged PR is closed too, at the time it merged; the day bounds the pages to read.
      const closed = since
        ? [
            ...finishedSearches,
            ...(cfg.search ?? []).map((q) => ({ q: `is:closed archived:false ${q}`, fields: {} })),
          ].map(({ q, fields }) => ({
            q: `${q} closed:>=${since.toISOString().slice(0, 10)}`,
            fields,
            finished: true,
          }))
        : []
      const queries: Query[] = [...searches, ...extra, ...closed]
      for (const { q, fields, finished } of queries) {
        const nodes = await (finished ? searchAll : searchFirst)(run, q, ctx.log)
        for (const node of nodes) {
          if (!inScope(node.repository.nameWithOwner)) continue
          // Your thread for another item isn't an item: a plan rule would take it too.
          if (node.__typename === 'Issue' && node.viewerDidAuthor && threadOf(node.body)) continue
          const item = byId.get(node.id) ?? toItem(node)
          Object.assign(item.fields, fields)
          if (item.fields.mine) item.mine = true
          byId.set(node.id, item)
        }
      }
      await countThreads(run, byId, ctx.log)
      await countBehind(run, byId, ctx.log)
      await readFiles(run, byId, ctx.log)
      await readComments(run, byId, ctx.log)
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

    /** The gh login and its orgs. */
    discover: (cfg) => account(onHost(base, cfg.host)),

    /** Comments on the issue or PR, or moves it by adding the label `to`, which GitHub makes when the repo has none. */
    async write(_cfg, item, write) {
      const run = onHost(base, URL.canParse(item.url) ? new URL(item.url).host : undefined)
      const repo = item.fields.repo as string
      const [owner = '', name = ''] = repo.split('/')
      const number = Number(item.key.split('#')[1])
      const read = async () => {
        const { viewer, repository } = await graphql<{
          viewer: { login: string }
          repository: {
            issueOrPullRequest: { updatedAt: string; assignees?: Nodes<{ login: string }> }
          }
        }>(run, writeQuery, { owner, name, number })
        return { viewer: viewer.login, ...repository.issueOrPullRequest }
      }
      const before = await read()
      // Your PR stays yours, its author can't change; an issue is yours while it's assigned to you.
      if (item.type !== 'pr' && !before.assignees?.nodes.some((a) => a.login === before.viewer))
        throw new Error(`${item.key} is no longer yours: not assigned to you`)
      // A PR is an issue too: its labels and conversation comments go through the issues API.
      const path = `repos/${repo}/issues/${number}`
      let url = ''
      if (write.op === 'comment')
        url = (
          await run('gh', [
            'api',
            `${path}/comments`,
            '-f',
            `body=${write.body}`,
            '--jq',
            '.html_url',
          ])
        ).trim()
      else await run('gh', ['api', `${path}/labels`, '-f', `labels[]=${write.to}`])
      return { before: before.updatedAt, after: (await read()).updatedAt, ...(url && { url }) }
    },
  }
}

export const github = githubSource()

/** The forge's thread issues on GitHub, read and written as you through `gh`: listed, not searched, so one opened a minute ago is found. */
export function githubThreads(base: Exec = exec, host?: string): ThreadHost {
  const run = onHost(base, host)
  let login: Promise<string> | undefined
  const viewer = () => {
    login ??= run('gh', ['api', 'user', '--jq', '.login']).then((l) => l.trim())
    return login
  }
  const issuePath = (thread: ItemThread) => `repos/${thread.key.replace('#', '/issues/')}`
  const comment = async (thread: ItemThread, body: string) =>
    (
      await run('gh', [
        'api',
        `${issuePath(thread)}/comments`,
        '-f',
        `body=${body}`,
        '--jq',
        '.html_url',
      ])
    ).trim()
  return {
    byRepo: true,
    async threads(repo) {
      if (!repo) return []
      const [owner = '', name = ''] = repo.split('/')
      const vars = { owner, name, login: await viewer(), first: PAGE }
      const byId = new Map<string, Item>()
      let after: string | undefined
      do {
        const { repository } = await graphql<{
          repository: { issues: { pageInfo: Search['search']['pageInfo']; nodes: Node[] } }
        }>(run, openedQuery, { ...vars, ...(after && { after }) })
        for (const node of repository.issues.nodes)
          if (threadOf(node.body)) byId.set(node.id, toItem(node))
        const page = repository.issues.pageInfo
        after = page.hasNextPage ? page.endCursor : undefined
      } while (after)
      // A thread missing its older comments could miss the plan it waits on.
      const failed: string[] = []
      await readComments(run, byId, (line) => failed.push(line))
      if (failed[0]) throw new Error(failed[0])
      return [...byId.values()].map((issue) => ({
        item: threadOf(issue.description) as string,
        thread: { host: 'github', key: issue.key, url: issue.url },
        comments: issue.comments,
      }))
    },
    async openThread(repo, item) {
      if (!repo) throw new Error(`${item.key} has no repo to open its thread in`)
      const opened = await run('gh', [
        'api',
        `repos/${repo}/issues`,
        '-f',
        `title=${item.key}: ${item.title}`,
        '-f',
        `body=${threadBody(item)}`,
        '-f',
        `assignees[]=${await viewer()}`,
        '--jq',
        '[.number, .html_url] | @tsv',
      ])
      const [number = '', url = ''] = opened.trim().split('\t')
      return { host: 'github', key: `${repo}#${number}`, url }
    },
    threadComment: comment,
    async closeThread(thread, body) {
      await comment(thread, body)
      await run('gh', [
        'api',
        '-X',
        'PATCH',
        issuePath(thread),
        '-f',
        'state=closed',
        '-f',
        'state_reason=completed',
      ])
    },
  }
}

async function account(run: Exec) {
  const login = (await run('gh', ['api', 'user', '--jq', '.login'])).trim()
  const orgs = (await run('gh', ['api', 'user/orgs', '--jq', '.[].login']))
    .split('\n')
    .filter(Boolean)
  return { login, orgs }
}

type Search = {
  search: {
    issueCount: number
    pageInfo: { hasNextPage: boolean; endCursor: string }
    nodes: Node[]
  }
}

/** A search's first page, saying when there was more. */
async function searchFirst(run: Exec, q: string, log: (line: string) => void): Promise<Node[]> {
  const { search } = await graphql<Search>(run, searchQuery, { q, first: PAGE })
  if (search.issueCount > PAGE)
    log(`github: "${q}" found ${search.issueCount}, reading the first ${PAGE}`)
  return search.nodes
}

/** Every page of a search bounded by a date, up to GitHub's cap, saying when it hit it. */
async function searchAll(run: Exec, q: string, log: (line: string) => void): Promise<Node[]> {
  const nodes: Node[] = []
  let after: string | undefined
  do {
    const { search } = await graphql<Search>(run, searchQuery, {
      q,
      first: FINISHED_PAGE,
      ...(after && { after }),
    })
    if (!after && search.issueCount > SEARCH_CAP)
      log(`github: "${q}" found ${search.issueCount}, GitHub returns the first ${SEARCH_CAP}`)
    nodes.push(...search.nodes)
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : undefined
  } while (after)
  return nodes
}

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

/**
 * Sets `behind` on your open PRs in the repo, in one query per page; a fork's head isn't in the repo,
 * so it gets none, and neither does a page that fails, or a PR whose branch is gone.
 */
async function countBehind(
  run: Exec,
  byId: Map<string, Item>,
  log: (line: string) => void,
): Promise<void> {
  const prs = [...byId]
    .map(([id, item]) => ({ id, node: item.raw as Node }))
    .filter(({ node }) => node.viewerDidAuthor && node.state === 'OPEN' && !node.isCrossRepository)
    .flatMap(({ id, node }) => (node.baseRefName ? [{ id, base: node.baseRefName }] : []))
  for (let i = 0; i < prs.length; i += PAGE) {
    const page = await graphql<
      Record<string, { id: string; headRef: { compare: { aheadBy: number } | null } | null } | null>
    >(run, behindQuery(prs.slice(i, i + PAGE)), {}).catch((e: Error) => {
      log(`github: couldn't read how far your PRs are behind their base: ${e.message}`)
    })
    for (const node of Object.values(page ?? {})) {
      const item = node && byId.get(node.id)
      const behind = node?.headRef?.compare?.aheadBy
      if (item && behind !== undefined) item.fields.behind = behind
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

/** Reads each item's comments back past the last 50, so its whole thread is there; one whose page fails keeps those read. */
async function readComments(
  run: Exec,
  byId: Map<string, Item>,
  log: (line: string) => void,
): Promise<void> {
  for (const [id, item] of byId) {
    const comments = (item.raw as Node).comments
    let page = comments.pageInfo
    try {
      while (page?.hasPreviousPage && page.startCursor) {
        const { node } = await graphql<{ node: { comments: Comments } }>(run, commentsQuery, {
          id,
          before: page.startCursor,
        })
        comments.nodes.unshift(...node.comments.nodes)
        page = node.comments.pageInfo
      }
    } catch (e) {
      log(`github: couldn't read every comment of ${item.key}: ${(e as Error).message}`)
    }
    item.comments = comments.nodes.filter(isTrusted).map(toComment)
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
    state: node.state.toLowerCase(),
    ...(node.closedAt && { closed: node.closedAt }),
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
      ...(node.mergeable === 'CONFLICTING' && { conflicts: true }),
      ...(node.mergeable === 'MERGEABLE' && { conflicts: false }),
    })
  }
  // A finished item links no PR: it never joins an open PR's unit, nor works on a branch that may be gone.
  const links =
    node.state !== 'OPEN' ? [] : isPr ? [node] : (node.closedByPullRequestsReferences?.nodes ?? [])
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
    ...(isPr && !notYours(node) && { bodyMine: true as const }),
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
  ...(pr.baseRefName && { into: pr.baseRefName }),
  ...(pr.baseRef?.target && { intoHead: pr.baseRef.target.oid }),
  ours: isOurs(pr.body),
  ...leftIn(pr.body, pr.isDraft, notYours(pr)),
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
  // A collaborator can edit your comment; then its text isn't yours.
  ...(c.viewerDidAuthor &&
    (!c.editor || c.editor.login === c.author?.login) && { mine: true as const }),
  ...(c.author?.__typename === 'Bot' && { bot: true as const }),
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
  const failed = checks.filter((c) => checkResult(c)[1] === 'failing')
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
