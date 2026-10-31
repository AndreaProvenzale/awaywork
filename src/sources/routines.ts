import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { localTime } from '../core/report.js'
import type { Item, Source } from '../core/types.js'
import { clock, DAYS, time } from '../core/window.js'
import { itemMarkdown } from './command.js'

const routine = z
  .strictObject(
    {
      days: z
        .array(z.enum(DAYS))
        .min(1)
        .optional()
        .describe('Weekdays it comes due on; every day when unset'),
      at: z
        .union([time, z.array(time).min(1)])
        .transform((v) => [v].flat())
        .describe('When it comes due, local time: one time or a list'),
      repo: z
        .string({ error: 'required: the repo its work happens in' })
        .regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name')
        .describe('The repo its work happens in, owner/name'),
      title: z.string().min(1).describe("The item's title"),
      description: z.string().default('').describe("The item's description, what the worker reads"),
    },
    {
      error: (issue) =>
        issue.code === 'invalid_type'
          ? 'expected a routine with at, repo and title; routines is a built-in source, so give a custom one another name'
          : undefined,
    },
  )
  .describe('A routine: an item that comes due on the clock')

/** `url` is its repo's page on the config's forge, set when the config parses. */
export type Routine = z.output<typeof routine> & { url?: string }
export type RoutinesConfig = Record<string, unknown>

/** The keys awaywork reads off any source's config, so no routine's name. */
const ownKeys = ['context', 'every', 'link']

/** Refuses a routine named after one of the source's own keys, before they're read as theirs. */
export function refuseOwnKeys(cfg: unknown, ctx: z.RefinementCtx): unknown {
  const named = Object.entries(cfg ?? {}).filter(
    ([key, v]) => ownKeys.includes(key) && typeof v === 'object' && v !== null && 'at' in v,
  )
  for (const [key] of named)
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: "context, every and link are the source's own keys; give the routine another name",
    })
  return cfg
}

/** The routines in the source's config, by name: its own keys aside. */
export function routinesOf(cfg: RoutinesConfig | undefined): [string, Routine][] {
  return Object.entries(cfg ?? {}).filter(([key]) => !ownKeys.includes(key)) as [string, Routine][]
}

/** Each time the routine comes due within a week either side of `now`, local time: always one before it and one after. */
function around(r: Routine, now: Date): Date[] {
  const found: Date[] = []
  for (let offset = -7; offset <= 7; offset++) {
    const day = new Date(now)
    day.setDate(day.getDate() + offset)
    if (r.days && !r.days.includes(DAYS[day.getDay()] as (typeof DAYS)[number])) continue
    for (const at of r.at) {
      const due = new Date(day)
      due.setHours(...clock(at), 0, 0)
      found.push(due)
    }
  }
  return found
}

/** The last time the routine came due, at or before `now`. */
export function lastOccurrence(r: Routine, now: Date): Date {
  const past = around(r, now).filter((d) => d <= now)
  return new Date(Math.max(...past.map(Number)))
}

/** The next time the routine comes due, after `now`. */
export function nextOccurrence(r: Routine, now: Date): Date {
  const future = around(r, now).filter((d) => d > now)
  return new Date(Math.min(...future.map(Number)))
}

const two = (n: number) => String(n).padStart(2, '0')

/** E.g. `sentry-triage-20261026-0900`, the occurrence in local time. */
export function occurrenceKey(name: string, at: Date): string {
  const day = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`
  return `${name}-${day}-${two(at.getHours())}${two(at.getMinutes())}`
}

/** E.g. `mon 2026-10-26 09:00`, local time. */
export const describeOccurrence = (at: Date) => `${DAYS[at.getDay()]} ${localTime(at).slice(0, 16)}`

/** Each routine's next occurrence, by name, as an ISO time. */
export function nextOccurrences(
  cfg: RoutinesConfig | undefined,
  now: Date,
): Record<string, string> {
  return Object.fromEntries(
    routinesOf(cfg).map(([name, r]) => [name, nextOccurrence(r, now).toISOString()]),
  )
}

/** Items from the clock: each routine's latest occurrence, one per routine however long the machine slept. */
export const routines: Source<RoutinesConfig> = {
  id: 'routines',
  configSchema: z
    .object({})
    .catchall(routine)
    .describe('Routines by name, each an item that comes due on the clock, like a weekly triage'),
  fields: {
    name: z.string(),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    created: z.iso.datetime({ offset: true }),
    updated: z.iso.datetime({ offset: true }),
  },
  link: false,
  secrets: () => [],

  async items(cfg) {
    const now = new Date()
    return routinesOf(cfg).map(([name, r]): Item => {
      const at = lastOccurrence(r, now)
      const key = occurrenceKey(name, at)
      return {
        source: 'routines',
        id: key,
        key,
        type: 'task',
        title: r.title,
        description: r.description,
        url: r.url ?? `https://github.com/${r.repo}`,
        status: 'open',
        reviewers: [],
        labels: [],
        comments: [],
        linkedPrs: [],
        fields: {
          name,
          repo: r.repo,
          created: at.toISOString(),
          updated: at.toISOString(),
          state: 'open',
        },
        mine: true,
        raw: r,
      }
    })
  },

  async prefetch(item, dir) {
    await writeFile(join(dir, 'item.md'), itemMarkdown(item))
  },
}
