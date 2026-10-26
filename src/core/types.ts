import type { z } from 'zod'
import type { Status } from './footer.js'
import type { Contract, PlanLimits } from './plan.js'

/** Puts the machine's own login in the worker's `home` before a phase; what it returns saves it back after, told whether `home` is the developer's again, and logs a save it refuses. */
export type Login = (
  home: string,
  log?: (line: string) => void,
) => Promise<(back: boolean) => Promise<void>>

export interface PrRef {
  repo: string
  number: number
  url: string
  branch: string
  /** Its branch's head commit, when the source reads it. */
  head?: string
  /** Opened by awaywork: its body carries the footer. */
  ours: boolean
  /** Opened by the developer, by hand or through awaywork. */
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
  /** `mine` when your own account wrote it and nobody else edited it since. */
  comments: { author: string; body: string; at: string; mine?: true; bot?: true }[]
  /** A PR item links itself, so items sharing a PR dedupe into one unit. */
  linkedPrs: PrRef[]
  /** The line a PR body carries to link this item, rendered from its source's `link`. */
  link?: string
  fields: Record<string, unknown>
  /** Yours: your PR, or an item assigned to you; awaywork writes only to these. */
  mine?: true
  /** A task of the plan approved on the card `parent`: awaywork makes it, and writes to the card for it. */
  task?: {
    parent: Item
    id: string
    skill: string
    /** The lines under your `approve`. */
    notes: string
    /** The plan's tasks, this one too, with what each waits on, its repo and the files it ships. */
    plan: {
      id: string
      title: string
      /** By task id: `opened`, `merged`, or a check's name. */
      after: Record<string, string>
      repo?: string
      ships?: string[]
    }[]
    /** The task whose PR this one stacks on: the first down its stack of `opened` tasks in its repo whose PR isn't merged. */
    onto?: string
    /** The contract approved with the plan. */
    contract?: Contract
  }
  /** On a card: the PRs its plans' tasks have, by task id; unset when none was looked up, null when reading failed. */
  taskPrs?: Record<string, TaskPr> | null
  raw: unknown
}

/** A task's PR, found by the task's branch and its footer: open, merged, or closed unmerged at `closedAt`. */
export interface TaskPr extends PrRef {
  state: 'open' | 'merged' | 'closed'
  closedAt?: string
  /** On an open PR, the checks some task's `after` names, by name, as they stand on its head; a name the forge doesn't report is missing. */
  checks?: Record<string, CheckState>
}

/** A check's latest run or status on a commit. */
export type CheckState = 'passed' | 'pending' | 'failing'

export interface Ctx {
  env: NodeJS.ProcessEnv
  log(line: string): void
}

export interface Choice<T extends string = string> {
  value: T
  label?: string
  hint?: string
}

/** Questions `awaywork init` asks in the terminal; tests answer them from a script. */
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
  /** The open items, plus those finished (`state` merged or closed) since `since` when given. */
  items(cfg: C, ctx: Ctx, since?: Date): Promise<Item[]>
  prefetch(item: Item, dir: string, ctx: Ctx): Promise<void>
  /** Asks what `awaywork init` needs to configure this source. */
  init?(ask: Ask, ctx: Ctx): Promise<SourceSetup>
  /**
   * Writes to one of its items as you: a comment, or a move to the status, state, section or
   * label named `to`. Returns the item's updated time just before and after it, when the tracker says,
   * and a comment's own link when it returns one.
   */
  write?(cfg: C, item: Item, write: Write, ctx: Ctx): Promise<Written>
}

/** What awaywork writes to a tracker item. */
export type Write = { op: 'comment'; body: string } | { op: 'move'; to: string }

/** The item's updated time just before and after a write, and a comment's own link. */
export interface Written {
  before?: string
  after?: string
  url?: string
}

export interface Quota {
  /** `used` is a share (0 to 1); `resetsAt` is in unix seconds; `minutes` is the window's length. */
  windows: {
    name: string
    span: 'short' | 'long'
    used: number
    resetsAt: number
    minutes?: number
  }[]
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
  /** The MCP servers the unit's rule names, by name; their secrets are in `env`. */
  mcp?: Record<string, McpServer>
}

/** A stdio (`command`) or HTTP (`url`) MCP server; its secrets reach it by name or as `${NAME}` in `headers`. */
export interface McpServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  secrets: string[]
  /** The tools a worker may call; unset, all of them. */
  tools?: string[]
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
  /** Why it can't run in this environment, if it can't; routing then skips it. */
  unavailable?(env: NodeJS.ProcessEnv): string | undefined
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx: Ctx): Promise<Quota | null>
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  /** Under a worker user, whose `HOME` is fresh for each clone: lends it the machine's own login for the run. */
  login?: Login
  /** Where the binary finds skills in the clone; unset, they come in `Job.plugin`. */
  skillsDir?: string
  instructionsFile: string
}

export interface Forge {
  /** With `fork`, `branch` is on a fork: the clone checks out its pull ref, which must be at `fork.head` if given. */
  clone(repo: string, branch: string, dir: string, fork?: Unit['fork']): Promise<void>
  prsFor(item: Item): Promise<PrRef[]>
  branchExists(repo: string, name: string): Promise<boolean>
  /** PRs whose head is `branch` in the repo, not a fork, open, closed or merged. */
  prsOn(repo: string, branch: string): Promise<BranchPr[]>
  /** The message of the commit at the tip of `branch` in the repo. */
  tipMessage(repo: string, branch: string): Promise<string>
  /** The text of the file at `path` in the repo at `ref`, a commit or branch; undefined when there's none. */
  fileAt(repo: string, ref: string, path: string): Promise<string | undefined>
  /** The state of each check on PR `pr`'s head commit, by name. */
  checks(repo: string, pr: number): Promise<Record<string, CheckState>>
  push(dir: string, branch: string, opts: { repo: string }): Promise<void>
  /**
   * Pushes HEAD onto PR `pr`'s branch, only while the PR is yours, open, in the repo, without
   * auto-merge, and still at `from`, and the branch is unprotected and backs no one else's PR;
   * never forced. Returns why it refused, or nothing once pushed.
   */
  fastForward(
    dir: string,
    branch: string,
    from: string,
    opts: { repo: string; pr: number },
  ): Promise<string | undefined>
  /** Opens a PR from `head` into `base`, the default branch when empty, as a draft when `draft`, its footer recording `status`. */
  openPr(
    repo: string,
    head: string,
    base: string,
    bodyFile: string,
    runId: string,
    items: Pick<Item, 'source' | 'key'>[],
    draft: boolean,
    status?: Status,
  ): Promise<string>
  /** Puts PR `pr` on top of PR `below` in the forge's stacked PRs, without editing either PR. */
  stack(repo: string, below: string, pr: string): Promise<void>
  /**
   * Leaves `review` on PR `pr` as your pending review at commit `head`, unsubmitted and seen by no
   * one else; returns its URL. Throws why it didn't, e.g. a pending review of yours already there.
   */
  pendingReview(repo: string, pr: number, head: string, review: Review): Promise<string>
}

/** A PR on a branch; `closedAt` when the forge says. */
export interface BranchPr {
  url: string
  number: number
  body: string
  /** Its head commit, when the forge says. */
  head?: string
  open: boolean
  merged: boolean
  closedAt?: string
}

/** A review's body and its comments on lines of the PR's new side. */
export interface Review {
  body: string
  comments: { path: string; line: number; body: string }[]
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
/** Item facts that must all hold; `any` holds when one of its entries does. */
export type Where = Record<string, WhereValue | Where[]>

/** What a unit runs: a rule's own settings, or a step of its chain with the rule's filled in. */
export interface Step {
  skill: string
  provider: string[]
  model?: Record<string, string | string[]>
  skills: string[]
  /** MCP servers the worker gets, by name under the config's `mcp`. */
  mcp?: string[]
  instructions: string[]
  /** Parameters listed in the prompt next to the skill. */
  with?: Record<string, Scalar>
  /** A `then` or loop step runs only when this holds, checked in its clone before the worker. */
  when?: Condition
}

/** A `then` or loop step as written: the settings it leaves unset are the rule's. */
export type ThenStep = Omit<Step, 'provider' | 'skills' | 'instructions'> &
  Partial<Pick<Step, 'provider' | 'skills' | 'instructions'>> & {
    /** Starts a new slice: a new branch cut from the slice before, and a PR stacked on its PR. */
    stack?: boolean
  }

/** What a loop checks after each of its steps, or a step before it runs; every key set must hold. */
export interface Condition {
  /** The latest verdict: for `until` the loop's, for `when` the chain's. */
  verdict?: Scalar | Scalar[] | { not: Scalar | Scalar[] }
  /** A shell command awaywork runs in the clone, outside the model; exit 0 holds. */
  command?: string
  /** `when` only: globs, holding when the chain's commits change a matching path, against where the chain started. */
  changed?: string[]
  /** A rule's `when` only: holds when the long window resets within this many runs. */
  runs_until_reset?: number
  /** A rule's `when` only: holds when at least this share of the long window is left under this run's ceiling. */
  headroom?: number
}

/** Steps run round after round in the chain's clone, until `until` holds or `max` rounds ran. */
export interface Loop {
  loop: ThenStep[]
  until: Condition
  max: number
  /** Starts a new slice at the loop's first round. */
  stack?: boolean
}

export interface Rule extends Step {
  /** How the chain publishes its commits: one draft or ready PR, or a push onto your PR; report, pending_review and plan commit nothing. */
  deliver?: Deliver
  branch?: string
  source?: string
  where: Where
  order?: Order
  units?: number
  /** Steps run in turn after the rule's unit, in its clone; each slice of the chain publishes once, when it ends. */
  then?: (ThenStep | Loop)[]
  /** Written to the unit's items that are yours once its chain finished and published, or a plan rule's plan was posted: its result as a comment, then the move. */
  on_done?: { move?: string; comment?: 'result' }
  /** `soon`: awaywork watch starts its units as soon as it sees them due, not only in a window. */
  run?: 'soon' | 'window'
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
  /** `base` is PR `number`'s branch on a fork, read at `head`: only a report delivers there. */
  fork?: { number: number; head?: string }
  /** Command run in the clone after the worker, before publishing: a failure goes in the PR body or report. */
  verify?: string
  /** Checks run before publishing commits, the top-level ones merged with the repo's: one that fires drafts a `deliver: pr` PR and goes on top of its body. */
  gates?: Record<string, Gate>
  /** The URL of the awaywork PR whose branch `base` is: one a rule took up again, or the chain's slice before. */
  stackedOn?: string
  branch: string
  rule: Step
  skill: string
  skills: string[]
  providers: string[]
  instructions: string[]
  deliver: Deliver
  /** A `deliver: plan` unit's: what its card's plan is checked against. */
  planLimits?: PlanLimits
}

/** A gate fires when the slice's commits change a path matching one of `changed`, one of `commands` fails, or one of `skills` judges it should. */
export interface Gate {
  changed: string[]
  commands: string[]
  skills: string[]
}

export type Deliver = 'draft_pr' | 'pr' | 'report' | 'push' | 'pending_review' | 'plan'
