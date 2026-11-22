import { execa } from 'execa'
import { bin, profile } from '#config/paths'
import { DEFAULT_PROFILE } from '#config/profiles'
import type { LaunchOptions } from '.'

/** Set by awaywork's Dockerfile, whose image runs every launch as the worker user, as a GitHub-hosted runner does. */
export const inAwayworkImage = (env: NodeJS.ProcessEnv) => Boolean(env.AWAYWORK_IMAGE)
export const hostedRunner = (env: NodeJS.ProcessEnv) => env.RUNNER_ENVIRONMENT === 'github-hosted'

/** The user repo code runs as under `isolation: user`: one per profile, so one's kill reaches no other's processes; always `awaywork` on a hosted runner and in the image. */
export const workerNamed = (profileName: string, env: NodeJS.ProcessEnv = {}) =>
  profileName === DEFAULT_PROFILE || hostedRunner(env) || inAwayworkImage(env)
    ? 'awaywork'
    : `awaywork-${profileName}`

/** The worker user of the profile in force, made by `action.yml` on a GitHub-hosted runner, by you elsewhere. */
export const WORKER = workerNamed(profile.name, process.env)

/** Each clone is a folder straight under the sticky `/tmp`, so no folder of the developer's sits on its path for a link to be planted in. */
export const ROOT = '/tmp/awaywork-'
export const CHOWN = ['/usr/bin/chown', '-R', '-h', '-P']
/** Set by sudo for the worker, so never taken from the developer's env. */
const sudoSets = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'MAIL']
/** The developer's own folders, which the worker can't enter; PAM sets them from `/etc/environment` on a hosted runner. */
const developerFolders = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'PNPM_HOME',
]

export const developer = () => `${process.getuid?.()}:${process.getgid?.()}`

/** sudo's argv running `file` as `user`: the env's names go on it, its values stay in sudo's env, which no other user can read. */
export function sudoArgs(
  user: string,
  file: string,
  args: readonly string[],
  options: LaunchOptions,
) {
  const env = options.extendEnv === false ? options.env : { ...process.env, ...options.env }
  const names = Object.keys(env ?? {}).filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !sudoSets.includes(name) &&
      !developerFolders.includes(name),
  )
  const unset = [
    '/usr/bin/env',
    ...developerFolders.flatMap((name) => ['-u', name]),
    ...(options.home ? [`HOME=${options.home}`] : []),
    ...(options.tmpdir ? [`TMPDIR=${options.tmpdir}`] : []),
  ]
  // sudo looks a bare name up on its own secure_path, not the env's PATH.
  const command = options.shell
    ? ['/bin/sh', '-c', [file, ...args].join(' ')]
    : [bin(file), ...args]
  return ['-n', '-u', user, `--preserve-env=${names.join(',')}`, '--', ...unset, ...command]
}

/** The only command awaywork runs as root, shaped as the sudoers line names it. */
export const chown = (owner: string, dir: string) =>
  execa(bin('sudo'), ['-n', ...CHOWN, owner, dir], { reject: false })
