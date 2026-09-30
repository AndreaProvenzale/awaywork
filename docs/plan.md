---
description: "How v1 is built: scope, stack, architecture, the contracts between modules, config semantics and milestones."
---

# Plan: first release

How v1 gets built, in milestones an agent can pick up in a fresh session.
The shape comes from `design.md`, the facts from `lessons.md`,
`providers.md` and `sources.md`. Read those first.

## v1 scope

- **Providers:** Claude Code, Codex.
- **Sources:** GitHub (also the forge), Asana.
- **Runs:** locally (launchd, systemd, cron) and in GitHub Actions. Codex
  remote is best effort (rotating `auth.json`).
- **Customization:** which providers and sources to use, an ordered queue
  of rules that map items to skills, per-rule provider, extra skills,
  instructions and delivery, the branch name template (global, per repo,
  per rule), and quota allocation per provider.
- **Out:** vendor cloud schedulers, MCP for workers, GitLab/Jira/Linear,
  web UI, delivery modes other than a draft PR or the report.

Adding a provider, source or skill after v1 must be one file (or folder)
plus a registry line, passing a shared contract test. Every milestone
protects that.

## Stack

TypeScript on Node ≥ 22, ESM, published to npm as `nightshift-agent`;
the command is `nightshift`.

| Need | Pick |
|---|---|
| CLI commands | `commander` |
| Interactive prompts (init) | `@clack/prompts` |
| Queue reordering screen | `node:readline` keypress events |
| Config parsing and validation | `yaml`, `zod` (JSON Schema exported for editor autocompletion) |
| Child processes | `execa` |
| Tests | `vitest` |
| Lint and format | `biome` |
| Package manager | `pnpm` |
| Build | `tsup` |
| Docs site | `vitepress` on GitHub Pages |

Add a dependency only when a milestone needs it.

## Architecture

```
collect ──> match ──> dedupe ──> budget ──> dispatch ──> publish ──> report
(sources)   (queue    (one unit  (quota     (workers,    (forge,     (morning
             rules ->  per        probes,    one per      no model)   report)
             skills)   feature)   caps)      unit)
└──────────────── foreman, no model call ────────────────┘
```

```
src/
  cli/            commander entry, one file per command, ask.ts (prompts)
  config/         schema.ts (zod), load.ts (file + env + flags), paths.ts
  core/           types.ts (the contracts below), queue.ts, dedupe.ts,
                  budget.ts, skills.ts, foreman.ts, prompt.ts, report.ts
  providers/      index.ts (registry), claude.ts, codex.ts
  sources/        index.ts (registry), github.ts, asana.ts
  forge/          index.ts, github.ts (clone, find PRs, push, draft PR via gh)
  worker/         run.ts, watchdog.ts, workspace.ts (clone, skills, context)
  scheduler/      launchd.ts, systemd.ts, cron.ts, github-actions.ts
harness.md        fixed worker prompt: guardrails, PR body, stop rules
skills/           built-in skills, one Agent Skills folder each
test/contracts/   provider.contract.ts, source.contract.ts (shared suites)
test/fakes/       fake source, fake provider, fake forge
```

## Skills, not kinds

The prototype hard-coded work kinds (`ci_red`, `qa_feedback`, …). v1
replaces them:

- **Sources state facts.** Each item has a `type` (`pr`, `issue`,
  `task`) and source-declared `fields`, e.g. a GitHub PR carries `mine`,
  `checks` (`failing`, `pending`, `passing`), `unresolved_threads`,
  `review_requested`; an Asana task carries `project`, `section`, `tags`.
  The source also prefetches the context that fits the item type.
- **Rules pick the skill.** A queue rule matches items on those fields
  and names a `skill`: an Agent Skills folder (`SKILL.md`) that tells the
  worker what to do.
- **Built-in skills** ship as defaults and cover the prototype's kinds:
  `fix-ci`, `address-review`, `qa-feedback`, `continue`, `plan`,
  `implement`, `review`. `nightshift skills eject <name>` copies one into
  the user's skills dir to tweak; a user skill shadows a built-in of the
  same name.
- **The harness wraps every skill.** `harness.md` holds what no skill
  may change: where the context files are, no forge access, write the PR
  body after the first commit, targeted tests only, no builds or
  background commands, stop rules. A skill decides the work, the harness
  decides the limits.

## Contracts

These live in `src/core/types.ts` and are the seams between milestones.
Changing one means updating this section in the same PR.

```ts
interface Item {            // from sources.md, plus the forge link
  source: string; id: string; key: string; type: 'pr' | 'issue' | 'task'
  title: string; description: string; url: string; status: string
  assignee?: string; reviewers: string[]; labels: string[]
  comments: { author: string; body: string; at: string }[]
  linkedPrs: PrRef[]; fields: Record<string, unknown>; raw: unknown
}                           // a PR item links itself
interface PrRef { repo: string; number: number; url: string; branch: string; ours: boolean }  // ours = night-shift footer
interface Ctx { env: NodeJS.ProcessEnv; log(line: string): void }

interface Source {
  id: string
  configSchema: ZodObject                         // strict; the config file nests it
  fields: Record<string, ZodType>                // what `where` may match on, one scalar each;
                                                 // `prefix.*` declares every `prefix.<name>`
  secrets(cfg): string[]                         // env var names it reads
  items(cfg, ctx): Promise<Item[]>               // mine, open
  prefetch(item, dir, ctx): Promise<void>        // write context files for the worker
  init?(ask: Ask, ctx): Promise<SourceSetup>     // its own `nightshift init` questions
}
interface SourceSetup {     // config as written; values found for `where` fields (real sections)
  config: Record<string, unknown>; values?: Record<string, string[]>
}
interface Ask {             // terminal prompts in the CLI, a script in tests
  text; select; multiselect; confirm; note
  secret(name, message): Promise<string>         // prompts, saves to the env file; '' = skipped
}

interface Provider {
  id: string
  configSchema: ZodObject                         // strict; `budget` is added to it
  credential: 'static' | 'rotating'
  quota: 'window' | 'credits'
  unattended: 'allowed' | 'grey' | 'forbidden'
  package: string                                // npm package with the binary, for runners
  secrets: string[]                              // env var names it reads unattended
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx): Promise<Quota | null>              // null = fixed budget
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  skillsDir?: string                             // where skills go in the clone; unset: job.plugin
  instructionsFile: string                       // CLAUDE.md, AGENTS.md, …
}

interface Quota {           // short = 5 h session, long = weekly or monthly; used 0–1, resetsAt unix s
  windows: { name: string; span: 'short' | 'long'; used: number; resetsAt: number }[]
}
type WorkerEvent = { type: 'quota'; quota: Quota } | { type: 'log'; line: string }
                 | { type: 'done'; ok: boolean; turns: number }

interface Forge {
  clone(repo, branch, dir): Promise<void>        // credentials stripped afterwards
  prsFor(item): Promise<PrRef[]>                 // fallback link by key in branch/title
  branchExists(repo, name): Promise<boolean>
  push(dir, branch, opts): Promise<void>         // only branches absent on the remote, never force
  draftPr(repo, head, base, bodyFile, runId): Promise<string>   // title = the body's first line; adds the footer
}

interface Job { unit: Unit; dir: string; prompt: string; maxTurns: number; model?: string; env: ProcessEnv }  // env from workerEnv

interface Unit {
  id: string; items: Item[]; repo: string; base: string; branch: string   // base '' = default branch; branch rendered
  foreign: boolean                               // base is a PR someone else opened
  rule: Rule; skill: string; skills: string[]; providers: string[]
  instructions: string[]; deliver: Deliver
}
type Deliver = 'draft_pr' | 'report'             // 'push' after v1, see Delivery
interface Rule {            // a queue entry, normalized: one-or-many fields are lists
  skill: string; source?: string; where: Record<string, WhereValue>
  provider: string[]; skills: string[]; instructions: string[]; deliver?: Deliver
  branch?: string
}
```

## Config

User config, validated by zod. `nightshift config schema` prints the
JSON Schema. The path is provisional; `--config` and `NIGHT_SHIFT_CONFIG`
override it.

```yaml
# ~/.config/night-shift/config.yml
night: { start: "01:00", end: "07:00" }
budget:                         # defaults; any provider can override
  reserve: 10%                  # never go past 1 - reserve of any window
  per_night: 15%                # at most this share of the long window per night
  session_max: 90%              # stop a worker past this share of the short window
  fallback: { units: 4, turns: 60 }   # when the quota can't be read
providers:                      # order = routing preference
  - claude                      # a name, or a map to override
  - codex: { budget: { per_night: 5% } }
sources:
  github: { repos: [acme/*] }
  asana:
    workspace: "123"
    token_env: ASANA_TOKEN
    project_repos: { "1201": acme/api }   # project gid -> the repo its tasks' code lives in
branch: night/{key}             # default; {key} is required
repos:
  acme/api:
    branch: feat/{key}-{title}
    setup: pnpm install --frozen-lockfile
    test: pnpm vitest run {files}
    instructions: notes/acme-api.md
instructions: [notes/me.md]     # every unit
queue:                          # first matching rule wins; top = highest priority
  - skill: fix-ci
    where: { type: pr, mine: true, checks: failing }
    branch: fix/{key}
  - skill: implement
    source: github
    where: { type: issue, label: night-shift, repo: acme/api }
  - skill: review
    where: { type: pr, review_requested: true }
  - skill: implement
    source: asana
    where: { section: Ready, tags: backend }
    provider: codex
    skills: [our-api-conventions]
    instructions: notes/backend.md
```

Semantics, fixed so every milestone agrees:

- **Queue.** An item takes the first rule it matches. Units are ordered by
  that rule's position, then by source order (oldest first). An item that
  matches no rule is skipped. With no `queue`, a built-in default queue
  reproduces the prototype's order (`design.md`), keeping only rules for
  configured sources: `fix-ci` (GitHub, my PR, checks failing),
  `qa-feedback` (Asana section `QA`), `address-review` (my PR, unresolved
  threads), `review` (review requested), `continue` (Asana `In progress`),
  `plan` (Asana `Current sprint`).
- **Units.** Items sharing a key or a linked PR (repo + branch) are one
  unit, placed at its best-ranked item's rule. The unit works in the
  linked PR's repo, else the item's `repo` field; with neither it is
  skipped. A tracker source fills `repo` from its own mapping, e.g.
  Asana's `project_repos` (a task's first mapped project wins). `id` is the top item's key as a slug. A unit whose items link
  an open night-shift PR (`ours`) is skipped as waiting for review; such
  a PR is never a unit's base.
- **Chains.** A rule's `then` is a step or a list of steps: a skill
  name, or a map with the rule keys other than `source`, `where`, `order`
  and `then`, inheriting none of the rule's. Each step is a unit planned
  after the rule's, id `<unit>-<skill slug>`, that runs only when the one
  before delivered and gets its `out/` in `.nightshift/context/previous/`.
  After a draft PR the step's base is that PR's branch, so its own draft
  PR stacks on it; after a report the base is unchanged, except that a
  draft PR step off the default branch stacks at run time on the repo's
  last stacked draft PR that night. A step's branch gets `-<skill>`
  appended when an earlier draft PR in the chain renders the same name.
  A skill runs at most once outside loops, and once across the chain's loops.
- **Loops.** A `then` entry `{ loop: steps, until, max }` repeats its
  steps round after round, planned as units `<unit>-<skill>-<round>` up
  to `max` (at most 5). Rounds work in the clone of the draft PR unit
  before the loop, whose publish waits for the loop's end; after a
  report the loop's first unit clones afresh and hosts it. `until` is
  checked after every step; its `verdict` matches the latest word a step
  wrote to `out/verdict`. Before each step `context/previous/` holds the
  step before's `report.md`, `verdict`, `pr.md` and a `diff.patch` of
  its commits. A round that can't route, reaches `night.end`, fails or
  stops ends the loop, which publishes what it has; night-shift appends
  the loop's summary and last report to the PR body. A loop counts once
  against the caps and as an attempt through its host; a step after the
  loop follows the host.
- **Attempts.** A unit whose worker finished records each item's
  `updated` time and the unit's skill in
  `~/.local/state/night-shift/attempts.json`; a unit of the same skill
  none of whose items changed since is skipped as unchanged since that
  run. A chain records its items once, when every unit finished or
  the chain ended at a unit that made nothing; commits left unpushed
  retry, and a step is never skipped on its own. A unit picked with
  `run --unit` isn't skipped. A chain that ran but didn't finish counts
  one failure on each item instead; after 3 in a row on the same
  `updated` time and skill the unit is skipped as gave up. Not
  persisted in Actions.
- **Skips.** `nightshift skip <source:key>` keeps `{ until?, reason? }`
  under `source:key` in `~/.local/state/night-shift/skips.json`, which
  only `skip` and `unskip` write. A unit with a skipped item is skipped
  until `unskip` or the start of the `until` day; `run --unit` ignores
  skips. Not persisted in Actions.
- **Branch.** The rule's `branch`, else the repo's, else the global one,
  rendered per unit. `{key}` is the top item's key in its own case, runs
  outside `[A-Za-z0-9._-]` replaced by `-` (`acme-api-12`, `ABC-123`);
  `{title}` is the title as a lowercase slug of at most 40 characters.
  A template without `{key}`, or one that renders an invalid ref, is a
  config error. The name is cosmetic: the push guardrail is that the
  branch doesn't exist on the remote.
- **Conventions.** PR title, body and commit messages have no config.
  The harness has the model follow the repo's PR template, recent commit
  style and any rule in the instructions (e.g. "prefix titles with the
  key"). The publisher appends a footer naming night-shift and the run
  id; it discloses the author and marks the PR as `ours`.
- **`where`.** Keys are `type` plus the fields the source declares. A
  scalar means equals, a list means any of, and `{ not: … }` negates.
  Against a list-valued field (labels, tags) equals means contains. A
  missing field equals nothing. An unknown key is a config error. Asana
  custom fields match as `fields.<name>`, e.g. `"fields.Priority": High`.
- **Routing.** A rule's `provider` (one or a list) is used in that order;
  otherwise the `providers` order. The first provider under its ceiling
  takes the unit; a provider without a probe takes at most `fallback.units`.
  `plan` routes with the quota read before the night; the run re-routes
  as windows fill.
- **Budget.** Each provider has a ceiling for tonight on its long window:
  the lowest of `used + per_night`, `1 - reserve`, and the paced ceiling
  in `lessons.md` ("Budgeting a night"), where nights to reset is the
  whole days until `resetsAt`, rounded up, at least one. Unset `per_night` leaves only
  the pacing. Workers stop at that ceiling or at `session_max` of the
  short window, as soon as the provider reports quota: mid-run for
  Claude, after the run for Codex. For `credits` providers the long window is the month.
  Without a probe, `fallback` caps units and turns per night.
- **Skills.** `skill` is the main skill, and `skills` are extras available
  to the worker. A name is looked up in `~/.config/night-shift/skills/`,
  then in-repo `.night-shift/skills/`, then the built-ins. Skills are
  copied into the clone at the provider's `skillsDir`, or into a plugin
  folder outside it for a provider without one (Claude). Check each
  provider's skill location in its docs and tag it as in `providers.md`.
- **Prompt**, in order: `harness.md`, the main skill, global
  `instructions`, repo `setup`/`test`/`instructions`, in-repo
  `.night-shift/instructions.md`, the rule's `instructions`.
- **Workspace.** A unit runs in a fresh clone on its new branch, cut
  from `base`. Skills go to the provider's `skillsDir` or plugin; `.nightshift/`
  holds `context/<item key slug>/`, `prompt.md` and `out/`, where the
  model writes `pr.md` (first line the title) or `report.md`. Both are
  in `.git/info/exclude`, so the model can't commit them. The model's
  environment has no forge token and a `GH_CONFIG_DIR` without a login.
- **Deliver**, per rule, else the skill's default (frontmatter `metadata`),
  else `draft_pr`. Built-in `review` and `plan` default to `report`.
- **Secrets** are only ever env var names in config. Locally they come
  from the environment or `~/.config/night-shift/env` (mode 600; the
  environment wins); in Actions they come from repository secrets, with
  `GH_TOKEN` for the forge and the config at `.night-shift/config.yml`.

## Delivery

- `draft_pr` (default): push the unit's new branch and open a draft PR,
  into the developer's branch when the unit has one, else into the
  default branch.
- `report`: nothing is pushed; the output goes into the morning report.
- `push` (after v1): commit onto the developer's own branch, only when
  a rule opts in, the branch is the developer's own PR head, and the push
  is a fast-forward. Never someone else's branch, never force, never
  merge, never a comment.

## Milestones

Each milestone is one branch and one or more PRs. Tick the boxes as they
land. Dependencies: M1 needs M0; M2, M3 and M6 need M1; M4 needs M2 and
M3; M5 and M7 need M4; M8 needs M1; M9 needs everything else.

### M0 Skeleton
- [x] Package, tsconfig, lint, vitest, tsup, CI workflow (lint, typecheck, test).
- [x] `src/core/types.ts` with the contracts above.
- [x] Config schema, loader and `config schema` / `config check` commands.
- [x] Registries for providers and sources; fakes in `test/fakes/`.
- [x] Shared contract suites in `test/contracts/`, run against the fakes.

Done when `nightshift config check` validates the example above and
reports a clear error for a bad `where` key or an unknown skill.

### M1 Foreman core (pure, no I/O)
- [x] `queue.ts`: rule matching, `where` semantics, ordering, the default
      queue.
- [x] `dedupe.ts`: one unit per feature (same repo+branch or linked item
      key); the highest-ranked rule wins; items merge.
- [x] `budget.ts`: tonight's ceiling per provider (`reserve`, `per_night`,
      pacing), `session_max`, fallback, routing.
- [x] Skill resolution (user, in-repo, built-in) and the prompt order.
- [x] `nightshift plan`: collect → match → dedupe → budget, printed as a
      table (unit, rule #, skill, provider, deliver) plus each provider's
      ceiling. No worker runs.

Done when `plan` against fakes shows the expected order and ceilings for
a table of config cases, all covered by unit tests. This is the command
users will use to debug their customization, so its output has to explain
why a unit is placed where it is.

### M2 GitHub source and forge
- [x] Items through `gh api graphql` (`--json` lacks review threads): my
      PRs, PRs where my review is requested, assigned issues; fields
      `repo`, `label`, `author`, `mine` (my PR or assigned issue), `draft`,
      `checks` (absent without checks), `unresolved_threads`,
      `review_requested`. An issue links the open PRs that close it.
- [x] Prefetch: `pr.md` (view, comments, reviews), `diff.patch`,
      `threads.md` (unresolved, deduped by title, per `lessons.md`),
      `checks.md` (last 200 lines of each failed Actions job), or
      `issue.md` (body and comments). One item per dir.
- [x] Forge: clone through `gh`'s login with no credential helper left
      in the clone, find my PRs by key, `night/<…>` existence check, push
      that refuses existing and non-`night/` branches, draft PR.
- [x] Contract suite passes; recorded `gh` fixtures for tests. Push and
      draft PR are tested on fixtures only; M4's burn test runs them.

### M3 Claude provider, worker, built-in skills
- [x] `claude.ts`: `claude -p` with stream-json, `--max-turns`, token
      from `CLAUDE_CODE_OAUTH_TOKEN` or the local login; `probe` via the
      Haiku one-turn `rate_limit_event` (`lessons.md`).
- [x] `harness.md` and the built-in skills, written from the prototype's
      prompts and the "What the worker had to discover" list. The
      harness points the model at the repo's PR template and commit style.
- [x] `worker/workspace.ts`: clone, install skills, write the assembled
      prompt and the context files.
- [x] `worker/run.ts`: parse events, kill at the ceiling or at
      `session_max`. The provider enforces the turn cap (`--max-turns`
      ends the run itself, `providers.md`).
- [x] `worker/watchdog.ts`: kill every descendant, stop below 1.5 GB of
      memory or 2 GB of disk. Findings in `design.md`, "Watchdog".

### M4 Publisher, report, first real night
- [x] Branch template: `branch` in config (global, repo, rule) with the
      checks above, rendered in the foreman and shown by `plan`. Forge:
      drop M2's `night/` prefix check (the absent-branch check stays),
      read PR bodies so `prsFor` sets `ours`.
- [x] `draft_pr`: publish only if the model wrote its PR body; commit
      trailer `Night-shift: <run id>`, added at publish time since a
      repo's `core.hooksPath` (husky) bypasses a hook in the clone; the
      body footer; skip units with an open night-shift PR; refuse a
      branch that exists, checked before the worker runs and again at
      push.
- [x] `report` delivery and the morning report (markdown in the run dir,
      plus a terminal summary): units done, skipped and why, quota used
      against each ceiling, report-only outputs.
- [x] Run state in `~/.local/state/night-shift/runs/<id>/` (plan, logs,
      context, report); `nightshift report [id]`.
- [x] `nightshift run` end to end, `--dry-run` (workspaces only, no
      worker), `--unit <id>`. Units run one at a time; each re-routes on
      the quota the previous worker saw; a provider at `session_max` is
      passed over. Without a quota reading the turn cap is
      `fallback.turns`, otherwise 200.
- [x] Burn test on a real repo with Claude, `per_night` included; record
      the results in `lessons.md`. The unit stayed below 1% of either
      window, so stopping at the ceiling is still only tested on fakes.

### M5 Scheduling and doctor
- [x] `schedule install|remove` for launchd, systemd user timers and
      cron, using the `night` window: the job starts
      `run --scheduled` at `night.start` with the installing shell's
      PATH; a scheduled run outside the window does nothing and starts
      no unit after `night.end`.
- [x] `ci init`: writes a GitHub Actions workflow (cron, disk cleanup from
      `lessons.md`, secrets by name only). The schedule's `timezone` is
      [C] (GitHub changelog, not yet seen firing on a runner).
- [x] `doctor`: binaries, versions, credentials present, one probe per
      provider with tonight's ceiling, source reachability, the ToS
      `unattended` flag shown for each provider.

### M6 Asana source
- [x] Items: `/tasks?assignee=me` in the configured workspace/projects;
      comments from `stories`; fields `project`, `section`, `tags`,
      `fields.*` (custom fields). The key is the task's custom ID
      (`ENG-12`) when it has one, else its gid. Prefetch writes `task.md`.
- [x] PR link: the forge fallback by task key, run on every task that
      links no PR before planning. The attachments path stays unverified
      and unused (`sources.md`).
- [x] Docs: token scope (Asana has no read-only PAT, so say so).
- [x] `project_repos` maps a project gid to a repo, filling the `repo`
      field so a task with no PR still gets a unit; `init` asks for one
      per picked project.
- [x] Contract suite passes on fixtures shaped from Asana's documented
      responses; `test/real-asana.test.ts` reads a real workspace when
      `ASANA_TOKEN` and `NIGHTSHIFT_ASANA_WORKSPACE` are set. Not yet
      run against a live workspace.

### M7 Codex provider
- [x] `codex exec --json` headless run and its event stream; the turn
      cap counts tool calls, since `exec` has none. The rotating
      `auth.json` in `$CODEX_HOME` is seeded from `CODEX_AUTH_JSON` only
      when missing; Codex writes the refreshed file back in place, and
      night-shift never rewrites an existing one. Runs and probes hold a
      per-machine lock. An ephemeral runner has nowhere to persist the
      refreshed file, so Codex remote stays best effort.
- [x] `probe` via `account/rateLimits/read` through `codex app-server`,
      burn-tested and recorded in `providers.md` [V]; a failed read falls
      back to a fixed budget. `exec` carries no quota and a second Codex
      process could race the token refresh, so a run reads it once it
      ends: Codex workers stop at the ceiling between units, not mid-run.
- [x] Contract suite; routing with two providers exercised in `plan`
      (tests, and `plan` on this repo) and in one real night (`lessons.md`).

### M8 Customization UX
Screens only where an editor can't help: discovery (`init`) and live
feedback (`queue`). Every other setting is edited as YAML, with the JSON
Schema for autocompletion and `config edit` as the safety net.

- [x] `nightshift init`: detect installed binaries and `gh` login, pick
      providers, sources and a starting queue, write the config. Each
      source asks its own questions (`Source.init`); Asana lists
      workspaces, projects and the real section names, and each default
      Asana rule picks its section from them. An unset token is prompted
      for and saved to the env file. The queue is written out, not left
      to the hidden default.
- [x] `nightshift queue`: list rules with tonight's matches and the items
      an earlier rule took, reorder with the keyboard (counts update as
      rules move), save the YAML with comments preserved: rules move as
      source text with the comments above them, the rest of the file is
      unchanged. No queue in the config: saving writes the default one.
      Items are fetched once; no provider is probed.
- [x] `nightshift skills list|eject`: resolved skills and where each
      comes from; copy a built-in to the user dir.
- [x] `nightshift config edit`: `$VISUAL`/`$EDITOR` on a draft copy,
      written over the config only once it validates; a scheduled run
      never sees a broken config.
- [x] Providers take a bare name (`- claude`) next to the override map.

### M9 Release
- [ ] The end-to-end pass in `e2e.md`, results recorded in `lessons.md`.
- [x] README usage, a configuration reference generated from the schema,
      and guides for adding a provider, a source and a skill. User docs in
      `docs/guide/` and `docs/extend/`, published to GitHub Pages with
      VitePress, plus `llms.txt`, `llms-full.txt` and each page as Markdown.
      `pnpm docs:gen` writes the CLI and config references and the JSON
      Schema from the CLI's source; CI fails when they are stale.
- [x] npm publish workflow (a `v*` tag, trusted publishing, `next` for
      pre-releases), versioning in `CONTRIBUTING.md`, Apache-2.0 LICENSE
      and NOTICE (Symphony credit). Neither workflow has run yet.

## Rules for agents picking this up

- Read `CLAUDE.md`, `README.md`, `docs/`, then this file. Take one
  unchecked milestone whose dependencies are done.
- Contracts and config semantics above are the agreement between
  sessions. Change them only in the same PR as this file.
- A provider or source claim tagged [C] or [I] gets a test or a burn
  test before code depends on it. Record the result with its tag.
- Test everything that doesn't spawn a vendor binary against the fakes
  and recorded fixtures. Mark real-binary tests and skip them in CI.

## Open decisions

- **Keeping the morning's session window fresh.** A 5 h window opened at
  04:00 is still open at 09:00. A rule like "no new unit whose short
  window would outlive `night.end`" may matter more than `per_night` for
  daytime use. Decide after the M4 burn test.
- **Pending GitHub reviews** as a `review` delivery: a write through the
  developer's token, even if unsubmitted.
- **Config path**, and whether a team-shared in-repo `.night-shift.yml`
  can also hold queue rules.
- **In-repo skills in `config check`.** It sees only user and built-in
  skills, so a rule naming an in-repo `.night-shift/skills/` skill fails
  the check. Resolve once M3 clones repos.
- **Mapping tracker columns to skills.** Section and status names are the
  user's own, so the default queue's Asana names (`QA`, `In progress`,
  `Current sprint`) are guesses. Symphony has no mapping layer: config
  lists provider-native `active_states`/`terminal_states`, compared
  case-insensitively, and one prompt serves every state [V]
  (https://github.com/openai/symphony/blob/main/SPEC.md). Our `where` on
  native names already goes further, and `init` picks each rule's section
  from the user's real ones (M8). Still open: the default queue guesses
  names when a config has no queue, and case-insensitive matching for
  native state names.
- **PR metadata beyond the branch**: labels, reviewers, ready instead
  of draft, a base override. None is config until someone asks.
  Requesting reviewers notifies people through the developer's token, so
  it needs the same scrutiny as pending reviews.
- **`where` escape hatch**, such as a `script:` filter, if the declarative
  keys aren't enough in practice.
