import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitUnrestored, lostToWorker, workerHome } from '#core/isolation'
import type { Item } from '#core/types'
import type { PlannedUnit } from '#plan/foreman'
import type { PostState } from '#posts/comments'
import type { UnitResult } from '#posts/report'
import { bounded } from '#util/text'
import { copyOut, outputFile, reportsOnly, WORK_DIR } from '#worker/clone/files'
import { type Publisher, publishSlice } from '#worker/deliver/slice'
import type { Ready } from '#worker/units/ready'
import { delivered, leanText, leftBy, notReady, resultOf } from '#worker/units/results'
import type { Run } from '#worker/units/state'
import {
  commentRefused,
  moveItems,
  ownItems,
  pinOut,
  postPlan,
  postQuestions,
  postResult,
} from '#worker/units/writes'
import { judge } from './judge'
import { describeLoop } from './loop'
import { type ChainState, startChain } from './state'
import { runStep } from './step'

/** Puts what the PR's `.away/out/` holds besides its body in the store, from a copy out of the clone. */
const pin =
  (run: Run, { first, storeNotes }: ChainState): Publisher['pin'] =>
  async (clone) => {
    const { store } = run
    if (!store) return []
    const copy = await mkdtemp(join(tmpdir(), 'awaywork-pin-'))
    try {
      await copyOut(join(clone, WORK_DIR, 'out'), copy)
      return await pinOut(run, first, copy, [outputFile.report], storeNotes)
    } finally {
      await rm(copy, { recursive: true, force: true })
    }
  }

/** Publishes the chain once its last step ended. */
async function publishChain(run: Run, cs: ChainState) {
  const { input, publisher } = run
  const { done, first, base, deliver, shape, dir, chainDir, loops, reports, onDone, ownGates } = cs
  const lead = done.find(
    (r) => r.planned.unit.id === first.unit.id && r.status !== 'skipped' && !r.retried,
  )
  const out = join(chainDir, 'out')
  // A step the chain ended before also leaves it unfinished; one passed over by its `when` doesn't.
  const failed = done.find(
    (r) =>
      !r.retried &&
      (/^(failed|stopped|error)/.test(r.status) || (r.status === 'skipped' && !r.passedOver)),
  )
  // on_done writes only for a chain that finished: without commits, the rule's own gates run first.
  const writes =
    onDone &&
    !failed &&
    (!cs.ended || cs.ended.when) &&
    Object.values(loops).every((l) => l.held) &&
    ownItems(first).some((i) => !commentRefused(run, first, i))
  if (cs.from !== undefined && lead && cs.ran && !input.dryRun) {
    cs.publishedBy = lead
    if (Object.keys(loops).length) lead.loop = Object.values(loops).map(describeLoop).join('; ')
    cs.interrupted ||= !!input.signal?.aborted
    try {
      const kept = cs.interrupted
        ? 'interrupted'
        : lostToWorker(dir)
          ? 'the clone is lost to the worker user'
          : gitUnrestored(dir)
            ? "the clone's .git was refused"
            : cs.unmerged
      const askedOn = ownItems(first).find((i) => !commentRefused(run, first, i))
      // The footer records it even when no later run goes on, to hold dependents back; a one-off has none, and left nothing to go on from.
      const held = cs.leaves && !first.unit.oneOff ? { ...cs.leaves, url: askedOn?.url } : undefined
      lead.outcome = kept
        ? { kind: 'none', reason: kept, unpublished: true }
        : await publishSlice(
            { ...publisher, judge: judge(run, cs), pin: pin(run, cs) },
            {
              ...first.unit,
              ...shape,
              deliver,
              // A clean merge has nothing of a model's for gates to check.
              ...(cs.merged &&
                (cs.resolving
                  ? {
                      merged: cs.merged,
                      automatic: cs.resolving.automatic,
                      conflicted: cs.resolving.paths,
                    }
                  : { merged: cs.merged, gates: undefined })),
            },
            dir,
            cs.from,
            cs.original ?? cs.from,
            reports,
            loops,
            // Only a chain cut from the default branch, as the draft it resumes was, closes its issues.
            base === '' || (!!shape.resume && !shape.stackedOn),
            (failed && notReady(failed)) || cs.leaves?.byHand,
            held,
            writes ? ownGates : undefined,
          )
      // Its questions stay in the report only with a draft.
      if (cs.leaves?.byHand && lead.outcome.kind === 'pr')
        cs.finishByHand = `${cs.leaves.byHand}: finish ${lead.outcome.url} by hand`
      else if (
        cs.leaves?.byHand &&
        lead.outcome.kind === 'report' &&
        cs.leaves.status === 'continue'
      )
        cs.finishByHand = `${cs.leaves.byHand}: finish it by hand`
      if (cs.asked && lead.outcome.kind === 'none' && !lead.outcome.unpublished)
        lead.outcome = { kind: 'none', reason: 'asked questions' }
    } catch (e) {
      input.ctx.log(`${lead.planned.unit.id}: publish error: ${bounded((e as Error).stack ?? '')}`)
      await appendFile(
        join(chainDir, lead.step ?? '', 'worker.log'),
        `publish error: ${(e as Error).stack}\n`,
      ).catch(() => {})
      Object.assign(lead, { status: 'error', reason: (e as Error).message })
    } finally {
      if (!lostToWorker(dir)) await copyOut(join(dir, WORK_DIR, 'out'), out).catch(() => {})
    }
  }
  if (lead && (failed || !delivered(lead.outcome) || Object.values(loops).some((l) => !l.held)))
    cs.unfinished = true
}

/** Runs a chain's steps in one clone, then publishes it once and posts what it finished on its items. */
export async function runChain(
  run: Run,
  chain: PlannedUnit[],
  ready?: Partial<Ready>,
): Promise<UnitResult[]> {
  const { input } = run
  const cs = await startChain(run, chain, ready)
  const { done, first, deliver, dir, chainDir, reports, onDone, storeNotes } = cs
  for (let i = 0; i < chain.length; i += cs.retrying ? 0 : 1) await runStep(run, cs, i)
  await publishChain(run, cs)
  const lead = done.find((r) => !r.planned.chain && !r.retried)
  // Answers to a draft awaywork can't push onto would reach no later run.
  if (cs.asked && lead)
    lead.questions = {
      ...cs.asked,
      ...(cs.finishByHand
        ? { unposted: cs.finishByHand }
        : await postQuestions(run, first, cs.asked.text)),
    }
  else if (cs.finishByHand && lead) lead.byHand = cs.finishByHand
  // A unit that goes on isn't done: a report keeps its count in its result, a PR in its draft.
  const continues = cs.leaves?.status === 'continue'
  // A plan's or report's post waits, or goes ahead unless one of its gates fired, saying which ran clear.
  const outcome = cs.publishedBy?.outcome
  const gates = outcome?.kind === 'report' ? outcome.gates : undefined
  const decides = first.unit.waits !== undefined && !continues
  const waits = decides && (!!first.unit.waits || !!gates?.fired)
  const went: PostState | undefined =
    decides && !waits ? { went: true, gates: gates?.ran ?? [] } : undefined
  const out = join(chainDir, 'out')
  // Only what posts reads it, so only a post says it's missing.
  const summary = () =>
    first.unit.lean ? leanText(out, outcome, reports, storeNotes) : Promise.resolve(undefined)
  if (deliver === 'plan' && !cs.asked && lead?.outcome?.kind === 'report')
    lead.plan = await postPlan(
      run,
      first,
      lead.outcome.text,
      out,
      went,
      await summary(),
      storeNotes,
    )
  // The chain ran and published, and only a `when`, or a report's `continue`, ended it early; a plan rule's plan was posted.
  const finished =
    !cs.interrupted &&
    !cs.unfinished &&
    (!cs.ended || cs.ended.when || (continues && deliver === 'report')) &&
    !!cs.publishedBy
  const posted = deliver !== 'plan' || !!lead?.plan?.url
  if (lead && finished && posted && !input.dryRun && !input.signal?.aborted) {
    // A report task's result is how its card hears it's done, so it always posts one, as does a report that decides.
    const report = deliver === 'report' && decides
    if (
      onDone?.comment === 'result' ||
      (first.unit.items[0]?.task && reportsOnly(deliver)) ||
      report
    ) {
      const status = continues ? 'continue' : 'done'
      // A post that waits holds on_done's move until you approve it, while the card stays where it saw it; a card that can't move holds none.
      const holds = (item: Item) => !!onDone?.move && !!input.sources[item.source]?.write
      const post = report
        ? (item: Item): PostState =>
            went ?? {
              waits: true,
              ...(holds(item) && { move: onDone?.move as string, saw: item.status }),
            }
        : undefined
      const skipped: string[] = []
      const pins =
        deliver === 'report'
          ? await pinOut(run, first, out, [outputFile.report], storeNotes, undefined, skipped)
          : []
      // A lean post links its report: one whose put failed goes in the post whole, the gates' card with it; one the store skipped stays home.
      const whole =
        deliver === 'report' &&
        first.unit.lean &&
        ![...pins.map((pin) => pin.name), ...skipped].includes(outputFile.report)
      if (whole)
        storeNotes.push(`${outputFile.report} isn't in the store: the post shows all of it`)
      const text = (deliver === 'report' && !whole && (await summary())) || resultOf(outcome)
      lead.result = await postResult(run, first, text, status, cs.leaves?.continued, post, pins)
    }
    if (onDone?.move && !continues && !(report && waits))
      lead.moved = await moveItems(run, ownItems(first), onDone.move, lead.result)
  }
  if (lead && storeNotes.length) lead.store = storeNotes
  for (const r of done) {
    // A committing chain that committed nothing published its reports.
    const published = r === cs.publishedBy && r.outcome?.kind === 'report' ? 'report' : deliver
    Object.assign(r, await leftBy(input.runDir, first.unit.id, r, published, r === cs.publishedBy))
  }
  for (const path of [dir, workerHome(dir)])
    if (path && !input.dryRun && !lostToWorker(path))
      await rm(path, { recursive: true, force: true })
  return done
}
