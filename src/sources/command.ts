import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { commentMarkdown, linkProblem, threadBody, threadOf } from '../core/footer.js'
import { awaitGroup } from '../core/group.js'
import type { Ctx, Item, Source, ThreadHost, Write } from '../core/types.js'

export const linkTemplate = z
  .string()
  .superRefine((template, ctx) => {
    const problem = linkProblem(template)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })
  .describe(
    "Line awaywork writes into its PR bodies, and finds in yours, to link an item; {key}, {id} and {url} are the item's",
  )

export const contextCommand = z
  .strictObject({
    command: z
      .string()
      .min(1)
      .describe(
        "Shell command run per item before the worker, in the config file's folder; AWAYWORK_ITEM_KEY, _ITEM_URL and _ITEM_FILE (the item as JSON) are in its env. Files it writes to $AWAYWORK_CONTEXT_DIR reach the worker in the item's `extra/` folder",
      ),
    secrets: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an env var name'))
      .default([])
      .describe('Env vars the command needs; withheld from workers, listed in Actions'),
  })
  .describe("Fetches more context for an item, with secrets kept out of the agent's environment")

/** A poll interval: a span of a minute or more, the daemon's tick. */
export const pollSpan = z
  .string()
  .regex(/^[1-9]\d*[mhdw]$/, 'expected a span of 1m or more, like 15m: a number and m, h, d or w')

export const pollEvery = pollSpan
  .optional()
  .describe(
    'How often awaywork watch polls this source for run: soon rules, when that is less often than watch.every',
  )

export const commandConfig = z
  .strictObject({
    command: z
      .string({ error: 'not a built-in source; a custom source needs a `command`' })
      .min(1)
      .describe(
        "Shell command printing the items as a JSON array; runs in the config file's folder",
      ),
    fields: z
      .array(
        z
          .string()
          .refine((name) => name !== 'any', '`any` is reserved in where')
          .refine(
            (name) => name !== 'state' && name !== 'closed',
            "state and closed are awaywork's own on every item: rename your tracker's field, or print state (open or closed) and closed (a datetime) at the item's top level",
          ),
      )
      .default([])
      .describe('Item fields rules may match on'),
    secrets: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an env var name'))
      .default([])
      .describe('Env vars the command reads; the GitHub Actions workflow passes them in'),
    setup: z
      .string()
      .optional()
      .describe(
        "Runs in the config file's folder before awaywork on GitHub Actions, and at build in awaywork's container image",
      ),
    link: linkTemplate.optional(),
    every: pollEvery,
    write: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Shell command that comments on or moves one of your items, run like `command`; it reads the write as JSON on stdin, e.g. {"op":"move","item":"ENG-2101","id":"10012","to":"QA"}, and may print the item\'s updated times as {"before":"…","after":"…"}. Without it, on_done writes nothing to this source',
      ),
    thread: z
      .boolean()
      .optional()
      .describe(
        'A thread host: a rule\'s `thread` may name this source, whose `write` then also answers {"op":"open","item":"<card key>","title":"…","body":"…"} with {"key":"…","url":"…"}, and `command` lists the threads it opened as items, their comments the replies',
      ),
  })
  .refine((c) => !c.thread || c.write, {
    path: ['thread'],
    message: 'a thread host opens threads through its `write`: add one',
  })
  .describe('A custom source: any command that prints your open items as JSON')

/** `dir` is the folder of the config file that set it, set when the config loads. */
export type CommandConfig = z.output<typeof commandConfig> & { dir?: string }

const TIMEOUT_MS = 10 * 60_000

const scalar = z.union([z.string(), z.number(), z.boolean()])
const time = z.iso.datetime({ offset: true }).optional()
const written = z.object({ before: time, after: time })
const entry = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  type: z.enum(['issue', 'task']).default('task'),
  title: z.string(),
  url: z.string(),
  description: z.string().default(''),
  status: z.string().default('open'),
  // Commands printed these before awaywork read them, e.g. GitLab's `"state": "opened"`: unreadable ones are ignored.
  state: z.unknown().optional(),
  closed: z.unknown().optional(),
  assignee: z.string().optional(),
  reviewers: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  comments: z
    .array(
      z.object({
        author: z.string(),
        body: z.string(),
        at: z.string(),
        /** Written by your own account. */
        mine: z.boolean().optional(),
      }),
    )
    .default([]),
  fields: z.record(z.string(), z.union([scalar, z.array(scalar)])).default({}),
  /** Markdown the worker reads instead of the description. */
  context: z.string().optional(),
})
type Entry = z.output<typeof entry>

/** Runs a command of the config as a custom source's runs: in its folder, on `env` alone, with `input` on stdin, its stdout into `file` when given. */
export const runShell = (
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  input?: string,
  file?: string,
) =>
  // A timeout kills only the shell; kill its process group so no child keeps stdout open.
  awaitGroup(
    execa(command, {
      shell: true,
      cwd,
      env,
      extendEnv: false,
      timeout: TIMEOUT_MS,
      detached: true,
      ...(input !== undefined && { input }),
      ...(file !== undefined && { stdout: { file } }),
    }),
  )

export function isCommand(cfg: unknown): cfg is CommandConfig {
  return typeof cfg === 'object' && cfg !== null && 'command' in cfg
}

const run = (command: string, c: CommandConfig, ctx: Ctx, input?: string) =>
  runShell(command, c.dir, ctx.env, input)

const fieldsOf = (cfg: CommandConfig): Record<string, z.ZodType> => ({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  created: z.iso.datetime({ offset: true }),
  updated: z.iso.datetime({ offset: true }),
  ...Object.fromEntries(cfg.fields.map((name) => [name, scalar])),
})

/** Every item the command prints, the threads it opened as a thread host included. */
async function printed(id: string, c: CommandConfig, ctx: Ctx, since?: Date): Promise<Item[]> {
  const env = since ? { ...ctx.env, AWAYWORK_CLOSED_SINCE: since.toISOString() } : ctx.env
  const { stdout } = await run(c.command, c, { ...ctx, env })
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error(`\`${c.command}\` did not print JSON`)
  }
  const parsed = z.array(entry).safeParse(json)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    throw new Error(`items${issue?.path.map((p) => `[${String(p)}]`).join('')}: ${issue?.message}`)
  }
  const odd = parsed.data.find((e) => unreadable(e))
  if (odd)
    ctx.log(
      `${id}: ignoring ${odd.key}'s ${unreadable(odd)}, and any like it: a top-level state is open or closed, and closed a datetime`,
    )
  const fields = fieldsOf(c)
  return parsed.data.map((e) => toItem(id, e, fields))
}

/** A source whose items come from the user's own command; its fields come from the config. */
export function commandSource(id: string, cfg: CommandConfig): Source<CommandConfig> {
  return {
    id,
    configSchema: commandConfig,
    fields: fieldsOf(cfg),
    secrets: (c) => c.secrets,

    async items(c, ctx, since) {
      // Awaywork's thread for another item isn't an item: a plan rule would take it too.
      return (await printed(id, c, ctx, since)).filter((i) => !threadOf(i.description))
    },

    async prefetch(item, dir) {
      await writeFile(join(dir, 'item.md'), itemMarkdown(item))
    },

    ...(cfg.write && {
      async write(c: CommandConfig, item: Item, { op, ...write }: Write, ctx: Ctx) {
        const { stdout } = await run(
          c.write as string,
          c,
          ctx,
          JSON.stringify({ op, item: item.key, id: item.id, ...write }),
        )
        let printed: unknown
        try {
          printed = JSON.parse(stdout)
        } catch {}
        // Times it didn't print, or printed wrong, are none: the move then reads as a change.
        return written.safeParse(printed).data ?? {}
      },
    }),
  }
}

/** A thread host's threads: the items its command prints with awaywork's thread marker, opened, commented and closed through its `write`. */
export function commandThreads(id: string, cfg: CommandConfig, ctx: Ctx): ThreadHost {
  const write = async (input: Record<string, string>) =>
    (await run(cfg.write as string, cfg, ctx, JSON.stringify(input))).stdout
  let listed: Promise<Item[]> | undefined
  return {
    async threads() {
      listed ??= printed(id, cfg, ctx)
      return (await listed).flatMap((i) => {
        const item = threadOf(i.description)
        const thread = { host: id, key: i.key, url: i.url }
        return item ? [{ item, thread, comments: i.comments }] : []
      })
    },
    async openThread(_repo, item) {
      const title = `${item.key}: ${item.title}`
      const stdout = await write({ op: 'open', item: item.key, title, body: threadBody(item) })
      let opened: unknown
      try {
        opened = JSON.parse(stdout)
      } catch {}
      const { data } = z.object({ key: z.string().min(1), url: z.string() }).safeParse(opened)
      if (!data) throw new Error(`${id}'s write printed no {"key","url"} for the thread it opened`)
      return { host: id, ...data }
    },
    async threadComment(thread, body) {
      await write({ op: 'comment', item: thread.key, id: thread.key, body })
      return thread.url
    },
    async closeThread(thread, body) {
      await write({ op: 'close', item: thread.key, id: thread.key, body })
    },
  }
}

function toItem(source: string, e: Entry, fields: Record<string, z.ZodType>): Item {
  for (const [key, value] of Object.entries(e.fields)) {
    const field = fields[key]
    if (!field) throw new Error(`${e.key}: undeclared field "${key}"; add it to \`fields\``)
    for (const v of [value].flat())
      if (!field.safeParse(v).success)
        throw new Error(`${e.key}: invalid ${key} ${JSON.stringify(v)}`)
  }
  const { context: _, fields: itemFields, comments, state, closed, ...rest } = e
  return {
    ...rest,
    source,
    comments: comments.map(({ mine, ...c }) => ({ ...c, ...(mine && { mine: true as const }) })),
    fields: {
      ...itemFields,
      state: state === 'closed' ? 'closed' : 'open',
      ...(isTime(closed) && { closed }),
    },
    linkedPrs: [],
    mine: true,
    raw: e,
  }
}

const isTime = (v: unknown): v is string => z.iso.datetime({ offset: true }).safeParse(v).success

/** The top-level `state` or `closed` awaywork can't read, as it would print it. */
function unreadable(e: Entry): string | undefined {
  if (e.state !== undefined && e.state !== 'open' && e.state !== 'closed')
    return `state ${JSON.stringify(e.state)}`
  if (e.closed !== undefined && !isTime(e.closed)) return `closed ${JSON.stringify(e.closed)}`
}

export function itemMarkdown(item: Item): string {
  const body = (item.raw as Entry).context ?? item.description
  const comments = item.comments.map(commentMarkdown)
  return [
    `# ${item.key}: ${item.title}\n\n${item.url}\n\n${body}\n`,
    ...(comments.length ? ['\n## Comments\n', ...comments] : []),
  ].join('')
}
