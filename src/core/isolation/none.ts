import { execa } from 'execa'
import type { Mode } from '../isolation'

/** Launches as the developer's user, with the provider's `HOME` when one is given. */
export const none: Mode = {
  name: 'none',
  start(file, args, options) {
    const { home, tmpdir: _, ...rest } = options
    return execa(
      file,
      args,
      (home ? { ...rest, env: { ...rest.env, HOME: home } } : rest) as typeof options,
    )
  },
  phase: (_dir, run) => run(),
  hold: (run) => run(),
  where: () => ({ user: undefined }),
  raiseWall: async () => {},
  walled: () => false,
}
