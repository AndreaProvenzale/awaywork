import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { Ctx, Item, Source } from '../core/types.js'

const config = z.strictObject({
  workspace: z.string(),
  projects: z.array(z.string()).optional(),
  token_env: z.string().default('ASANA_TOKEN'),
})
type Config = z.infer<typeof config>

const API = 'https://app.asana.com/api/1.0'
const RETRIES = 3

const taskFields = [
  'name',
  'notes',
  'permalink_url',
  'assignee.name',
  'memberships.project.name',
  'memberships.section.name',
  'tags.name',
  'custom_fields.name',
  'custom_fields.representation_type',
  'custom_fields.display_value',
  'custom_fields.number_value',
  'custom_fields.multi_enum_values.name',
].join(',')

type Named = { gid: string; name: string }
interface CustomField extends Named {
  representation_type: string
  display_value: string | null
  number_value?: number | null
  multi_enum_values?: Named[]
}
interface Task {
  gid: string
  name: string
  notes: string
  permalink_url: string
  assignee: Named | null
  memberships: { project: Named; section?: Named | null }[]
  tags: Named[]
  custom_fields: CustomField[]
}
interface Story {
  created_at: string
  created_by: { name: string } | null
  text: string
}
type Page<T> = { data: T[]; next_page: { offset: string } | null }

export function asanaSource(http: typeof fetch = fetch): Source<Config> {
  /** Every page of a GET, waiting out 429s as `Retry-After` says. */
  async function getAll<T>(path: string, params: Record<string, string>, token: string) {
    const all: T[] = []
    let offset: string | undefined
    do {
      const query = new URLSearchParams({ ...params, limit: '100', ...(offset && { offset }) })
      const page = await get<Page<T>>(`${path}?${query}`, token)
      all.push(...page.data)
      offset = page.next_page?.offset
    } while (offset)
    return all
  }

  async function get<T>(pathAndQuery: string, token: string, attempt = 1): Promise<T> {
    const res = await http(`${API}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 429 && attempt < RETRIES) {
      await sleep(Number(res.headers.get('retry-after') ?? 60) * 1000)
      return get(pathAndQuery, token, attempt + 1)
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok)
      throw new Error(
        `GET ${pathAndQuery.split('?')[0]}: ${res.status} ${body.errors?.[0]?.message ?? res.statusText}`,
      )
    return body as T
  }

  return {
    id: 'asana',
    configSchema: config,
    fields: {
      project: z.string(),
      section: z.string(),
      tags: z.string(),
      'fields.*': z.union([z.string(), z.number()]),
    },
    secrets: (cfg) => [cfg.token_env],

    /** My incomplete tasks in the workspace, optionally only those in the configured projects. */
    async items(cfg, ctx) {
      const token = tokenFrom(cfg, ctx)
      const tasks = await getAll<Task>(
        '/tasks',
        {
          assignee: 'me',
          workspace: cfg.workspace,
          completed_since: new Date().toISOString(),
          opt_fields: taskFields,
        },
        token,
      )
      const inScope = (t: Task) =>
        !cfg.projects || t.memberships.some((m) => cfg.projects?.includes(m.project.gid))
      const items: Item[] = []
      for (const task of tasks.filter(inScope)) {
        const stories = await getAll<Story>(
          `/tasks/${task.gid}/stories`,
          { resource_subtype: 'comment_added', opt_fields: 'created_at,created_by.name,text' },
          token,
        )
        items.push(toItem(task, stories))
      }
      return items
    },

    /** Writes task.md: description, fields and comments. */
    async prefetch(item, dir) {
      await writeFile(join(dir, 'task.md'), taskMarkdown(item))
    },
  }
}

export const asana = asanaSource()

function tokenFrom(cfg: Config, ctx: Ctx): string {
  const token = ctx.env[cfg.token_env]
  if (!token) throw new Error(`${cfg.token_env} is not set`)
  return token
}

function toItem(task: Task, stories: Story[]): Item {
  const sections = task.memberships.flatMap((m) => (m.section ? [m.section.name] : []))
  const tags = task.tags.map((t) => t.name)
  const custom = task.custom_fields.flatMap((f) => {
    const value = fieldValue(f)
    return value === undefined ? [] : [[`fields.${f.name}`, value] as const]
  })
  const customId = task.custom_fields.find((f) => f.representation_type === 'custom_id')
  return {
    source: 'asana',
    id: task.gid,
    key: customId?.display_value || task.gid,
    type: 'task',
    title: task.name,
    description: task.notes,
    url: task.permalink_url,
    status: sections[0] ?? 'open',
    assignee: task.assignee?.name,
    reviewers: [],
    labels: tags,
    comments: stories.map((s) => ({
      author: s.created_by?.name ?? 'unknown',
      body: s.text,
      at: s.created_at,
    })),
    linkedPrs: [],
    fields: {
      project: task.memberships.map((m) => m.project.name),
      section: sections,
      tags,
      ...Object.fromEntries(custom),
    },
    raw: task,
  }
}

function fieldValue(f: CustomField): string | number | string[] | undefined {
  if (f.representation_type === 'number' && typeof f.number_value === 'number')
    return f.number_value
  if (f.representation_type === 'multi_enum') return f.multi_enum_values?.map((v) => v.name)
  return f.display_value ?? undefined
}

function taskMarkdown(item: Item): string {
  const facts = Object.entries(item.fields).map(
    ([k, v]) => `- ${k}: ${[v].flat().join(', ') || '(none)'}`,
  )
  const comments = item.comments.map((c) => `\n### ${c.author}, ${c.at}\n\n${c.body}\n`)
  return [
    `# ${item.key}: ${item.title}\n\n${item.url}\n\n${facts.join('\n')}\n\n${item.description}\n`,
    ...(comments.length ? ['\n## Comments\n', ...comments] : []),
  ].join('')
}
