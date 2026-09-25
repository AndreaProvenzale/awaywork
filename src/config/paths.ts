import { homedir } from 'node:os'
import { join } from 'node:path'

export const configDir = join(homedir(), '.config', 'night-shift')
export const defaultConfigPath = join(configDir, 'config.yml')
export const userSkillsDir = join(configDir, 'skills')
