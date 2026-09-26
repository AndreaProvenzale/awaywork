import { z } from 'zod'
import { defaultBranch, templateProblem } from '../core/branch.js'
import type { Rule } from '../core/types.js'
import { providers } from '../providers/index.js'
import { sources } from '../sources/index.js'

const percent = z
  .string()
  .regex(/^(100|\d{1,2}(\.\d+)?)%$/, 'expected a percentage like "10%"')
  .transform((s) => Number.parseFloat(s) / 100)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected a time like "01:00"')
const oneOrMany = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === 'string' ? [v] : v))

const branch = z.string().superRefine((template, ctx) => {
  const problem = templateProblem(template)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

const fallback = z.strictObject({ units: z.int().positive(), turns: z.int().positive() })
const budget = z.strictObject({
  reserve: percent.default(0.1),
  per_night: percent.optional(),
  session_max: percent.default(0.9),
  fallback: fallback.default({ units: 4, turns: 60 }),
})
const budgetOverride = z
  .strictObject({
    reserve: percent,
    per_night: percent,
    session_max: percent,
    fallback,
  })
  .partial()

type ProviderConfig = { budget?: z.output<typeof budgetOverride> } & Record<string, unknown>

const providerEntry = z
  .strictObject(
    Object.fromEntries(
      Object.values(providers).map((p) => [
        p.id,
        p.configSchema.extend({ budget: budgetOverride.optional() }).optional(),
      ]),
    ),
  )
  .refine((entry) => Object.keys(entry).length === 1, {
    message: 'each entry names exactly one provider',
    when: (payload) => payload.issues.length === 0,
  })

const sourcesConfig = z
  .strictObject(
    Object.fromEntries(Object.values(sources).map((s) => [s.id, s.configSchema.optional()])),
  )
  .refine((s) => Object.keys(s).length > 0, 'configure at least one source')

const scalar = z.union([z.string(), z.number(), z.boolean()])
const scalars = z.union([scalar, z.array(scalar).min(1)])
const whereValue = z.union([scalars, z.strictObject({ not: scalars })])

const rule: z.ZodType<Rule, unknown> = z.strictObject({
  skill: z.string().min(1),
  source: z.enum(Object.keys(sources)).optional(),
  where: z.record(z.string(), whereValue).default({}),
  provider: oneOrMany.default([]),
  skills: z.array(z.string()).default([]),
  instructions: oneOrMany.default([]),
  deliver: z.enum(['draft_pr', 'report']).optional(),
  branch: branch.optional(),
})

const repo = z.strictObject({
  branch: branch.optional(),
  setup: z.string().optional(),
  test: z.string().optional(),
  instructions: z.string().optional(),
})

const itemType = z.enum(['pr', 'issue', 'task'])

export const configSchema = z
  .strictObject({
    night: z
      .strictObject({ start: time, end: time })
      .refine((n) => n.start !== n.end, 'start and end must differ')
      .default({ start: '01:00', end: '07:00' }),
    budget: budget.prefault({}),
    providers: z.array(providerEntry).min(1),
    sources: sourcesConfig,
    branch: branch.default(defaultBranch),
    repos: z
      .record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name'), repo)
      .default({}),
    instructions: oneOrMany.default([]),
    queue: z.array(rule).optional(),
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
        const values = [
          typeof value === 'object' && !Array.isArray(value) ? value.not : value,
        ].flat()
        for (const v of values)
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
        ([id, { budget: override, ...config }]) => ({
          id,
          config,
          budget: { ...cfg.budget, ...override },
        }),
      ),
    ),
  }))

export type Config = z.output<typeof configSchema>

function fieldFor(scope: string[], key: string): z.ZodType | undefined {
  const matches = scope.flatMap((id) => sources[id]?.fields[key] ?? [])
  if (matches.length === 0) return undefined
  return matches.length === 1 ? matches[0] : z.union(matches)
}

function unknownKey(key: string, scope: string[]): string {
  const known = scope.map((id) => `${id}: ${Object.keys(sources[id]?.fields ?? {}).join(', ')}`)
  return `unknown key "${key}"; use type or a source field (${known.join('; ')})`
}
export type Budget = Config['providers'][number]['budget']
