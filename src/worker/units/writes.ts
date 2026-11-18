import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Item } from '#core/types'
import type { PlannedUnit } from '#plan/foreman'
import { ruleThread } from '#plan/queue'
import {
  leanPlanComment,
  type PostState,
  planComment,
  questionsComment,
  resultComment,
  type Status,
} from '#posts/comments'
import { type Pin, pinBlock } from '#posts/footer'
import type { Commented, Moved, PlanPost, Posted, UnitResult } from '#posts/report'
import { type Kind, outFiles, putFiles } from '#posts/store'
import { notifyUnit } from '#run/notify'
import { type Threads, threaded, unwritable, writeItem } from '#sources/index'
import { checkPlan, contractName, contractText, PLAN_TASKS, planYaml } from '#tasks/plan-file'
import { bounded } from '#util/text'
import { outputFile, readOutput } from '#worker/clone/files'
import { maskSecrets } from '#worker/process/command'
import type { Run } from './state'

/** Under every tracker's comment limit as text; Jira's write also checks the longer ADF it sends. */
const MAX_COMMENT_BYTES = 30_000

/** Posts a finished unit's result on each of its items that is yours, saying what `post` says of it there; a write that fails is reported, never thrown. */
export async function postResult(
  run: Run,
  p: PlannedUnit,
  text: string,
  status: Status = 'done',
  continued = 0,
  post?: (item: Item) => PostState,
  pins: Pin[] = [],
): Promise<Commented[]> {
  const { input, secrets, event } = run
  const posted: Commented[] = []
  for (const item of ownItems(p)) {
    const source = input.sources[item.source]
    const refused = commentRefused(run, p, item)
    if (refused) {
      input.ctx.log(`${item.key} got no result, ${refused}`)
      continue
    }
    const ref = { item: `${item.source}:${item.key}` }
    if (Buffer.byteLength(text) > MAX_COMMENT_BYTES) {
      posted.push({ ...ref, failed: `the result is over ${MAX_COMMENT_BYTES} bytes` })
      continue
    }
    try {
      const state = post?.(item)
      const waits = !!state && 'waits' in state
      const write = {
        op: 'comment',
        body: `${resultComment(text, status, p.unit.skill, item.task?.id, continued, waits)}${pinBlock(pins)}`,
      } as const
      const cfg = input.config.sources[item.source]
      const { updated, url = item.url } = await writeItem(
        source,
        cfg,
        item,
        write,
        input.ctx,
        state,
        threadsOf(run, p),
      )
      input.ctx.log(`${item.key}: result posted on ${url}`)
      posted.push({ ...ref, url, ...(updated && { updated }), ...(state && { post: state }) })
    } catch (e) {
      const failed = bounded(maskSecrets((e as Error).message, secrets, input.ctx.env))
      event(`couldn't post the result on ${item.key}: ${failed}`)
      posted.push({ ...ref, failed })
    }
  }
  return posted
}

/** Moves each of a finished unit's items that is yours to `to`, after its result was `posted`; a write that fails is reported, never thrown. */
export async function moveItems(
  run: Run,
  items: Item[],
  to: string,
  posted: Commented[] = [],
): Promise<Moved[]> {
  const { input, secrets, event } = run
  const moved: Moved[] = []
  for (const item of items) {
    const source = input.sources[item.source]
    const refused = unwritable(item, source)
    const ref = { item: `${item.source}:${item.key}`, to }
    if (refused) {
      input.ctx.log(`on_done: ${item.key} not moved, ${refused}`)
      // Its posts went to its thread, so the report says the card stayed put.
      if (item.mine && item.thread) moved.push({ ...ref, failed: refused })
      continue
    }
    // The result's post is awaywork's own change: the move compares with the item as it left it.
    const after = posted.find((c) => c.item === ref.item)?.updated
    const read = after ? { ...item, fields: { ...item.fields, updated: after } } : item
    try {
      const write = { op: 'move', to } as const
      const cfg = input.config.sources[item.source]
      const { updated } = await writeItem(source, cfg, read, write, input.ctx)
      input.ctx.log(`on_done: moved ${item.key} to ${to}`)
      moved.push({ ...ref, ...(updated && { updated }) })
    } catch (e) {
      const failed = bounded(maskSecrets((e as Error).message, secrets, input.ctx.env))
      event(`on_done: couldn't move ${item.key} to ${to}: ${failed}`)
      moved.push({ ...ref, failed })
    }
  }
  return moved
}

/** A unit's items in one tracker's words: from the source of the item its rule matched first. */
export const ownItems = (p: PlannedUnit): Item[] =>
  p.unit.items.filter((i) => i.source === p.unit.items[0]?.source)

/** Where the unit's comments go instead of its items: their threads, opened for a rule with a `thread`. */
function threadsOf(run: Run, p: PlannedUnit): Threads {
  const { input } = run
  const rule = input.plan.queue[p.rule]
  return { forge: input.forge, sources: input.config.sources, open: rule && ruleThread(rule) }
}

/** Why awaywork won't comment on the unit's item, here or on its thread. */
export const commentRefused = (run: Run, p: PlannedUnit, item: Item): string | undefined =>
  p.unit.oneOff
    ? 'ran with --skill, which posts nothing on the item'
    : unwritable(item, run.input.sources[item.source], threaded(item, threadsOf(run, p)))

/**
 * Posts a comment on the first of the unit's own items that is yours, through a source that writes;
 * a post that fails is reported, never thrown. An item waiting for an answer made no unit.
 */
async function postComment(
  run: Run,
  p: PlannedUnit,
  what: string,
  body: (item: Item) => string,
  post?: PostState,
): Promise<Posted> {
  const { input, secrets, event } = run
  if (input.signal?.aborted) return { unposted: 'interrupted' }
  const item = ownItems(p).find((i) => !commentRefused(run, p, i))
  if (!item) {
    const top = p.unit.items[0] as Item
    return { unposted: `${top.key} ${commentRefused(run, p, top)}` }
  }
  const ref = `${item.source}:${item.key}`
  try {
    const write = { op: 'comment', body: body(item) } as const
    const cfg = input.config.sources[item.source]
    const { url = item.url } = await writeItem(
      input.sources[item.source],
      cfg,
      item,
      write,
      input.ctx,
      post,
      threadsOf(run, p),
    )
    input.ctx.log(`${p.unit.id}: ${what} posted on ${url}`)
    return { item: ref, url }
  } catch (e) {
    const failed = bounded(maskSecrets((e as Error).message, secrets, input.ctx.env))
    event(`${p.unit.id}: couldn't post its ${what} on ${item.key}: ${failed}`)
    return { item: ref, unposted: failed }
  }
}

export const postQuestions = async (run: Run, p: PlannedUnit, text: string) =>
  Buffer.byteLength(text) > MAX_COMMENT_BYTES
    ? { unposted: `questions.md is over ${MAX_COMMENT_BYTES} bytes` }
    : postComment(run, p, 'questions', (item) => questionsComment(text, item.task?.id))

/**
 * Puts the files of `out` a post of `p` pins in the store, if there's one, but those `inline` in the post unless it's lean;
 * a put that fails gets a line in `notes`, a file the store skips its name in `skipped`.
 */
export async function pinOut(
  run: Run,
  p: PlannedUnit,
  out: string,
  inline: string[],
  notes: string[],
  contract?: string,
  skipped: string[] = [],
): Promise<Pin[]> {
  const { input, secrets, store } = run
  if (!store || input.dryRun) return []
  const names = (await outFiles(out)).filter((name) => p.unit.lean || !inline.includes(name))
  const kind = (name: string): Kind =>
    name === 'plan.yml'
      ? 'plan'
      : name === outputFile.report
        ? 'report'
        : name === contract
          ? 'contract'
          : name
  const files = names.map((name) => ({ name, kind: kind(name) }))
  const item = (ownItems(p)[0] as Item).key
  const put = await putFiles(store, input.ctx.env, out, files, { item, unit: p.unit.id })
  skipped.push(...put.skipped)
  notes.push(...put.failed.map((line) => maskSecrets(line, secrets, input.ctx.env)))
  return put.pins
}

/**
 * Checks the chain's `plan.yml` in its `out` folder and posts it with the report and its contract, saying it went ahead
 * unless it waits, or, lean, its `summary` and tasks with those files pinned; a refused plan posts nothing.
 */
export async function postPlan(
  run: Run,
  p: PlannedUnit,
  report: string,
  out: string,
  post: PostState | undefined,
  summary: string | undefined,
  notes: string[],
): Promise<PlanPost> {
  const limits = p.unit.planLimits ?? { maxTasks: PLAN_TASKS }
  const yaml = await readOutput(join(out, 'plan.yml'))
  const file = checkPlan(yaml, limits)
  if ('problem' in file) return { unposted: `plan.yml: ${file.problem}` }
  const name = file.plan.contract && contractName(file.plan.contract)
  const text = name ? (await readOutput(join(out, name))).replace(/\r\n/g, '\n').trimEnd() : ''
  if (name && !text.trim())
    return { unposted: `plan.yml: contract ${file.plan.contract} is missing or empty` }
  const tasks = file.plan.tasks.map((t) => t.id)
  const inline = [outputFile.report, 'plan.yml', ...(name ? [name] : [])]
  const went = !!post && 'went' in post
  const tooLong = { tasks, unposted: `the plan comment is over ${MAX_COMMENT_BYTES} bytes` }
  if (summary !== undefined) {
    const lean = leanPlanComment(summary, file.plan.tasks, went)
    if (Buffer.byteLength(lean) > MAX_COMMENT_BYTES) return tooLong
    const pins = await pinOut(run, p, out, inline, notes, name || undefined)
    const missing = ['plan.yml', ...(name ? [name] : [])].find(
      (n) => !pins.some((pin) => pin.name === n),
    )
    if (missing) return { tasks, unposted: `${missing} isn't in the store` }
    const posted = await postComment(run, p, 'plan', () => `${lean}${pinBlock(pins)}`, post)
    return { tasks, ...posted, ...(posted.url && { post: post ?? { waits: true } }) }
  }
  const body = planComment(report, yaml, name ? { name, text } : undefined, went)
  // The plan an approve approves is the one the next run reads back, so it must be the file's.
  const read = checkPlan(planYaml(body), limits)
  if (!('plan' in read && isDeepStrictEqual(read.plan, file.plan)))
    return {
      unposted: `plan.yml doesn't read back from its comment: ${'problem' in read ? read.problem : 'it reads as another plan'}`,
    }
  if (name && contractText(body, name) !== text)
    return { unposted: `the contract ${name} doesn't read back from its comment` }
  if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) return tooLong
  const pins = await pinOut(run, p, out, inline, notes)
  const posted = await postComment(run, p, 'plan', () => `${body}${pinBlock(pins)}`, post)
  return { tasks, ...posted, ...(posted.url && { post: post ?? { waits: true } }) }
}

/** Runs notify for each step of a finished chain: its own output, and the chain's PR. Once interrupted, none starts. */
export async function notifyUnits(run: Run, chain: UnitResult[]) {
  const { input, secrets, event } = run
  const hook = input.config.notify
  if (!hook || input.dryRun) return
  const outcome = chain.find((r) => r.outcome)?.outcome
  const pr = outcome?.kind === 'pr' ? outcome.url : undefined
  for (const r of chain) {
    if (input.signal?.aborted) return
    const { id, skill, deliver, items, repo } = r.planned.unit
    const chainId = r.planned.chain ?? id
    const outDir = r.step && join(input.runDir, 'units', chainId, r.step, 'out')
    const out = outDir && join(outDir, outputFile[deliver])
    const failure = await notifyUnit(
      hook.command,
      {
        runId: input.runId,
        id,
        skill,
        status: r.status,
        items,
        repo,
        verdict: r.verdict,
        pr,
        report: out && existsSync(out) ? out : undefined,
        outDir: outDir && existsSync(outDir) ? outDir : undefined,
      },
      input.signal,
    )
    if (failure) event(`notify failed for ${id}: ${maskSecrets(failure, secrets, input.ctx.env)}`)
  }
}
