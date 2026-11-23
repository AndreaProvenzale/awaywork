import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROFILE, readRegistry, resolveProfile } from './profiles'

export const configDir = join(homedir(), '.config', 'awaywork')
export const profilesPath = join(configDir, 'profiles.yml')
export const profile = (() => {
  try {
    return resolveProfile(process.env.AWAYWORK_PROFILE, readRegistry(profilesPath))
  } catch (e) {
    return { name: DEFAULT_PROFILE, problem: (e as Error).message }
  }
})()
/** The config in use when neither `--config` nor `AWAYWORK_CONFIG` says: the profile's, else `config.yml`. */
export const defaultConfigPath = profile.config ?? join(configDir, 'config.yml')
export const legacyEnvFile = join(configDir, 'env')
const dotEnv = join(dirname(defaultConfigPath), '.env')
/** The profile's secrets, beside its config; the default profile's older `env` still counts until a `.env` exists. */
export const envFile =
  profile.name === DEFAULT_PROFILE && !existsSync(dotEnv) && existsSync(legacyEnvFile)
    ? legacyEnvFile
    : dotEnv

/** The user's skills: `skills/` beside the config in use. */
export const skillsDirIn = (dir: string) => join(dir, 'skills')
export const skillsDirOf = (configPath: string) => skillsDirIn(dirname(configPath))

/** The installed package's root, from src/ in development or dist/ once bundled. */
function packageRoot(dir = dirname(fileURLToPath(import.meta.url))): string {
  if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) return dir
  return packageRoot(dirname(dir))
}

export const harnessPath = join(packageRoot(), 'harness.md')
export const builtinSkillsDir = join(packageRoot(), 'skills')
export const dockerDir = join(packageRoot(), 'docker')
/** The Claude Code plugin the package ships, for a `--plugin-dir` session. */
export const pluginDir = join(packageRoot(), 'plugin')
export const packageVersion: string = JSON.parse(
  readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
).version

/** What every profile shares, like the lock on `~/.codex`. */
export const rootStateDir = join(homedir(), '.local', 'state', 'awaywork')
export const stateDir =
  profile.name === DEFAULT_PROFILE ? rootStateDir : join(rootStateDir, 'profiles', profile.name)
export const runsDir = join(stateDir, 'runs')
/** Runs downloaded from a control repo's artifacts, as `<owner>/<repo>/<run id>`. */
export const remoteDir = join(stateDir, 'remote')
export const attemptsPath = join(stateDir, 'attempts.json')
export const runLockPath = join(stateDir, 'run.lock')
export const watchLockPath = join(stateDir, 'watch.lock')
/** What `awaywork watch` is doing, for `schedule status`. */
export const watchStatePath = join(stateDir, 'watch.json')
/** The end of the last window `awaywork watch` ran, so a restart inside it starts no second run. */
export const windowEndPath = join(stateDir, 'window-end.json')
export const watchLogPath = join(stateDir, 'watch.log')
export const skipsPath = join(stateDir, 'skips.json')
export const pausePath = join(stateDir, 'pause.json')

const bins = new Map<string, string>()

/**
 * `name`'s absolute path on PATH, looked up once, or `name` when it isn't there. On macOS,
 * libuv spawns a bare name by trying each PATH entry in turn, tens of ms a spawn with a long PATH.
 */
export function bin(name: string): string {
  let path = bins.get(name)
  if (!path) {
    path =
      (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(dir, name))
        .find(isExecutableFile) ?? name
    bins.set(name, path)
  }
  return path
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
