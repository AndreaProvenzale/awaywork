import type { z } from 'zod'

export interface PrRef {
  repo: string
  number: number
  url: string
  branch: string
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

export interface Source<C = unknown> {
  id: string
  configSchema: z.ZodObject
  /** What `where` may match on; each schema validates one scalar a rule compares against. */
  fields: Record<string, z.ZodType>
  secrets(cfg: C): string[]
  items(cfg: C, ctx: Ctx): Promise<Item[]>
  prefetch(item: Item, dir: string, ctx: Ctx): Promise<void>
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
}

export interface Provider {
  id: string
  configSchema: z.ZodObject
  credential: 'static' | 'rotating'
  quota: 'window' | 'credits'
  unattended: 'allowed' | 'grey' | 'forbidden'
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
  draftPr(repo: string, head: string, base: string, bodyFile: string): Promise<string>
}

export type Scalar = string | number | boolean
export type WhereValue = Scalar | Scalar[] | { not: Scalar | Scalar[] }

export interface Rule {
  skill: string
  source?: string
  where: Record<string, WhereValue>
  provider: string[]
  skills: string[]
  instructions: string[]
  deliver?: Deliver
}

export interface Unit {
  id: string
  items: Item[]
  repo: string
  /** The linked PR's branch, or '' for the repo's default branch. */
  base: string
  branch: string
  rule: Rule
  skill: string
  skills: string[]
  providers: string[]
  instructions: string[]
  deliver: Deliver
}

export type Deliver = 'draft_pr' | 'report'
