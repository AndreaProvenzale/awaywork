---
description: The awaywork config file by example, covering run windows, limits, budgets, providers, sources, branch names, PR links, per-repo settings, instructions and queue rules with where matching.
---

# Configuration

One YAML file, `~/.config/awaywork/config.yml` by default;
`--config <path>` or `AWAYWORK_CONFIG` point elsewhere. Every key is
listed in the [reference](../reference/config.md).

## Editing safely

```sh
awaywork config edit    # opens $VISUAL/$EDITOR on a copy; saved only once valid
awaywork doctor         # validate, including skill names
awaywork plan           # see what the change does to the next run
```

For autocompletion and hover docs in editors with the YAML language
server (VS Code's YAML extension, JetBrains, Neovim), put this first line
in the file:

```yaml
# yaml-language-server: $schema=https://andreaprovenzale.github.io/awaywork/config.schema.json
```

`awaywork config schema` prints the same JSON Schema for the installed
version.

## A full example

```yaml
windows:                        # when scheduled runs start; this one is the default
  - { start: "01:00", end: "07:00" }
limits:                         # per run, every provider; unset by default
  units: 8
  units_per_repo: 3
  unit_minutes: 90              # stop a worker after this many minutes
budget:                         # defaults; any provider can override
  reserve: 10%                  # never go past 1 - reserve of any window
  per_run: 15%                  # at most this share of the long window per run
  session_max: 90%              # stop a worker past this share of the short window
  fallback: { units: 4, turns: 60 }   # when the quota can't be read
providers:                      # order = routing preference
  - claude: { model: opus, settings: claude-worker.json }   # default: the binary's own model
  - codex: { budget: { per_run: 5% }, config: { model_reasoning_effort: high } }
sources:
  github: { repos: [acme/*] }
  asana:
    workspace: "123"
    token_env: ASANA_TOKEN
    repo_map: { "1201": acme/api }   # project gid -> the repo its tasks' code lives in
branch: away/{key}             # default; {key} or {title} is required
repos:
  acme/api:
    branch: feat/{key}-{title}
    setup: pnpm install --frozen-lockfile   # run before the worker
    secrets: [NPM_TOKEN]        # only setup sees these
    test: pnpm vitest run {files}
    instructions: notes/acme-api.md
instructions: [notes/me.md]     # every unit
skills: [house-style]           # every unit, next to a rule's skills; yours, in skills/ beside this file
queue:                          # first matching rule wins; top = highest priority
  - skill: fix
    where: { type: pr, mine: true, checks: failing }
    branch: fix/{key}
  - skill: implement
    source: github
    where: { type: issue, label: awaywork, repo: acme/api }
    order: oldest
    units: 2                    # at most 2 of these per run
  - skill: review
    where: { type: pr, review_requested: true, trusted: true }
    model: { claude: sonnet }
  - skill: implement
    source: asana
    where: { section: Ready, tags: backend }
    provider: codex
    skills: [our-api-conventions]   # yours too
    instructions: notes/backend.md
```

## Windows, limits and budget

A run is one window opening, or one `awaywork run` by hand. A window's
`start` is when a scheduled run begins; no unit starts after its `end`,
and a running one stops there. Times are local to the machine, or to the
workflow's `timezone` in GitHub Actions, where a GitHub-hosted runner
[cuts a run at about 6 hours](./scheduling.md#in-github-actions)
whatever the window says. The default is one window,
`01:00` to `07:00`. Add windows, each with optional `days` (`sun` to
`sat`, the day it opens on), for quota that idles at weekends or over
lunch:

```yaml
windows:
  - { start: "01:00", end: "07:00" }
  - { days: [sat, sun], start: "10:00", end: "18:00" }
```

The scheduler gets one trigger per window, and pacing divides the
headroom by the runs left before the reset. Windows should not overlap.
Budgets count runs, not days: three windows a day can spend `per_run`
three times, and `runs_until_reset` counts window openings.

A readable quota decides how much work fits, not how much you can review
in a morning. `limits.units` caps the units planned per run,
`limits.units_per_repo` those in any one repo, and a rule's `units`
those from that rule. None is set by default. Units past a cap are
skipped in queue order, with the cap named in `awaywork plan` and the
report. A rule's [`then`](#then) chain is one unit, counted once. Only
units whose first step is routed to a provider count, and caps apply to
each `awaywork run`, like `fallback.units`, which every step draws on.
`limits.unit_minutes` stops any worker after that many minutes,
whichever provider runs it.

Budgets are shares of each provider's quota windows; see
[How it works](./how-it-works.md#budget) for how they combine. Start low:
`per_run: 5%` for a week shows what a unit costs you before you raise it.

## Providers

A list, in routing order. A bare name uses the defaults; a map overrides
the budget for that provider or sets its `model`, passed as is to the
binary (`claude --model`, `codex exec -m`). Without one, the binary picks
its own default.

Workers skip your user-level agent config. To give them the hooks, env
or settings you do want, list them here; they apply on every unit,
including someone else's PR:

- `claude: { settings: <file> }`: a Claude Code settings file, relative
  to the config file, passed as `--settings`. Auto-memory stays off, and
  workers run in `dontAsk` mode: a tool that isn't pre-approved, by
  awaywork or by your `permissions.allow`, is denied.
- `codex: { config: { <key>: <value> } }`: each key passed as
  `codex exec -c key=value`, e.g. `model_reasoning_effort: high`.

## Sources

| Source | Keys |
|---|---|
| `github` | `repos`: `owner/name` globs such as `acme/*` |
| `asana` | `workspace` gid, optional `projects` (gids), `repo_map` (project gid → `owner/name`), `token_env` (default `ASANA_TOKEN`) |
| `linear` | optional `repo_map` (team key → `owner/name`), `token_env` (default `LINEAR_API_KEY`) |
| `jira` | `site` host (`acme.atlassian.net`), `email` of the token's account, optional `cloud_id` (for a scoped token), `jql` (a condition ANDed with my unresolved issues, no `ORDER BY`), `repo_map` (project key → `owner/name`), `token_env` (default `JIRA_API_TOKEN`) |
| any other name | `command` printing your items as JSON, `fields`, `secrets`, `setup`: see [Custom sources](./custom-sources.md) |

Every source but `github` also takes a [`link`](#linking-prs).

Asana has no read-only personal token: the token can do anything you can.
awaywork only reads with it and never hands it to the agent, unless
you list it in an [MCP server](#mcp-servers)'s `secrets`. Create one just
for awaywork so you can revoke it alone.

**Linear is beta:** its tests read a live workspace, but no real run has
used it yet. It takes a personal API key (Settings > Account >
Security & access).
awaywork only reads with it and never hands it to the agent, unless
you list it in an [MCP server](#mcp-servers)'s `secrets`: when Linear
offers the choice, give the key read access only.

**Jira is beta:** its tests read a live site, but no real run has used it
yet. Jira Cloud takes an Atlassian API token (id.atlassian.com > Security >
API tokens). Prefer "Create API token with scopes", app Jira, scope
`read:jira-work`: `init` then finds the site's `cloud_id` and awaywork
calls `api.atlassian.com`, as scoped tokens require. A token without
scopes can do anything you can; awaywork only reads with it. Tokens
expire after at most a year.

Jira custom fields that share a name are keyed by name and id, such as
`fields.Team (customfield_10040)`.

## Branch names

`branch` is a template rendered per unit, set globally, per repo or per
rule (the most specific wins). It needs `{key}`, `{title}` (the item's
title as a slug of at most 40 characters) or both: `feat/work` would name
every unit the same, so it's refused.

| Item | `{key}` |
|---|---|
| GitHub PR or issue `acme/api#12` | `acme-api-12` |
| Asana task with custom ID `ENG-12` | `ENG-12` |
| Linear issue `ENG-12` | `ENG-12` |
| Jira issue `ENG-12` | `ENG-12` |

Per-rule templates follow your repo's conventions:

```yaml
queue:
  - { skill: fix, where: { type: pr, mine: true, checks: failing }, branch: "fix/{title}" }
  - { skill: implement, where: { type: issue }, branch: "feat/{title}" }
```

The name is cosmetic: awaywork finds its own PRs by their footer, and
yours as [Linking PRs](#linking-prs) says. Jira is the exception, since
it links a PR only by the key in its branch or title: for Jira items keep
the key in one of them, e.g. `feat/{key}-{title}`, or Jira loses the PR.

The guardrail is that awaywork only pushes a branch that doesn't
exist on the remote yet, unless a rule opts in to [`push`](#push). When
the name is taken, the unit takes the first free one of `<branch>-2` to
`<branch>-10`, and every step of its chain works on it; a
[stacked slice](#stack) renders the same name, so it takes the next free
one.
Not when awaywork already tried there: when a PR on the taken branch,
open or closed unmerged, has a footer naming one of the unit's items, the
unit is skipped as `awaywork tried this in <PR>; delete <branch> to
run it again`. That record lives on GitHub, so it holds on a runner that
keeps no [attempts](./how-it-works.md#units). A merged one landed, so
the next pickup is a new round and takes a suffix. A taken branch with
no PR whose tip has the `Awaywork:` trailer is a push whose PR
failed, so it skips the unit too, until you delete it; one without the
trailer, your own work in progress, is passed over for a suffix.

## Linking PRs

Trackers don't tell awaywork which PR is a task's, so it looks
through your open PRs:

- A PR awaywork opened is linked by the items its footer names,
  whatever its branch or title. It never falls back to names, so an
  awaywork PR for ENG-13 that mentions ENG-12 isn't ENG-12's. A
  footer naming no items counts as none, so it is linked like yours.
- One you wrote is linked when its branch or title holds the item's key
  as a whole word, in any case, or its body holds the source's `link`
  line. A bare key in the body doesn't count: "follow-up to ENG-12"
  would mark ENG-12 as taken.

`link` is one line in the tracker's own words, rendered from the item's
`{key}`, `{id}` and `{url}`. awaywork writes it into its draft PRs
too, so the tracker links them whatever the branch is called.

| Source | Default `link` | Why |
|---|---|---|
| `linear` | `Part of {key}` | A non-closing magic word: merging leaves the issue to your workflow |
| `asana` | `{url}` | Asana links a PR whose description holds the task URL |
| `jira` | none | Jira links on the branch or title only |
| custom | none | Whatever your tracker reads, e.g. `Refs {key}` or `{url}` |

```yaml
sources:
  linear: { link: "Closes {key}" }   # merging closes the issue
```

## Repos and instructions

`repos.<owner/name>` holds the `setup` and `test` commands for that
repo, plus an instructions file. `setup` runs once per unit, in the fresh
clone before any agent starts, outside the model; the agent is told it
already ran. A chain's later steps share that clone and don't run it
again, so dependencies a step adds aren't installed for the steps after
it: a `when` or `until` command that needs them installs them itself,
like `pnpm i --frozen-lockfile && pnpm test`. Anything setup leaves
running is stopped when it exits. A setup that fails,
takes over 15 minutes or reaches the window's end skips the unit, with the
tail of its output in the report.

`secrets` names the env vars setup needs, such as a private registry
token: setup gets them and no other secret, the agent never sees them,
and the GitHub Actions workflow passes them from repository secrets.
Their values are masked in setup's output. On a PR someone else opened,
setup runs the author's install scripts, so it gets none of them, and
it runs only when the author has write access or org membership;
otherwise the agent is told it didn't run. It gets none of them either
on the branch of an awaywork PR a rule took up again, which a worker
wrote. Read
them from the repo's config, e.g. `${NPM_TOKEN}` in `.npmrc`, rather
than writing them to your home directory, which the agent shares.

::: warning Experimental
`verify` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

`verify` runs in the clone once the chain ends, outside the model,
before it is published; set it on a repo or a rule (the rule wins). Use
it for lint, format or the repo's tests. A failure doesn't stop the
publish: the PR body or the push's summary gets the tail of its output.
It runs once per commit, with none of the secrets, and not on a PR by an
untrusted author or with `network: false`, where it is reported as not
run. An empty `verify: ""` on a rule turns the repo's off. A `report`
delivery has nothing to publish and skips it.

`test` is given to the agent in its prompt. `instructions` at the top
level, per repo and per rule are **file paths**, relative to the config
file. A repo can also carry `.awaywork/instructions.md`, read from the
clone unless the unit is on a PR someone else opened.

::: warning Experimental
`network: false` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

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
| `skill` | The skill that does the work (`awaywork skills list`) |
| `source` | Only items from this source |
| `where` | Conditions on `type` and the source's fields |
| `provider` | One or a list; overrides the global order for this rule |
| `model` | A model per provider, e.g. `{ claude: sonnet, codex: gpt-5-codex }`; overrides the provider's `model` for this rule |
| `skills` | Extra skills the agent may use |
| `mcp` | MCP servers the agent gets, by name; see [MCP servers](#mcp-servers) |
| `instructions` | One or more instruction files for this rule |
| `with` | Parameters for the skill, listed in its prompt; see [Write your own](./skills.md#write-your-own) |
| `deliver` | Where the chain's commits go: `draft_pr` (default), `push` onto your own open PR's branch (see [`push`](#push)), or `report`, where no step commits |
| `branch` | Branch template for this rule |
| `order` | Which matching item goes first: `oldest` or `newest` created, or last `updated`; default the source's order |
| `units` | At most this many units per run from this rule; a chain counts once |
| `then` | Steps that run after this rule's skill, in the same clone; see [`then`](#then) |
| `network` | `false` cuts the agent's commands off the network, `then` steps included; default the repo's |

### `where`

```yaml
where:
  type: pr                          # equals
  checks: [failing, pending]        # any of
  review_requested: { not: true }   # not
  unresolved_threads: { gte: 2 }    # on a number field: gt, gte, lt, lte; combine for a range
  updated: { older_than: 3d }       # on a date field: older_than, newer_than; m, h, d or w
  title: { matches: '^\[bug\]' }    # on title, description or a text field: case-insensitive regex
  label: awaywork                # on a list field: contains; GitHub issues must also be assigned to you
  "fields.Priority": High           # an Asana custom field
  blocked: false                    # Linear, Jira, Asana: no open blocker
  any:                              # at least one entry holds; each is a where, ANDed with the keys above
    - { label: urgent }
    - { checks: failing }
```

`title` and `description` are keys on every source. An invalid regex is a
config error, and `plan` names the match an item failed; for `any`, it names
what each entry failed. An empty `any` entry is a config error, since it
matches everything. A missing field equals nothing, and is neither older
nor newer than anything; spans count back from when the plan runs. An unknown
key is a config error that lists the keys each source offers. The
[field table](./how-it-works.md#items)
lists them too.

A PR awaywork opened only matches a rule whose top-level `where` names
`ours` (inside `any` it is a config error), so rules written for your own
PRs leave it waiting for your review. To act on it once you've reviewed it:

```yaml
- skill: fix
  where: { type: pr, mine: true, ours: true, my_unresolved_threads: { not: 0 } }
```

The unit's draft PR stacks on the awaywork PR, on a branch named
after it (`away/acme-api-9` for #9). Once you merge the stacked PR, the
next pickup of #9 takes a `-2` branch; while the stacked PR is open or
closed unmerged, it is skipped as `awaywork tried this in <PR>;
delete away/acme-api-9 to run it again`. Resolve the threads it
answered too: merging moves #9, and with your threads still open the
rule takes it up again for the same threads.
The rule runs on the threads you started, but the agent reads every
unresolved thread, as on your other PRs. `ours` comes from the GitHub
source: a custom source's `ours` field holds nothing back.

### `order`

Within a rule, units run in the order the source returns items; for
GitHub that is newest first, so with little quota the oldest can wait
run after run. `order: oldest` runs them first. Items without the
timestamp go last.

### `then`

Steps run right after the rule's skill, one after the other, in the same
clone and on the same branch. The whole chain is one unit: it publishes
once, when it ends, as one draft PR, one push or one report, unless a
step says [`stack`](#stack). A step is a skill name, or a map when you
want to set more:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    then: review

  - skill: plan
    where: { section: Ready }
    model: { claude: opus }
    mcp: [sentry]
    then:
      - { skill: implement, model: { claude: sonnet }, instructions: notes/impl.md }
      - { skill: review, provider: codex, mcp: [] }
```

- A step takes `provider`, `model`, `skills`, `mcp` and `instructions`,
  plus `with`, [`when`](#when) and [`stack`](#stack). It inherits the
  first five from the rule unless it sets its own, and `[]` clears a
  list: above, `implement` gets `sentry`, `review` gets no MCP server and
  keeps `opus` should it route to Claude. `with`, `when` and `stack` are
  the step's own. Top-level `instructions` and `skills` still apply, as
  to every unit.
- A skill commits unless its metadata says it reports, as the built-in
  `plan` and `review` do. The rule's `deliver` says where the chain's
  commits go: one draft PR (`draft_pr`, the default), a [`push`](#push)
  onto your own PR, or `report`, where no step commits. A chain that
  committed nothing publishes its steps' reports, joined, as one report.
  Steps have no `deliver` or `branch` of their own: a committing skill
  that should only report is a [skill of your own](./skills.md#write-your-own).
- Each step finds what the one before left in `.away/context/previous/`:
  its `report.md` and `verdict`, what the chain did so far in `pr.md`,
  its commits in `diff.patch`, and, in a loop, the `until` command's
  output in `check.log`.
- A step that leaves nothing for the next one ends the chain: a
  committing step that commits nothing (`implement` writing questions
  instead of code), or a report step that writes no report. The steps
  after it are passed over and the chain counts as finished. A step that
  fails or stops, and the window's end, end it too: the chain publishes
  what it has. A draft PR it opened, or commits it [pushed](#push) onto
  your PR, wait for your review; otherwise the chain runs again the next
  run. Ctrl-C publishes nothing.
- The PR body is the `pr.md` the steps kept current, plus an
  `## Awaywork chain` section with how each loop went, its failing check
  if any, and the latest report of each report step:

  ```markdown
  Rate-limit the export endpoint

  Closes #12. ...

  ## Awaywork chain

  Loop: 2 rounds of review ⇄ fix; until held: verdict approve; last verdict approve.

  <details><summary>Report: acme-api-12-review-2</summary>

  Approve.

  </details>
  ```

- A chain is one row in `plan`, with its steps under it. Every step is
  routed (`plan` routes every round of a loop up to its `max`), and
  budgeted live:

  ```
  Units
       unit         repo      rule  skill                 provider  deliver   branch
    1  acme-api-12  acme/api  #1    implement (built-in)  claude    draft_pr  away/acme-api-12
       github acme/api#12: Rate-limit the export endpoint
       then loop review ⇄ fix until verdict approve, at most 3 rounds
         review (built-in) on codex
         fix (built-in) on claude
       then docs (user) on claude, when the branch changes src/**
  ```

- A chain counts once against the [caps](#windows-limits-and-budget) and
  its rule's `units`, as soon as its first step has a provider, and once
  more per [stacked slice](#stack). A chain whose first slice is over a
  cap is skipped whole, naming the cap; a later slice over it is left
  out.
- On someone else's PR or a PR from a fork, a chain that could commit
  (a step's skill commits and `deliver` isn't `report`) is skipped with
  the reason. `deliver: report` turns it into a review chain.
- A skill runs at most once outside loops, and once across the chain's
  loops: a loop may repeat the rule's skill, as in `fix` then
  `loop: [review, fix]`.
- Steps are named `<unit>-<skill>`, and `<unit>-<skill>-<round>` in a
  loop. Each leaves a folder under the run's `units/<unit>/`, numbered in
  the order the steps ran, next to `out/` with what the chain published
  (and `out-2/` on, one per [stacked slice](#stack)):

  ```
  units/acme-api-12/
    1-implement/   context/  prompt.md  worker.log  out/  replay.json
    2-review/
    3-fix/
    4-review/
    5-docs/
    out/           pr.md  diff.patch
  ```

  [`awaywork replay`](../reference/cli.md#awaywork-replay) rebuilds a
  unit's first step: the later ones start from commits that only ever
  existed in the clone.

#### Loops

A `loop` step repeats its steps, round after round, until a condition
holds or `max` rounds ran. Review and fix until the review approves, with
the other agent reviewing:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    then:
      - loop:
          - { skill: review, provider: codex }
          - fix
        until: { verdict: [approve, comments] }
        max: 3
```

::: warning Experimental
`until`'s `command` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

- Rounds are steps like any other: they work in the chain's clone, and
  their commits publish with the rest of the chain. The PR body says how
  the loop went.
- `until` is checked after every step and ends the loop as soon as it
  holds; with both keys, both must. `verdict` is the latest word a step
  wrote to `.away/out/verdict` (built-in `review` writes `approve`,
  `comments` or `changes`); it takes a word, a list for any of, or
  `{ not: … }`. It waits for a step in the loop to write a verdict, so
  `{ not: changes }` doesn't hold after a step that wrote none.
  `command` is a shell command awaywork runs in the clone after the
  step, outside the model; it holds when it exits 0. `max` is at most 5.
- A command runs like `setup` on a branch a worker wrote: without the
  repo's `secrets`, for at most 15 minutes, and not past the window's
  end. `setup` doesn't run again before it, so a command that needs
  dependencies a step added installs them itself, like
  `pnpm i --frozen-lockfile && pnpm test`. It runs again only once a
  step committed. In `until` it doesn't hold while the clone has
  uncommitted changes beyond what `setup` and earlier checks left, since
  the branch wouldn't publish them; a `when` command sees them, as the
  step will.
- A command isn't run on a PR whose author isn't trusted, or with
  `network: false` (it would run the worker's code outside the worker's
  sandbox): config refuses one on a rule with `network: false`, but a
  repo's `network: false` is only known at run time. A command that isn't
  run doesn't hold for `when`, and ends the loop either way. One that
  runs past its 15 minutes fails, like one that exits non-zero. One
  stopped by the window's end ends the chain, which publishes what it
  has as in [`then`](#then); a `when` it stopped doesn't pass over its
  step. After Ctrl-C the chain publishes nothing and is tried again.
  When the loop ends with the command failing, the tail of its output
  goes into the PR body.
- A step that leaves nothing for the next one ends only its loop: a
  `fix` that disputes every finding commits nothing, and the next
  `review` would only repeat itself. The steps after the loop still run.
- Loops can follow loops, and a step with a `when` can come right before
  one.

#### `when`

::: warning Experimental
The `command` check and the quota checks (`runs_until_reset`,
`headroom`) have only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

A step, in a chain or a loop, runs only when its `when` holds. Otherwise
it is passed over and the chain goes on as if the step weren't there,
unless the step [starts a slice](#stack):

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    then:
      - loop:
          - review
          - { skill: fix, when: { verdict: changes } }
        until: { verdict: [approve, comments], command: pnpm test }
        max: 3
      - { skill: security-review, when: { changed: "src/auth/**" } }   # a skill of yours
```

- `verdict` is the latest verdict written in the chain, by any step
  before this one. It matches as in `until`, except that `{ not: … }`
  also holds when no verdict was written.
- `command` runs as in `until`, in the chain's clone before the step's
  agent starts. Prefix `!` to run a step only when a check fails, such
  as a fixer with `when: { command: "! pnpm test" }`; it finds the
  output in `.away/context/previous/when.log`. A check that times out
  says nothing: it ends the chain without passing over the step, and the
  chain publishes what it has as in [`then`](#then).
- `changed` is a glob or a list; it holds when the chain's commits change
  a matching path, measured from where the chain started: the repo's
  default branch or the awaywork PR a rule took up. Globs are git's, from the repo root, with no leading
  `/`: `*` stays in one directory and `**` crosses them, so `*.md` matches
  `README.md` but not `docs/a.md`, and `src/auth/**` everything under it.
- `runs_until_reset` holds when at most that many window openings are
  left before the provider's long window resets: `1` holds in the last
  window before the reset, and in a manual run when at most one window
  is left. `headroom` (e.g. `20%`) holds when at least that share
  of the window is left under this run's ceiling, so a loop with a high `max` or a second review
  can run only on spare quota. Both read the quota the run last saw, as
  the budget does, and don't hold when the quota can't be read. A rule
  takes a `when` with these two keys only, to skip its whole chain.
- Every key set must hold. `plan` shows each step's `when`, notes when its
  quota part doesn't hold on the probe or has no quota reading, and the
  report says which one didn't hold.
- A passed-over step doesn't end a loop, unless its command didn't run:
  it wouldn't in a later round either. A round whose steps were all
  passed over ends it too, since the next would be the same.

#### `stack`

::: warning Experimental
`stack` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

A chain is one PR by default: an `implement` and its review rounds are
one change. When it does two separable things, `stack: true` on a step
starts a new **slice**, with a branch and a draft PR of its own, stacked
on the slice before:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    then:
      - loop: [{ skill: review, provider: codex }, fix]
        until: { verdict: approve }
        max: 3
      - { skill: docs, stack: true }   # a skill of your own
```

That publishes `away/acme-api-12` with the implement, review and fix
rounds, then a draft PR for `docs` on `away/acme-api-12-2`, into
`away/acme-api-12`.

- A slice publishes as soon as its last step ends, before the next one
  starts. The next slice's branch is cut from its tip in the same clone,
  so `setup` doesn't run again, and its commits are pushed on top of the
  slice before's as pushed, each with the `Awaywork:` trailer.
- Every slice renders the rule's [`branch`](#branch-names), so a later
  one takes the first free `-2` to `-10`. A branch the chain published
  this run never counts as awaywork having tried there.
- The stacked PR's body ends with `Stacked on <PR>: merge that first.`,
  and on a repo with GitHub's [stacked PRs](https://gh.io/stacks) the two
  are linked. Its first step finds the slice before's PR body, as
  published, in `.away/context/previous/pr.md`, next to what the step
  before left, and its prompt names the PR.
- On a loop, `stack: true` starts the slice at the loop's first round. A
  loop sits inside one slice, so a step in a loop can't have it.
- `stack` needs `deliver: draft_pr`, the default. `plan` skips a chain
  where it's on a step whose skill reports, or after steps that all
  report: there would be nothing to put in the PR, or nothing to stack
  on.
- A stacked slice whose first step commits nothing ends the chain; the
  slices before it stay published. So does a stacked step whose
  [`when`](#when) doesn't hold: the rest of the chain is passed over. A failing step or the window's end
  ends the chain too, and the open slice publishes what it has. Ctrl-C
  drops the open slice, and the ones that already ended stay published.
- `when: { changed }` still diffs from where the chain started, so it
  sees the earlier slices' commits too.
- Each slice counts once against the [caps](#windows-limits-and-budget),
  as soon as its first step has a provider. A chain keeps the slices
  that fit and leaves out the rest, naming the cap under it in `plan`
  and on its row in the report.
- `plan` starts a slice with `stack` where the other steps say `then`:

  ```
  Units
       unit         repo      rule  skill                 provider  deliver   branch
    1  acme-api-12  acme/api  #1    implement (built-in)  claude    draft_pr  away/acme-api-12
       github acme/api#12: Rate-limit the export endpoint
       then loop review ⇄ fix until verdict approve, at most 3 rounds
         review (built-in) on codex
         fix (built-in) on claude
       stack docs (user) on claude
  ```

  The morning report has the chain's row, then each slice with its steps:

  ```
  #  Unit                      Skill                                        Provider       Status                                                                        Result
  1  acme-api-12               implement → loop(review ⇄ fix) → stack docs  claude, codex  done, 70 turns                                                                https://github.com/acme/api/pull/42 (2 commits), verdict approve; https://github.com/acme/api/pull/43 (1 commits)
     └ slice 1                 implement → loop(review ⇄ fix)               claude, codex  done, 56 turns (loop: 2 rounds of review ⇄ fix; until held: verdict approve)  https://github.com/acme/api/pull/42 (2 commits), verdict approve
       └ acme-api-12           implement                                    claude         done, 14 turns                                                                1 commit
       └ acme-api-12-review-1  review                                       codex          done, 14 turns                                                                a report, verdict changes
       └ acme-api-12-fix-1     fix                                          claude         done, 14 turns                                                                1 commit
       └ acme-api-12-review-2  review                                       codex          done, 14 turns                                                                a report, verdict approve
     └ slice 2                 docs                                         claude         done, 14 turns                                                                https://github.com/acme/api/pull/43 (1 commits)
       └ acme-api-12-docs      docs                                         claude         done, 14 turns                                                                1 commit
  ```

- [`after_unit`](#after-each-unit) gives every step its own slice's PR
  in `AWAYWORK_PR_URL`, and `stats` counts each slice's draft PR.

::: warning Squash-merging the base
Once the first PR is squash-merged and its branch deleted (as GitHub's
"Automatically delete head branches" does), GitHub retargets the stacked
one to the default branch; with the branch kept, it still targets the
merged branch. Either way it still carries the first one's commits.
Merging the default branch into it usually resolves cleanly, since the
content is the same. Workers never rebase, and nobody does that merge
for you.
:::

### `push`

::: warning Experimental
`deliver: push` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

By default awaywork only pushes branches that don't exist yet. `deliver:
push` is the opt-in to add commits onto your own open PR instead of
stacking a draft PR on it, e.g. to have review threads addressed in place:

```yaml
queue:
  - skill: fix
    where: { type: pr, mine: true, unresolved_threads: { gt: 0 } }
    deliver: push
```

- Only onto an open PR you authored, awaywork's own included (they
  are opened with your login). On someone else's PR, a PR from a fork,
  or an item with no PR of yours, a chain that could commit is skipped
  with the reason.
- The chain pushes once, when it ends: every step's commits, a
  [loop](#loops)'s rounds included.
- A fast-forward only: awaywork pushes only commits on top of where
  the clone started, and refuses when the branch moved since, so it
  never rewrites history. It reads the PR again right before the
  push and refuses when it is no longer yours or open, or has auto-merge
  on, which would merge unreviewed commits, and when its branch lives on
  a fork, is the default branch, is protected, or also backs someone
  else's open PR in the repo. New commits that include a merge aren't pushed
  either. The commits get the `Awaywork:` trailer, which drops a
  commit's signature.
- The agent writes `.away/out/pr.md`, as for a draft PR, and the steps
  keep it current; without it nothing is pushed. The PR body stays as it
  is: `pr.md`, with the chain's notes, goes into the morning report.
- A skill's frontmatter can't default to `push`: only a rule opts in.
- After a push, the PR waits for your review: no rule takes it while
  its head is still the commit awaywork pushed. Any commit on top
  releases it, yours or a bot's, and so does a rebase or an amend.
  Without that, the push itself would update the PR and run the rule
  again every run. The pushed head is kept in awaywork's state dir,
  which a [GitHub Actions runner](./scheduling.md#in-github-actions)
  doesn't keep: there, a push rule pushes again every run its `where`
  holds.

## Notify

To get the morning report where you already look, `notify.command` runs
in a shell after every run, dry runs included, with the report's path in
`AWAYWORK_REPORT` and the run id in `AWAYWORK_RUN_ID`. There are no
built-in integrations. A command that fails or takes over a minute is
logged; the run still succeeds. Anything it leaves running in the
background is stopped when it exits.

```yaml
notify:                         # ntfy
  command: >-
    curl -sf -H "Title: awaywork $AWAYWORK_RUN_ID" -H "Markdown: yes"
    --data-binary @"$AWAYWORK_REPORT" "https://ntfy.sh/$NTFY_TOPIC"
  secrets: [NTFY_TOPIC]
```

```yaml
notify:                         # a Slack incoming webhook
  command: >-
    jq -Rs '{text:.}' "$AWAYWORK_REPORT" |
    curl -sf -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK_URL"
  secrets: [SLACK_WEBHOOK_URL]
```

`secrets` names the env vars the command reads: workers never see them,
and the GitHub Actions workflow passes them from repository secrets.

## After each unit

::: warning Experimental
`after_unit` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

To act as units finish, say to post to your own tools or record metrics,
`after_unit.command` runs in a shell once for every step of a unit, as
soon as the unit published, before the next unit starts. A dry run runs
none, and Ctrl-C stops the running one and starts no more. Its env has
`AWAYWORK_RUN_ID`, `AWAYWORK_UNIT` (the step's, e.g.
`acme-api-12-review-1`), `AWAYWORK_SKILL` and `AWAYWORK_STATUS` (`done`,
`failed`, `skipped`...), plus `AWAYWORK_PR_URL` on every step of a unit,
or of a [slice](#stack), that opened a draft PR, and `AWAYWORK_REPORT`,
the path of what the step wrote: its report, or for a step that commits,
the PR body as it left it. Like `notify`, a command that fails or takes
over a minute is logged and the run goes on, and `secrets` are withheld
from workers.

```yaml
after_unit:
  command: echo "$AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL" >> ~/awaywork.log
```

## MCP servers

::: warning Experimental
MCP servers have only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

Declare servers once under `mcp`, then give them to the rules or steps
that need them with `mcp: [names]`. No step gets a server its rule or
step doesn't name: a `then` step gets its rule's unless it names its
own, and `mcp: []` gives it none.

```yaml
mcp:
  sentry:                       # HTTP
    url: https://mcp.sentry.dev/mcp
    headers: { Authorization: "Bearer ${SENTRY_TOKEN}" }
    secrets: [SENTRY_TOKEN]
  db:                           # stdio
    command: npx
    args: [-y, some-postgres-mcp]
    env: { READ_ONLY: "1" }
    secrets: [DATABASE_URL]     # in the server's env as DATABASE_URL
    tools: [query]              # default: all the server's tools

queue:
  - skill: implement
    where: { type: issue, label: bug }
    mcp: [sentry]
    then:
      - { skill: review, mcp: [db] }
```

The shape is a subset of Claude Code's `.mcp.json`, translated for each
agent: a `command` with `args` and `env`, or a `url` with `headers`.
`secrets` names the env vars the server needs. A stdio server receives
its secrets in its env under those same names. An HTTP server gets each
one in a header, as `${NAME}`, or as `Bearer ${NAME}` for
`Authorization`. A secret can't appear in `command`, `args` or `url`,
where it would show in the process list, nor in `env`, where Codex takes
only literal values. Names starting
with `GH_` or `GITHUB_` are reserved: workers never get GitHub tokens, and
Actions refuses `GITHUB_` secrets. `tools` limits what the agent may call: anything
outside the list is refused. Only units whose rule names a server get
its secrets. `awaywork schedule` maps them into the Actions workflow,
and `awaywork doctor` shows whether each one is set.

Servers start for your own PRs and for issues and tasks, but not on
someone else's PR or an issue it closes, nor when one of their secrets
is unset. Only token-based servers work unattended: OAuth-only servers,
such as claude.ai connectors, need a login a runner doesn't have. A server's secret is one the agent can read. A server's
tools are tools that injected instructions can call. See
[Safety](./safety.md#mcp-servers).

## Secrets

The config holds env var **names** only. Values come from the environment
or `~/.config/awaywork/env` (the environment wins).

| Variable | Used by |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude, when not using the local login (`claude setup-token`) |
| `ASANA_TOKEN` (or your `token_env`) | Asana |
| `LINEAR_API_KEY` (or your `token_env`) | Linear |
| `JIRA_API_TOKEN` (or your `token_env`) | Jira |
| A custom source's `secrets` | That source's command |
| `GH_TOKEN` | GitHub in Actions; locally `gh`'s own login |
| Your `notify.secrets` | The notify command |
| Your `after_unit.secrets` | The after-unit command |
| Your `repos.<owner/name>.secrets` | That repo's `setup` |
| Your `mcp.<name>.secrets` | That MCP server, for the units whose rule names it |
