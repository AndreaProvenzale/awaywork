import { z } from 'zod'
import { defaultBranch, templateProblem } from '../core/branch.js'
import { bounds } from '../core/queue.js'
import type { Rule, Scalar, WhereValue } from '../core/types.js'
import { providers } from '../providers/index.js'
import { sourceField, sources } from '../sources/index.js'

const percent = z
  .string()
  .regex(/^(100|\d{1,2}(\.\d+)?)%$/, 'expected a percentage like "10%"')
  .transform((s) => Number.parseFloat(s) / 100)
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected a time like "01:00"')
const oneOrMany = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === 'string' ? [v] : v))

const branch = z.string().superRefine((template, ctx) => {
  const problem = templateProblem(template)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

const fallback = z
  .strictObject({
    units: z.int().positive().describe('Units per night'),
    turns: z.int().positive().describe('Turns per unit'),
  })
  .describe("Caps when the provider's quota can't be read")
const reserve = 'Never go past 1 - reserve of any window'
const perNight = 'At most this share of the long window per night'
const sessionMax = 'Stop a worker past this share of the short window'
const budget = z
  .strictObject({
    reserve: percent.prefault('10%').describe(reserve),
    per_night: percent.optional().describe(perNight),
    session_max: percent.prefault('90%').describe(sessionMax),
    fallback: fallback.default({ units: 4, turns: 60 }),
  })
  .describe('Quota allocation defaults; any provider can override them')
const budgetOverride = z
  .strictObject({
    reserve: percent.describe(reserve),
    per_night: percent.describe(perNight),
    session_max: percent.describe(sessionMax),
    fallback,
  })
  .partial()
  .describe('Overrides the top-level budget for this provider')

const model = z
  .string()
  .min(1)
  .describe("Model passed to the provider's binary; default the binary's")

type ProviderConfig = {
  model?: string
  budget?: z.output<typeof budgetOverride>
} & Record<string, unknown>

const providerName = z
  .enum(Object.keys(providers))
  .transform((id): Record<string, ProviderConfig> => ({ [id]: {} }))
const providerOverride = z
  .strictObject(
    Object.fromEntries(
      Object.values(providers).map((p) => [
        p.id,
        p.configSchema
          .extend({ model: model.optional(), budget: budgetOverride.optional() })
          .optional()
          .describe(`${p.id} settings`),
      ]),
    ),
  )
  .refine((entry) => Object.keys(entry).length === 1, {
    message: 'each entry names exactly one provider',
    when: (payload) => payload.issues.length === 0,
  })
const providerEntry = z.union([providerName, providerOverride], {
  error: (issue) =>
    typeof issue.input === 'string' ? `unknown provider "${issue.input}"` : undefined,
})

const sourcesConfig = z
  .strictObject(
    Object.fromEntries(Object.values(sources).map((s) => [s.id, s.configSchema.optional()])),
  )
  .refine((s) => Object.keys(s).length > 0, 'configure at least one source')
  .describe('Where work comes from; configure at least one')

const scalar = z.union([z.string(), z.number(), z.boolean()])
const scalars = z.union([scalar, z.array(scalar).min(1)])
const whereValue = z.union([
  scalars,
  z.strictObject({ not: scalars }).describe('Matches items whose field has none of these values'),
  z
    .strictObject({
      gt: z.number().optional().describe('Greater than'),
      gte: z.number().optional().describe('Greater than or equal to'),
      lt: z.number().optional().describe('Less than'),
      lte: z.number().optional().describe('Less than or equal to'),
    })
    .refine((c) => Object.keys(c).length > 0, 'expected gt, gte, lt or lte')
    .describe('Matches items whose number field passes every comparison'),
])

const rule: z.ZodType<Rule, unknown> = z
  .strictObject({
    skill: z.string().min(1).describe('The skill that does the work'),
    source: z.enum(Object.keys(sources)).optional().describe('Match only items from this source'),
    where: z
      .record(z.string(), whereValue)
      .default({})
      .describe(
        'Item facts to match: type or a source field; a list means any of, {not} negates, {gt,gte,lt,lte} compare numbers',
      ),
    provider: oneOrMany
      .default([])
      .describe('Providers for this rule, in order; default the providers order'),
    model: z
      .record(z.string(), model)
      .optional()
      .describe(
        "Model per provider for this rule, e.g. { claude: sonnet }; default the provider's",
      ),
    skills: z.array(z.string()).default([]).describe('Extra skills available to the worker'),
    instructions: oneOrMany.default([]).describe('Instruction files added for this rule'),
    deliver: z
      .enum(['draft_pr', 'report'])
      .optional()
      .describe("Output: a draft PR or the morning report; default the skill's"),
    branch: branch.optional().describe('Branch name template for this rule'),
    order: z
      .enum(['oldest', 'newest', 'updated'])
      .optional()
      .describe('Which item goes first: oldest, newest or last updated; default the source order'),
  })
  .describe('First matching rule wins; top = highest priority')

const repo = z.strictObject({
  branch: branch.optional().describe('Branch name template for this repo'),
  setup: z.string().optional().describe('Setup command, given to the worker in its prompt'),
  test: z.string().optional().describe('Targeted test command, given to the worker in its prompt'),
  instructions: z.string().optional().describe('Instruction file for units in this repo'),
})

const itemType = z.enum(['pr', 'issue', 'task'])

export const configSchema = z
  .strictObject({
    night: z
      .strictObject({
        start: time.describe('When a scheduled run starts, local time'),
        end: time.describe('No unit starts after this'),
      })
      .refine((n) => n.start !== n.end, 'start and end must differ')
      .default({ start: '01:00', end: '07:00' })
      .describe('Local hours a scheduled run may start units in'),
    budget: budget.prefault({}),
    providers: z
      .array(providerEntry)
      .min(1)
      .describe('Providers to use, a name or a map to override; order = routing preference'),
    sources: sourcesConfig,
    branch: branch
      .default(defaultBranch)
      .describe('Branch name template; {key} is required, {title} optional'),
    repos: z
      .record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name'), repo)
      .default({})
      .describe('Per-repo settings, keyed by owner/name'),
    instructions: oneOrMany.default([]).describe('Instruction files added to every unit'),
    queue: z
      .array(rule)
      .optional()
      .describe('Rules mapping items to skills; default the built-in queue'),
  })
  .superRefine((cfg, ctx) => {
    const providerIds = cfg.providers.flatMap(Object.keys)
    const sourceIds = Object.keys(cfg.sources)
    providerIds.forEach((id, i) => {
      if (providerIds.indexOf(id) !== i)
        ctx.addIssue({ code: 'custom', path: ['providers', i], message: `"${id}" is listed twice` })
    })
    cfg.queue?.forEach((r, i) => {
      const at = ['queue', i]
      if (r.source && !sourceIds.includes(r.source))
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'source'],
          message: `source "${r.source}" is not configured`,
        })
      for (const p of r.provider)
        if (!providerIds.includes(p))
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'provider'],
            message: `provider "${p}" is not configured`,
          })
      for (const p of Object.keys(r.model ?? {}))
        if (!providerIds.includes(p))
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'model', p],
            message: `provider "${p}" is not configured`,
          })
      const scope = r.source ? [r.source] : sourceIds
      for (const [key, value] of Object.entries(r.where)) {
        const field = key === 'type' ? itemType : fieldFor(scope, key)
        if (!field) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'where', key],
            message: unknownKey(key, scope),
          })
          continue
        }
        for (const v of whereValues(value))
          if (!field.safeParse(v).success)
            ctx.addIssue({
              code: 'custom',
              path: [...at, 'where', key],
              message: `invalid value ${JSON.stringify(v)}`,
            })
      }
    })
  })
  .transform(({ providers: entries, ...cfg }) => ({
    ...cfg,
    providers: entries.flatMap((entry) =>
      Object.entries(entry as Record<string, ProviderConfig>).map(
        ([id, { model, budget: override, ...config }]) => ({
          id,
          config,
          model,
          budget: { ...cfg.budget, ...override },
        }),
      ),
    ),
  }))

export type Config = z.output<typeof configSchema>

function fieldFor(scope: string[], key: string): z.ZodType | undefined {
  const matches = scope.flatMap((id) => sourceField(sources[id]?.fields ?? {}, key) ?? [])
  if (matches.length === 0) return undefined
  return matches.length === 1 ? matches[0] : z.union(matches)
}

function whereValues(value: WhereValue): Scalar[] {
  if (typeof value !== 'object' || Array.isArray(value)) return [value].flat()
  return 'not' in value ? [value.not].flat() : bounds(value).map(([, bound]) => bound)
}

function unknownKey(key: string, scope: string[]): string {
  const known = scope.map((id) => `${id}: ${Object.keys(sources[id]?.fields ?? {}).join(', ')}`)
  return `unknown key "${key}"; use type or a source field (${known.join('; ')})`
}
export type Budget = Config['providers'][number]['budget']
