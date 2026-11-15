import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Item, Unit } from '#core/types'
import type { Attempts } from '#plan/attempts'
import { type PlannedUnit, slug, taskChain } from '#plan/foreman'
import { readBackPosts } from '#posts/posts'
import type { UnitResult } from '#posts/report'
import { readBack } from '#posts/store'
import { elsewhere, latestResult } from '#tasks/plan-file'
import { outputFile, readOutput, writeOutput } from '#worker/clone/files'
import type { Previous, Shipped } from '#worker/clone/workspace'
import { maskSecrets } from '#worker/process/command'
import type { Run } from './state'

/** The latest report an earlier run left on one of the items. */
async function earlierReport(
  items: Item[],
  attempts: Attempts,
  runsDir: string,
  thisRun: string,
): Promise<Previous | undefined> {
  for (const item of items) {
    const last = attempts[`${item.source}:${item.key}`]?.report
    if (!last || last.runId === thisRun) continue
    const out = join(runsDir, last.runId, 'units', last.unit, last.step, 'out')
    if ((await readOutput(join(out, outputFile.report))).trim())
      return { skill: last.skill, out, earlierRun: last.runId }
  }
}

/** What a chain starts from: the files its tasks in other repos ship, the folder of each item's files read back from the store, and what didn't come back. */
export interface Ready {
  shipped: Shipped[]
  pinned: Record<string, string>
  notes: string[]
}

/** A task's chain skipped, its loops' first rounds listed, e.g. because a task it waits on opened no PR, or never got to run. */
export function skipTask(chain: PlannedUnit[], reason: string): UnitResult[] {
  return chain
    .filter((p) => !p.loop || p.loop.round === 1)
    .map((planned) => ({ planned, status: 'skipped', reason }))
}

/** The latest report an earlier run left on the unit: from this machine's runs, else as its draft's body or its `continue` result on the item has it. */
export async function lastReport(
  run: Run,
  unit: Unit,
  chainDir: string,
): Promise<Previous | undefined> {
  const { input } = run
  const runs = dirname(input.runDir)
  const kept = await earlierReport(unit.items, input.attempts ?? {}, runs, input.runId)
  const { resume } = unit
  if (kept || (!resume && !unit.continued)) return kept
  const item = unit.items[0] as Item
  const text = resume
    ? await input.forge.prsOn(unit.repo, unit.base).then(
        (prs) => prs.find((pr) => pr.number === resume.number)?.body,
        (e: Error) => input.ctx.log(`${unit.id}: couldn't read ${resume.url}: ${e.message}`),
      )
    : latestResult(item)?.text
  if (!text?.trim()) return undefined
  const out = join(chainDir, 'earlier')
  await mkdir(out, { recursive: true })
  await writeOutput(join(out, outputFile.report), `${text.trim()}\n`)
  return { skill: unit.skill, out, left: resume?.url ?? item.url }
}

/** Why a task's chain can't start: a task it stacks on or waits for opened no PR in this run, or one of its card's posted what waits for you; else the files its tasks in other repos ship, from their PRs. */
export async function blocked(
  run: Run,
  head: PlannedUnit,
): Promise<{ skip: string } | { shipped: Shipped[] }> {
  const { input, opened, started, held, waiting } = run
  const item = head.unit.items[0] as Item
  const task = item.task
  const own = task?.plan.find((t) => t.id === task.id)
  if (!task || !own) return { shipped: [] }
  const chainOf = (id: string) => taskChain(input.plan.units, item, id)?.unit.id ?? ''
  const waited = [
    ...(head.after && task.onto ? [{ id: task.onto, chain: head.after }] : []),
    ...(head.waitsFor ?? []).map((id) => ({ id, chain: chainOf(id) })),
  ]
  const missing = input.dryRun ? undefined : waited.find(({ chain }) => !opened[chain])
  if (missing)
    return {
      skip: `${missing.id} ${held.has(missing.chain) ? `left a draft that says ${held.get(missing.chain)}` : started.has(missing.chain) ? 'opened no PR' : "didn't run"}`,
    }
  const post = waiting.get(`${item.source}:${task.parent.key}`)
  if (post) return { skip: post }
  const shipped: Shipped[] = []
  for (const dep of elsewhere(own, task.plan).filter((t) => t.ships?.length)) {
    const pr = task.parent.taskPrs?.[dep.id]
    const ran = opened[chainOf(dep.id)]
    // An open PR's branch is its head now; a merged one's may be deleted.
    const at = pr
      ? { repo: pr.repo, ref: pr.state === 'open' ? pr.branch : (pr.head ?? pr.branch) }
      : ran && { repo: ran.repo, ref: ran.head }
    if (!at) {
      input.ctx.log(
        `${head.unit.id}: prepared without ${dep.id}'s files; a real run reads them from its PR`,
      )
      continue
    }
    for (const path of dep.ships ?? []) {
      const text = await input.forge
        .fileAt(at.repo, at.ref, path)
        .catch((e: Error) => ({ failed: e.message }))
      if (text === undefined) return { skip: `${dep.id}'s PR has no ${path}` }
      if (typeof text !== 'string')
        return { skip: `couldn't read ${path} from ${dep.id}'s PR: ${text.failed}` }
      shipped.push({ task: dep.id, path, text })
    }
  }
  return { shipped }
}

/** Reads back the files of the posts each of a chain's items holds for its first step, into the chain's `files/` in the run dir; why it can't start when a get fails. */
export async function readPosts(
  run: Run,
  head: PlannedUnit,
  shipped: Shipped[],
): Promise<{ skip: string } | Ready> {
  const { input, secrets, store } = run
  const ready: Ready = { shipped, pinned: {}, notes: [] }
  if (!store) return ready
  for (const item of head.unit.items) {
    const posts = readBackPosts(item, head.unit.skill, head.unit.deliver === 'plan')
    if (!posts.length) continue
    const dir = join(input.runDir, 'units', head.unit.id, 'files', slug(item.key))
    try {
      const notes = await readBack(store, input.ctx.env, posts, dir)
      ready.notes.push(...notes.map((n) => maskSecrets(n, secrets, input.ctx.env)))
    } catch (e) {
      return { skip: maskSecrets((e as Error).message, secrets, input.ctx.env) }
    }
    ready.pinned[item.key] = dir
  }
  return ready
}
