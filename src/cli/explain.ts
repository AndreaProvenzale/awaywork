import { isMap, isSeq, LineCounter, parseDocument } from 'yaml'
import { ConfigError, parseConfig } from '../config/load.js'
import { defaultRules, isLoop } from '../core/queue.js'
import { builtinSkills } from '../core/skills.js'
import type { Rule, Where } from '../core/types.js'

const pct = (share: number) => `${Math.round(share * 100)}%`

const OPEN_THREADS = '{"not":0}'

/** The conditions worth their own words; anything else reads through `phrase`. */
const words: Record<string, (value: unknown) => string | undefined> = {
  review_requested: (v) => (v === true ? 'review requested' : undefined),
  checks: (v) => (typeof v === 'string' ? `checks ${v}` : undefined),
  label: (v) => `label ${[v].flat().join(', ')}`,
  unresolved_threads: (v) => (JSON.stringify(v) === OPEN_THREADS ? 'open threads' : undefined),
  my_unresolved_threads: (v) =>
    JSON.stringify(v) === OPEN_THREADS ? 'your open threads' : undefined,
  ours: (v) => (v === true ? "awaywork's own" : undefined),
  trusted: (v) => (v === true ? 'from trusted authors' : undefined),
  behind: (v) => (JSON.stringify(v) === '{"gt":0}' ? 'behind their base' : undefined),
  conflicts: (v) => (v === true ? 'with conflicts' : v === false ? 'no conflicts' : undefined),
  author: (v) => `by ${[v].flat().join(', ')}`,
  repo: (v) => `in ${[v].flat().join(', ')}`,
}

const comparisons = { gt: 'over', gte: 'at least', lt: 'under', lte: 'at most' } as const

/** A condition in words: `updated over 3d ago`, `changed lines at most 200`, `not draft`. */
function phrase(key: string, value: unknown): string {
  const name = key.replaceAll('_', ' ')
  if (value === true) return name
  if (value === false) return `not ${name}`
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return `${name} ${[value].flat().join(', ')}`
  const v = value as Record<string, unknown>
  if ('not' in v) return `${name} not ${[v.not].flat().join(', ')}`
  if ('matches' in v) return `${name} matching /${v.matches}/`
  const ages = [
    v.older_than !== undefined && `over ${v.older_than} ago`,
    v.newer_than !== undefined && `in the last ${v.newer_than}`,
  ]
  const bounds = Object.entries(comparisons).map(
    ([op, word]) => v[op] !== undefined && `${word} ${v[op]}`,
  )
  return `${name} ${[...ages, ...bounds].filter(Boolean).join(' and ')}`
}

function conditions({ any, ...where }: Where): string[] {
  const said = Object.entries(where).map(
    ([key, value]) => words[key]?.(value) ?? phrase(key, value),
  )
  if (!any) return said
  return [...said, `any of: ${(any as Where[]).map((w) => conditions(w).join(', ')).join(' or ')}`]
}

/** What a rule takes, in words. */
export function takes({ source, where }: Pick<Rule, 'source' | 'where'>): string {
  const { type, mine, planned, ...rest } = where as Where & Record<string, unknown>
  const noun = planned ? 'planned tasks' : typeof type === 'string' ? `${type}s` : 'items'
  const subject = [mine === true && 'my', source !== 'github' && source, noun.replace(/^pr/, 'PR')]
    .filter(Boolean)
    .join(' ')
  return [subject, ...conditions(rest as Where)].join(', ')
}

function leaves(r: Rule): string {
  if (r.deliver === 'draft_pr') return 'draft PR'
  if (r.deliver === 'pending_review') return 'pending review'
  if (r.deliver) return r.deliver === 'pr' ? 'PR' : r.deliver
  const steps = [r, ...(r.then ?? []).flatMap((s) => (isLoop(s) ? s.loop : s))]
  return steps.every((s) => builtinSkills[s.skill]?.deliver === 'report') ? 'report' : 'draft PR'
}

function until(c: { verdict?: unknown; command?: string }): string {
  return c.command ?? [c.verdict].flat().join(' or ')
}

/** Each `queue` entry's first and last line in the file; none when the rules are the default queue. */
function ruleLines(text: string): ([number, number] | undefined)[] {
  const counter = new LineCounter()
  const doc = parseDocument(text, { lineCounter: counter })
  const queue = isMap(doc.contents) ? doc.contents.get('queue', true) : undefined
  if (!isSeq(queue)) return []
  return queue.items.map((item) => {
    const range = (item as { range?: [number, number, number] }).range
    return range && [counter.linePos(range[0]).line, counter.linePos(range[1] - 1).line]
  })
}

/** What a config says, as the `/away` pane draws it: local, no source or provider is read. */
export function explainConfig(text: string, path: string) {
  let config: ReturnType<typeof parseConfig>
  try {
    config = parseConfig(text, path)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    return { valid: false as const, problems: e.problems }
  }
  const lines = ruleLines(text)
  const budget = config.providers[0]?.budget
  return {
    valid: true as const,
    windows: config.windows.map(
      (w) => `${w.days ? `${w.days.join(',')} ` : ''}${w.start}–${w.end}`,
    ),
    providers: config.providers.map((p) => p.id),
    sources: Object.keys(config.sources),
    reserve: budget && pct(budget.reserve),
    defaultQueue: !config.queue,
    rules: (config.queue ?? defaultRules(Object.keys(config.sources))).map((r, i) => ({
      rule: i + 1,
      lines: lines[i],
      takes: takes(r),
      skill: r.skill,
      steps: (r.then ?? []).map((s) =>
        isLoop(s)
          ? { loop: s.loop.map((l) => l.skill), until: until(s.until), max: s.max }
          : { skill: s.skill },
      ),
      leaves: leaves(r),
      waits: r.deliver === 'plan' ? r.wait !== false : r.wait === true || !!r.gates,
      plan: r.deliver === 'plan',
      planned: 'planned' in r.where,
      soon: r.run === 'soon',
    })),
  }
}
