import { ConfigError } from '../config/load.js'

export function reportConfigError(e: unknown): void {
  if (!(e instanceof ConfigError)) throw e
  console.error(e.message)
  process.exitCode = 1
}
