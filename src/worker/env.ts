import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import { refuseSymlinks } from './safe-files.js'
import { WORK_DIR } from './work-dir.js'

const forgeTokens = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']
/** Credentials that aren't tokens: askpass helpers, the ssh agent and git config set through the env. */
const credentialPlumbing = [
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]
const gitConfigEntry = /^GIT_CONFIG_(KEY|VALUE)_\d+$/

/** The entries `writeGitConfig` resolved for each clone, which the gates' config gets again. Per process. */
export const gitEntries = new Map<string, string[][]>()

export async function writeConfigFile(file: string, entries: string[][]): Promise<void> {
  await writeFile(file, '', { flag: 'wx' })
  for (const [key = '', value = 'true'] of entries)
    await execa(bin('git'), ['config', '--file', file, '--add', key, value])
}

export const gitConfigFile = (dir: string) => join(dir, WORK_DIR, 'gitconfig')

/** The env of setup: no forge token, none of `withheld`, and gh and twg without their config or keyring login. */
export function commandEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  withheld: string[],
): NodeJS.ProcessEnv {
  const hidden = new Set([...forgeTokens, ...withheld])
  // Every TWG_ name, whatever the forge: twg logins come in many names, and you may be logged in for Jira alone.
  const kept = Object.entries(env).filter(([name]) => !hidden.has(name) && !name.startsWith('TWG_'))
  return {
    ...Object.fromEntries(kept),
    GH_CONFIG_DIR: join(dir, WORK_DIR, 'gh'),
    GH_TOKEN: 'none',
    GH_ENTERPRISE_TOKEN: 'none',
    TWG_CONFIG_DIR: join(dir, WORK_DIR, 'twg'),
  }
}

/** The env of the model and the checks: `commandEnv`'s without the credential plumbing, on awaywork's global git config and no system one. */
export function workerEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  withheld: string[],
): NodeJS.ProcessEnv {
  const kept = Object.entries(commandEnv(env, dir, withheld)).filter(
    ([name]) => !credentialPlumbing.includes(name) && !gitConfigEntry.test(name),
  )
  return {
    ...Object.fromEntries(kept),
    GIT_CONFIG_GLOBAL: gitConfigFile(dir),
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

/** The env of the checks: `workerEnv`'s, git ignoring the clone's replace refs, and the slice's base as `AWAYWORK_FROM`. */
export function checkEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  withheld: string[],
  from?: string,
): NodeJS.ProcessEnv {
  return {
    ...workerEnv(env, dir, withheld),
    GIT_NO_REPLACE_OBJECTS: '1',
    ...(from && { AWAYWORK_FROM: from }),
  }
}

/**
 * The env of a gate's command and judge: a gate check's, on a global git config awaywork writes afresh from the steps'
 * identity and lfs filter, none of their edits, with no attributes file and no diff or textconv drivers, so the clone's
 * git shows it the slice as pushed, reading attributes from the chain's `start` rather than the worktree.
 */
export async function gateEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  withheld: string[],
  from?: string,
  start?: string,
): Promise<NodeJS.ProcessEnv> {
  const file = join(dir, WORK_DIR, 'gate-gitconfig')
  await refuseSymlinks(dir, [WORK_DIR])
  await rm(file, { recursive: true, force: true })
  await writeConfigFile(file, [
    ...(gitEntries.get(dir) ?? []),
    ['core.attributesFile', '/dev/null'],
  ])
  return {
    ...checkEnv(env, dir, withheld, from),
    ...(start && { GIT_ATTR_SOURCE: start }),
    GIT_CONFIG_GLOBAL: file,
  }
}
