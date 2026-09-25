import type { Forge } from '../core/types.js'
import { githubForge } from './github.js'

export const forges: Record<string, Forge> = { github: githubForge() }
