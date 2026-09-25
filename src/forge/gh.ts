import { execa } from 'execa'

/** Runs a command and returns its stdout; injected so tests replay recorded output. */
export type Exec = (cmd: string, args: string[]) => Promise<string>

export const exec: Exec = async (cmd, args) => (await execa(cmd, args)).stdout

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
