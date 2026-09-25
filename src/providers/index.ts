import type { Provider } from '../core/types.js'
import { claude } from './claude.js'
import { codex } from './codex.js'

export const providers: Record<string, Provider> = { claude, codex }
