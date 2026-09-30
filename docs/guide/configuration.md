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
    setup: pnpm install --frozen-lockfile
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

Asana has no read-only personal token: the token can do anything you can.
night-shift only reads with it and never hands it to the agent. Create
one just for night-shift so you can revoke it alone.

Linear takes a personal API key (Settings > Account > Security & access).
night-shift only reads with it and never hands it to the agent: when
Linear offers the choice, give the key read access only.

## Branch names

`branch` is a template rendered per unit, set globally, per repo or per
rule (the most specific wins). `{key}` is required; `{title}` is the
item's title as a slug of at most 40 characters.

| Item | `{key}` |
|---|---|
| GitHub PR or issue `acme/api#12` | `acme-api-12` |
| Asana task with custom ID `ENG-12` | `ENG-12` |
| Linear issue `ENG-12` | `ENG-12` |

The name is cosmetic. The guardrail is that night-shift only pushes a
branch that doesn't exist on the remote yet.

## Repos and instructions

`repos.<owner/name>` holds the `setup` and `test` commands the agent
should use there, plus an instructions file. `instructions` at the top
level, per repo and per rule are **file paths**, relative to the config
file. A repo can also carry `.night-shift/instructions.md`, read from the
clone unless the unit is on a PR someone else opened.

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
| `deliver` | `draft_pr` or `report`; default from the skill |
| `branch` | Branch template for this rule |
| `order` | Which matching item goes first: `oldest` or `newest` created, or last `updated`; default the source's order |
| `units` | At most this many units per night from this rule, its `then` steps included |
| `then` | Steps that run after this rule's unit, the same night; see [`then`](#then) |

### `where`

```yaml
where:
  type: pr                          # equals
  checks: [failing, pending]        # any of
  review_requested: { not: true }   # not
  unresolved_threads: { gte: 2 }    # on a number field: gt, gte, lt, lte; combine for a range
  label: night-shift                # on a list field: contains
  "fields.Priority": High           # an Asana custom field
```

A missing field equals nothing. An unknown key is a config error that
lists the keys each source offers. The [field table](./how-it-works.md#items)
lists them too.

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
  and `then`. It inherits none of the rule's: an unset key has the same
  default as on a rule. Top-level `instructions` and `skills` still
  apply, as to every unit.
- After a draft PR, the next step starts from that PR's branch, and a
  draft PR it opens is stacked on it. After a report, it starts from the
  same base.
- The step finds what the one before delivered in
  `.nightshift/context/previous/`: `pr.md` and `diff.patch`, or
  `report.md`.
- A step runs only when the one before delivered; otherwise the rest of
  the chain is skipped, with the reason in the report. Once a unit in the
  chain opened a draft PR, the next night doesn't retry: the item waits
  for your review of it. Otherwise the whole chain runs again.
- Each step is a unit of its own in `plan` and the report (`<unit>-<skill>`),
  routed and budgeted like any other. Its branch uses the usual template,
  with `-<skill>` appended when a draft PR earlier in the chain already
  took the name.
- A skill runs at most once per chain.
- Steps count against the [caps](#night-and-budget) like any unit, and
  against their rule's `units`. A chain whose first unit is over a cap
  doesn't start; a step over a cap is left out with the rest of the chain,
  and the unit before it names the cap.

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
| `GH_TOKEN` | GitHub in Actions; locally `gh`'s own login |
| Your `notify.secrets` | The notify command |
