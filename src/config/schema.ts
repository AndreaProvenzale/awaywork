import { z } from 'zod'
import { defaultBranch, templateProblem } from '#core/branch'
import type { Provider, Rule, Source, Where } from '#core/types'
import { spanPattern } from '#plan/where'
import { headerSecret } from '#providers/codex'
import { commandProviderConfig } from '#providers/command'
import { providers } from '#providers/index'
import { DAYS, time } from '#quota/window'
import { commandConfig, contextCommand, linkTemplate, pollEvery, pollSpan } from '#sources/command'
import { sources } from '#sources/index'
import { refuseOwnKeys, routines } from '#sources/routines'
import { validateConfig } from './validate/index'

const percent = z
  .string()
  .regex(/^(100|\d{1,2}(\.\d+)?)%$/, 'expected a percentage like "10%"')
  .transform((s) => Number.parseFloat(s) / 100)
const oneOrMany = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === 'string' ? [v] : v))

const units = z.int().positive()

/** Keys a release dropped, by name or by path, with what to write instead: the config refuses them with this. */
export const removedKeys: Record<string, string> = {
  stack: 'stack was removed: split work into tasks with a deliver: plan rule',
  'sources.github.repos':
    'repos was removed: list each repo as a key of the top-level repos, e.g. repos: { acme/api: }',
  'sources.github.host':
    'host was removed: it goes on the forge, forge: { github: { host: github.acme.com } }',
  'sources.github.user':
    'user was removed: it goes on the forge, forge: { github: { user: octocat } }',
  'sources.bitbucket':
    'the bitbucket source was removed: write forge: bitbucket at the top level and list each repo as a key of repos',
  'queue.when':
    "when was renamed on a rule: write quota, e.g. quota: { headroom: 20% }; a step's when stays",
  'limits.plan_tasks':
    'plan_tasks was removed: it goes on the deliver: plan rule, e.g. { skill: plan, deliver: plan, plan_tasks: 8 }',
  'providers.budget':
    'budget was removed: the top-level budget applies to every provider; a different budget takes a second config',
}

const branch = z.string().superRefine((template, ctx) => {
  const problem = templateProblem(template)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

const fallbackUnits = z.int().positive().describe('Units per run')
const turns = z.int().positive().describe('Turns per unit')
const caps = "Caps when the provider's quota can't be read"
const fallback = z
  .strictObject({ units: fallbackUnits.optional(), turns: turns.optional() })
  .describe(caps)
const reserve = 'Never go past 1 - reserve of any window'
const perRun = 'At most this share of the long window per run'
const sessionMax = 'Stop a worker past this share of the short window'
const presentSessionMax =
  'Stop a worker past this share of the short window in a run started outside every window'
const budget = z
  .strictObject({
    reserve: percent.prefault('10%').describe(reserve),
    per_run: percent.optional().describe(perRun),
    session_max: percent.prefault('90%').describe(sessionMax),
    present_session_max: percent.prefault('40%').describe(presentSessionMax),
    fallback: fallback
      .extend({ units: fallbackUnits, turns: turns.default(60) })
      .describe(caps)
      .default({ units: 4, turns: 60 }),
  })
  .describe('Quota shares, for every provider')

const model = z
  .string()
  .min(1)
  .describe("Model passed to the provider's binary; default the binary's")

const models = z
  .union([model, z.array(model).length(2)])
  .describe('A model, or two: a step that fails on the first runs once more on the second')

export type ProviderConfig = {
  model?: string
  config_dir?: string
} & Record<string, unknown>

const loginFolder = (p: Provider, { env, default: folder }: NonNullable<Provider['loginDir']>) =>
  z
    .string()
    .regex(/^~?\//, 'expected an absolute path or one under ~/')
    .describe(
      [
        `Folder of the login it runs on, passed as ${env}, e.g. ${folder}-work; default the environment's`,
        ...(p.secrets.length ? [`${p.secrets.join(', ')} wins when set`] : []),
        ...(p.login ? [] : ['not with isolation: user or container']),
      ].join('; '),
    )

const providerName = z
  .enum(Object.keys(providers))
  .transform((id): Record<string, ProviderConfig> => ({ [id]: {} }))
const providerOverride = z
  .object(
    Object.fromEntries(
      Object.values(providers).map((p) => [
        p.id,
        p.configSchema
          .extend({
            model: model.optional(),
            ...(p.loginDir && { config_dir: loginFolder(p, p.loginDir).optional() }),
          })
          .optional()
          .describe(`${p.id} settings`),
      ]),
    ),
  )
  .catchall(commandProviderConfig)
  .refine((entry) => Object.keys(entry).length === 1, {
    message: 'each entry names exactly one provider',
    when: (payload) => payload.issues.length === 0,
  })
const providerEntry = z.union([providerName, providerOverride], {
  error: (issue) =>
    typeof issue.input === 'string' ? `unknown provider "${issue.input}"` : nested(issue.errors[1]),
})

/** The override branch's first issue, its path inside the entry in the message. */
function nested(issues: z.core.$ZodIssue[] | undefined): string | undefined {
  const [issue] = issues ?? []
  if (!issue) return undefined
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
}

/** A built-in source's config with its `context` and its `link`, unless its items link their PRs themselves. */
function builtinConfig(s: Source): z.ZodObject {
  const fallback = s.link ? `\`${s.link}\`` : 'none'
  const link = linkTemplate.optional().describe(`${linkTemplate.description}; default ${fallback}`)
  return s.configSchema
    .extend({
      context: contextCommand.optional(),
      every: pollEvery,
      ...(s.link === false ? {} : { link }),
    })
    .describe(s.configSchema.description ?? '')
}

/** Refuses `sources.bitbucket`, a forge now, before it's read as a custom source. */
function refuseBitbucket(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof raw !== 'object' || raw === null || !('bitbucket' in raw)) return raw
  ctx.addIssue({
    code: 'custom',
    path: ['bitbucket'],
    message: removedKeys['sources.bitbucket'] as string,
  })
  const { bitbucket: _, ...rest } = raw
  return rest
}

const sourcesConfig = z
  .preprocess(
    refuseBitbucket,
    z
      .object({
        ...Object.fromEntries(
          Object.values(sources).map((s) => [s.id, builtinConfig(s).optional()]),
        ),
        [routines.id]: z.preprocess(refuseOwnKeys, builtinConfig(routines)).optional(),
      })
      .catchall(commandConfig)
      .refine((s) => Object.keys(s).length > 0, 'configure at least one source'),
  )
  .describe('Where work comes from: built-in sources or your own commands; at least one')

// Only GitHub has settings, so a map names one forge by construction.
const forgeSettings = z.strictObject({
  github: z
    .preprocess(
      (raw) => (raw === null ? {} : raw),
      z.strictObject({
        host: z
          .string()
          .regex(/^[^/\s]+$/, 'host only, no scheme or path')
          .optional()
          .describe('GitHub Enterprise host, e.g. github.acme.com; github.com by default'),
        user: z
          .string()
          .regex(/^[A-Za-z0-9-]+$/, 'expected a GitHub login')
          .optional()
          .describe(
            "The gh account awaywork acts as, e.g. octocat: its `gh auth token` becomes GH_TOKEN (GH_ENTERPRISE_TOKEN with a host) for everything awaywork does on GitHub; default gh's active account. A token already in the environment wins",
          ),
      }),
    )
    .describe('GitHub, through gh'),
})
const forgeIds = ['github', 'bitbucket'] as const
type ForgeConfig = { id: (typeof forgeIds)[number]; host?: string; user?: string }
const forge = z
  .union([z.enum(forgeIds), forgeSettings], {
    error: (issue) =>
      typeof issue.input === 'string'
        ? `unknown forge "${issue.input}": github or bitbucket`
        : typeof issue.input === 'object' && issue.input !== null && 'github' in issue.input
          ? nested(issue.errors[1])
          : 'expected github or bitbucket, or github as a map of its settings, e.g. { github: { host: github.acme.com } }; bitbucket takes no settings',
  })
  .transform(
    (f): ForgeConfig => (typeof f === 'string' ? { id: f } : { id: 'github', ...f.github }),
  )

const scalar = z.union([z.string(), z.number(), z.boolean()])
const scalars = z.union([scalar, z.array(scalar).min(1)])
const span = z.string().regex(spanPattern, 'expected a span like 3d: a number and m, h, d or w')
const whereValue = z.union([
  scalars,
  z.strictObject({ not: scalars }).describe('Matches items whose field has none of these values'),
  z
    .strictObject({
      gt: z.number().optional().describe('Greater than'),
      gte: z.number().optional().describe('Greater than or equal to'),
      lt: z.number().optional().describe('Less than'),
      lte: z.number().optional().describe('Less than or equal to'),
    })
    .refine((c) => Object.keys(c).length > 0, 'expected gt, gte, lt or lte')
    .describe('Matches items whose number field passes every comparison'),
  z
    .strictObject({
      older_than: span.optional().describe('Longer ago than this span'),
      newer_than: span.optional().describe('More recent than this span'),
    })
    .refine((a) => Object.keys(a).length > 0, 'expected older_than or newer_than')
    .describe('Matches items whose date field is this long before now, e.g. { older_than: 3d }'),
  z
    .strictObject({
      matches: z
        .string()
        .refine(isRegex, 'invalid regular expression')
        .describe('A regular expression, case-insensitive'),
    })
    .describe("Matches items whose text field contains a match, e.g. `{ matches: '^\\[bug\\]' }`"),
])

function isRegex(source: string): boolean {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

const where: z.ZodType<Where, unknown> = z.lazy(() =>
  z
    .object({
      any: z
        .array(where)
        .min(1)
        .optional()
        .describe('Matches when at least one of these conditions does; each is a where of its own'),
    })
    .catchall(whereValue),
)

const skill = z.string().min(1).describe('The skill that does the work')
const stepSettings = {
  provider: oneOrMany
    .default([])
    .describe('Providers for this rule, in order; default the providers order'),
  model: z
    .record(z.string(), models)
    .optional()
    .describe(
      "Model per provider for this rule, e.g. { claude: sonnet } or { claude: [sonnet, opus] }; default the provider's",
    ),
  skills: z
    .array(z.string())
    .default([])
    .describe(
      "Extra skills available to the worker; also looked up in the repo's .claude/skills, .agents/skills and .cursor/skills",
    ),
  mcp: z
    .array(z.string())
    .min(1)
    .optional()
    .describe('MCP servers the worker gets, by their name under the top-level mcp'),
  instructions: oneOrMany.default([]).describe('Instruction files added for this rule'),
  with: z
    .record(z.string().min(1), scalar)
    .optional()
    .describe(
      "Parameters for the skill, listed in its prompt; a skill's metadata says which it reads",
    ),
}
const MAX_ROUNDS = 5
const verdict = z.string().regex(/^[a-z][a-z_-]*$/, 'expected one lowercase word like approve')
const verdicts = z.union([verdict, z.array(verdict).min(1)])
const conditionKeys = {
  verdict: z
    .union([
      verdicts,
      z.strictObject({ not: verdicts }).describe('Matches every verdict but these'),
    ])
    .optional()
    .describe('The latest verdict a loop step wrote; a list means any of, {not} negates'),
  command: z
    .string()
    .min(1)
    .optional()
    .describe('A shell command awaywork runs in the clone, outside the model; exit 0 holds'),
}
const condition = z
  .strictObject(conditionKeys)
  .refine((c) => Object.keys(c).length > 0, 'expected verdict or command')
const quotaKeys = {
  runs_until_reset: z
    .int()
    .positive()
    .optional()
    .describe(
      "Holds when at most this many window openings are left before the provider's long window resets; 1 is the last window",
    ),
  headroom: percent
    .optional()
    .describe("Holds when at least this share of the long window is left under this run's ceiling"),
}
const when = z
  .strictObject(
    {
      ...conditionKeys,
      verdict: conditionKeys.verdict.describe(
        'The latest verdict in the chain; a list means any of, {not} negates',
      ),
      changed: oneOrMany
        .optional()
        .describe(
          "Git globs from the repo root; holds when the chain's commits change a matching path, against where the chain started",
        ),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys' && issue.keys.some((key) => key in quotaKeys)
          ? `${issue.keys.filter((key) => key in quotaKeys).join(', ')}: a quota check goes on the rule's quota, which gates the whole chain`
          : undefined,
    },
  )
  .refine((c) => Object.keys(c).length > 0, {
    message: 'expected verdict, command or changed',
    when: (payload) => payload.issues.length === 0,
  })
const ruleQuota = z.strictObject(quotaKeys).refine((c) => Object.keys(c).length > 0, {
  message: 'expected runs_until_reset or headroom',
  when: (payload) => payload.issues.length === 0,
})
const stepObject = z.strictObject({
  skill,
  ...stepSettings,
  provider: oneOrMany
    .optional()
    .describe("Providers for this step, in order; default the rule's, [] the providers order"),
  model: stepSettings.model.describe("Model per provider for this step; default the rule's"),
  skills: z
    .array(z.string())
    .optional()
    .describe("Extra skills available to the worker; default the rule's, [] none"),
  mcp: z
    .array(z.string())
    .optional()
    .describe(
      "MCP servers the worker gets, by their name under the top-level mcp; default the rule's, [] none",
    ),
  instructions: oneOrMany
    .optional()
    .describe("Instruction files added for this step; default the rule's, [] none"),
  when: when.optional().describe('Run this step only when every key holds; otherwise skip it'),
})
const step = z
  .union([
    z
      .string()
      .min(1)
      .transform((name) => ({ skill: name }))
      .pipe(stepObject),
    stepObject,
  ])
  .describe(
    "A skill name, or a map with skill, provider, model, skills, mcp and instructions (unset, the rule's), with and when",
  )
const loop = z
  .strictObject({
    loop: z
      .union([step, z.array(step).min(1)])
      .transform((steps) => [steps].flat())
      .describe("Steps run in turn every round, in the chain's clone"),
    until: condition.describe('Ends the loop as soon as it holds; checked after every step'),
    max: z.int().min(1).max(MAX_ROUNDS).describe(`At most this many rounds, up to ${MAX_ROUNDS}`),
  })
  .describe('Steps repeated until a condition holds')

const gate = z
  .strictObject({
    changed: oneOrMany
      .refine((globs) => globs.length > 0, 'expected at least one glob')
      .optional()
      .describe(
        "Git globs from the repo root; fires when the chain's commits change a matching path; not on a plan or report rule's gate, which has no commits",
      ),
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A shell command awaywork runs in the clone, outside the model, naming its script by its path from the repo root; it diffs from AWAYWORK_FROM, the commit the chain started from, unset on a plan or report, and reads AWAYWORK_OUT_DIR, a read-only copy of what the steps left in .away/out; a non-zero exit fires, with its stdout as the line; so does one that can't run or times out, and, without running, one where a file it names differs from the one the chain started with",
      ),
    skill: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A skill, yours or built in, that a model runs on the chain's commits and a read-only copy of what the steps left in .away/out, a plan's or report's out files alone, after the other gates, routed like the rule's steps; it fires when it writes the verdict fires, its report lines on the card; so does a run that fails or changes the clone, whose changes awaywork drops",
      ),
    instructions: oneOrMany
      .optional()
      .describe(
        "Instruction files a skill gate's judge reads, relative to the config file; never the repo's, and never the rule's",
      ),
  })
  .superRefine((g, ctx) => {
    const set = [g.changed, g.command, g.skill].filter((d) => d !== undefined).length
    if (set !== 1)
      ctx.addIssue({
        code: 'custom',
        message: set
          ? 'expected one of changed, command or skill'
          : 'expected changed, command or skill',
      })
    if (g.instructions && !g.skill)
      ctx.addIssue({
        code: 'custom',
        path: ['instructions'],
        message: 'instructions go to a judge: they need skill',
      })
  })
const gates = z
  .record(z.string().regex(/^[\w-]+$/, 'expected a name like schema'), gate)
  .prefault({})

const rule: z.ZodType<Rule, unknown> = z
  .strictObject({
    skill,
    source: z.string().min(1).optional().describe('Match only items from this source'),
    where: where
      .default({})
      .describe(
        'Item facts to match: type or a source field; a list means any of, {not} negates, {gt,gte,lt,lte} compare numbers, {older_than,newer_than} compare dates to now, {matches} tests text against a case-insensitive regex, any: [{...}] holds when one entry does; title, description, approved, state (open, merged, closed) and closed (when it finished) are on every source; a where, or an any entry under one, that never names state matches open items only',
      ),
    ...stepSettings,
    deliver: z
      .enum(['draft_pr', 'pr', 'report', 'push', 'pending_review', 'plan'])
      .optional()
      .describe(
        "Where the chain's commits go: one draft PR (default), one PR ready for review (a draft when a step fails or the run ends before one runs, a step asks questions with ask in its status file, verify fails, a loop's until never held, or a gate fires), or a push onto your own PR's branch; report makes no step commit, and a chain without commits reports; pending_review reports too, and leaves the last report on the PR it reviews as your pending review, seen by no one until you submit it; plan reports too, and posts the report with the plan.yml a step wrote as one comment on the item, which waits for your reply: approve as its first line approves it, anything else re-plans",
      ),
    wait: z
      .boolean()
      .optional()
      .describe(
        "deliver: plan or report: the post waits for your reply on the item, approve as its first line letting the next stage take it, anything else running the step again; default true for plan, false for report; a gate of the rule's own that fires makes it wait anyway",
      ),
    gates: z
      .record(z.string().regex(/^[\w-]+$/, 'expected a name like schema'), gate)
      .optional()
      .describe(
        "Gates of the rule's own, under names no top-level or repo gate has. On a rule that opens a PR or pushes they run with those, and one that fires does what theirs does; on deliver: plan or report, where those never run, they run on what the step left, without changed, and one that fires puts its line on the post and makes it wait, a planned rule's task holding its card's other tasks until you answer; not on pending_review",
      ),
    post: z
      .enum(['summary', 'full'])
      .optional()
      .describe(
        "deliver: plan, or a report that posts: summary posts the step's .away/out/summary.md, awaywork's facts and a pinned link per file it put in the store; full posts the report inline, plan and contract included; default summary with a store, else full",
      ),
    thread: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Where its posts go and their replies are read: item (default), the item itself; github, an issue awaywork opens as the item's thread in its repo, assigned to you; or a custom source with thread: true, whose write opens one; for a tracker that can't take them; from then on all of the item's posts go there, its plan's tasks' too, and it closes once its source says the item is done",
      ),
    branch: branch.optional().describe('Branch name template for this rule'),
    order: z
      .enum(['oldest', 'newest', 'updated'])
      .optional()
      .describe('Which item goes first: oldest, newest or last updated; default the source order'),
    quota: ruleQuota
      .optional()
      .describe("Run this rule's unit only when the quota holds; otherwise skip it"),
    plan_tasks: z
      .int()
      .positive()
      .optional()
      .describe('deliver: plan: at most this many tasks in its plan; default 8'),
    units: units
      .optional()
      .describe('At most this many units per run from this rule; a chain counts once'),
    // biome-ignore lint/suspicious/noThenProperty: the key users write; never a function
    then: z
      .union([step, loop, z.array(z.union([step, loop])).min(1)])
      .transform((steps) => [steps].flat())
      .default([])
      .describe(
        "Steps run in turn after this rule's unit, in its clone; the chain publishes once, when it ends; a {loop} repeats its steps",
      ),
    on_done: z
      .strictObject({
        move: z
          .string()
          .min(1)
          .describe(
            "Where the item goes, in its tracker's words: a Jira status, a Linear state, an Asana section, a GitHub label to add",
          )
          .optional(),
        comment: z
          .literal('result')
          .optional()
          .describe(
            "result posts the unit's result as awaywork's comment, before any move: a report rule's report, else a link to what it published",
          ),
      })
      .refine((d) => Object.keys(d).length > 0, 'expected move or comment')
      .optional()
      .describe(
        "Written to the unit's items that are yours once its chain finished and published; a write that fails is only reported",
      ),
    run: z
      .enum(['soon', 'window'])
      .optional()
      .describe(
        'When its units start: window (default), in the next window run; soon, as soon as awaywork watch sees one due (a new item, or one changed since its last attempt), polling every watch.every',
      ),
  })
  .describe('First matching rule wins; top = highest priority')

const mcpServer = z
  .strictObject({
    command: z.string().min(1).optional().describe('Command that starts a stdio server'),
    args: z.array(z.string()).optional().describe("The command's arguments"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("The server's env vars, besides its secrets; plain values"),
    url: z
      .url({ protocol: /^https?$/ })
      .optional()
      .describe('URL of an HTTP server'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(`HTTP headers; a value may be \${NAME}, or Bearer \${NAME} for Authorization`),
    secrets: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (name) => !/^(GH|GITHUB|TWG)_/.test(name),
            'GH_, GITHUB_ and TWG_ names are reserved: workers never get forge logins and Actions refuses GITHUB_ secrets; use another, like MCP_GITHUB_TOKEN',
          ),
      )
      .default([])
      .describe(
        'Env vars the server reads, in its env under their own names or in headers; given only to units whose rule names it, listed in Actions',
      ),
    tools: z
      .array(z.string().regex(/^[\w-]+$/, 'expected a tool name like search_issues'))
      .min(1)
      .optional()
      .describe("Tools the worker may call; default all the server's"),
  })
  .superRefine((s, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })
    if (s.command && s.url) issue('command', 'expected command (stdio) or url (HTTP), not both')
    if (!s.command && !s.url) issue('command', 'expected command (stdio) or url (HTTP)')
    if (s.url && (s.args || s.env)) issue(s.args ? 'args' : 'env', 'args and env need a command')
    if (s.command && s.headers) issue('headers', 'headers need a url')
    const plain = {
      command: [s.command],
      args: s.args,
      env: Object.values(s.env ?? {}),
      url: [s.url],
    }
    const leak = Object.entries(plain).find(([, values]) => values?.some((v) => v?.includes('${')))
    if (leak)
      issue(
        leak[0],
        "a secret can't go in command, args, env or url: list it in secrets, and it reaches the server's env under its own name",
      )
    for (const [header, value] of Object.entries(s.headers ?? {})) {
      if (!value.includes('${')) continue
      const secret = headerSecret(header, value)
      if (!secret)
        issue('headers', `${header}: expected \${NAME}, or Bearer \${NAME} for Authorization`)
      else if (!s.secrets.includes(secret.name))
        issue('headers', `${header}: \${${secret.name}} is not one of this server's secrets`)
    }
    const headers = Object.values(s.headers ?? {})
    for (const name of s.url ? s.secrets : [])
      if (!headers.some((v) => v.includes(`\${${name}}`)))
        issue(
          'secrets',
          `${name}: an HTTP server gets a secret only in a header, like Bearer \${${name}}`,
        )
  })

const repoSettings = z.strictObject({
  branch: branch.optional().describe('Branch name template for this repo'),
  setup: z
    .string()
    .optional()
    .describe('Setup command, run in the clone before the worker; a failure skips the unit'),
  secrets: z
    .array(z.string().min(1))
    .default([])
    .describe('Env vars setup needs; withheld from workers, listed in Actions'),
  verify: z
    .string()
    .optional()
    .describe(
      'Command run in the clone after the worker, before publishing; a failure goes in the PR body or report, and the work is still published',
    ),
  gates: gates.describe(
    "Gates for this repo's units, on top of the top-level ones; a name both have fires on either's changed, command or skill",
  ),
  test: z.string().optional().describe('Targeted test command, given to the worker in its prompt'),
  instructions: z.string().optional().describe('Instruction file for units in this repo'),
  image: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Docker image setup, the agent and the checks run in under isolation: container; it ships the agent CLIs the repo's rules use and its toolchain",
    ),
})
// A bare key lists the repo with no settings.
const repo = z.union([repoSettings, z.null().transform(() => repoSettings.parse({}))])

const configShape = z.strictObject({
  extends: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A base config file this one goes on top of, relative to this file: maps merge, this file's keys winning, and a list replaces the base's; relative paths resolve against the file they're in. A base can't extend another",
    ),
  windows: z
    .array(
      z
        .strictObject({
          days: z
            .array(z.enum(DAYS))
            .min(1)
            .optional()
            .describe('Weekdays the window opens on; every day when unset'),
          start: time.describe('When a scheduled run starts, local time'),
          end: time.describe('No unit starts after this'),
        })
        .refine((w) => w.start !== w.end, 'start and end must differ'),
    )
    .default([{ start: '01:00', end: '07:00' }])
    .describe(
      'Local hours a scheduled run may start units in; each opening is one run; [] for none',
    ),
  watch: z
    .strictObject({
      every: pollSpan
        .default('5m')
        .describe(
          "How often the daemon polls the sources of run: soon rules; a source's own every can make it less often",
        ),
      debug: z
        .boolean()
        .default(false)
        .describe("Also write each run's full output to the daemon log"),
    })
    .prefault({})
    .describe('awaywork watch, the daemon schedule install keeps running'),
  limits: z
    .strictObject({
      units: units.optional().describe('At most this many units per run'),
      units_per_repo: units.optional().describe('At most this many units per run in one repo'),
      unit_minutes: z.int().positive().optional().describe('Stop a worker after this many minutes'),
    })
    .prefault({})
    .describe('Unit counts and time per run, for every provider'),
  isolation: z
    .enum(['none', 'user', 'container'])
    .default('none')
    .describe(
      "Who setup, the agent and the checks run as: none, you; user, the awaywork user (Linux, set up as doctor shows); container, a fresh container of the repo's image each; always user on a GitHub-hosted runner and in awaywork's image",
    ),
  budget: budget.prefault({}),
  providers: z
    .array(providerEntry)
    .min(1)
    .describe('Providers to use, a name or a map to override; order = routing preference'),
  forge: forge
    .prefault('github')
    .describe(
      'Where the repos live: github or bitbucket, or github as a map of its settings, e.g. { github: { host: github.acme.com } }',
    ),
  sources: sourcesConfig,
  branch: branch
    .default(defaultBranch)
    .describe(
      'Branch name template; {key} or {title} is required, {type} is the conventional-commit type',
    ),
  repos: z
    .record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name'), repo)
    .prefault({})
    .describe(
      'The repos awaywork works in: each key an owner/name or a * glob such as acme/*, with its settings or nothing. A repo takes the settings of every key naming it, globs in the order written and its own key last, a later one winning; an item in a repo no key names is skipped',
    ),
  gates: gates.describe(
    "Checks on every slice that publishes commits, run before it's published; one that fires opens a deliver: pr PR as a draft and puts its line in a decision card on top of the PR body",
  ),
  instructions: oneOrMany.default([]).describe('Instruction files added to every unit'),
  skills: z
    .array(z.string())
    .default([])
    .describe(
      "Extra skills available to every unit; also looked up in the repo's .claude/skills, .agents/skills and .cursor/skills",
    ),
  mcp: z
    .record(z.string(), mcpServer)
    .default({})
    .describe('MCP servers a rule or step names in its mcp'),
  queue: z
    .array(rule)
    .optional()
    .describe('Rules mapping items to skills; without any, nothing runs'),
  notify: z
    .strictObject({
      command: z
        .string()
        .min(1)
        .describe(
          'Shell command; AWAYWORK_EVENT (unit or run) and AWAYWORK_RUN_ID are in its env, plus AWAYWORK_REPORT for a run, and _UNIT, _SKILL, _STATUS, _ITEM_URL, _ITEM_KEY and _SOURCE (one line per item), _REPO and, when there is one, _VERDICT, _PR_URL, _REPORT or _OUT_DIR for a unit',
        ),
      secrets: z
        .array(z.string().min(1))
        .default([])
        .describe('Env vars the command needs; withheld from workers, listed in Actions'),
    })
    .optional()
    .describe(
      'Runs after each step of a finished unit and with the morning report when a run ends; a failure is only logged',
    ),
  store: z
    .strictObject({
      command: z
        .string()
        .min(1)
        .describe(
          'Shell command run like a custom source\'s, once per file: it reads {"op":"put","item","unit","path","kind"} on stdin and prints {"url":"…"}, or {"skip":true} to keep the file out of the store, or reads {"op":"get","url"} and prints the file\'s bytes',
        ),
      secrets: z
        .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an env var name'))
        .default([])
        .describe('Env vars the command reads; withheld from workers, listed in Actions'),
      get: z
        .boolean()
        .default(true)
        .describe(
          'false: the command only puts, and awaywork reads a file back with a plain HTTP GET of its URL',
        ),
      read: z
        .strictObject({
          max_mb: z
            .number()
            .positive()
            .default(10)
            .describe("At most this many MB of a unit's files come back; the rest stay links"),
          files: z
            .array(z.string().min(1))
            .default([])
            .describe(
              'Globs of the file names that come back, e.g. ["*.md", "*.yml"]; default every file',
            ),
        })
        .prefault({})
        .describe("What comes back into a unit's context when it reads its item's thread"),
    })
    .optional()
    .describe(
      'Where awaywork puts the files a post pins, plan.yml, reports and whatever else a step leaves in .away/out/, so a unit on any machine reads them back',
    ),
  keep_runs: span
    .default('30d')
    .describe(
      "How long run dirs stay; older ones go when awaywork run or watch starts and daily while watch runs, except those holding an item's latest report",
    ),
})

/** The config as its shapes parse it, before the cross-field checks and the transform. */
export type ConfigShape = z.output<typeof configShape>

export const configSchema = configShape
  .superRefine(validateConfig)
  .transform(({ providers: entries, ...cfg }) => ({
    ...cfg,
    // The github source reads the listed repos, on the forge's host.
    sources: withScope(cfg.sources, { repos: Object.keys(cfg.repos), host: cfg.forge.host }),
    providers: entries.flatMap((entry) =>
      Object.entries(entry as Record<string, ProviderConfig>).map(
        ([id, { model, config_dir, ...config }]) => ({ id, config, model, config_dir }),
      ),
    ),
  }))

export type Config = z.output<typeof configSchema>

const withScope = <S extends Record<string, unknown>>(sources: S, scope: object): S =>
  sources.github ? { ...sources, github: { ...sources.github, ...scope } } : sources

export type Budget = Config['budget']
