import { execa, type Options } from 'execa'

/**
 * Starts a process that runs repo code: setup, the agent and the checks, never awaywork's own commands.
 * Isolation `none`, the only mode so far, starts it as is, as the developer's user.
 */
export function launch<O extends Options>(file: string, args: readonly string[], options: O) {
  return execa(file, args, options)
}

export type Launch = typeof launch
