import { z } from 'zod'
import { notImplemented } from '../core/not-implemented.js'
import type { Provider } from '../core/types.js'

export const claude: Provider = {
  id: 'claude',
  configSchema: z.strictObject({}),
  credential: 'static',
  quota: 'window',
  unattended: 'allowed',
  detect: () => notImplemented('claude.detect', 'M3'),
  probe: () => notImplemented('claude.probe', 'M3'),
  run: () => notImplemented('claude.run', 'M3'),
  skillsDir: '.claude/skills',
  instructionsFile: 'CLAUDE.md',
}
