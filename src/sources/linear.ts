import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Ctx, Item, Source } from '../core/types.js'
import { taskMarkdown } from './asana.js'

const config = z
  .strictObject({
    repo_map: z
      .record(z.string(), z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .optional()
      .describe("Team key -> owner/repo where its issues' code lives"),
    token_env: z
      .string()
      .default('LINEAR_API_KEY')
      .describe('Env var holding the Linear personal API key'),
  })
  .describe('My open Linear issues')
type Config = z.infer<typeof config>

export const API = 'https://api.linear.app/graphql'

const FINISHED = ['completed', 'canceled']
const OPEN = { state: { type: { nin: FINISHED } } }

const issuesQuery = `query Issues($after: String, $filter: IssueFilter, $archived: Boolean) {
  viewer {
    assignedIssues(first: 50, after: $after, filter: $filter, includeArchived: $archived) {
      nodes {
        id identifier title description url priorityLabel createdAt updatedAt completedAt canceledAt
        assignee { name }
        state { name type }
        team { key }
        project { name }
        labels { nodes { name } }
        inverseRelations(first: 10) { nodes { type issue { state { type } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const commentsQuery = `query Comments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { body createdAt user { name isMe } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const commentMutation = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`

const statesQuery = `query States($id: String!) {
  issue(id: $id) { updatedAt assignee { isMe } team { states(first: 100) { nodes { id name } } } }
}`

const moveMutation = `mutation IssueMove($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`

const updatedQuery = `query Updated($id: String!) { issue(id: $id) { updatedAt assignee { isMe } } }`

const teamsQuery = `query Teams($after: String) {
  teams(first: 50, after: $after) {
    nodes { key name states { nodes { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`

interface Issue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priorityLabel: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  canceledAt: string | null
  assignee: { name: string } | null
  state: { name: string; type: string }
  team: { key: string }
  project: { name: string } | null
  labels: { nodes: { name: string }[] }
  inverseRelations: { nodes: { type: string; issue: { state: { type: string } } }[] }
}
interface Comment {
  body: string
  createdAt: string
  user: { name: string; isMe: boolean } | null
}
/** An issue as read right before a write. */
type Read = { updatedAt: string; assignee: { isMe: boolean } | null }
interface Team {
  key: string
  name: string
  states: { nodes: { name: string }[] }
}
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

export function linearSource(http: typeof fetch = fetch): Source<Config> {
  async function graphql<T>(query: string, variables: object, token: string): Promise<T> {
    // A personal API key goes in Authorization as is; only OAuth tokens take `Bearer`.
    const res = await http(API, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.errors?.length)
      throw new Error(`Linear API: ${res.status} ${body.errors?.[0]?.message ?? res.statusText}`)
    return body.data as T
  }

  /** Every node of a connection, following `pageInfo.endCursor`. */
  async function all<D, T>(
    query: string,
    variables: object,
    token: string,
    connection: (data: D) => Connection<T>,
  ) {
    const nodes: T[] = []
    let after: string | null = null
    do {
      const page = connection(await graphql<D>(query, { ...variables, after }, token))
      nodes.push(...page.nodes)
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (after)
    return nodes
  }

  return {
    id: 'linear',
    configSchema: config,
    // A non-closing magic word: merging leaves the issue's state to the team's workflow.
    link: 'Part of {key}',
    fields: {
      team: z.string(),
      status: z.string(),
      labels: z.string(),
      priority: z.string(),
      blocked: z.boolean(),
      project: z.string(),
      repo: z.string(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
    },
    secrets: (cfg) => [cfg.token_env],

    /** My assigned issues that are neither completed nor canceled, or were since `since`, with their comments. */
    async items(cfg, ctx, since) {
      const token = tokenFrom(cfg, ctx)
      const after = since && { gte: since.toISOString() }
      // Linear archives finished issues after a while; reading those keeps archived open ones out.
      const filter = after
        ? {
            or: [
              { ...OPEN, archivedAt: { null: true } },
              { completedAt: after },
              { canceledAt: after },
            ],
          }
        : OPEN
      const issues = await all(
        issuesQuery,
        { filter, ...(after && { archived: true }) },
        token,
        (d: { viewer: { assignedIssues: Connection<Issue> } }) => d.viewer.assignedIssues,
      )
      const items: Item[] = []
      for (const issue of issues) {
        const comments = await all(
          commentsQuery,
          { id: issue.id },
          token,
          (d: { issue: { comments: Connection<Comment> } }) => d.issue.comments,
        )
        items.push(toItem(issue, comments, cfg.repo_map))
      }
      return items
    },

    /** Writes item.md: description, fields and comments. */
    async prefetch(item, dir) {
      await writeFile(join(dir, 'item.md'), taskMarkdown(item))
    },

    /** Comments on the issue, or moves it to the workflow state of its team named `to`. */
    async write(cfg, item, write, ctx) {
      const token = tokenFrom(cfg, ctx)
      const id = item.id
      const read = async () => (await graphql<{ issue: Read }>(updatedQuery, { id }, token)).issue
      const yours = (issue: Read) => {
        if (!issue.assignee?.isMe)
          throw new Error(`${item.key} is no longer yours: not assigned to you`)
        return issue.updatedAt
      }
      let before: string
      if (write.op === 'comment') {
        before = yours(await read())
        await graphql(commentMutation, { issueId: id, body: write.body }, token)
      } else {
        const { issue } = await graphql<{
          issue: Read & { team: { states: { nodes: { id: string; name: string }[] } } }
        }>(statesQuery, { id }, token)
        before = yours(issue)
        const states = issue.team.states.nodes
        const state = states.find((s) => s.name.toLowerCase() === write.to.toLowerCase())
        if (!state)
          throw new Error(
            `${item.key}'s team has no state "${write.to}", only ${states.map((s) => `"${s.name}"`).join(', ')}`,
          )
        await graphql(moveMutation, { id, stateId: state.id }, token)
      }
      return { before, after: (await read()).updatedAt }
    },

    /** Maps teams to repos and lists the account's real team keys and workflow state names. */
    async init(ask, ctx) {
      const token =
        ctx.env.LINEAR_API_KEY ||
        (await ask.secret(
          'LINEAR_API_KEY',
          'Linear personal API key (Settings > Account > Security & access)',
        ))
      if (!token) return { config: {} }

      const teams = await all(teamsQuery, {}, token, (d: { teams: Connection<Team> }) => d.teams)
      const picked = await ask.multiselect(
        'Linear teams whose issues have code in a GitHub repo',
        teams.map((t) => ({ value: t.key, label: t.name })),
      )
      const repos: Record<string, string> = {}
      for (const key of picked) {
        const repo = await ask.text(`GitHub repo for issues in ${key} (owner/repo, blank: none)`)
        if (repo.trim()) repos[key] = repo.trim()
      }
      return {
        config: Object.keys(repos).length > 0 ? { repo_map: repos } : {},
        values: {
          team: teams.map((t) => t.key),
          status: [...new Set(teams.flatMap((t) => t.states.nodes.map((s) => s.name)))],
        },
      }
    },
  }
}

export const linear = linearSource()

function tokenFrom(cfg: Config, ctx: Ctx): string {
  const token = ctx.env[cfg.token_env]
  if (!token) throw new Error(`${cfg.token_env} is not set`)
  return token
}

function toItem(issue: Issue, comments: Comment[], repoMap: Config['repo_map'] = {}): Item {
  const labels = issue.labels.nodes.map((l) => l.name)
  const repo = repoMap[issue.team.key]
  const finished = FINISHED.includes(issue.state.type)
  const closed = finished && (issue.completedAt ?? issue.canceledAt)
  return {
    source: 'linear',
    id: issue.id,
    key: issue.identifier,
    type: 'task',
    title: issue.title,
    description: issue.description ?? '',
    url: issue.url,
    status: issue.state.name,
    assignee: issue.assignee?.name,
    reviewers: [],
    labels,
    comments: comments
      .map((c) => ({
        author: c.user?.name ?? 'unknown',
        body: c.body,
        at: c.createdAt,
        ...(c.user?.isMe && { mine: true as const }),
      }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    linkedPrs: [],
    mine: true,
    fields: {
      team: issue.team.key,
      status: issue.state.name,
      labels,
      priority: issue.priorityLabel,
      blocked: issue.inverseRelations.nodes.some(
        (r) => r.type === 'blocks' && !FINISHED.includes(r.issue.state.type),
      ),
      ...(issue.project && { project: issue.project.name }),
      ...(repo && { repo }),
      created: issue.createdAt,
      updated: issue.updatedAt,
      state: finished ? 'closed' : 'open',
      ...(closed && { closed }),
    },
    raw: issue,
  }
}
