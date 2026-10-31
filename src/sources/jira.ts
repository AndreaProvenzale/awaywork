import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { httpError, unsetSecret } from '../core/poll.js'
import type { Ctx, Item, Source } from '../core/types.js'
import { taskMarkdown } from './asana.js'

const config = z
  .strictObject({
    site: z
      .string()
      .regex(/^[\w-]+(\.[\w-]+)+$/)
      .describe('Jira Cloud site host, e.g. acme.atlassian.net'),
    email: z.string().describe('Atlassian account email the API token belongs to'),
    cloud_id: z
      .string()
      .optional()
      .describe('Site cloud id: set for a scoped token, which calls api.atlassian.com'),
    jql: z.string().optional().describe('JQL condition ANDed with my unresolved issues'),
    repo_map: z
      .record(z.string(), z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .optional()
      .describe("Project key -> owner/repo where its issues' code lives"),
    token_env: z
      .string()
      .default('JIRA_API_TOKEN')
      .describe('Env var holding the Atlassian API token'),
  })
  .describe('My unresolved Jira Cloud issues')
type Config = z.infer<typeof config>

const RETRIES = 3
// Jira Cloud's comment limit, which counts the stored ADF rather than the text.
const MAX_COMMENT = 32_767

interface Adf {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: Adf[]
}
interface Field {
  id: string
  name: string
  custom: boolean
}
interface Issue {
  id: string
  key: string
  fields: {
    summary: string
    description: Adf | null
    status: { name: string }
    labels: string[]
    priority: { name: string } | null
    issuetype: { name: string }
    project: { key: string }
    assignee: { displayName: string; accountId?: string } | null
    created: string
    updated: string
    resolutiondate?: string | null
    issuelinks?: {
      type: { name: string }
      inwardIssue?: { fields: { status: { statusCategory: { key: string } } } }
    }[]
    [id: string]: unknown
  }
}
interface Comment {
  author: { displayName: string; accountId?: string; accountType?: string } | null
  updateAuthor?: { accountId?: string } | null
  body: Adf
  created: string
}
interface Project {
  key: string
  name: string
}

export function jiraSource(http: typeof fetch = fetch): Source<Config> {
  /** A call to the REST API, waiting out 429s as `Retry-After` says. */
  async function call<T>(
    cfg: Config,
    token: string,
    path: string,
    body?: object,
    attempt = 1,
  ): Promise<T> {
    const base = cfg.cloud_id
      ? `https://api.atlassian.com/ex/jira/${cfg.cloud_id}`
      : `https://${cfg.site}`
    const res = await http(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    })
    if (res.status === 429 && attempt < RETRIES) {
      await sleep(Number(res.headers.get('retry-after') ?? 60) * 1000)
      return call(cfg, token, path, body, attempt + 1)
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok)
      throw httpError(
        `Jira ${path.split('?')[0]}: ${res.status} ${json.errorMessages?.[0] ?? res.statusText}`,
        res,
      )
    return json as T
  }

  /** Every value of an offset-paged list, following `startAt` until `isLast` or `total`. */
  async function paged<P, T>(
    cfg: Config,
    token: string,
    path: string,
    values: (page: P) => T[],
    done: (page: P, seen: number) => boolean,
  ) {
    const all: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (;;) {
      const page = await call<P>(cfg, token, `${path}${sep}startAt=${all.length}&maxResults=100`)
      const got = values(page)
      all.push(...got)
      if (got.length === 0 || done(page, all.length)) return all
    }
  }

  const projects = (cfg: Config, token: string) =>
    paged(
      cfg,
      token,
      '/rest/api/3/project/search',
      (p: { values: Project[]; isLast: boolean }) => p.values,
      (p) => p.isLast,
    )

  const statuses = async (cfg: Config, token: string) => [
    ...new Set(
      (await call<{ name: string }[]>(cfg, token, '/rest/api/3/status')).map((s) => s.name),
    ),
  ]

  return {
    id: 'jira',
    configSchema: config,
    fields: {
      project: z.string(),
      status: z.string(),
      labels: z.string(),
      priority: z.string(),
      blocked: z.boolean(),
      issuetype: z.string(),
      repo: z.string(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
      'fields.*': z.union([z.string(), z.number()]),
    },
    secrets: (cfg) => [cfg.token_env],

    /** My unresolved issues, and those resolved since `since`, narrowed by the configured JQL, with their comments. */
    async items(cfg, ctx, since) {
      const token = tokenFrom(cfg, ctx)
      const custom = (await call<Field[]>(cfg, token, '/rest/api/3/field')).filter((f) => f.custom)
      const shared = (name: string) => custom.filter((f) => f.name === name).length > 1
      const names = new Map(
        custom.map((f) => [f.id, shared(f.name) ? `${f.name} (${f.id})` : f.name]),
      )
      const resolution = since
        ? `(resolution = Unresolved OR resolved >= -${Math.ceil((Date.now() - since.getTime()) / 60_000)}m)`
        : 'resolution = Unresolved'
      const jql = `assignee = currentUser() AND ${resolution}${cfg.jql ? ` AND (${cfg.jql})` : ''} ORDER BY updated DESC`
      const issues: Issue[] = []
      const tokens = new Set<string>()
      let nextPageToken: string | undefined
      for (;;) {
        const page = await call<{ issues: Issue[]; nextPageToken?: string; isLast?: boolean }>(
          cfg,
          token,
          '/rest/api/3/search/jql',
          { jql, fields: ['*all', '-comment'], maxResults: 100, nextPageToken },
        )
        issues.push(...page.issues)
        nextPageToken = page.nextPageToken
        // Stops on a repeated token too: /search/jql has reported pagination bugs.
        if (page.isLast || page.issues.length === 0 || !nextPageToken || tokens.has(nextPageToken))
          break
        tokens.add(nextPageToken)
      }

      const items: Item[] = []
      for (const issue of issues) {
        const comments = await paged(
          cfg,
          token,
          `/rest/api/3/issue/${issue.id}/comment`,
          (p: { comments: Comment[]; total: number }) => p.comments,
          (p, seen) => seen >= p.total,
        )
        items.push(toItem(issue, comments, names, cfg))
      }
      return items
    },

    /** Writes item.md: description, fields and comments. */
    async prefetch(item, dir) {
      await writeFile(join(dir, 'item.md'), taskMarkdown(item))
    },

    /** Comments on the issue, or moves it through the transition whose target status is named `to`. */
    async write(cfg, item, write, ctx) {
      const token = tokenFrom(cfg, ctx)
      const body = write.op === 'comment' ? textToAdf(write.body) : undefined
      if (body && JSON.stringify(body).length > MAX_COMMENT)
        throw new Error(`the comment is over Jira's ${MAX_COMMENT} characters as ADF`)
      const issue = `/rest/api/3/issue/${item.id}`
      const read = await call<{
        fields: { updated: string; assignee: { accountId?: string } | null }
        transitions?: { id: string; to: { name: string } }[]
      }>(
        cfg,
        token,
        `${issue}?fields=updated,assignee${write.op === 'move' ? '&expand=transitions' : ''}`,
      )
      // Read as assigned to you, so the plan's assignee is you.
      const me = (item.raw as Issue).fields.assignee?.accountId
      if (!me || read.fields.assignee?.accountId !== me)
        throw new Error(`${item.key} is no longer yours: not assigned to you`)
      if (write.op === 'comment') await call(cfg, token, `${issue}/comment`, { body })
      else {
        const transitions = read.transitions ?? []
        const to = transitions.find((t) => t.to.name.toLowerCase() === write.to.toLowerCase())
        if (!to)
          throw new Error(
            `${item.key} has no transition to "${write.to}", only to ${transitions.map((t) => `"${t.to.name}"`).join(', ') || 'none'}`,
          )
        await call(cfg, token, `${issue}/transitions`, { transition: { id: to.id } })
      }
      const { fields } = await call<{ fields: { updated: string } }>(
        cfg,
        token,
        `${issue}?fields=updated`,
      )
      return { before: iso(read.fields.updated), after: iso(fields.updated) }
    },

    /** Finds the site, maps projects to repos and lists the site's real status names. */
    async init(ask, ctx) {
      const site = (await ask.text('Jira Cloud site', { placeholder: 'acme.atlassian.net' }))
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
      const email = (await ask.text('Atlassian account email')).trim()
      if (!site || !email) throw new Error('Jira needs a site and an email')
      const token =
        ctx.env.JIRA_API_TOKEN ||
        (await ask.secret(
          'JIRA_API_TOKEN',
          'Atlassian API token, scoped to read:jira-work (id.atlassian.com > Security > API tokens)',
        ))
      if (!token) return { config: { site, email } }

      let cfg: Config = { site, email, token_env: 'JIRA_API_TOKEN' }
      if (await ask.confirm('Is the token scoped (created "with scopes")?', true)) {
        const tenant = await http(`https://${site}/_edge/tenant_info`)
        if (!tenant.ok) throw new Error(`no Jira Cloud site at ${site}: ${tenant.status}`)
        cfg = { ...cfg, cloud_id: ((await tenant.json()) as { cloudId: string }).cloudId }
      }
      const found = await projects(cfg, token)
      const picked = await ask.multiselect(
        'Jira projects whose issues have code in a GitHub repo',
        found.map((p) => ({ value: p.key, label: p.name })),
      )
      const repos: Record<string, string> = {}
      for (const key of picked) {
        const repo = await ask.text(`GitHub repo for issues in ${key} (owner/repo, blank: none)`)
        if (repo.trim()) repos[key] = repo.trim()
      }
      return {
        config: {
          site,
          email,
          ...(cfg.cloud_id && { cloud_id: cfg.cloud_id }),
          ...(Object.keys(repos).length > 0 && { repo_map: repos }),
        },
        values: {
          project: found.map((p) => p.key),
          status: await statuses(cfg, token),
        },
      }
    },

    /** The projects and the site's statuses; the site and email come from the config alone. */
    async discover(partial, ctx) {
      const { site, email } = partial
      if (!site || !email) throw new Error('add sources.jira { site, email } to the config first')
      const cfg = {
        ...partial,
        site,
        email,
        token_env: config.shape.token_env.parse(partial.token_env),
      }
      const token = tokenFrom(cfg, ctx)
      // Jira takes wrong credentials as anonymous, who sees no projects but can't read /myself.
      await call(cfg, token, '/rest/api/3/myself')
      return {
        projects: (await projects(cfg, token)).map((p) => ({ key: p.key, name: p.name })),
        statuses: await statuses(cfg, token),
      }
    },
  }
}

export const jira = jiraSource()

function tokenFrom(cfg: Config, ctx: Ctx): string {
  const token = ctx.env[cfg.token_env]
  if (!token) throw unsetSecret(cfg.token_env)
  return token
}

function toItem(issue: Issue, comments: Comment[], names: Map<string, string>, cfg: Config): Item {
  const f = issue.fields
  // Issues are read as assigned to you: your comments are the assignee's that nobody else edited last.
  const me = f.assignee?.accountId
  const repo = cfg.repo_map?.[f.project.key]
  const custom = [...names].flatMap(([id, name]) => {
    const value = fieldValue(f[id])
    return value === undefined ? [] : [[`fields.${name}`, value] as const]
  })
  return {
    source: 'jira',
    id: issue.id,
    key: issue.key,
    type: 'task',
    title: f.summary,
    description: f.description ? adfToMarkdown(f.description) : '',
    url: `https://${cfg.site}/browse/${issue.key}`,
    status: f.status.name,
    assignee: f.assignee?.displayName,
    reviewers: [],
    labels: f.labels,
    comments: comments
      .map((c) => ({
        author: c.author?.displayName ?? 'unknown',
        body: adfToMarkdown(c.body),
        at: iso(c.created),
        ...(!!me &&
          c.author?.accountId === me &&
          (c.updateAuthor?.accountId ?? me) === me && { mine: true as const }),
        ...(c.author?.accountType === 'app' && { bot: true as const }),
      }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    linkedPrs: [],
    mine: true,
    fields: {
      project: f.project.key,
      status: f.status.name,
      labels: f.labels,
      ...(f.priority && { priority: f.priority.name }),
      issuetype: f.issuetype.name,
      // On a Blocks link the inward issue is the one blocking this issue.
      blocked: (f.issuelinks ?? []).some(
        (l) =>
          l.type.name === 'Blocks' &&
          l.inwardIssue &&
          l.inwardIssue.fields.status.statusCategory.key !== 'done',
      ),
      ...(repo && { repo }),
      created: iso(f.created),
      updated: iso(f.updated),
      state: f.resolutiondate ? 'closed' : 'open',
      ...(f.resolutiondate && { closed: iso(f.resolutiondate) }),
      ...Object.fromEntries(custom),
    },
    raw: issue,
  }
}

// Jira writes `+0000` offsets, which ISO datetime parsers reject.
const iso = (at: string) => new Date(at).toISOString()

/** A custom field's value as a scalar or a list of them; rich text and unknown shapes are left out. */
function fieldValue(value: unknown): string | number | string[] | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (Array.isArray(value)) {
    const values = value.map(fieldValue).filter((v) => typeof v === 'string')
    return values.length > 0 ? values : undefined
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    const named = v.value ?? v.name ?? v.displayName
    return typeof named === 'string' ? named : undefined
  }
  return undefined
}

/** Text as ADF, a paragraph per block between blank lines, its line breaks kept; nothing in it is parsed as Markdown. */
export function textToAdf(text: string): Adf & { version: 1 } {
  const content = text.split(/\n\s*\n/).map((block) => ({
    type: 'paragraph',
    content: block
      .split('\n')
      .flatMap((line, i): Adf[] => [
        ...(i > 0 ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]),
  }))
  return { type: 'doc', version: 1, content }
}

/** Atlassian Document Format as minimal Markdown: text, marks, lists, tasks, tables, code, quotes, mentions. */
export function adfToMarkdown(node: Adf): string {
  const inner = (sep = '') => (node.content ?? []).map(adfToMarkdown).join(sep)
  switch (node.type) {
    case 'text':
      return (node.marks ?? []).reduce((text, mark) => {
        if (mark.type === 'strong') return `**${text}**`
        if (mark.type === 'em') return `_${text}_`
        if (mark.type === 'code') return `\`${text}\``
        if (mark.type === 'link') return `[${text}](${mark.attrs?.href})`
        return text
      }, node.text ?? '')
    case 'hardBreak':
      return '\n'
    case 'mention':
    case 'emoji':
    case 'status':
      return String(node.attrs?.text ?? '')
    case 'date': {
      const at = new Date(Number(node.attrs?.timestamp))
      return Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 10)
    }
    case 'inlineCard':
      return String(node.attrs?.url ?? '')
    case 'rule':
      return '---\n\n'
    case 'paragraph':
      return `${inner()}\n\n`
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inner()}\n\n`
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language ?? ''}\n${inner()}\n\`\`\`\n\n`
    case 'blockquote':
      return `${inner()
        .trimEnd()
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n')}\n\n`
    case 'bulletList':
    case 'orderedList':
      return `${(node.content ?? [])
        .map((item, i) => {
          const bullet = node.type === 'bulletList' ? '- ' : `${i + 1}. `
          const text = adfToMarkdown(item).trimEnd().replace(/\n\n/g, '\n')
          return bullet + text.replace(/\n/g, `\n${' '.repeat(bullet.length)}`)
        })
        .join('\n')}\n\n`
    case 'taskList':
      return `${inner()}\n`
    case 'taskItem':
      return `- [${node.attrs?.state === 'DONE' ? 'x' : ' '}] ${inner()}\n`
    case 'table': {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) =>
          adfToMarkdown(cell)
            .trim()
            .replace(/\s*\n+\s*/g, ' ')
            .replaceAll('|', '\\|'),
        ),
      )
      const line = (cells: string[]) => `| ${cells.join(' | ')} |`
      const [head = [], ...body] = rows
      return `${[line(head), line(head.map(() => '---')), ...body.map(line)].join('\n')}\n\n`
    }
    case 'doc':
      return inner().trimEnd()
    default:
      return inner()
  }
}
