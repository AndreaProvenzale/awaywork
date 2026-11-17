import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command } from 'commander'
import { expandHome } from '#config/logins'
import { configDir, profilesPath } from '#config/paths'
import { DEFAULT_PROFILE, readRegistry, switchTo } from '#config/profiles'

const tilde = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

export function switchCommand(program: Command, fromEnv?: string): void {
  program
    .command('switch [name] [config]')
    .description(
      'list the profiles, make one current, or register one with its config file: switch <name> <config>',
    )
    .action(async (name?: string, config?: string) => {
      try {
        console.log(await runSwitch(profilesPath, fromEnv, name, config))
      } catch (e) {
        console.error((e as Error).message)
        process.exitCode = 1
      }
    })
}

/** The lines `awaywork switch` prints; `fromEnv` is AWAYWORK_PROFILE as the shell had it. */
export async function runSwitch(
  path: string,
  fromEnv: string | undefined,
  name?: string,
  config?: string,
): Promise<string> {
  const registry = name
    ? await switchTo(path, name, config && resolve(expandHome(config)))
    : readRegistry(path)
  const current = registry.current ?? DEFAULT_PROFILE
  const rows: [string, string][] = [
    [DEFAULT_PROFILE, join(configDir, 'config.yml')],
    ...Object.entries(registry.profiles),
  ]
  const width = Math.max(...rows.map(([n]) => n.length))
  const lines = name
    ? [`Switched to ${current}`]
    : rows.map(([n, c]) => `${n === current ? '*' : ' '} ${n.padEnd(width)}  ${tilde(c)}`)
  if (!name && current !== DEFAULT_PROFILE && !Object.hasOwn(registry.profiles, current))
    lines.push(`current is ${current}, which isn't registered`)
  if (fromEnv && fromEnv !== current)
    lines.push(
      `AWAYWORK_PROFILE=${fromEnv} in this shell overrides it; unset it to follow the switch`,
    )
  return lines.join('\n')
}
