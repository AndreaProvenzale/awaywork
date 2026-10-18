import { randomBytes } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { type Allowance, MAX_TURNS } from '../core/budget.js'
import type { Ctx, Forge, Provider, Source, Unit } from '../core/types.js'
import { runWorker, type WorkerOptions, type WorkerResult } from './run.js'
import { runSetup } from './setup.js'
import {
  commandEnv,
  configSecrets,
  notSymlink,
  prepareWorkspace,
  restoreGitConfig,
  WORK_DIR,
  workerEnv,
} from './workspace.js'

/** What a chain's first step leaves in `units/<id>/1-<skill>/replay.json` so it can be rebuilt: the clone's commit before any worker ran. */
export interface ReplayState {
  unit: Unit
  provider: string
  commit: string
}

interface ReplayInput {
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

interface ReplayResult extends WorkerResult {
  /** The clone, on the unit's branch, with whatever the worker committed. */
  dir: string
  /** Where the worker's `out/` was copied. */
  out: string
  commits: number
}

/**
 * Rebuilds a past unit's first step from its run dir: the same base commit and saved context, today's skills and instructions.
 * Nothing is published; the clone stays under `replays/` in that run dir.
 */
export async function replayUnit(r: ReplayInput): Promise<ReplayResult> {
  const chainDir = join(r.runDir, 'units', r.unitId)
  const first = (await readdir(chainDir).catch(() => [])).find((name) => name.startsWith('1-'))
  const unitDir = join(chainDir, first ?? '')
  const raw = await readFile(join(unitDir, 'replay.json'), 'utf8').catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
      throw new Error(
        `no replay.json in ${chainDir}: the unit never started, the run or unit id is wrong, or the run predates replay; only a unit's first step replays, not a later step of its chain`,
      )
    },
  )
  const state: ReplayState = JSON.parse(raw)
  const { unit } = state
  const provider = r.providers[state.provider]
  if (!provider) throw new Error(`provider ${state.provider} is not configured`)

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const root = join(r.runDir, 'replays', `${r.unitId}-${stamp}-${randomBytes(2).toString('hex')}`)
  const dir = join(root, 'work')
  const plugin = join(root, 'plugin')
  await mkdir(root, { recursive: true })
  const log = (line: string) => r.ctx.log(line)
  const secrets = configSecrets(r.config, r.providers, r.sources)
  const prompt = await prepareWorkspace({
    ...r,
    secrets,
    unit,
    dir,
    provider,
    plugin,
    ctx: r.ctx,
    sources: {},
    replay: { commit: state.commit, context: join(unitDir, 'context') },
  })

  const entry = r.config.providers.find((c) => c.id === state.provider)
  const withheld = secrets.filter((name) => !provider.secrets.includes(name))
  const gitConfig = await readFile(join(dir, '.git', 'config'), 'utf8')
  const setup = r.config.repos[unit.repo]?.setup
  if (setup && !unit.untrusted) {
    const failed = await runSetup(setup, dir, commandEnv(r.ctx.env, dir, secrets), log, {
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
    maxMinutes: r.config.limits.unit_minutes,
    watch: r.watch,
  })
  await restoreGitConfig(dir, gitConfig)
  const out = join(root, 'out')
  await cp(join(dir, WORK_DIR, 'out'), out, { recursive: true, filter: notSymlink })
  await rm(plugin, { recursive: true, force: true })
  const commits = Number(
    (await execa(bin('git'), ['-C', dir, 'rev-list', '--count', `${state.commit}..HEAD`])).stdout,
  )
  return { ...worker, dir, out, commits }
}
