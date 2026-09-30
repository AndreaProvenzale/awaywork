---
description: The night-shift config file by example, covering the night window, budgets, providers, sources, per-repo settings, branch names, instructions and queue rules with where matching.
---

# Configuration

One YAML file, `~/.config/night-shift/config.yml` by default;
`--config <path>` or `NIGHT_SHIFT_CONFIG` point elsewhere. Every key is
listed in the [reference](../reference/config.md).

## Editing safely

```sh
nightshift config edit    # opens $VISUAL/$EDITOR on a copy; saved only once valid
nightshift config check   # validate, including skill names
nightshift plan           # see what the change does tonight
```

For autocompletion and hover docs in editors with the YAML language
server (VS Code's YAML extension, JetBrains, Neovim), put this first line
in the file:

```yaml
# yaml-language-server: $schema=https://andreaprovenzale.github.io/night-shift/config.schema.json
```

`nightshift config schema` prints the same JSON Schema for the installed
version.

## A full example

```yaml
night:
  start: "01:00"
  end: "07:00"
  units: 8                      # caps, unset by default
  units_per_repo: 3
budget:                         # defaults; any provider can override
  reserve: 10%                  # never go past 1 - reserve of any window
  per_night: 15%                # at most this share of the long window per night
  session_max: 90%              # stop a worker past this share of the short window
  unit_minutes: 90              # stop a worker after this many minutes
  fallback: { units: 4, turns: 60 }   # when the quota can't be read
providers:                      # order = routing preference
  - claude: { model: opus, settings: claude-worker.json }   # default: the binary's own model
  - codex: { budget: { per_night: 5% }, config: { model_reasoning_effort: high } }
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
    setup: pnpm install --frozen-lockfile   # run before the worker
    secrets: [NPM_TOKEN]        # only setup sees these
    test: pnpm vitest run {files}
    instructions: notes/acme-api.md
instructions: [notes/me.md]     # every unit
skills: [house-style]           # every unit, next to a rule's skills
queue:                          # first matching rule wins; top = highest priority
  - skill: fix-ci
    where: { type: pr, mine: true, checks: failing }
    branch: fix/{key}
  - skill: implement
    source: github
    where: { type: issue, label: night-shift, repo: acme/api }
    order: oldest
    units: 2                    # at most 2 of these per night
  - skill: review
    where: { type: pr, review_requested: true, trusted: true }
    model: { claude: sonnet }
  - skill: implement
    source: asana
    where: { section: Ready, tags: backend }
    provider: codex
    skills: [our-api-conventions]
    instructions: notes/backend.md
```

## Night and budget

`night.start` is when a scheduled run begins; no unit starts after
`night.end`, and a running one stops there. Times are local to the machine, or to the workflow's
`timezone` in GitHub Actions.

A readable quota decides how much work fits, not how much you can review
in a morning. `night.units` caps the units planned per night,
`night.units_per_repo` those in any one repo, and a rule's `units` those
from that rule. None is set by default. Units past a cap are skipped in
queue order, with the cap named in `nightshift plan` and the report. A
[`then`](#then) step counts as a unit of the rule that started its chain.
Only units routed to a provider count, and caps apply to each `nightshift
run`, like `fallback.units`.

Budgets are shares of each provider's quota windows; see
[How it works](./how-it-works.md#budget) for how they combine. Start low:
`per_night: 5%` for a week shows what a unit costs you before you raise it.

## Providers

A list, in routing order. A bare name uses the defaults; a map overrides
the budget for that provider or sets its `model`, passed as is to the
binary (`claude --model`, `codex exec -m`). Without one, the binary picks
its own default.

Workers skip your user-level agent config. To give them the hooks, env
or settings you do want, list them here; they apply on every unit,
including someone else's PR:

- `claude: { settings: <file> }`: a Claude Code settings file, relative
  to the config file, passed as `--settings`. Auto-memory stays off.
- `codex: { config: { <key>: <value> } }`: each key passed as
  `codex exec -c key=value`, e.g. `model_reasoning_effort: high`.

## Sources

| Source | Keys |
|---|---|
| `github` | `repos`: `owner/name` globs such as `acme/*` |
| `asana` | `workspace` gid, optional `projects` (gids), `project_repos` (project gid → `owner/name`), `token_env` (default `ASANA_TOKEN`) |
| `linear` | optional `team_repos` (team key → `owner/name`), `token_env` (default `LINEAR_API_KEY`) |
| `jira` | `site` host (`acme.atlassian.net`), `email` of the token's account, optional `cloud_id` (for a scoped token), `jql` (a condition ANDed with my unresolved issues, no `ORDER BY`), `project_repos` (project key → `owner/name`), `token_env` (default `JIRA_API_TOKEN`) |
| any other name | `command` printing your items as JSON, `fields`, `secrets`, `setup`: see [Custom sources](./custom-sources.md) |

Asana has no read-only personal token: the token can do anything you can.
night-shift only reads with it and never hands it to the agent. Create
one just for night-shift so you can revoke it alone.

Linear takes a personal API key (Settings > Account > Security & access).
night-shift only reads with it and never hands it to the agent: when
Linear offers the choice, give the key read access only.

Jira Cloud takes an Atlassian API token (id.atlassian.com > Security >
API tokens). Prefer "Create API token with scopes", app Jira, scope
`read:jira-work`: `init` then finds the site's `cloud_id` and night-shift
calls `api.atlassian.com`, as scoped tokens require. A token without
scopes can do anything you can; night-shift only reads with it. Tokens
expire after at most a year.

Jira custom fields that share a name are keyed by name and id, such as
`fields.Team (customfield_10040)`.

## Branch names

`branch` is a template rendered per unit, set globally, per repo or per
rule (the most specific wins). `{key}` is required; `{title}` is the
item's title as a slug of at most 40 characters.

| Item | `{key}` |
|---|---|
| GitHub PR or issue `acme/api#12` | `acme-api-12` |
| Asana task with custom ID `ENG-12` | `ENG-12` |
| Linear issue `ENG-12` | `ENG-12` |
| Jira issue `ENG-12` | `ENG-12` |

The name is cosmetic. The guardrail is that night-shift only pushes a
branch that doesn't exist on the remote yet, unless a rule opts in to
[`push`](#push).

## Repos and instructions

`repos.<owner/name>` holds the `setup` and `test` commands for that
repo, plus an instructions file. `setup` runs in the clone before the
agent starts, outside the model; the agent is told it already ran.
Anything it leaves running is stopped when it exits. A setup that fails,
takes over 15 minutes or reaches `night.end` skips the unit, with the
tail of its output in the report.

`secrets` names the env vars setup needs, such as a private registry
token: setup gets them and no other secret, the agent never sees them,
and the GitHub Actions workflow passes them from repository secrets.
Their values are masked in setup's output. On a PR someone else opened,
setup runs the author's install scripts, so it gets none of them, and
it runs only when the author has write access or org membership;
otherwise the agent is told it didn't run. It gets none of them either
on a branch a worker wrote: a `then` step's after a draft PR or a push,
a stacked draft PR's, or a night-shift PR's a rule took up again. Read
them from the repo's config, e.g. `${NPM_TOKEN}` in `.npmrc`, rather
than writing them to your home directory, which the agent shares.

`test` is given to the agent in its prompt. `instructions` at the top
level, per repo and per rule are **file paths**, relative to the config
file. A repo can also carry `.night-shift/instructions.md`, read from the
clone unless the unit is on a PR someone else opened.

`network: false` on a repo or a rule cuts the agent's commands off the
network; the rule wins over the repo and covers its `then` steps. Unset,
it is on. `setup` keeps the network, so it can install what the agent
needs, but it doesn't run on an untrusted author's PR: there an offline
agent has only the clone. Offline is tested on macOS only: on Linux,
Claude Code's sandbox needs bubblewrap and socat, and neither agent's is
verified there yet [I]. See [Safety](./safety.md#network).

`skills` at the top level adds skills to every unit, like a rule's
`skills`; see [Skills](./skills.md#where-skills-come-from).

PR titles, bodies and commit messages have no config: the agent follows
the repo's PR template, its recent commit style and your instructions
(e.g. "prefix PR titles with the task key").

## Queue rules

| Key | Meaning |
|---|---|
| `skill` | The skill that does the work (`nightshift skills list`) |
| `source` | Only items from this source |
| `where` | Conditions on `type` and the source's fields |
| `provider` | One or a list; overrides the global order for this rule |
| `model` | A model per provider, e.g. `{ claude: sonnet, codex: gpt-5-codex }`; overrides the provider's `model` for this rule |
| `skills` | Extra skills the agent may use |
| `instructions` | One or more instruction files for this rule |
| `deliver` | `draft_pr`, `report`, or `push`: commits onto your own open PR's branch, see [`push`](#push); default from the skill |
| `branch` | Branch template for this rule |
| `order` | Which matching item goes first: `oldest` or `newest` created, or last `updated`; default the source's order |
| `units` | At most this many units per night from this rule, its `then` steps included |
| `then` | Steps that run after this rule's unit, the same night; see [`then`](#then) |
| `network` | `false` cuts the agent's commands off the network, `then` steps included; default the repo's |

### `where`

```yaml
where:
  type: pr                          # equals
  checks: [failing, pending]        # any of
  review_requested: { not: true }   # not
  unresolved_threads: { gte: 2 }    # on a number field: gt, gte, lt, lte; combine for a range
  updated: { older_than: 3d }       # on a date field: older_than, newer_than; m, h, d or w
  label: night-shift                # on a list field: contains
  "fields.Priority": High           # an Asana custom field
```

A missing field equals nothing, and is neither older nor newer than
anything; spans count back from when the plan runs. An unknown key is a config error that
lists the keys each source offers. The [field table](./how-it-works.md#items)
lists them too.

A PR night-shift opened only matches a rule whose `where` names `ours`,
so rules written for your own PRs leave it waiting for your review. To
act on it once you've reviewed it:

```yaml
- skill: address-review
  where: { type: pr, mine: true, ours: true, my_unresolved_threads: { not: 0 } }
```

The unit's draft PR stacks on the night-shift PR, on a branch named
after it (`night/acme-api-9` for #9). Delete that branch once you merge
the stacked PR, since GitHub keeps it by default: while it exists, the
next pickup of #9 is skipped as `night/acme-api-9 already exists`.
Resolve the threads it answered too: merging moves #9, and with your
threads still open the rule takes it up again for the same threads.
The rule runs on the threads you started, but the agent reads every
unresolved thread, as on your other PRs. `ours` comes from the GitHub
source: a custom source's `ours` field holds nothing back.

### `order`

Within a rule, units run in the order the source returns items; for
GitHub that is newest first, so with little quota the oldest can wait
night after night. `order: oldest` runs them first. Items without the
timestamp go last.

### `then`

Steps run right after the rule's unit, one after the other, each on what
the one before delivered. A step is a skill name, or a map when you want
to set more:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: night-shift }
    then: review

  - skill: plan
    where: { section: Ready }
    model: { claude: opus }
    then:
      - { skill: implement, model: { claude: sonnet }, instructions: notes/impl.md }
      - { skill: review, provider: codex }
```

- A step takes the rule keys except `source`, `where`, `order`, `units`
  and `then`, plus [`when`](#when). It inherits none of the rule's: an
  unset key has the same default as on a rule. Top-level `instructions`
  and `skills` still apply, as to every unit.
- After a draft PR, the next step starts from that PR's branch, and a
  draft PR it opens is stacked on it: its body names that PR to merge
  first. After a report, it starts from the same base, except that a
  draft PR it would open off the default branch stacks on the repo's
  last one that night, as any unit's does. After a push, it starts from
  your PR's branch, pushed commits included.
- The step finds what the one before delivered in
  `.nightshift/context/previous/`: `pr.md` and `diff.patch`, `report.md`,
  or both `report.md` and `diff.patch` after a push.
- A step runs only when the one before delivered; otherwise the rest of
  the chain is skipped, with the reason in the report. Once a unit in the
  chain opened a draft PR, the next night doesn't retry: the item waits
  for your review of it. Otherwise the whole chain runs again.
- Each step is a unit of its own in `plan` and the report (`<unit>-<skill>`),
  routed and budgeted like any other. Its branch uses the usual template,
  with `-<skill>` appended when a draft PR earlier in the chain already
  took the name.
- A skill runs at most once outside loops, and once across the chain's loops: a loop may repeat the rule's skill, as in `address-review` then `loop: [review, address-review]`.
- Steps count against the [caps](#night-and-budget) like any unit, and
  against their rule's `units`. A chain whose first unit is over a cap
  doesn't start; a step over a cap is left out with the rest of the chain,
  and the unit before it names the cap.

#### Loops

A `loop` step repeats its steps, round after round, until a condition
holds or `max` rounds ran. Review and fix until the review approves, with
the other agent reviewing:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: night-shift }
    then:
      - loop:
          - { skill: review, provider: codex }
          - address-review
        until: { verdict: [approve, comments] }
        max: 3
```

- Every round works in the clone of the draft PR unit before the loop,
  on its branch, and nothing is pushed until the loop ends: then that
  unit opens one draft PR with every round's commits. Its body ends with
  how the loop went, the last verdict and the last report a round
  wrote. If that unit doesn't finish `done` with commits, it publishes
  as usual and the loop doesn't run. After a report, the loop starts
  from a fresh clone on the same base, and its first unit opens the
  draft PR.
- `until` is checked after every step and ends the loop as soon as it
  holds; with both keys, both must. `verdict` is the latest word a step
  wrote to `.nightshift/out/verdict` (built-in `review` writes `approve`,
  `comments` or `changes`); it takes a word, a list for any of, or
  `{ not: … }`. It waits for a step in the loop to write a verdict, so
  `{ not: changes }` doesn't hold after a step that wrote none.
  `command` is a shell command night-shift runs in the clone after the
  step, outside the model; it holds when it exits 0. `max` is at most 5.
- A command runs like `setup` on a branch a worker wrote: without the
  repo's `secrets`, for at most 15 minutes, and not past `night.end`. It
  runs again only once a step committed. In `until` it doesn't hold
  while the clone has uncommitted changes beyond what `setup` and earlier
  checks left, since the branch wouldn't publish them; a `when` command
  sees them, as the step will.
- A command isn't run on a PR whose author isn't trusted, or with
  `network: false` (it would run the worker's code outside the worker's
  sandbox): config refuses one on a rule with `network: false`, but a
  repo's `network: false` is only known at run time. A command that isn't
  run doesn't hold for `when`, and ends the loop either way. One that
  runs past its 15 minutes fails, like one that exits non-zero. One
  stopped by `night.end` ends the loop, which publishes what it has;
  outside a loop it skips a `when` step without passing over it, so the
  chain is tried again the next night. After Ctrl-C the chain is tried
  again in both cases.
- A step finds the one before's output in `.nightshift/context/previous/`:
  its `report.md` and `verdict`, the PR body so far in `pr.md`, its
  commits in `diff.patch`, and the command's output in `check.log`. When
  the loop ends with the command failing, the tail of its output goes
  into the PR body too.
- Each round is routed and budgeted live. No provider left, `night.end`,
  or a step that fails or stops ends the loop, which still publishes what
  it has and says why; a loop after a report that ends this way with no
  commits runs again, counting a failure unless a round couldn't run
  for `night.end` or no provider left. An interrupt (Ctrl-C) publishes
  nothing, and the chain runs again the next night without counting as
  a failure.
- Rounds are units of their own in the report (`<unit>-<skill>-<round>`);
  `plan` lists round 1, but routes every round up to `max`, so a loop
  holds fallback units for all of them. A loop counts once against the
  caps, since it opens one draft PR, and once as an attempt: when it
  published, the item waits for your review. The caps count every unit
  that could still route if each loop ended after round 1, so a later
  item `plan` shows without a provider can still count.
- A loop's branch comes from its first step's `branch`, and only after a
  report: after a draft PR, the rounds work on that PR's branch.
- A step after the loop follows the loop's draft PR, or, when a loop
  after a report ended at `until`, `max` or a round where no step's
  `when` held, with nothing committed, runs where the loop's host ran.
  A loop can't follow another loop directly: put a step between them.

#### `when`

A step, in a chain or a loop, runs only when its `when` holds. Otherwise
it is skipped and the chain goes on from the unit before, as if the step
weren't there:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: night-shift }
    then:
      - loop:
          - review
          - { skill: address-review, when: { verdict: changes } }
        until: { verdict: [approve, comments], command: pnpm test }
        max: 3
      - { skill: security-review, when: { changed: "src/auth/**" } }
```

- `verdict` is the step before's or, after a loop, the latest one
  written in it, or the host's own when the loop wrote none. It matches
  as in `until`, except that `{ not: … }` also holds when no verdict was
  written.
- `command` runs as in `until`, in the step's clone before its agent
  starts. Prefix `!` to run a step only when a check fails, such as a
  fixer with `when: { command: "! pnpm test" }`; it finds the output in
  `.nightshift/context/previous/when.log`.
- `changed` is a glob or a list; it holds when the chain's commits change
  a matching path, measured from where the chain started: the repo's
  default branch, the draft PR it stacked on, or the night-shift PR a
  rule took up. Globs are git's, from the repo root, with no leading
  `/`: `*` stays in one directory and `**` crosses them, so `*.md` matches
  `README.md` but not `docs/a.md`, and `src/auth/**` everything under it.
- Every key set must hold. `plan` shows each step's `when`, and the
  report says which one didn't hold.
- A skipped step doesn't end a loop, unless its command didn't run: it
  wouldn't in a later round either. A round whose steps were all passed
  over ends it too, since the next would be the same. After a report, a
  loop's first unit opens its clone: when its `when` doesn't hold, the
  loop doesn't run.
- The step right before a loop can't have a `when` unless it sets
  `deliver: report`, since the loop works in its clone: gate the loop's
  steps, or put a step between.

### `push`

By default night-shift only pushes branches that don't exist yet. `deliver:
push` is the opt-in to add commits onto your own open PR instead of
stacking a draft PR on it, e.g. to have review threads addressed in place:

```yaml
queue:
  - skill: address-review
    where: { type: pr, mine: true, unresolved_threads: { gt: 0 } }
    deliver: push
```

- Only onto an open PR you authored, night-shift's own included (they
  are opened with your login). On someone else's PR, or an item with no
  PR of yours, the unit is skipped with the reason.
- A `then` step can push only after a report or a push, onto the same
  PR. After a draft PR its base is that night's new branch, not your PR:
  the step is left out with the rest of the chain.
- A fast-forward only: night-shift refuses when the branch moved since
  the clone, and never forces. The commits get the `Night-shift:` trailer.
- The agent writes `.nightshift/out/report.md`; without it nothing is
  pushed. The PR body stays as it is and the report goes into the
  morning report.
- A skill's frontmatter can't default to `push`: only a rule opts in.

## Notify

To get the morning report where you already look, `notify.command` runs
in a shell after every run, dry runs included, with the report's path in
`NIGHTSHIFT_REPORT` and the run id in `NIGHTSHIFT_RUN_ID`. There are no
built-in integrations. A command that fails or takes over a minute is
logged; the run still succeeds.

```yaml
notify:                         # ntfy
  command: curl -sf -H "Title: night-shift $NIGHTSHIFT_RUN_ID" -H "Markdown: yes" --data-binary @"$NIGHTSHIFT_REPORT" "https://ntfy.sh/$NTFY_TOPIC"
  secrets: [NTFY_TOPIC]
```

```yaml
notify:                         # a Slack incoming webhook
  command: jq -Rs '{text:.}' "$NIGHTSHIFT_REPORT" | curl -sf -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK_URL"
  secrets: [SLACK_WEBHOOK_URL]
```

`secrets` names the env vars the command reads: workers never see them,
and the GitHub Actions workflow passes them from repository secrets.

## Secrets

The config holds env var **names** only. Values come from the environment
or `~/.config/night-shift/env` (the environment wins).

| Variable | Used by |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude, when not using the local login (`claude setup-token`) |
| `CODEX_AUTH_JSON` | Codex on a runner: seeds `auth.json` when missing |
| `ASANA_TOKEN` (or your `token_env`) | Asana |
| `LINEAR_API_KEY` (or your `token_env`) | Linear |
| `JIRA_API_TOKEN` (or your `token_env`) | Jira |
| A custom source's `secrets` | That source's command |
| `GH_TOKEN` | GitHub in Actions; locally `gh`'s own login |
| Your `notify.secrets` | The notify command |
| Your `repos.<owner/name>.secrets` | That repo's `setup` |
