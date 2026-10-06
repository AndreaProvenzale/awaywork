import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import type { Config } from '../config/schema.js'
import type { Allowance } from '../core/budget.js'
import type { Ctx, Forge, Provider, Source, Unit } from '../core/types.js'
import { MAX_TURNS } from './night.js'
import type { Outcome } from './publish.js'
import { runWorker, type WorkerOptions, type WorkerResult } from './run.js'
import { runSetup } from './setup.js'
import { prepareWorkspace, WORK_DIR, workerEnv } from './workspace.js'

/** What a unit leaves in `units/<id>/replay.json` so it can be rebuilt: the clone's commit before any worker ran. */
export interface ReplayState {
  unit: Unit
  provider: string
  commit: string
  /** The unit it followed: its skill and what it delivered. */
  previous?: { skill: string; outcome?: Outcome }
}

export interface ReplayInput {
  config: Config
  configDir: string
  /** The past run's directory. */
  runDir: string
  unitId: string
  providers: Record<string, Provider>
  /** Only their secrets are used, to keep them from the worker. */
  sources: Record<string, Source>
  forge: Forge
  ctx: Ctx
  signal?: AbortSignal
  watch?: WorkerOptions['watch']
  skillDirs?: { user: string; builtin: string }
}

export interface ReplayResult extends WorkerResult {
  /** The clone, on the unit's branch, with whatever the worker committed. */
  dir: string
  /** Where the worker's `out/` was copied. */
  out: string
  commits: number
}

/**
 * Rebuilds a past unit from its run dir: the same base commit and saved context, today's skills and instructions.
 * Nothing is published; the clone stays under `replays/` in that run dir.
 */
export async function replayUnit(r: ReplayInput): Promise<ReplayResult> {
  const unitDir = join(r.runDir, 'units', r.unitId)
  const state: ReplayState = await readFile(join(unitDir, 'replay.json'), 'utf8').then(
    JSON.parse,
    () => {
      throw new Error(
        `unit ${r.unitId} has no replay.json in ${unitDir}: it ran before replay existed`,
      )
    },
  )
  const { unit } = state
  const provider = r.providers[state.provider]
  if (!provider) throw new Error(`provider ${state.provider} is not configured`)

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const root = join(r.runDir, 'replays', `${r.unitId}-${stamp}`)
  const dir = join(root, 'work')
  const plugin = join(root, 'plugin')
  await mkdir(root, { recursive: true })
  const log = (line: string) => r.ctx.log(line)
  await prepareWorkspace({
    ...r,
    unit,
    dir,
    provider,
    plugin,
    ctx: r.ctx,
    sources: {},
    previous: state.previous && { ...state.previous, out: '' },
    replay: { commit: state.commit, context: join(unitDir, 'context') },
  })
  const prompt = await readFile(join(dir, WORK_DIR, 'prompt.md'), 'utf8')

  const entry = r.config.providers.find((c) => c.id === state.provider)
  const secrets = [
    ...Object.values(r.providers).flatMap((p) => p.secrets),
    ...Object.entries(r.config.sources).flatMap(([id, cfg]) => r.sources[id]?.secrets(cfg) ?? []),
    ...(r.config.notify?.secrets ?? []),
    ...(r.config.after_unit?.secrets ?? []),
    ...Object.values(r.config.repos).flatMap((c) => c.secrets),
    ...Object.values(r.config.mcp).flatMap((s) => s.secrets),
  ]
  const withheld = secrets.filter((name) => !provider.secrets.includes(name))
  const setup = r.config.repos[unit.repo]?.setup
  if (setup && !unit.untrusted) {
    const failed = await runSetup(setup, dir, workerEnv(r.ctx.env, dir, secrets), log, {
      secrets: [],
      signal: r.signal,
    })
    if (failed) throw new Error(failed)
  }
  const allowance: Allowance = { kind: 'fallback', units: 1, turns: MAX_TURNS, reason: 'replay' }
  const job = {
    unit,
    dir,
    prompt,
    maxTurns: MAX_TURNS,
    model: unit.rule.model?.[state.provider] ?? entry?.model,
    env: workerEnv(r.ctx.env, dir, withheld),
    config: entry?.config,
    configDir: r.configDir,
    plugin,
  }
  const worker = await runWorker(provider, job, allowance, {
    log,
    signal: r.signal,
    maxMinutes: entry?.budget.unit_minutes,
    watch: r.watch,
  })
  const out = join(root, 'out')
  await cp(join(dir, WORK_DIR, 'out'), out, { recursive: true })
  await rm(plugin, { recursive: true, force: true })
  const commits = Number(
    (await execa('git', ['-C', dir, 'rev-list', '--count', `${state.commit}..HEAD`])).stdout,
  )
  return { ...worker, dir, out, commits }
}
