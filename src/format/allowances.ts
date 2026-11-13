import { providers } from '#providers/index'
import { type Allowance, pct } from '#quota/budget'
import { counted } from '#util/text'

/** An allowance in one line, with what a run outside the windows gets under `outside`, the present session limit. */
export function describeAllowance(id: string, a: Allowance, outside: number): string {
  if (a.kind === 'fallback')
    return `fallback: ${describeFallback(id, a)}, sits out runs outside the windows`
  const session = a.session
    ? `; session ${pct(a.session.used)}, workers stop at ${pct(a.session.stopAt)} in windows, ${pct(outside)} outside`
    : ''
  return `${a.window} ${pct(a.used)} used, ceiling ${pct(a.ceiling)} set by ${bindingLimit(a)} (${otherLimits(a)}; resets in ${runs(a.runs)})${session}`
}

type QuotaAllowance = Extract<Allowance, { kind: 'quota' }>
type FallbackAllowance = Extract<Allowance, { kind: 'fallback' }>

export function allowanceRow(id: string, a: Allowance): string[] {
  if (a.kind === 'fallback') return [id, 'fallback']
  const session = a.session ? `${pct(a.session.used)} / ${pct(a.session.stopAt)}` : '-'
  return [id, a.window, pct(a.used), pct(a.ceiling), bindingLimit(a), runs(a.runs), session]
}

export function allowanceNote(id: string, a: Allowance): string {
  return a.kind === 'fallback' ? describeFallback(id, a) : `other limits: ${otherLimits(a)}`
}

function describeFallback(id: string, a: FallbackAllowance): string {
  if (a.present) return `sits out a present run (${a.reason})`
  // A command provider has no turn cap, so its fallback turns mean nothing.
  const turns = Object.hasOwn(providers, id) ? `, ${counted(a.turns, 'turn')} each` : ''
  return `${counted(a.units, 'unit')}${turns} (${a.reason})`
}

// `reserve` is the share kept back; its limit is the cap that leaves it.
const limitName = (name: string) => (name === 'reserve' ? 'reserve cap' : name)

const binding = (a: QuotaAllowance) => a.limits.find((l) => l.value === a.ceiling)

const bindingLimit = (a: QuotaAllowance) => limitName(binding(a)?.name ?? '-')

function otherLimits(a: QuotaAllowance): string {
  return a.limits
    .filter((l) => l !== binding(a))
    .map((l) => `${limitName(l.name)} ${pct(l.value)}`)
    .join(', ')
}

const runs = (n: number) => counted(n, 'run')
