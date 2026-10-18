import { execa } from 'execa'
import { bin } from '../config/paths.js'

/** Runs a command and returns its stdout; injected so tests replay recorded output. */
export type Exec = (cmd: string, args: string[], env?: Record<string, string>) => Promise<string>

export const exec: Exec = async (cmd, args, env) => (await execa(bin(cmd), args, { env })).stdout

/** `run` with `gh` pointed at a GitHub Enterprise host; unchanged without one. */
export const onHost = (run: Exec, host?: string): Exec =>
  host ? (cmd, args) => run(cmd, args, cmd === 'gh' ? { GH_HOST: host } : undefined) : run

export async function graphql<T>(
  run: Exec,
  query: string,
  vars: Record<string, string | number>,
): Promise<T> {
  const flags = Object.entries(vars).flatMap(([k, v]) => [
    typeof v === 'number' ? '-F' : '-f',
    `${k}=${v}`,
  ])
  return JSON.parse(await run('gh', ['api', 'graphql', ...flags, '-f', `query=${query}`])).data
}
