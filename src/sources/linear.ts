import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Ctx, Item, Source } from '../core/types.js'
import { taskMarkdown } from './asana.js'

const config = z
  .strictObject({
    team_repos: z
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

const API = 'https://api.linear.app/graphql'

const issuesQuery = `query Issues($after: String) {
  viewer {
    assignedIssues(first: 50, after: $after, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes {
        id identifier title description url priorityLabel createdAt updatedAt
        assignee { name }
        state { name }
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
      nodes { body createdAt user { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

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
  assignee: { name: string } | null
  state: { name: string }
  team: { key: string }
  project: { name: string } | null
  labels: { nodes: { name: string }[] }
  inverseRelations: { nodes: { type: string; issue: { state: { type: string } } }[] }
}
interface Comment {
  body: string
  createdAt: string
  user: { name: string } | null
}
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
      state: z.string(),
      labels: z.string(),
      priority: z.string(),
      blocked: z.boolean(),
      project: z.string(),
      repo: z.string(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
    },
    secrets: (cfg) => [cfg.token_env],

    /** My assigned issues that are neither completed nor canceled, with their comments. */
    async items(cfg, ctx) {
      const token = tokenFrom(cfg, ctx)
      const issues = await all(
        issuesQuery,
        {},
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
        items.push(toItem(issue, comments, cfg.team_repos))
      }
      return items
    },

    /** Writes issue.md: description, fields and comments. */
    async prefetch(item, dir) {
      await writeFile(join(dir, 'issue.md'), taskMarkdown(item))
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
        config: Object.keys(repos).length > 0 ? { team_repos: repos } : {},
        values: {
          team: teams.map((t) => t.key),
          state: [...new Set(teams.flatMap((t) => t.states.nodes.map((s) => s.name)))],
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

function toItem(issue: Issue, comments: Comment[], teamRepos: Config['team_repos'] = {}): Item {
  const labels = issue.labels.nodes.map((l) => l.name)
  const repo = teamRepos[issue.team.key]
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
      .map((c) => ({ author: c.user?.name ?? 'unknown', body: c.body, at: c.createdAt }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    linkedPrs: [],
    fields: {
      team: issue.team.key,
      state: issue.state.name,
      labels,
      priority: issue.priorityLabel,
      blocked: issue.inverseRelations.nodes.some(
        (r) => r.type === 'blocks' && !['completed', 'canceled'].includes(r.issue.state.type),
      ),
      ...(issue.project && { project: issue.project.name }),
      ...(repo && { repo }),
      created: issue.createdAt,
      updated: issue.updatedAt,
    },
    raw: issue,
  }
}
