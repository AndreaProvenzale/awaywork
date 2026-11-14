import { z } from 'zod'
import type { ConfigShape } from '#config/schema'
import type { Rule, Scalar, Where, WhereValue } from '#core/types'
import { bounds, DEFAULT_LOOKBACK, isAge, isMatch, matchesValue, newerThan } from '#plan/where'
import { itemFields, sourceField, sourceFor } from '#sources/index'

/** A rule's where: keys its sources know, values their fields take, and how far back closed reads. */
export function checkRuleWhere(
  cfg: ConfigShape,
  ctx: z.RefinementCtx,
  r: Rule,
  at: (string | number)[],
  sourceIds: string[],
) {
  const scope = r.source ? [r.source] : sourceIds
  checkWhere(r.where, [...at, 'where'], false, undefined)
  function canFinish(state: WhereValue | undefined, where: Where): boolean {
    const finished = (s: WhereValue) => ['merged', 'closed'].some((f) => matchesValue(s, f))
    const entries = (where.any as Where[] | undefined) ?? []
    return state === undefined
      ? entries.some((w) => canFinish(w.state as WhereValue | undefined, w))
      : finished(state)
  }
  function checkWhere(
    where: Where,
    path: (string | number)[],
    outerBounded: boolean,
    outerState: WhereValue | undefined,
  ) {
    const bounded = outerBounded || newerThan(where.closed as WhereValue) !== undefined
    const state = (where.state as WhereValue | undefined) ?? outerState
    for (const [key, value] of Object.entries(where)) {
      if (key === 'any') {
        for (const [i, w] of (value as Where[]).entries())
          if (Object.keys(w).length === 0)
            ctx.addIssue({
              code: 'custom',
              path: [...path, key, i],
              message: 'an empty entry matches everything',
            })
          else checkWhere(w, [...path, key, i], bounded, state)
        continue
      }
      if (key === 'ours' && path.includes('any')) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, key],
          message: 'ours only lifts the awaywork PR wait at the top of where',
        })
        continue
      }
      if (key === 'planned' && path.includes('any')) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, key],
          message: "planned only takes a plan's tasks at the top of where",
        })
        continue
      }
      const v = value as WhereValue
      if (key === 'approved' && whereValues(v).some((x) => typeof x === 'boolean')) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, key],
          message: "approved names the approved post's skill now, e.g. approved: story",
        })
        continue
      }
      const field = itemFields[key] ?? fieldFor(cfg.sources, scope, key)
      if (!field) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, key],
          message: unknownKey(cfg.sources, scope, key),
        })
        continue
      }
      if (typeof v === 'object' && !Array.isArray(v) && isMatch(v)) {
        if (!isText(field))
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: 'matches needs a text field',
          })
        continue
      }
      if (typeof v === 'object' && !Array.isArray(v) && isAge(v)) {
        if (!field.safeParse(new Date().toISOString()).success)
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: 'older_than and newer_than need a date field',
          })
        else if (key === 'closed' && !canFinish(state, where))
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: 'closed only matches merged or closed items; add state: [merged, closed]',
          })
        else if (key === 'closed' && 'older_than' in v && !bounded)
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: `closed needs newer_than to bound how far back to read; without it, awaywork reads ${DEFAULT_LOOKBACK} back`,
          })
        continue
      }
      const hint = scope.includes('linear') ? "; Linear's workflow state is status" : ''
      for (const scalar of whereValues(v))
        if (!field.safeParse(scalar).success)
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: `invalid value ${JSON.stringify(scalar)}${key === 'state' ? `: state is open, merged or closed${hint}` : ''}`,
          })
    }
  }
}

type Sources = Record<string, unknown>

const fieldsOf = (configured: Sources, id: string) => sourceFor(id, configured[id])?.fields ?? {}

/** Whether source `id`'s items can match `where`: it has fields, and so items, and one for each key. */
export function canMatch(configured: Sources, id: string, where: Where): boolean {
  const fields = fieldsOf(configured, id)
  const fits = (w: Where): boolean =>
    Object.entries(w).every(([key, value]) =>
      key === 'any'
        ? (value as Where[]).some(fits)
        : key in itemFields || !!sourceField(fields, key),
    )
  return Object.keys(fields).length > 0 && fits(where)
}

function fieldFor(configured: Sources, scope: string[], key: string): z.ZodType | undefined {
  const matches = scope.flatMap((id) => sourceField(fieldsOf(configured, id), key) ?? [])
  if (matches.length === 0) return undefined
  return matches.length === 1 ? matches[0] : z.union(matches)
}

function whereValues(value: WhereValue): Scalar[] {
  if (typeof value !== 'object' || Array.isArray(value)) return [value].flat()
  if ('not' in value) return [value.not].flat()
  return isAge(value) || isMatch(value) ? [] : bounds(value).map(([, bound]) => bound)
}

/** A field `matches` can test: a string, dates aside, or a union holding one. */
function isText(field: z.core.$ZodType): boolean {
  return field instanceof z.ZodString || (field instanceof z.ZodUnion && field.options.some(isText))
}

function unknownKey(configured: Sources, scope: string[], key: string): string {
  const known = scope.map((id) => `${id}: ${Object.keys(fieldsOf(configured, id)).join(', ')}`)
  const items = Object.keys(itemFields).join(', ')
  return `unknown key "${key}"; use ${items} or a source field (${known.join('; ')})`
}
