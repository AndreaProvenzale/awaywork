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
  instructions and delivery, and quota allocation per provider.
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
| Interactive screens (queue reordering, init wizard, live run) | `ink` |
| Config parsing and validation | `yaml`, `zod` (JSON Schema exported for editor autocompletion) |
| Child processes | `execa` |
| Tests | `vitest` |
| Lint and format | `biome` |
| Package manager | `pnpm` |
| Build | `tsup` |

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
  cli/            commander entry, one file per command; ink screens in cli/ui/
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
interface PrRef { repo: string; number: number; url: string; branch: string }
interface Ctx { env: NodeJS.ProcessEnv; log(line: string): void }

interface Source {
  id: string
  configSchema: ZodObject                         // strict; the config file nests it
  fields: Record<string, ZodType>                // what `where` may match on, one scalar each
  secrets(cfg): string[]                         // env var names it reads
  items(cfg, ctx): Promise<Item[]>               // mine, open
  prefetch(item, dir, ctx): Promise<void>        // write context files for the worker
}

interface Provider {
  id: string
  configSchema: ZodObject                         // strict; `budget` is added to it
  credential: 'static' | 'rotating'
  quota: 'window' | 'credits'
  unattended: 'allowed' | 'grey' | 'forbidden'
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx): Promise<Quota | null>              // null = fixed budget
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  skillsDir: string                              // where skills go in the clone
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
  push(dir, branch, opts): Promise<void>         // new branches only, never force
  draftPr(repo, head, base, bodyFile): Promise<string>
}

interface Job { unit: Unit; dir: string; prompt: string; maxTurns: number }

interface Unit {
  id: string; items: Item[]; repo: string; base: string; branch: string   // base '' = default branch
  rule: Rule; skill: string; skills: string[]; providers: string[]
  instructions: string[]; deliver: Deliver
}
type Deliver = 'draft_pr' | 'report'             // 'push' after v1, see Delivery
interface Rule {            // a queue entry, normalized: one-or-many fields are lists
  skill: string; source?: string; where: Record<string, WhereValue>
  provider: string[]; skills: string[]; instructions: string[]; deliver?: Deliver
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
  - claude: {}
  - codex: { budget: { per_night: 5% } }
sources:
  github: { repos: [acme/*] }
  asana: { workspace: "123", token_env: ASANA_TOKEN }
repos:
  acme/api:
    setup: pnpm install --frozen-lockfile
    test: pnpm vitest run {files}
    instructions: notes/acme-api.md
instructions: [notes/me.md]     # every unit
queue:                          # first matching rule wins; top = highest priority
  - skill: fix-ci
    where: { type: pr, mine: true, checks: failing }
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
  skipped. `id` is the top item's key as a slug; `branch` is `night/<id>`.
- **`where`.** Keys are `type` plus the fields the source declares. A
  scalar means equals, a list means any of, and `{ not: … }` negates.
  Against a list-valued field (labels, tags) equals means contains. A
  missing field equals nothing. An unknown key is a config error.
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
  short window. For `credits` providers the long window is the month.
  Without a probe, `fallback` caps units and turns per night.
- **Skills.** `skill` is the main skill, and `skills` are extras available
  to the worker. A name is looked up in `~/.config/night-shift/skills/`,
  then in-repo `.night-shift/skills/`, then the built-ins. Skills are
  copied into the clone at the provider's `skillsDir`. Check each
  provider's skill location in its docs and tag it as in `providers.md`.
- **Prompt**, in order: `harness.md`, the main skill, global
  `instructions`, repo `setup`/`test`/`instructions`, in-repo
  `.night-shift/instructions.md`, the rule's `instructions`.
- **Deliver**, per rule, else the skill's default (frontmatter `metadata`),
  else `draft_pr`. Built-in `review` and `plan` default to `report`.
- **Secrets** are only ever env var names in config. Locally they come
  from the environment or `~/.config/night-shift/env` (mode 600); in
  Actions they come from repository secrets.

## Delivery

- `draft_pr` (default): push a new `night/<key>` branch and open a draft
  PR, into the developer's branch when the unit has one, else into the
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
- [ ] Items through `gh --json`: my PRs, PRs where my review is
      requested, assigned issues; fields `repo`, `label`, `author`, `mine`,
      `draft`, `checks`, `unresolved_threads`, `review_requested`.
- [ ] Prefetch: PR view, diff, threads (deduped by title, per
      `lessons.md`), failed-check logs, issue body and comments → files.
- [ ] Forge: clone with credentials stripped, find PRs by key,
      `night/<…>` existence check, push that refuses existing branches,
      draft PR.
- [ ] Contract suite passes; recorded `gh` fixtures for tests.

### M3 Claude provider, worker, built-in skills
- [ ] `claude.ts`: `claude -p` with stream-json, `--max-turns`, token
      from `CLAUDE_CODE_OAUTH_TOKEN` or the local login; `probe` via the
      Haiku one-turn `rate_limit_event` (`lessons.md`).
- [ ] `harness.md` and the built-in skills, written from the prototype's
      prompts and the "What the worker had to discover" list.
- [ ] `worker/workspace.ts`: clone, install skills, write the assembled
      prompt and the context files.
- [ ] `worker/run.ts`: parse events, kill at the ceiling or at
      `session_max`, and kill at the turn cap.
- [ ] `worker/watchdog.ts`: kill every descendant, stop below 1.5 GB of
      memory or 2 GB of disk. Linux: subreaper or cgroup. macOS: walk the
      process tree. Research both first and tag what you find.

### M4 Publisher, report, first real night
- [ ] `draft_pr`: publish only if the model wrote its PR body; commit
      trailer `Night-shift: <run id>`; skip units whose `night/<…>` exists.
- [ ] `report` delivery and the morning report (markdown in the run dir,
      plus a terminal summary): units done, skipped and why, quota used
      against each ceiling, report-only outputs.
- [ ] Run state in `~/.local/state/night-shift/runs/<id>/` (plan, logs,
      context, report); `nightshift report [id]`.
- [ ] `nightshift run` end to end, `--dry-run`, `--unit <id>`.
- [ ] Burn test on a real repo with Claude, `per_night` included; record
      the results in `lessons.md`.

### M5 Scheduling and doctor
- [ ] `schedule install|remove` for launchd, systemd user timers and
      cron, using the `night` window.
- [ ] `ci init`: writes a GitHub Actions workflow (cron, disk cleanup from
      `lessons.md`, secrets by name only).
- [ ] `doctor`: binaries, versions, credentials present, one probe per
      provider with tonight's ceiling, source reachability, the ToS
      `unattended` flag shown for each provider.

### M6 Asana source
- [ ] Items: `/tasks?assignee=me` in the configured workspace/projects;
      comments from `stories`; fields `project`, `section`, `tags`,
      `fields.*` (custom fields).
- [ ] PR link: the forge fallback by task key; check the attachments path
      (`sources.md`, unverified).
- [ ] Docs: token scope (Asana has no read-only PAT, so say so).

### M7 Codex provider
- [ ] `codex exec` headless run and its event stream; the rotating
      `auth.json` is seeded only when missing and written back after each
      run; runs are serialized per machine.
- [ ] `probe` via `account/rateLimits/read`. It is [C] now, so burn-test
      it and record the result in `providers.md`; fall back to a fixed
      budget.
- [ ] Contract suite; routing with two providers exercised in `plan`
      and in one real night.

### M8 Customization UX (ink)
- [ ] `nightshift init`: detect installed binaries and `gh` login, pick
      providers, sources and a starting queue, write the config.
- [ ] `nightshift queue`: list rules with tonight's matches, reorder with
      the keyboard, save the YAML with comments preserved.
- [ ] `nightshift skills list|eject`: resolved skills and where each
      comes from; copy a built-in to the user dir.

### M9 Release
- [ ] README usage, a configuration reference generated from the schema,
      and guides for adding a provider, a source and a skill.
- [ ] npm publish workflow, versioning, NOTICE (Symphony credit).

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
- **Repo for tracker items without a PR.** An Asana task that links no
  PR has no repo, so `plan` skips it (e.g. the example's rule 4 for a new
  task). A rule-level `repo`, or a repo per Asana project, would fix it.
- **`where` escape hatch**, such as a `script:` filter, if the declarative
  keys aren't enough in practice.
