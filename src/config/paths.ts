import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const configDir = join(homedir(), '.config', 'night-shift')
export const defaultConfigPath = join(configDir, 'config.yml')
export const userSkillsDir = join(configDir, 'skills')
export const envFile = join(configDir, 'env')

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
export const attemptsFile = join(stateDir, 'attempts.json')
