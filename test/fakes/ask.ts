import type { Ask } from '../../src/core/types.js'

/** Stands for "take the prompt's initial value". */
export const initial = Symbol('initial')

/** Answers prompts in order; each answer names the prompt it expects by a pattern. */
export function scriptedAsk(
  script: [RegExp, unknown][],
): Ask & { notes: string[]; secrets: string[] } {
  const notes: string[] = []
  const secrets: string[] = []
  const next = (message: string, fallback: unknown) => {
    const step = script.shift()
    if (!step) throw new Error(`unscripted prompt: ${message}`)
    const [pattern, answer] = step
    if (!pattern.test(message)) throw new Error(`prompt "${message}" is not ${pattern}`)
    return answer === initial ? fallback : answer
  }
  return {
    notes,
    secrets,
    text: async (message, opts) => next(message, opts?.initial ?? '') as string,
    select: async (message, _, init) => next(message, init) as never,
    multiselect: async (message, _, init) => next(message, init ?? []) as never,
    confirm: async (message, init = true) => next(message, init) as boolean,
    secret: async (name, message) => {
      secrets.push(name)
      return next(message, '') as string
    },
    note: (message) => void notes.push(message),
  }
}
