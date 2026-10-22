import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { z } from 'zod'
import { linkProblem } from '../core/footer.js'
import { awaitGroup } from '../core/group.js'
import { repoPath } from '../core/repo-path.js'
import type { Item, Source } from '../core/types.js'

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

export const commandConfig = z
  .strictObject({
    command: z
      .string({ error: 'not a built-in source; a custom source needs a `command`' })
      .min(1)
      .describe(
        "Shell command printing the items as a JSON array; runs in the config file's folder",
      ),
    fields: z
      .array(z.string().refine((name) => name !== 'any', '`any` is reserved in where'))
      .default([])
      .describe('Item fields rules may match on'),
    secrets: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an env var name'))
      .default([])
      .describe('Env vars the command reads; the GitHub Actions workflow passes them in'),
    setup: z
      .string()
      .optional()
      .describe("Runs in the config file's folder before awaywork on GitHub Actions"),
    link: linkTemplate.optional(),
  })
  .describe('A custom source: any command that prints your open items as JSON')

/** `dir` is the config file's folder, set when the config loads. */
export type CommandConfig = z.output<typeof commandConfig> & { dir?: string }

const TIMEOUT_MS = 10 * 60_000

const scalar = z.union([z.string(), z.number(), z.boolean()])
const entry = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  type: z.enum(['issue', 'task']).default('task'),
  title: z.string(),
  url: z.string(),
  description: z.string().default(''),
  status: z.string().default('open'),
  assignee: z.string().optional(),
  reviewers: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  comments: z.array(z.object({ author: z.string(), body: z.string(), at: z.string() })).default([]),
  fields: z.record(z.string(), z.union([scalar, z.array(scalar)])).default({}),
  /** Markdown the worker reads instead of the description. */
  context: z.string().optional(),
})
type Entry = z.output<typeof entry>

export function isCommand(cfg: unknown): cfg is CommandConfig {
  return typeof cfg === 'object' && cfg !== null && 'command' in cfg
}

/** A source whose items come from the user's own command; its fields come from the config. */
export function commandSource(id: string, cfg: CommandConfig): Source<CommandConfig> {
  const fields: Record<string, z.ZodType> = {
    repo: repoPath,
    created: z.iso.datetime({ offset: true }),
    updated: z.iso.datetime({ offset: true }),
    ...Object.fromEntries(cfg.fields.map((name) => [name, scalar])),
  }
  return {
    id,
    configSchema: commandConfig,
    fields,
    secrets: (c) => c.secrets,

    async items(c, ctx) {
      const subprocess = execa(c.command, {
        shell: true,
        cwd: c.dir,
        env: ctx.env,
        extendEnv: false,
        timeout: TIMEOUT_MS,
        detached: true,
      })
      // A timeout kills only the shell; kill its process group so no child keeps stdout open.
      const { stdout } = await awaitGroup(subprocess)
      let json: unknown
      try {
        json = JSON.parse(stdout)
      } catch {
        throw new Error(`\`${c.command}\` did not print JSON`)
      }
      const parsed = z.array(entry).safeParse(json)
      if (!parsed.success) {
        const [issue] = parsed.error.issues
        throw new Error(
          `items${issue?.path.map((p) => `[${String(p)}]`).join('')}: ${issue?.message}`,
        )
      }
      return parsed.data.map((e) => toItem(id, e, fields))
    },

    async prefetch(item, dir) {
      await writeFile(join(dir, 'item.md'), itemMarkdown(item))
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
  const { context: _, fields: itemFields, ...rest } = e
  return { ...rest, source, fields: itemFields, linkedPrs: [], raw: e }
}

function itemMarkdown(item: Item): string {
  const body = (item.raw as Entry).context ?? item.description
  const comments = item.comments.map((c) => `\n### ${c.author}, ${c.at}\n\n${c.body}\n`)
  return [
    `# ${item.key}: ${item.title}\n\n${item.url}\n\n${body}\n`,
    ...(comments.length ? ['\n## Comments\n', ...comments] : []),
  ].join('')
}
