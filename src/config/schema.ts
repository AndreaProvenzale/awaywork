import { z } from 'zod'
import { defaultBranch, templateProblem } from '../core/branch.js'
import { headerSecret } from '../core/mcp.js'
import {
  bounds,
  DEFAULT_LOOKBACK,
  isAge,
  isLoop,
  isMatch,
  lookback,
  matchesOpen,
  matchesValue,
  newerThan,
  ruleSteps,
  spanPattern,
} from '../core/queue.js'
import type { Rule, Scalar, Source, Where, WhereValue } from '../core/types.js'
import { commandProviderConfig } from '../providers/command.js'
import { providers } from '../providers/index.js'
import { commandConfig, contextCommand, linkTemplate } from '../sources/command.js'
import { itemFields, sourceField, sourceFor, sources } from '../sources/index.js'

const percent = z
  .string()
  .regex(/^(100|\d{1,2}(\.\d+)?)%$/, 'expected a percentage like "10%"')
  .transform((s) => Number.parseFloat(s) / 100)
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected a time like "01:00"')
const oneOrMany = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === 'string' ? [v] : v))

const units = z.int().positive()

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
  .describe('Quota shares; any provider can override them')
const budgetOverride = z
  .strictObject({
    reserve: percent.describe(reserve),
    per_run: percent.describe(perRun),
    session_max: percent.describe(sessionMax),
    present_session_max: percent.describe(presentSessionMax),
    fallback,
  })
  .partial()
  .describe('Overrides the top-level budget for this provider')

const model = z
  .string()
  .min(1)
  .describe("Model passed to the provider's binary; default the binary's")

const models = z
  .union([model, z.array(model).length(2)])
  .describe('A model, or two: a step that fails on the first runs once more on the second')

type ProviderConfig = {
  model?: string
  budget?: z.output<typeof budgetOverride>
} & Record<string, unknown>

const providerName = z
  .enum(Object.keys(providers))
  .transform((id): Record<string, ProviderConfig> => ({ [id]: {} }))
const providerOverride = z
  .object(
    Object.fromEntries(
      Object.values(providers).map((p) => [
        p.id,
        p.configSchema
          .extend({ model: model.optional(), budget: budgetOverride.optional() })
          .optional()
          .describe(`${p.id} settings`),
      ]),
    ),
  )
  .catchall(commandProviderConfig.extend({ budget: budgetOverride.optional() }))
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
    .extend({ context: contextCommand.optional(), ...(s.link === false ? {} : { link }) })
    .describe(s.configSchema.description ?? '')
}

const sourcesConfig = z
  .object(
    Object.fromEntries(Object.values(sources).map((s) => [s.id, builtinConfig(s).optional()])),
  )
  .catchall(commandConfig)
  .refine((s) => Object.keys(s).length > 0, 'configure at least one source')
  .describe('Where work comes from: built-in sources or your own commands; at least one')

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
      "Extra skills available to the worker; also looked up in the repo's .claude/skills and .agents/skills",
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
          ? `${issue.keys.filter((key) => key in quotaKeys).join(', ')}: a quota check goes on the rule's when, which gates the whole chain`
          : undefined,
    },
  )
  .refine((c) => Object.keys(c).length > 0, {
    message: 'expected verdict, command or changed',
    when: (payload) => payload.issues.length === 0,
  })
const ruleWhen = z.strictObject(quotaKeys).refine((c) => Object.keys(c).length > 0, {
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
  stack: z
    .boolean()
    .optional()
    .describe(
      'Start a new slice here: a new branch cut from the slice before, published as a PR stacked on its PR',
    ),
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
    "A skill name, or a map with skill, provider, model, skills, mcp and instructions (unset, the rule's), with, when and stack",
  )
const loop = z
  .strictObject({
    loop: z
      .union([step, z.array(step).min(1)])
      .transform((steps) => [steps].flat())
      .describe("Steps run in turn every round, in the chain's clone"),
    until: condition.describe('Ends the loop as soon as it holds; checked after every step'),
    max: z.int().min(1).max(MAX_ROUNDS).describe(`At most this many rounds, up to ${MAX_ROUNDS}`),
    stack: z
      .boolean()
      .optional()
      .describe(
        "Start a new slice at the loop's first round: a new branch cut from the slice before, published as a PR stacked on its PR",
      ),
  })
  .describe('Steps repeated until a condition holds')

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
      .enum(['draft_pr', 'pr', 'report', 'push', 'pending_review'])
      .optional()
      .describe(
        "Where the chain's commits go: one draft PR (default), one PR ready for review (a draft when a step fails or the run ends before one runs, verify fails, a loop's until never held, or a gate fires), or a push onto your own PR's branch; report makes no step commit, and a chain without commits reports; pending_review reports too, and leaves the last report on the PR it reviews as your pending review, seen by no one until you submit it",
      ),
    branch: branch.optional().describe('Branch name template for this rule'),
    order: z
      .enum(['oldest', 'newest', 'updated'])
      .optional()
      .describe('Which item goes first: oldest, newest or last updated; default the source order'),
    when: ruleWhen
      .optional()
      .describe("Run this rule's unit only when the quota holds; otherwise skip it"),
    units: units
      .optional()
      .describe(
        "At most this many units per run from this rule; each of a chain's slices counts once",
      ),
    // biome-ignore lint/suspicious/noThenProperty: the key users write; never a function
    then: z
      .union([step, loop, z.array(z.union([step, loop])).min(1)])
      .transform((steps) => [steps].flat())
      .default([])
      .describe(
        "Steps run in turn after this rule's unit, in its clone; each slice publishes once, when it ends, and stack: true starts the next; a {loop} repeats its steps",
      ),
    on_done: z
      .strictObject({
        move: z
          .string()
          .min(1)
          .describe(
            "Where the item goes, in its tracker's words: a Jira status, a Linear state, an Asana section, a GitHub label to add",
          ),
      })
      .optional()
      .describe(
        "Written to the unit's items that are yours once its chain finished and every slice published; a write that fails is only reported",
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

const gate = z
  .strictObject({
    changed: oneOrMany
      .refine((globs) => globs.length > 0, 'expected at least one glob')
      .optional()
      .describe(
        "Git globs from the repo root; fires when the slice's commits change a matching path",
      ),
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A shell command awaywork runs in the clone, outside the model, naming its script by its path from the repo root; it diffs from AWAYWORK_FROM, the commit the slice started from; a non-zero exit fires, with its stdout as the line; so does one that can't run or times out, and, without running, one where a file it names differs from the one the chain started with",
      ),
    skill: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A skill, yours or built in, that a model runs on the slice's commits after the other gates, routed like the rule's steps; it fires when it writes the verdict fires, its report lines on the card; so does a run that fails or changes the clone, whose changes awaywork drops",
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
  })
const gates = z
  .record(z.string().regex(/^[\w-]+$/, 'expected a name like schema'), gate)
  .prefault({})

const repo = z.strictObject({
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

export const configSchema = z
  .strictObject({
    windows: z
      .array(
        z
          .strictObject({
            days: z
              .array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']))
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
        unit_minutes: z
          .int()
          .positive()
          .optional()
          .describe('Stop a worker after this many minutes'),
      })
      .prefault({})
      .describe('Unit counts and time per run, for every provider'),
    isolation: z
      .enum(['none', 'user', 'container'])
      .default('none')
      .describe(
        "Who setup, the agent and the checks run as: none, you; user, the awaywork user (Linux, set up as doctor shows); container, a fresh container of the repo's image each; always user on a GitHub-hosted runner",
      ),
    budget: budget.prefault({}),
    providers: z
      .array(providerEntry)
      .min(1)
      .describe('Providers to use, a name or a map to override; order = routing preference'),
    sources: sourcesConfig,
    branch: branch
      .default(defaultBranch)
      .describe(
        'Branch name template; {key} or {title} is required, {type} is the conventional-commit type',
      ),
    repos: z
      .record(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name'), repo)
      .prefault({})
      .describe('Per-repo settings, keyed by owner/name'),
    gates: gates.describe(
      "Checks on every slice that publishes commits, run before it's published; one that fires opens a deliver: pr PR as a draft and puts its line in a decision card on top of the PR body",
    ),
    instructions: oneOrMany.default([]).describe('Instruction files added to every unit'),
    skills: z
      .array(z.string())
      .default([])
      .describe(
        "Extra skills available to every unit; also looked up in the repo's .claude/skills and .agents/skills",
      ),
    mcp: z
      .record(z.string(), mcpServer)
      .default({})
      .describe('MCP servers a rule or step names in its mcp'),
    queue: z
      .array(rule)
      .optional()
      .describe('Rules mapping items to skills; default the built-in queue'),
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
    keep_runs: span
      .default('30d')
      .describe(
        "How long run dirs stay; older ones go when awaywork run or watch starts and daily while watch runs, except those holding an item's latest report",
      ),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.isolation === 'container')
      for (const [name, repo] of Object.entries(cfg.repos))
        if (!repo.image)
          ctx.addIssue({
            code: 'custom',
            path: ['repos', name, 'image'],
            message: 'required with isolation: container: the image its units run in',
          })
    const providerIds = cfg.providers.flatMap(Object.keys)
    const commandIds = providerIds.filter((id) => !Object.hasOwn(providers, id))
    if (commandIds.length > 0 && !cfg.limits.unit_minutes)
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'unit_minutes'],
        message: 'required with a command provider: it has no turn cap, so this bounds its unit',
      })
    cfg.providers.forEach((entry, i) => {
      for (const id of Object.keys(entry)) {
        if (!commandIds.includes(id)) continue
        // `constructor` is the one such name Object.prototype already has.
        if (!/^(?!constructor$)[a-z][a-z0-9-]*$/.test(id))
          ctx.addIssue({
            code: 'custom',
            path: ['providers', i, id],
            message: 'expected a lowercase name like opencode',
          })
      }
    })
    for (const name of Object.keys(cfg.mcp))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
        ctx.addIssue({
          code: 'custom',
          path: ['mcp', name],
          message: 'expected a lowercase name like sentry',
        })
    const sourceIds = Object.keys(cfg.sources)
    const bitbucket = sourceIds.includes('bitbucket')
    if (bitbucket && sourceIds.includes('github'))
      ctx.addIssue({
        code: 'custom',
        path: ['sources', 'bitbucket'],
        message: 'one forge per config: github or bitbucket, not both',
      })
    providerIds.forEach((id, i) => {
      if (providerIds.indexOf(id) !== i)
        ctx.addIssue({ code: 'custom', path: ['providers', i], message: `"${id}" is listed twice` })
    })
    cfg.queue?.forEach((r, i) => {
      const at = ['queue', i]
      if (r.source && !sourceIds.includes(r.source))
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'source'],
          message: `source "${r.source}" is not configured`,
        })
      if (bitbucket && r.deliver === 'push')
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'deliver'],
          message:
            "push isn't available on Bitbucket: twg reads neither branch restrictions nor auto-merge, so awaywork can't check them; use draft_pr",
        })
      if (bitbucket && r.deliver === 'pending_review')
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'deliver'],
          message:
            "pending_review isn't available on Bitbucket: awaywork leaves pending reviews on GitHub only; use report",
        })
      // A `then` that failed to parse is still raw here; its own issues say why.
      const chain = Array.isArray(r.then) ? ruleSteps(r) : [{ step: r, at: [] }]
      if (Array.isArray(r.then))
        r.then.forEach((entry, j) => {
          if (entry.stack && r.deliver && r.deliver !== 'draft_pr' && r.deliver !== 'pr')
            ctx.addIssue({
              code: 'custom',
              path: [...at, 'then', j, 'stack'],
              message: `stack needs deliver: draft_pr or pr, not ${r.deliver}: a stacked slice opens a PR`,
            })
          if (isLoop(entry))
            entry.loop.forEach((step, k) => {
              if (step.stack)
                ctx.addIssue({
                  code: 'custom',
                  path: [...at, 'then', j, 'loop', k, 'stack'],
                  message: 'a loop sits inside one slice: set stack on the loop',
                })
            })
        })
      // Round ids (`<unit>-<skill>-<n>`) can't collide with plain steps', only with other rounds'.
      const inLoop = (path: (string | number)[]) => path[2] === 'loop'
      chain.forEach(({ step: s, at: path }, j) => {
        const stepAt = [...at, ...path]
        const earlier = chain.findIndex(
          (c) => c.step.skill === s.skill && inLoop(c.at) === inLoop(path),
        )
        if (earlier < j)
          ctx.addIssue({
            code: 'custom',
            path: [...stepAt, 'skill'],
            message: inLoop(path)
              ? `"${s.skill}" already runs in a loop of this chain`
              : `"${s.skill}" already runs earlier in this chain`,
          })
        for (const p of s.provider ?? [])
          if (!providerIds.includes(p))
            ctx.addIssue({
              code: 'custom',
              path: [...stepAt, 'provider'],
              message: `provider "${p}" is not configured`,
            })
        for (const name of s.mcp ?? [])
          if (!Object.hasOwn(cfg.mcp, name))
            ctx.addIssue({
              code: 'custom',
              path: [...stepAt, 'mcp'],
              message: `MCP server "${name}" is not configured`,
            })
        for (const p of Object.keys(s.model ?? {}))
          if (!providerIds.includes(p))
            ctx.addIssue({
              code: 'custom',
              path: [...stepAt, 'model', p],
              message: `provider "${p}" is not configured`,
            })
          else if (commandIds.includes(p))
            ctx.addIssue({
              code: 'custom',
              path: [...stepAt, 'model', p],
              message: `no model for the command provider "${p}": put it in its command`,
            })
        // A step that sets neither runs as the rule, already checked.
        if (s !== r && s.mcp === undefined && s.provider === undefined) return
        const mcp = s.mcp ?? r.mcp ?? []
        const provider = s.provider ?? r.provider
        const routed = provider.length > 0 ? provider : providerIds
        const command = routed.find((p) => commandIds.includes(p))
        if (mcp.length > 0 && command)
          ctx.addIssue({
            code: 'custom',
            path: [...stepAt, s.mcp ? 'mcp' : 'provider'],
            message: `the command provider "${command}" gets no MCP servers: route this step to another provider with \`provider\``,
          })
      })
      const scope = r.source ? [r.source] : sourceIds
      if (
        (r.deliver === 'push' || r.deliver === 'pending_review') &&
        lookback(r.where) !== undefined &&
        !matchesOpen(r.where)
      )
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'deliver'],
          message: `${r.deliver} needs an open PR, and this rule matches only merged or closed items; use report, draft_pr or pr`,
        })
      checkWhere(r.where, [...at, 'where'], false, undefined)
      function canFinish(state: WhereValue | undefined, where: Where): boolean {
        const finished = (s: WhereValue) => ['merged', 'closed'].some((f) => matchesValue(s, f))
        const entries = (where.any as Where[] | undefined) ?? []
        return state === undefined
          ? entries.some((w) => canFinish(w.state as WhereValue | undefined, w))
          : finished(state)
      }
      function checkWhere(
        where: Where,
        path: (string | number)[],
        outerBounded: boolean,
        outerState: WhereValue | undefined,
      ) {
        const bounded = outerBounded || newerThan(where.closed as WhereValue) !== undefined
        const state = (where.state as WhereValue | undefined) ?? outerState
        for (const [key, value] of Object.entries(where)) {
          if (key === 'any') {
            for (const [i, w] of (value as Where[]).entries())
              if (Object.keys(w).length === 0)
                ctx.addIssue({
                  code: 'custom',
                  path: [...path, key, i],
                  message: 'an empty entry matches everything',
                })
              else checkWhere(w, [...path, key, i], bounded, state)
            continue
          }
          if (key === 'ours' && path.includes('any')) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, key],
              message: 'ours only lifts the awaywork PR wait at the top of where',
            })
            continue
          }
          const v = value as WhereValue
          const field = itemFields[key] ?? fieldFor(cfg.sources, scope, key)
          if (!field) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, key],
              message: unknownKey(cfg.sources, scope, key),
            })
            continue
          }
          if (typeof v === 'object' && !Array.isArray(v) && isMatch(v)) {
            if (!isText(field))
              ctx.addIssue({
                code: 'custom',
                path: [...path, key],
                message: 'matches needs a text field',
              })
            continue
          }
          if (typeof v === 'object' && !Array.isArray(v) && isAge(v)) {
            if (!field.safeParse(new Date().toISOString()).success)
              ctx.addIssue({
                code: 'custom',
                path: [...path, key],
                message: 'older_than and newer_than need a date field',
              })
            else if (key === 'closed' && !canFinish(state, where))
              ctx.addIssue({
                code: 'custom',
                path: [...path, key],
                message: 'closed only matches merged or closed items; add state: [merged, closed]',
              })
            else if (key === 'closed' && 'older_than' in v && !bounded)
              ctx.addIssue({
                code: 'custom',
                path: [...path, key],
                message: `closed needs newer_than to bound how far back to read; without it, awaywork reads ${DEFAULT_LOOKBACK} back`,
              })
            continue
          }
          const hint = scope.includes('linear') ? "; Linear's workflow state is status" : ''
          for (const scalar of whereValues(v))
            if (!field.safeParse(scalar).success)
              ctx.addIssue({
                code: 'custom',
                path: [...path, key],
                message: `invalid value ${JSON.stringify(scalar)}${key === 'state' ? `: state is open, merged or closed${hint}` : ''}`,
              })
        }
      }
    })
  })
  .transform(({ providers: entries, ...cfg }) => ({
    ...cfg,
    providers: entries.flatMap((entry) =>
      Object.entries(entry as Record<string, ProviderConfig>).map(
        ([id, { model, budget: override, ...config }]) => ({
          id,
          config,
          model,
          budget: {
            ...cfg.budget,
            ...override,
            fallback: { ...cfg.budget.fallback, ...override?.fallback },
          },
        }),
      ),
    ),
  }))

export type Config = z.output<typeof configSchema>

type Sources = Record<string, unknown>

const fieldsOf = (configured: Sources, id: string) => sourceFor(id, configured[id])?.fields ?? {}

/** Whether source `id`'s items can match `where`: it has fields, and so items, unlike bitbucket, and one for each key. */
export function canMatch(configured: Sources, id: string, where: Where): boolean {
  const fields = fieldsOf(configured, id)
  const fits = (w: Where): boolean =>
    Object.entries(w).every(([key, value]) =>
      key === 'any'
        ? (value as Where[]).some(fits)
        : key in itemFields || !!sourceField(fields, key),
    )
  return Object.keys(fields).length > 0 && fits(where)
}

function fieldFor(configured: Sources, scope: string[], key: string): z.ZodType | undefined {
  const matches = scope.flatMap((id) => sourceField(fieldsOf(configured, id), key) ?? [])
  if (matches.length === 0) return undefined
  return matches.length === 1 ? matches[0] : z.union(matches)
}

function whereValues(value: WhereValue): Scalar[] {
  if (typeof value !== 'object' || Array.isArray(value)) return [value].flat()
  if ('not' in value) return [value.not].flat()
  return isAge(value) || isMatch(value) ? [] : bounds(value).map(([, bound]) => bound)
}

/** A field `matches` can test: a string, dates aside, or a union holding one. */
function isText(field: z.core.$ZodType): boolean {
  return field instanceof z.ZodString || (field instanceof z.ZodUnion && field.options.some(isText))
}

function unknownKey(configured: Sources, scope: string[], key: string): string {
  const known = scope.map((id) => `${id}: ${Object.keys(fieldsOf(configured, id)).join(', ')}`)
  const items = Object.keys(itemFields).join(', ')
  return `unknown key "${key}"; use ${items} or a source field (${known.join('; ')})`
}
export type Budget = Config['providers'][number]['budget']
