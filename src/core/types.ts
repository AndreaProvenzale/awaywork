import type { z } from 'zod'

export interface PrRef {
  repo: string
  number: number
  url: string
  branch: string
  /** Its branch's head commit, when the source reads it. */
  head?: string
  /** Opened by night-shift: its body carries the footer. */
  ours: boolean
  /** Opened by the developer, by hand or through night-shift. */
  mine: boolean
  /** Its author has write access or org membership; always, when it's mine. */
  trusted: boolean
  /** Its branch lives on a fork, not in `repo`. */
  fork: boolean
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
  /** The line a PR body carries to link this item, rendered from its source's `link`. */
  link?: string
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
  /**
   * The default `link` template: how the tracker links a PR from its body, e.g. `Part of {key}`;
   * false when its items link their PRs themselves, so there is no `link` to configure.
   */
  link?: string | false
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
  /** The provider's entry in the config; its relative paths resolve against `configDir`. */
  config?: Record<string, unknown>
  configDir?: string
  /** A plugin folder outside the clone with the unit's skills when the provider has no `skillsDir`. */
  plugin?: string
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
  /** Where the binary finds skills in the clone; unset, they come in `Job.plugin`. */
  skillsDir?: string
  instructionsFile: string
}

export interface Forge {
  clone(repo: string, branch: string, dir: string): Promise<void>
  prsFor(item: Item): Promise<PrRef[]>
  branchExists(repo: string, name: string): Promise<boolean>
  /** PRs whose head is `branch` in the repo, not a fork, open, closed or merged. */
  prsOn(repo: string, branch: string): Promise<{ url: string; body: string }[]>
  /** The message of the commit at the tip of `branch` in the repo. */
  tipMessage(repo: string, branch: string): Promise<string>
  push(dir: string, branch: string, opts: { repo: string }): Promise<void>
  /**
   * Pushes HEAD onto PR `pr`'s branch, only while the PR is yours, open, in the repo, without
   * auto-merge, and still at `from`, and the branch is unprotected and backs no one else's PR;
   * never forced.
   */
  fastForward(
    dir: string,
    branch: string,
    from: string,
    opts: { repo: string; pr: number },
  ): Promise<void>
  draftPr(
    repo: string,
    head: string,
    base: string,
    bodyFile: string,
    runId: string,
    items: Pick<Item, 'source' | 'key'>[],
  ): Promise<string>
}

export type Scalar = string | number | boolean
export type Comparison = Partial<Record<'gt' | 'gte' | 'lt' | 'lte', number>>
/** Spans like `3d`: a number and m, h, d or w. */
export type Age = Partial<Record<'older_than' | 'newer_than', string>>
/** A case-insensitive regular expression tested against text. */
export interface Match {
  matches: string
}
export type WhereValue = Scalar | Scalar[] | { not: Scalar | Scalar[] } | Comparison | Age | Match

/** What a unit runs: a rule's own settings, or a step it chains after its unit. */
export interface Step {
  skill: string
  provider: string[]
  model?: Record<string, string>
  skills: string[]
  instructions: string[]
  /** Parameters listed in the prompt next to the skill. */
  with?: Record<string, Scalar>
  deliver?: Deliver
  branch?: string
  /** A `then` or loop step runs only when this holds, checked in its clone before the worker. */
  when?: Condition
}

/** What a loop checks after each of its steps, or a step before it runs; every key set must hold. */
export interface Condition {
  /** The latest verdict a step of the loop wrote, or for `when` the step before's. */
  verdict?: Scalar | Scalar[] | { not: Scalar | Scalar[] }
  /** A shell command night-shift runs in the clone, outside the model; exit 0 holds. */
  command?: string
  /** `when` only: globs, holding when the chain's commits change a matching path, against where the chain started. */
  changed?: string[]
}

/** Steps run round after round in one clone, until `until` holds or `max` rounds ran; one publish at the end. */
export interface Loop {
  loop: Step[]
  until: Condition
  max: number
}

export interface Rule extends Step {
  source?: string
  where: Record<string, WhereValue>
  order?: Order
  units?: number
  /** Units run in turn after the rule's unit, each on what the one before delivered. */
  then?: (Step | Loop)[]
  /** Whether the worker's commands, then steps included, may reach the network; unset takes the repo's. */
  network?: boolean
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
  /** `base` is a PR by an author without write access or org membership: setup doesn't run on it. */
  untrusted: boolean
  /** Whether the worker's commands may reach the network. */
  network: boolean
  /** The URL of the night-shift PR whose branch `base` is: tonight's draft PR, or one a rule took up again. */
  stackedOn?: string
  branch: string
  rule: Step
  skill: string
  skills: string[]
  providers: string[]
  instructions: string[]
  deliver: Deliver
}

export type Deliver = 'draft_pr' | 'report' | 'push'
