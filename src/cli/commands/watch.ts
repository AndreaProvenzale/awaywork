import type { Command } from 'commander'
import { configPath } from '../../config/load.js'
import { watch } from '../../run/daemon.js'
import type { Remote } from '../../run/remote.js'

export function watchCommand(program: Command, remote: Remote): void {
  program
    .command('watch')
    .description(
      'keep running and start a run when a window opens; `schedule install` keeps it running',
    )
    .action(() => {
      const stop = new AbortController()
      // `on`, not `once`: execa's signal-exit re-raises a signal it sees no other listener for.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
      // Inherited by hooks and workers, so `schedule install` there won't stop this daemon.
      process.env.AWAYWORK_WATCH = String(process.pid)
      return watch(configPath(program.opts().config), stop.signal, remote)
    })
}
