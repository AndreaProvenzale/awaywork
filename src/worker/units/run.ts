import { rm } from 'node:fs/promises'
import { lostToWorker } from '#core/isolation/clones'
import { holdingWorker, isolated } from '#core/isolation/index'
import { workerRoot } from '#core/isolation/user'
import type { Item, Quota } from '#core/types'
import { namesUnit, type PlannedUnit, type RunPlan } from '#plan/foreman'
import type { RunReport, UnitResult } from '#posts/report'
import type { Store } from '#posts/store'
import { bounded } from '#util/text'
import { runChain } from '#worker/chain/run'
import { configSecrets } from '#worker/clone/context'
import type { Publisher } from '#worker/deliver/slice'
import { createChecks } from '#worker/process/checks'
import { blocked, readPosts, skipTask } from './ready'
import { triedLater } from './results'
import type { Run, RunInput } from './state'
import { notifyUnits } from './writes'

/** The chains `name` names by a unit id or an item, in any case: each chain's first step. */
export function namedChains(plan: RunPlan, name: string): PlannedUnit[] {
  const heads = plan.units
    .filter((p) => namesUnit(p.unit.id, p.unit.items, name))
    .map((p) => p.chain ?? p.unit.id)
  return plan.units.filter((p) => !p.chain && heads.includes(p.unit.id))
}

/**
 * Runs the plan's chains one at a time, re-routing as windows fill. A rule's steps all work in one
 * clone, and the chain publishes once, when it ends: its commits as a PR or a push onto your PR,
 * else its reports. A PR stacks on the awaywork PR a rule took up, or on the task's it stacks on.
 * Every step leaves `units/<id>/<n>-<skill>/` in the run dir: its context, prompt, output and worker
 * log; what the chain published is in `units/<id>/out/`.
 */
export async function runUnits(input: RunInput): Promise<RunReport> {
  const startedAt = new Date()
  const allowances = { ...input.plan.allowances }
  const routed: Record<string, number> = {}
  const quotas: Record<string, Quota> = {}
  const event = (line: string) => (input.event ?? input.ctx.log)(line)
  const results: UnitResult[] = []
  const named = input.only ? namedChains(input.plan, input.only) : []
  if (input.only && named.length !== 1)
    throw new Error(`"${input.only}" names ${named.length} units in this run's plan, not one`)
  // A step needs its whole chain.
  const chains = input.plan.units
    .filter((p) => !p.chain && (!input.only || named.includes(p)))
    .map((head) => [head, ...input.plan.units.filter((p) => p.chain === head.unit.id)])
  const secrets = configSecrets(input.config, input.providers, input.sources)
  const store = input.config.store as Store | undefined
  // The worker user can't reach the run dir: its plugins and each clone get a folder of their own under /tmp.
  const root = isolated() ? await workerRoot() : input.runDir

  const checks = createChecks({
    env: input.ctx.env,
    secrets,
    signal: input.signal,
    until: input.until,
  })
  const publisher: Omit<Publisher, 'judge' | 'pin'> = {
    forge: input.forge,
    runId: input.runId,
    signal: input.signal,
    check: checks.check,
  }
  const run: Run = {
    input,
    event,
    secrets,
    store,
    root,
    allowances,
    routed,
    quotas,
    ...checks,
    publisher,
    opened: {},
    started: new Set(),
    held: new Map(),
    waiting: new Map(),
  }

  try {
    const turn = input.turn ?? ((chain) => chain())
    for (const chain of chains) {
      const head = chain[0] as PlannedUnit
      const onto = head.after && run.opened[head.after]
      if (head.after && input.dryRun)
        input.ctx.log(
          `${head.unit.id}: prepared from the default branch; a real run clones ${head.unit.items[0]?.task?.onto}'s branch`,
        )
      const blocker = await blocked(run, head)
      const ready = 'skip' in blocker ? blocker : await readPosts(run, head, blocker.shipped)
      const done =
        'skip' in ready
          ? skipTask(chain, ready.skip)
          : await turn(() => {
              const chained = () =>
                runChain(
                  run,
                  onto
                    ? chain.map((p) => ({
                        ...p,
                        unit: { ...p.unit, base: onto.branch, stackedOn: onto.url },
                      }))
                    : chain,
                  ready,
                )
              return input.dryRun
                ? chained()
                : holdingWorker(chained, (line) => input.ctx.log(`${head.unit.id}: ${line}`), {
                    signal: waitSignal(input.signal, input.until),
                  }).then(
                    (done) =>
                      done ??
                      skipTask(chain, input.signal?.aborted ? 'interrupted' : 'the window ended'),
                  )
            })
      if (done.some((r) => r.status !== 'skipped')) run.started.add(head.unit.id)
      const lead = done.find((r) => !r.planned.chain && !r.retried)
      const of = head.unit.items[0] as Item
      const card = `${of.source}:${of.task?.parent.key}`
      if (of.task && lead?.questions?.url)
        run.waiting.set(card, `${of.task.id}'s questions wait for your answer`)
      else if (of.task && lead?.result?.some((c) => c.post && 'waits' in c.post))
        run.waiting.set(card, `${of.task.id}'s result waits for your approval`)
      // A draft that waits for a later run holds half-done work: nothing stacks on it.
      if (lead?.outcome?.kind === 'pr' && lead.outcome.held)
        run.held.set(head.unit.id, lead.outcome.held)
      else if (lead?.outcome?.kind === 'pr')
        run.opened[head.unit.id] = {
          repo: lead.planned.unit.repo,
          branch: lead.planned.unit.branch,
          url: lead.outcome.url,
          head: lead.outcome.head,
        }
      for (const r of done) {
        if (r.reason) r.reason = bounded(r.reason)
        if (r.loop) r.loop = bounded(r.loop)
      }
      results.push(...done)
      await notifyUnits(
        run,
        done.filter((r) => !r.retried && !(input.soon && triedLater(r))),
      )
    }
  } finally {
    if (root !== input.runDir && !input.dryRun && !lostToWorker(root))
      await rm(root, { recursive: true, force: true })
  }

  const { runId, dryRun, plan } = input
  const models = Object.fromEntries(
    Object.entries(allowances).flatMap(([id, a]) =>
      a.kind === 'quota' && a.models ? [[id, a.models]] : [],
    ),
  )
  const finishedAt = new Date()
  const scoped = Object.keys(models).length > 0 && { models }
  return { runId, dryRun, startedAt, finishedAt, plan, results, quotas, ...scoped }
}

/** What ends a wait for the worker lock: the run's signal or the window's end. */
function waitSignal(signal?: AbortSignal, until?: Date): AbortSignal | undefined {
  const ends = [signal, until && AbortSignal.timeout(Math.max(0, until.getTime() - Date.now()))]
  const set = ends.filter((s) => s !== undefined)
  return set.length ? AbortSignal.any(set) : undefined
}
