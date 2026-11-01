import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { commentMarkdown } from '../core/footer.js'
import { httpError, unsetSecret } from '../core/poll.js'
import type { Ctx, Item, Source } from '../core/types.js'

const config = z
  .strictObject({
    workspace: z.string().describe('Workspace gid'),
    projects: z.array(z.string()).optional().describe('Only tasks in these project gids'),
    repo_map: z
      .record(z.string(), z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .optional()
      .describe("Project gid -> owner/repo where its tasks' code lives"),
    token_env: z.string().default('ASANA_TOKEN').describe('Env var holding the Asana token'),
  })
  .describe('My incomplete Asana tasks')
type Config = z.infer<typeof config>

export const API = 'https://app.asana.com/api/1.0'
const RETRIES = 3

const taskFields = [
  'name',
  'notes',
  'permalink_url',
  'created_at',
  'modified_at',
  'completed_at',
  'due_on',
  'due_at',
  'assignee.name',
  'memberships.project.name',
  'memberships.section.name',
  'tags.name',
  'custom_fields.name',
  'custom_fields.representation_type',
  'custom_fields.display_value',
  'custom_fields.number_value',
  'custom_fields.date_value',
  'custom_fields.multi_enum_values.name',
].join(',')

type Named = { gid: string; name: string }
interface CustomField extends Named {
  representation_type: string
  display_value: string | null
  number_value?: number | null
  date_value?: { date: string; date_time: string | null } | null
  multi_enum_values?: Named[]
}
interface Task {
  gid: string
  name: string
  notes: string
  permalink_url: string
  created_at?: string
  modified_at?: string
  completed_at?: string | null
  due_on?: string | null
  due_at?: string | null
  assignee: Named | null
  memberships: { project: Named; section?: Named | null }[]
  tags: Named[]
  // Asana omits it on free plans.
  custom_fields?: CustomField[]
}
interface Story {
  created_at: string
  created_by: Named | null
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
      const page = await request<Page<T>>(`${path}?${query}`, token)
      all.push(...page.data)
      offset = page.next_page?.offset
    } while (offset)
    return all
  }

  /** A GET, or a POST of `data`, waiting out 429s as `Retry-After` says. */
  async function request<T>(
    pathAndQuery: string,
    token: string,
    data?: object,
    attempt = 1,
  ): Promise<T> {
    const res = await http(`${API}${pathAndQuery}`, {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(data && { 'Content-Type': 'application/json' }),
      },
      ...(data && { body: JSON.stringify({ data }) }),
    })
    if (res.status === 429 && attempt < RETRIES) {
      await sleep(Number(res.headers.get('retry-after') ?? 60) * 1000)
      return request(pathAndQuery, token, data, attempt + 1)
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok)
      throw httpError(
        `${data ? 'POST' : 'GET'} ${pathAndQuery.split('?')[0]}: ${res.status} ${body.errors?.[0]?.message ?? res.statusText}`,
        res,
      )
    return body as T
  }

  const workspaces = (token: string) => getAll<Named>('/workspaces', { opt_fields: 'name' }, token)

  const projects = (workspace: string, token: string) =>
    getAll<Named>('/projects', { workspace, archived: 'false', opt_fields: 'name' }, token)

  /** The section names of these projects, or else of the sections my incomplete tasks in the workspace sit in. */
  async function sections(workspace: string, gids: string[], token: string) {
    const found =
      gids.length > 0
        ? await Promise.all(
            gids.map((p) =>
              getAll<Named>(`/projects/${p}/sections`, { opt_fields: 'name' }, token),
            ),
          )
        : (
            await getAll<Task>(
              '/tasks',
              {
                assignee: 'me',
                workspace,
                completed_since: new Date().toISOString(),
                opt_fields: 'memberships.section.name',
              },
              token,
            )
          ).map((t) => t.memberships.flatMap((m) => (m.section ? [m.section] : [])))
    return [...new Set(found.flat().map((s) => s.name))]
  }

  return {
    id: 'asana',
    configSchema: config,
    // Asana links a PR whose description holds the task's URL.
    link: '{url}',
    fields: {
      project: z.string(),
      section: z.string(),
      blocked: z.boolean(),
      repo: z.string(),
      tags: z.string(),
      created: z.iso.datetime(),
      updated: z.iso.datetime(),
      due: z.union([z.iso.datetime(), z.iso.date()]),
      'fields.*': z.union([z.string(), z.number()]),
    },
    secrets: (cfg) => [cfg.token_env],

    /** My incomplete tasks in the workspace, and those completed since `since`, optionally only those in the configured projects. */
    async items(cfg, ctx, since) {
      const token = tokenFrom(cfg, ctx)
      const tasks = await getAll<Task>(
        '/tasks',
        {
          assignee: 'me',
          workspace: cfg.workspace,
          completed_since: (since ?? new Date()).toISOString(),
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
        // Dependencies are a paid Asana feature: without them the task is still listed, just not `blocked`.
        const dependencies = await getAll<{ completed: boolean }>(
          `/tasks/${task.gid}/dependencies`,
          { opt_fields: 'completed' },
          token,
        ).catch((e: Error) => {
          ctx.log(`asana: couldn't read the dependencies of ${task.gid}: ${e.message}`)
          return undefined
        })
        items.push(toItem(task, stories, dependencies, cfg.repo_map))
      }
      return items
    },

    /** Writes item.md: description, fields and comments. */
    async prefetch(item, dir) {
      await writeFile(join(dir, 'item.md'), taskMarkdown(item))
    },

    /** Comments on the task as a story, or moves it to the section named `to` in the first of its configured projects that has one. */
    async write(cfg, item, write, ctx) {
      const token = tokenFrom(cfg, ctx)
      const task = `/tasks/${item.id}`
      const read = async () =>
        (
          await request<{ data: { modified_at: string; assignee: { gid: string } | null } }>(
            `${task}?opt_fields=modified_at,assignee`,
            token,
          )
        ).data
      const { modified_at: before, assignee } = await read()
      // Read as assigned to you, so the plan's assignee is you.
      const me = (item.raw as Task).assignee?.gid
      if (!me || assignee?.gid !== me)
        throw new Error(`${item.key} is no longer yours: not assigned to you`)
      if (write.op === 'comment') await request(`${task}/stories`, token, { text: write.body })
      else {
        const seen: string[] = []
        let section: Named | undefined
        const projects = (item.raw as Task).memberships.filter(
          (m) => !cfg.projects || cfg.projects.includes(m.project.gid),
        )
        for (const { project } of projects) {
          const sections = await getAll<Named>(
            `/projects/${project.gid}/sections`,
            { opt_fields: 'name' },
            token,
          )
          seen.push(...sections.map((s) => `"${s.name}"`))
          section = sections.find((s) => s.name.toLowerCase() === write.to.toLowerCase())
          if (section) break
        }
        if (!section)
          throw new Error(
            `${item.key}'s projects have no section "${write.to}", only ${seen.join(', ') || 'none'}`,
          )
        await request(`/sections/${section.gid}/addTask`, token, { task: item.id })
      }
      return { before, after: (await read()).modified_at }
    },

    /** Picks a workspace and projects from the account and lists their real section names. */
    async init(ask, ctx) {
      const token =
        ctx.env.ASANA_TOKEN ||
        (await ask.secret('ASANA_TOKEN', 'Asana personal access token (Settings > Apps)'))
      if (!token) return { config: { workspace: await ask.text('Asana workspace gid') } }

      const found = await workspaces(token)
      const [only] = found
      if (!only) throw new Error('this token sees no workspace')
      const workspace =
        found.length === 1
          ? only.gid
          : await ask.select(
              'Asana workspace',
              found.map((w) => ({ value: w.gid, label: w.name })),
            )
      const listed = await projects(workspace, token)
      const picked = await ask.multiselect(
        'Asana projects to watch (none: every project with my tasks)',
        listed.map((p) => ({ value: p.gid, label: p.name })),
      )
      const repos: Record<string, string> = {}
      for (const gid of picked) {
        const name = listed.find((p) => p.gid === gid)?.name
        const repo = await ask.text(`GitHub repo for tasks in ${name} (owner/repo, blank: none)`)
        if (repo.trim()) repos[gid] = repo.trim()
      }
      return {
        config: {
          workspace,
          ...(picked.length > 0 && { projects: picked }),
          ...(Object.keys(repos).length > 0 && { repo_map: repos }),
        },
        values: { section: await sections(workspace, picked, token) },
      }
    },

    /** The workspaces; the configured one's projects and sections, or every workspace's when unset. */
    async discover(cfg, ctx) {
      const token = tokenFrom({ token_env: config.shape.token_env.parse(cfg.token_env) }, ctx)
      const found = await workspaces(token)
      return {
        workspaces: await Promise.all(
          found.map(async ({ gid, name }) =>
            cfg.workspace && gid !== cfg.workspace
              ? { gid, name }
              : {
                  gid,
                  name,
                  projects: (await projects(gid, token)).map((p) => ({ gid: p.gid, name: p.name })),
                  sections: await sections(gid, cfg.projects ?? [], token),
                },
          ),
        ),
      }
    },
  }
}

export const asana = asanaSource()

function tokenFrom(cfg: Pick<Config, 'token_env'>, ctx: Ctx): string {
  const token = ctx.env[cfg.token_env]
  if (!token) throw unsetSecret(cfg.token_env)
  return token
}

function toItem(
  task: Task,
  stories: Story[],
  dependencies: { completed: boolean }[] | undefined,
  repoMap: Config['repo_map'] = {},
): Item {
  const sections = task.memberships.flatMap((m) => (m.section ? [m.section.name] : []))
  const tags = task.tags.map((t) => t.name)
  const customFields = task.custom_fields ?? []
  const custom = customFields.flatMap((f) => {
    const value = fieldValue(f)
    return value === undefined ? [] : [[`fields.${f.name}`, value] as const]
  })
  const repo = task.memberships.map((m) => repoMap[m.project.gid]).find(Boolean)
  const customId = customFields.find((f) => f.representation_type === 'custom_id')
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
      // Tasks are read as assigned to you: your stories are the assignee's.
      ...(!!task.assignee && s.created_by?.gid === task.assignee.gid && { mine: true as const }),
    })),
    linkedPrs: [],
    mine: true,
    fields: {
      project: task.memberships.map((m) => m.project.name),
      section: sections,
      ...(dependencies && { blocked: dependencies.some((d) => !d.completed) }),
      ...(repo && { repo }),
      tags,
      ...(task.created_at && { created: task.created_at }),
      ...(task.modified_at && { updated: task.modified_at }),
      ...((task.due_at || task.due_on) && { due: task.due_at || task.due_on }),
      state: task.completed_at ? 'closed' : 'open',
      ...(task.completed_at && { closed: task.completed_at }),
      ...Object.fromEntries(custom),
    },
    raw: task,
  }
}

function fieldValue(f: CustomField): string | number | string[] | undefined {
  if (f.representation_type === 'number' && typeof f.number_value === 'number')
    return f.number_value
  if (f.representation_type === 'date' && f.date_value)
    return f.date_value.date_time ?? f.date_value.date
  if (f.representation_type === 'multi_enum') return f.multi_enum_values?.map((v) => v.name)
  return f.display_value ?? undefined
}

/** An item as Markdown: title, url, fields, description and comments. */
export function taskMarkdown(item: Item): string {
  const facts = Object.entries(item.fields).map(
    ([k, v]) => `- ${k}: ${[v].flat().join(', ') || '(none)'}`,
  )
  const comments = item.comments.map(commentMarkdown)
  return [
    `# ${item.key}: ${item.title}\n\n${item.url}\n\n${facts.join('\n')}\n\n${item.description}\n`,
    ...(comments.length ? ['\n## Comments\n', ...comments] : []),
  ].join('')
}
