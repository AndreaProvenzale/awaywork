import { createWriteStream } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config/schema.js'
import { route, withQuota } from '../core/budget.js'
import { type NightPlan, slug } from '../core/foreman.js'
import type { NightReport, UnitResult } from '../core/report.js'
import type { Ctx, Forge, Provider, Quota, Source } from '../core/types.js'
import { publish } from './publish.js'
import { runWorker, type WorkerOptions } from './run.js'
import { runSetup } from './setup.js'
import { prepareWorkspace, WORK_DIR, workerEnv } from './workspace.js'

const MAX_TURNS = 200

export interface NightInput {
  config: Config
  configDir: string
  plan: NightPlan
  runId: string
  runDir: string
  dryRun: boolean
  /** Run only this unit, named by its id or an item key, in any case. */
  only?: string
  /** Start no unit from this time on, and stop the running one at it. */
  until?: Date
  providers: Record<string, Provider>
  sources: Record<string, Source>
  forge: Forge
  ctx: Ctx
  signal?: AbortSignal
  watch?: WorkerOptions['watch']
  skillDirs?: { user: string; builtin: string }
}

/**
 * Runs the plan's units one at a time, re-routing as windows fill, and publishes each.
 * Every unit leaves `units/<id>/` in the run dir: its context, prompt, output and worker log.
 */
export async function runNight(n: NightInput): Promise<NightReport> {
  const startedAt = new Date()
  const allowances = { ...n.plan.allowances }
  const routed: Record<string, number> = {}
  const quotas: Record<string, Quota> = {}
  const results: UnitResult[] = []
  const only = n.only && slug(n.only)
  const planned = n.plan.units.filter(
    (p) => !only || p.unit.id === only || p.unit.items.some((i) => slug(i.key) === only),
  )
  if (n.only && planned.length === 0) throw new Error(`no unit "${n.only}" in tonight's plan`)
  const secrets = [
    ...Object.values(n.providers).flatMap((p) => p.secrets),
    ...Object.entries(n.config.sources).flatMap(([id, cfg]) => n.sources[id]?.secrets(cfg) ?? []),
    ...(n.config.notify?.secrets ?? []),
    ...Object.values(n.config.repos).flatMap((r) => r.secrets),
  ]

  for (const p of planned) {
    const { unit } = p
    const skip = (reason: string) => results.push({ planned: p, status: 'skipped', reason })
    if (n.signal?.aborted) {
      skip('interrupted')
      continue
    }
    if (n.until && new Date() >= n.until) {
      skip('the night window ended')
      continue
    }
    const { provider: id, passed } = route(unit.providers, allowances, routed)
    const provider = id && n.providers[id]
    if (!id || !provider) {
      skip(`no provider left: ${passed.join('; ') || 'none configured'}`)
      continue
    }
    if (unit.deliver === 'draft_pr' && (await n.forge.branchExists(unit.repo, unit.branch))) {
      skip(`${unit.branch} already exists on ${unit.repo}`)
      continue
    }
    routed[id] = (routed[id] ?? 0) + 1
    const model = unit.rule.model?.[id] ?? n.config.providers.find((c) => c.id === id)?.model
    n.ctx.log(`${unit.id}: ${unit.skill} on ${id}${model ? ` (${model})` : ''}`)

    const unitDir = join(n.runDir, 'units', unit.id)
    const dir = join(n.runDir, 'work', unit.id)
    await mkdir(unitDir, { recursive: true })
    const logFile = createWriteStream(join(unitDir, 'worker.log'))
    const log = (line: string) => logFile.write(`${new Date().toISOString()} ${line}\n`)
    const result: UnitResult = { planned: p, provider: id, status: 'prepared' }
    results.push(result)
    try {
      const ctx = { ...n.ctx, log }
      const prompt = await prepareWorkspace({ ...n, unit, dir, provider, ctx })
      if (n.dryRun) continue
      const a = allowances[id]
      if (!a) continue
      const repo = n.config.repos[unit.repo]
      if (repo?.setup) {
        const failed = await runSetup(
          repo.setup,
          dir,
          setupEnv(n.ctx.env, dir, secrets, repo.secrets),
          log,
        )
        if (failed) {
          Object.assign(result, { status: 'skipped', reason: failed })
          continue
        }
      }
      const maxTurns = a.kind === 'fallback' ? a.turns : MAX_TURNS
      const withheld = secrets.filter((name) => !provider.secrets.includes(name))
      const env = workerEnv(n.ctx.env, dir, withheld)
      const job = { unit, dir, prompt, maxTurns, model, env }
      const worker = await runWorker(provider, job, a, {
        log,
        signal: n.signal,
        until: n.until,
        watch: n.watch,
      })
      Object.assign(result, worker)
      if (worker.quota) {
        quotas[id] = worker.quota
        allowances[id] = withQuota(a, worker.quota)
      }
      if (worker.status !== 'stopped: aborted')
        result.outcome = await publish(unit, dir, n.forge, n.runId)
    } catch (e) {
      Object.assign(result, { status: 'error', reason: (e as Error).message })
      log(`error: ${(e as Error).stack}`)
    } finally {
      await new Promise((done) => logFile.end(done))
      await cp(join(dir, WORK_DIR), unitDir, {
        recursive: true,
        filter: (src) => src !== join(dir, WORK_DIR, 'gh'),
      }).catch(() => {})
      if (!n.dryRun) await rm(dir, { recursive: true, force: true })
    }
    n.ctx.log(`${unit.id}: ${result.status}`)
  }

  const { runId, dryRun, plan } = n
  return { runId, dryRun, startedAt, finishedAt: new Date(), plan, results, quotas }
}

/** Like the worker's, with every secret withheld except the repo's own. */
function setupEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  secrets: string[],
  own: string[],
): NodeJS.ProcessEnv {
  const passed = own.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])
  return { ...workerEnv(env, dir, secrets), ...Object.fromEntries(passed) }
}
