import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ctx, Job, Provider, WorkerEvent } from '../../src/core/types.js'

const ctx: Ctx = { env: {}, log: () => {} }

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const all: WorkerEvent[] = []
  for await (const e of events) all.push(e)
  return all
}

/**
 * Every provider adapter must pass this suite; `job` builds a small job it can run. `exempt` names
 * the checks that don't apply to it, each with the reason.
 */
export function providerContract(
  provider: Provider,
  job: () => Job,
  exempt: { emptyConfig?: string; package?: string } = {},
): void {
  describe(`provider contract: ${provider.id}`, () => {
    it('declares a usable id, config and file locations', () => {
      expect(provider.id).toMatch(/^[a-z][a-z0-9-]*$/)
      if (!exempt.emptyConfig) expect(provider.configSchema.safeParse({}).success).toBe(true)
      if (provider.skillsDir) expect(isAbsolute(provider.skillsDir)).toBe(false)
      expect(provider.instructionsFile).not.toBe('')
      if (!exempt.package) expect(provider.package).not.toBe('')
      for (const name of provider.secrets) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
    })

    it('detects its binary', async () => {
      const found = await provider.detect()
      expect(typeof found.installed).toBe('boolean')
    })

    it('probes quota as shares of each window, or null', async () => {
      const quota = await provider.probe(ctx)
      for (const w of quota?.windows ?? []) {
        expect(w.used).toBeGreaterThanOrEqual(0)
        expect(w.used).toBeLessThanOrEqual(1)
        expect(['short', 'long']).toContain(w.span)
      }
    })

    it('ends a run with exactly one done event', async () => {
      const events = await collect(provider.run(job(), new AbortController().signal))
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('done')
    })

    it('stops when aborted', async () => {
      const abort = new AbortController()
      abort.abort()
      const events = await collect(provider.run(job(), abort.signal))
      expect(events.at(-1)).toMatchObject({ type: 'done', ok: false })
    })
  })
}
