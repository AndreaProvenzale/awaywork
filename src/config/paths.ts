import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const configDir = join(homedir(), '.config', 'night-shift')
export const defaultConfigPath = join(configDir, 'config.yml')
export const envFile = join(configDir, 'env')

/** The user's skills: `skills/` beside the config in use. */
export const skillsDirIn = (configDir: string) => join(configDir, 'skills')
export const skillsDirOf = (configPath: string) => skillsDirIn(dirname(configPath))

/** The installed package's root, from src/ in development or dist/ once bundled. */
function packageRoot(dir = dirname(fileURLToPath(import.meta.url))): string {
  if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) return dir
  return packageRoot(dirname(dir))
}

export const harnessPath = join(packageRoot(), 'harness.md')
export const builtinSkillsDir = join(packageRoot(), 'skills')
export const packageVersion: string = JSON.parse(
  readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
).version

export const stateDir = join(homedir(), '.local', 'state', 'night-shift')
export const runsDir = join(stateDir, 'runs')
export const attemptsPath = join(stateDir, 'attempts.json')
export const skipsPath = join(stateDir, 'skips.json')

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
