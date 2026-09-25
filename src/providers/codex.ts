import { z } from 'zod'
import { notImplemented } from '../core/not-implemented.js'
import type { Provider } from '../core/types.js'

export const codex: Provider = {
  id: 'codex',
  configSchema: z.strictObject({}),
  credential: 'rotating',
  quota: 'window',
  unattended: 'grey',
  detect: () => notImplemented('codex.detect', 'M7'),
  probe: () => notImplemented('codex.probe', 'M7'),
  run: () => notImplemented('codex.run', 'M7'),
  skillsDir: '.agents/skills',
  instructionsFile: 'AGENTS.md',
}
