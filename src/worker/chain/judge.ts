import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { contain, contained } from '#core/isolation'
import { lostToWorker } from '#core/isolation/clones'
import type { Unit } from '#core/types'
import { modelFor, modelsFor, slug } from '#plan/foreman'
import { settingsFor } from '#plan/repos'
import { shellRefusal } from '#providers/sandbox'
import { MAX_TURNS, route, withQuota } from '#quota/budget'
import { gateEnv } from '#worker/clone/env'
import { prepareWorkspace, revealHidden } from '#worker/clone/workspace'
import type { Publisher } from '#worker/deliver/slice'
import { maskSecrets } from '#worker/process/command'
import { runWorker } from '#worker/process/worker'
import type { Run } from '#worker/units/state'
import { snapshot } from './handoff'
import type { ChainState } from './state'

/** Runs a gate's judge like a step, on the rule's providers and models, its worker log in the chain's `out/`. */
export const judge =
  (run: Run, cs: ChainState): Publisher['judge'] =>
  async (gate, skill, unit, dir, on, instructions) => {
    const { input, secrets, allowances, routed, quotas, root, restoreGit } = run
    const { done, chainDir } = cs
    // On a provider that ran a step of the chain, a judge rides on that step's fallback unit; elsewhere it takes one.
    const ranSlice = new Set(done.filter((r) => r.status !== 'skipped').map((r) => r.provider))
    const counted = Object.fromEntries(Object.entries(routed).filter(([p]) => !ranSlice.has(p)))
    const tries = (on: string) => modelsFor(unit.rule.model, on, input.config.providers)
    const { provider: id, passed, model: at } = route(unit.providers, allowances, counted, tries)
    const provider = id && input.providers[id]
    const a = id && allowances[id]
    if (!id || !provider || !a) return `no provider left: ${passed.join('; ') || 'none configured'}`
    const refused = await shellRefusal(provider, { dir }, input.signal)
    if (refused) return refused
    if (!ranSlice.has(id)) routed[id] = (routed[id] ?? 0) + 1
    const image = settingsFor(input.config.repos, unit.repo).image
    const entry = input.config.providers.find((c) => c.id === id)
    const model = modelFor(unit.rule.model, id, at) ?? entry?.model
    const name = `judge-${gate}-${slug(skill)}`
    input.ctx.log(`${unit.id}: gate ${gate}, ${skill} on ${id}${model ? ` (${model})` : ''}`)
    const out = join(chainDir, 'out')
    await mkdir(out, { recursive: true })
    const logFile = createWriteStream(join(out, `${name}.log`))
    const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
    const plugin = join(root, 'plugins', `${unit.id}-${name}`)
    const judged: Unit = {
      ...unit,
      skill,
      skills: [],
      deliver: 'report',
      foreign: true,
      untrusted: true,
      stackedOn: undefined,
      lean: undefined,
      network: undefined,
      writable: undefined,
      // The gate's own instructions, from the config: the rule's are written for the worker it judges.
      rule: {
        ...unit.rule,
        instructions,
        with: undefined,
        when: undefined,
        serve: undefined,
      },
    }
    let why: string | undefined
    // The judge's workspace hides the repo's config and skill from it; a clone that isn't untrusted gets them back after.
    const hides = !unit.untrusted && (provider.skillsDir || provider.repoConfig?.length)
    const found = hides ? await snapshot(dir) : undefined
    try {
      if (contained() && image) contain(dir, { image, plugin, secrets })
      const prompt = await prepareWorkspace({
        ...input,
        unit: judged,
        dir,
        plugin,
        provider,
        ctx: { ...input.ctx, log },
        reuse: true,
        judge: on,
        setupSkipped: unit.untrusted,
      })
      const withheld = secrets.filter((name) => !provider.secrets.includes(name))
      const job = {
        unit: judged,
        dir,
        prompt,
        maxTurns: a.kind === 'fallback' ? a.turns : MAX_TURNS,
        model,
        // Attributes as the gates read them: a resolved merge's from git's automatic merge.
        env: await gateEnv(input.ctx.env, dir, withheld, on.from, unit.automatic ?? cs.original),
        config: entry?.config,
        configDir: input.configDir,
        plugin,
      }
      const worker = await runWorker(provider, job, a, {
        log,
        signal: input.signal,
        until: input.until,
        maxMinutes: input.config.limits.unit_minutes,
        watch: input.watch,
      })
      if (worker.quota) {
        quotas[id] = worker.quota
        allowances[id] = withQuota(a, worker.quota, model)
      }
      if (worker.status !== 'done')
        why = maskSecrets(worker.reason ?? 'its worker failed', secrets, input.ctx.env)
    } catch (e) {
      why = (e as Error).message
      log(`error: ${(e as Error).stack}`)
    } finally {
      await new Promise((done) => logFile.end(done))
      await rm(plugin, { recursive: true, force: true })
    }
    if (lostToWorker(dir)) throw new Error('the clone is lost to the worker user')
    await restoreGit(dir)
    if (found) await revealHidden(dir, provider, skill, found.tree)
    return why
  }
