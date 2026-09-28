import { z } from 'zod'
import type { Provider, Quota, WorkerEvent } from '../../src/core/types.js'

const quota: Quota = {
  windows: [
    { name: 'five_hour', span: 'short', used: 0.02, resetsAt: 1790254200 },
    { name: 'seven_day', span: 'long', used: 0.36, resetsAt: 1790391600 },
  ],
}

export function fakeProvider(id = 'fake'): Provider {
  return {
    id,
    configSchema: z.strictObject({}),
    credential: 'static',
    quota: 'window',
    unattended: 'allowed',
    package: 'fake-agent',
    secrets: ['FAKE_AGENT_TOKEN'],
    detect: async () => ({ installed: true, version: '1.0.0' }),
    probe: async () => quota,
    async *run(job, signal): AsyncIterable<WorkerEvent> {
      for (let turn = 1; turn <= job.maxTurns; turn++) {
        if (signal.aborted) return yield { type: 'done', ok: false, turns: turn - 1 }
        yield { type: 'log', line: `turn ${turn}` }
        yield { type: 'quota', quota }
      }
      yield { type: 'done', ok: true, turns: job.maxTurns }
    },
    skillsDir: '.fake/skills',
    instructionsFile: 'FAKE.md',
  }
}
