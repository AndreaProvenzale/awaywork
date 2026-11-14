import type { RanCheck } from '#worker/process/checks'

/** A loop of the chain, while its rounds run. */
export interface OpenLoop {
  skills: string[]
  rounds: number
  verdict?: string
  /** The last run of `until`'s command. */
  check?: RanCheck
  ended?: string
  /** Its `until` held. */
  held?: true
}

/** E.g. `2 rounds of review ⇄ fix; until held: verdict approve`. */
export function describeLoop(loop: OpenLoop): string {
  const rounds = `${loop.rounds} ${loop.rounds === 1 ? 'round' : 'rounds'}`
  return `${rounds} of ${loop.skills.join(' ⇄ ')}; ${loop.ended ?? 'nothing ran'}`
}
