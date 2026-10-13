import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Ask } from '../src/core/types.js'
import { API, asana } from '../src/sources/asana.js'
import { sourceField } from '../src/sources/index.js'
import { scriptedAsk } from './fakes/ask.js'

const token = process.env.ASANA_TOKEN
const workspace = process.env.AWAYWORK_ASANA_WORKSPACE ?? ''
const project = process.env.AWAYWORK_ASANA_PROJECT ?? ''
const ctx = { env: process.env, log: console.log }

type Named = { gid: string; name: string }

/** Calls Asana's REST API as the token's user and returns the response's `data`. */
async function call<T = Named>(method: string, path: string, data?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: data && JSON.stringify({ data }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok)
    throw Object.assign(
      new Error(`${method} ${path}: ${res.status} ${body.errors?.[0]?.message ?? res.statusText}`),
      { status: res.status },
    )
  return body.data
}

/** Runs a seed step Asana keeps for paid plans; undefined when the plan refuses it with a 402. */
const paid = <T>(what: string, step: Promise<T>) =>
  step.catch((e) => {
    if (e.status !== 402) throw e
    console.log(`asana: not checking ${what}, a paid plan feature: ${e.message}`)
    return undefined
  })

/**
 * Seeds two tasks assigned to me in a new section of a test project, one blocked by the other,
 * reads them back for real and deletes them; run with ASANA_TOKEN, AWAYWORK_ASANA_WORKSPACE
 * and AWAYWORK_ASANA_PROJECT (a project gid in that workspace) set.
 */
describe.skipIf(!token || !workspace || !project)('asana source, live', () => {
  const run = Date.now().toString(36)
  const repo = 'awaywork/e2e'
  const comment = `e2e comment ${run}`
  const value = `e2e value ${run}`
  const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  const cfg = { workspace, projects: [project], repo_map: { [project]: repo } }
  let me: Named & { workspaces: Named[] }
  let projectName = ''
  let section = { gid: '', name: '' }
  let tag = { gid: '', name: '' }
  let field: Named | undefined
  const tasks: string[] = []
  let blocker = { gid: '', name: '' }
  let blocked = { gid: '', name: '' }
  let dependency: boolean | undefined

  beforeAll(async () => {
    me = await call('GET', '/users/me?opt_fields=name,workspaces.name')
    projectName = (await call('GET', `/projects/${project}?opt_fields=name`)).name
    section = await call('POST', `/projects/${project}/sections`, { name: `e2e ${run}` })
    tag = await call('POST', '/tags', { name: `e2e-${run}`, workspace })
    field = await paid(
      'custom fields',
      call('POST', '/custom_fields', { workspace, name: `e2e ${run}`, resource_subtype: 'text' }),
    )
    if (field)
      await call('POST', `/projects/${project}/addCustomFieldSetting`, { custom_field: field.gid })
    const seed = async (name: string) => {
      const { gid } = await call('POST', '/tasks', {
        name,
        notes: 'Seeded.',
        assignee: me.gid,
        projects: [project],
        tags: [tag.gid],
        due_on: due,
        ...(field && { custom_fields: { [field.gid]: value } }),
      })
      tasks.push(gid)
      await call('POST', `/sections/${section.gid}/addTask`, { task: gid })
      return { gid, name }
    }
    blocker = await seed(`[e2e ${run}] blocker`)
    blocked = await seed(`[e2e ${run}] blocked`)
    await call('POST', `/tasks/${blocked.gid}/stories`, { text: comment })
    const blocking = { dependencies: [blocker.gid] }
    dependency = await paid(
      'dependencies',
      call('POST', `/tasks/${blocked.gid}/addDependencies`, blocking).then(() => true),
    )
  }, 60_000)

  /** Deletes each seeded thing that was created, then fails naming whatever is left behind. */
  afterAll(async () => {
    const left: Error[] = []
    const undo = (what: string, path: string) =>
      call('DELETE', path).catch((cause) => left.push(new Error(`${what} left`, { cause })))
    for (const gid of tasks) await undo(`task ${gid}`, `/tasks/${gid}`)
    if (section.gid)
      await undo(`section "${section.name}" in project ${project}`, `/sections/${section.gid}`)
    if (tag.gid) await undo(`tag "${tag.name}"`, `/tags/${tag.gid}`)
    if (field) await undo(`custom field "${field.name}"`, `/custom_fields/${field.gid}`)
    if (left.length) throw new AggregateError(left, 'cleanup left seeded items behind in Asana')
  }, 60_000)

  it('reads the seeded tasks with their fields and context', async () => {
    const items = await asana.items({ ...cfg, token_env: 'ASANA_TOKEN' }, ctx)
    const listed = (task: Named) => {
      const item = items.find((i) => i.id === task.gid)
      if (!item) throw new Error(`seeded task "${task.name}" is not listed`)
      return item
    }
    const found = { blocker: listed(blocker), blocked: listed(blocked) }
    for (const item of Object.values(found))
      for (const [key, v] of Object.entries(item.fields))
        for (const one of [v].flat())
          expect(sourceField(asana.fields, key)?.safeParse(one).success).toBe(true)

    const seeded = (task: Named, isBlocked: boolean) => ({
      type: 'task',
      title: task.name,
      description: 'Seeded.',
      url: expect.stringContaining(task.gid),
      status: section.name,
      assignee: me.name,
      labels: [tag.name],
      fields: {
        project: [projectName],
        section: [section.name],
        repo,
        tags: [tag.name],
        due,
        ...(dependency && { blocked: isBlocked }),
        ...(field && { [`fields.${field.name}`]: value }),
      },
    })
    expect(found.blocker).toMatchObject({ ...seeded(blocker, false), comments: [] })
    expect(found.blocked).toMatchObject({
      ...seeded(blocked, true),
      comments: [{ author: me.name, body: comment }],
    })

    const dir = await mkdtemp(join(tmpdir(), 'awaywork-real-'))
    await asana.prefetch(found.blocked, dir, ctx)
    expect(await readdir(dir)).toEqual(['task.md'])
    expect(await readFile(join(dir, 'task.md'), 'utf8')).toContain(comment)
  }, 120_000)

  it('offers my real workspace, projects and sections at init', async () => {
    const offered: string[] = []
    const script = scriptedAsk([
      ...(me.workspaces.length > 1 ? [[/Asana workspace/, workspace] as [RegExp, unknown]] : []),
      [/Asana projects/, [project]],
      [/GitHub repo for tasks in/, repo],
    ])
    const ask: Ask = {
      ...script,
      select: (message, choices, initial) => {
        offered.push(...choices.map((c) => c.label ?? c.value))
        return script.select(message, choices, initial)
      },
      multiselect: (message, choices, initial) => {
        offered.push(...choices.map((c) => c.label ?? c.value))
        return script.multiselect(message, choices, initial)
      },
    }
    const setup = await asana.init?.(ask, ctx)
    expect(setup?.config).toEqual(cfg)
    expect(setup?.values?.section).toContain(section.name)
    expect(offered).toContain(projectName)
    if (me.workspaces.length > 1)
      expect(offered).toContain(me.workspaces.find((w) => w.gid === workspace)?.name)
  }, 30_000)
})
