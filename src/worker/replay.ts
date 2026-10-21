import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { bin } from '../config/paths.js'
import type { Config } from '../config/schema.js'
import { type Allowance, MAX_TURNS } from '../core/budget.js'
import { modelFor } from '../core/foreman.js'
import { contain, contained, isolated, workerHome, workerRoot } from '../core/launch.js'
import type { Ctx, Forge, Provider, Source, Unit } from '../core/types.js'
import { runWorker, type WorkerOptions, type WorkerResult } from './run.js'
import { runSetup } from './setup.js'
import {
  commandEnv,
  configSecrets,
  copyOut,
  inClone,
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
 * Under the run's isolation, and nothing is published; the clone stays under `replays/` in that run dir, or in `/tmp` under `user`.
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
  const image = r.config.repos[unit.repo]?.image
  if (contained() && !image)
    throw new Error(`no image for ${unit.repo}: isolation: container needs one in its repos entry`)

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const root = join(r.runDir, 'replays', `${r.unitId}-${stamp}-${randomBytes(2).toString('hex')}`)
  // The worker user can't reach the run dir: the clone and the plugin get folders of their own under /tmp.
  const dir = isolated() ? await workerRoot(0o700) : join(root, 'work')
  const plugins = isolated() ? await workerRoot() : root
  const plugin = join(plugins, 'plugin')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const secrets = configSecrets(r.config, r.providers, r.sources)
  if (contained() && image) contain(dir, { image, plugin, secrets })
  const log = (line: string) => r.ctx.log(line)
  const prompt = await prepareWorkspace({
    ...r,
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
    model: modelFor(unit.rule.model, state.provider) ?? entry?.model,
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
  // Your git in the clone kept for you runs none of the worker's hooks; a link is removed, not followed.
  await rm(join(dir, '.git', 'hooks'), { recursive: true, force: true })
  const out = join(root, 'out')
  await copyOut(join(dir, WORK_DIR, 'out'), out)
  await rm(plugin, { recursive: true, force: true })
  for (const path of [plugins, workerHome(dir)])
    if (path && path !== root) await rm(path, { recursive: true, force: true })
  const commits = Number(
    (await execa(bin('git'), [...inClone(dir), 'rev-list', '--count', `${state.commit}..HEAD`]))
      .stdout,
  )
  return { ...worker, dir, out, commits }
}
