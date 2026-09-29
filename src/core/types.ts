import type { z } from 'zod'

export interface PrRef {
  repo: string
  number: number
  url: string
  branch: string
  /** Opened by night-shift: its body carries the footer. */
  ours: boolean
  /** Opened by the developer, by hand or through night-shift. */
  mine: boolean
}

export interface Item {
  source: string
  id: string
  key: string
  type: 'pr' | 'issue' | 'task'
  title: string
  description: string
  url: string
  status: string
  assignee?: string
  reviewers: string[]
  labels: string[]
  comments: { author: string; body: string; at: string }[]
  /** A PR item links itself, so items sharing a PR dedupe into one unit. */
  linkedPrs: PrRef[]
  fields: Record<string, unknown>
  raw: unknown
}

export interface Ctx {
  env: NodeJS.ProcessEnv
  log(line: string): void
}

export interface Choice<T extends string = string> {
  value: T
  label?: string
  hint?: string
}

/** Questions `nightshift init` asks in the terminal; tests answer them from a script. */
export interface Ask {
  text(message: string, opts?: { initial?: string; placeholder?: string }): Promise<string>
  select<T extends string>(message: string, choices: Choice<T>[], initial?: T): Promise<T>
  multiselect<T extends string>(message: string, choices: Choice<T>[], initial?: T[]): Promise<T[]>
  confirm(message: string, initial?: boolean): Promise<boolean>
  /** Prompts for an unset secret and saves it to the env file; '' when skipped. */
  secret(name: string, message: string): Promise<string>
  note(message: string): void
}

export interface SourceSetup {
  /** The config as a user writes it. */
  config: Record<string, unknown>
  /** Values found for `where` fields, e.g. the user's real section names. */
  values?: Record<string, string[]>
}

export interface Source<C = unknown> {
  id: string
  configSchema: z.ZodObject
  /** What `where` may match on; each schema validates one scalar a rule compares against. */
  fields: Record<string, z.ZodType>
  secrets(cfg: C): string[]
  items(cfg: C, ctx: Ctx): Promise<Item[]>
  prefetch(item: Item, dir: string, ctx: Ctx): Promise<void>
  /** Asks what `nightshift init` needs to configure this source. */
  init?(ask: Ask, ctx: Ctx): Promise<SourceSetup>
}

export interface Quota {
  /** `used` is a share (0 to 1); `resetsAt` is in unix seconds. */
  windows: { name: string; span: 'short' | 'long'; used: number; resetsAt: number }[]
}

export type WorkerEvent =
  | { type: 'quota'; quota: Quota }
  | { type: 'log'; line: string }
  | { type: 'done'; ok: boolean; turns: number }

export interface Job {
  unit: Unit
  dir: string
  prompt: string
  maxTurns: number
  model?: string
  /** The worker's whole environment, from `workerEnv`: providers spawn with it and nothing else. */
  env: NodeJS.ProcessEnv
}

export interface Provider {
  id: string
  configSchema: z.ZodObject
  credential: 'static' | 'rotating'
  quota: 'window' | 'credits'
  unattended: 'allowed' | 'grey' | 'forbidden'
  /** The npm package that installs the binary on a runner. */
  package: string
  /** Env var names it reads unattended; locally a login may stand in. */
  secrets: string[]
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx: Ctx): Promise<Quota | null>
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  skillsDir: string
  instructionsFile: string
}

export interface Forge {
  clone(repo: string, branch: string, dir: string): Promise<void>
  prsFor(item: Item): Promise<PrRef[]>
  branchExists(repo: string, name: string): Promise<boolean>
  push(dir: string, branch: string, opts: { repo: string }): Promise<void>
  draftPr(
    repo: string,
    head: string,
    base: string,
    bodyFile: string,
    runId: string,
  ): Promise<string>
}

export type Scalar = string | number | boolean
export type Comparison = Partial<Record<'gt' | 'gte' | 'lt' | 'lte', number>>
export type WhereValue = Scalar | Scalar[] | { not: Scalar | Scalar[] } | Comparison

/** What a unit runs: a rule's own settings, or a step it chains after its unit. */
export interface Step {
  skill: string
  provider: string[]
  model?: Record<string, string>
  skills: string[]
  instructions: string[]
  deliver?: Deliver
  branch?: string
}

export interface Rule extends Step {
  source?: string
  where: Record<string, WhereValue>
  order?: Order
  /** Units run in turn after the rule's unit, each on what the one before delivered. */
  then?: Step[]
}

/** Which of a rule's items goes first; unset keeps the source's order. */
export type Order = 'oldest' | 'newest' | 'updated'

export interface Unit {
  id: string
  items: Item[]
  repo: string
  /** The linked PR's branch, or '' for the repo's default branch. */
  base: string
  /** `base` is a PR someone else opened: its in-repo config is the author's, not the developer's. */
  foreign: boolean
  branch: string
  rule: Step
  skill: string
  skills: string[]
  providers: string[]
  instructions: string[]
  deliver: Deliver
}

export type Deliver = 'draft_pr' | 'report'
