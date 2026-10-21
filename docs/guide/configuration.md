---
description: The awaywork config file by example and what stays stable, covering run windows, limits, budgets, providers, sources, branch names, PR links, per-repo settings, instructions, queue rules with where matching, and isolation.
---

# Configuration

One YAML file, `~/.config/awaywork/config.yml` by default; `--config <path>` or `AWAYWORK_CONFIG` point elsewhere. Every key is listed in the [reference](../reference/config.md).

## Editing safely

```sh
awaywork config edit    # opens $VISUAL/$EDITOR on a copy; saved only once valid
awaywork doctor         # validate, including skill names
awaywork plan           # see what the change does to the next run
```

For autocompletion and hover docs in editors with the YAML language server (VS Code's YAML extension, JetBrains, Neovim), put this first line in the file:

```yaml
# yaml-language-server: $schema=https://andreaprovenzale.github.io/awaywork/config.schema.json
```

`awaywork config schema` prints the same JSON Schema for the installed version.

## Stability

From 0.1.0-rc.1, the config schema holds across minor releases: a config that's valid on one stays valid on the next. Keys marked experimental are the exception: they have only run in tests, so they may change in a minor release, with a note in the release notes. So far that's only `github.host`.

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

A run is one window opening, or one `awaywork run` by hand. A window's `start` is when a scheduled run begins; no unit starts after its `end`, and a running one stops there. Times are local to the machine, or to the workflow's `timezone` in GitHub Actions, where a GitHub-hosted runner [cuts a run at about 6 hours](./scheduling.md#in-github-actions) whatever the window says. The default is one window, `01:00` to `07:00`. Add windows, each with optional `days` (`sun` to `sat`, the day it opens on), for quota that idles at weekends or over lunch:

```yaml
windows:
  - { start: "01:00", end: "07:00" }
  - { days: [sat, sun], start: "10:00", end: "18:00" }
```

The scheduler gets one trigger per window, and pacing divides the headroom by the runs left before the reset. Windows should not overlap. Budgets count runs, not days: three windows a day can spend `per_run` three times, and `runs_until_reset` counts window openings.

A readable quota decides how much work fits, not how much you can review in a morning. `limits.units` caps the units planned per run, `limits.units_per_repo` those in any one repo, and a rule's `units` those from that rule. None is set by default. Units past a cap are skipped in queue order, with the cap named in `awaywork plan` and the report. A rule's [`then`](./chains.md#then) chain is one unit, counted once. Only units whose first step is routed to a provider count, and caps apply to each `awaywork run`, like `fallback.units`, which every step draws on. `limits.unit_minutes` stops any worker after that many minutes, whichever provider runs it.

Budgets are shares of each provider's quota windows; see [How it works](./how-it-works.md#budget) for how they combine. Start low: `per_run: 5%` for a week shows what a unit costs you before you raise it.

## Providers

A list, in routing order. A bare name uses the defaults; a map overrides the budget for that provider or sets its `model`, passed as is to the binary (`claude --model`, `codex exec -m`). Without one, the binary picks its own default.

Workers skip your user-level agent config. To give them the hooks, env or settings you do want, list them here; they apply on every unit, including someone else's PR:

- `claude: { settings: <file> }`: a Claude Code settings file, relative to the config file, passed as `--settings`. Auto-memory stays off, and workers run in `dontAsk` mode: a tool that isn't pre-approved, by awaywork or by your `permissions.allow`, is denied.
- `codex: { config: { <key>: <value> } }`: each key passed as `codex exec -c key=value`, e.g. `model_reasoning_effort: high`.

### Bring your own CLI

opencode, Amp and friends don't need code in awaywork. Name a provider yourself and give it a command; it's your CLI and your login:

```yaml
providers:
  - claude
  - opencode:
      command: opencode run --auto "$(cat "$AWAYWORK_PROMPT")"
      probe: ./opencode-quota.sh # optional
limits:
  unit_minutes: 45
```

(`--auto` approves every permission your opencode config doesn't deny; check `opencode run --help` on your version.)

The command runs in the clone like any worker, with the prompt in the file `$AWAYWORK_PROMPT`; stdout and stderr go to `worker.log`, and exit 0 is a finished unit. `secrets`, the env vars it reads such as an API key, are withheld from other workers and listed in Actions. `skills_dir` (default `.agents/skills`) is where the unit's skills go in the clone. There's no `model` key: put it in the command, and no `mcp` either: a rule or step it may run can't name MCP servers, so route those to another provider with `provider`. Nothing installs your CLI on a GitHub-hosted runner, so there `plan` routes around it and `schedule install` leaves it out; run it locally or on a self-hosted runner. A `probe` gets your whole environment, secrets included, since it's your own command.

There's no turn cap, so `limits.unit_minutes` is required and bounds each unit, and a `budget.fallback` needs no `turns`. Without a `probe`, the provider runs on the `fallback` caps (units per run); there are no live rate-limit events, so it can't stop mid-unit at the ceiling. A `probe` is a command that prints the quota as JSON, run in the config file's folder once per `plan` or `run`, again after each unit, and by `doctor`; it gets 60 s:

```json
{
  "windows": [
    { "name": "5h", "span": "short", "used": 0.2, "resetsAt": 1793021152 },
    { "name": "7d", "span": "long", "used": 0.3, "resetsAt": 1793539552 }
  ]
}
```

`used` is a share from 0 to 1 and `resetsAt` is in unix seconds. awaywork paces against the `long` window; the `short` one only feeds the session stop, and a probe without a `long` window means the fallback caps. Whether the vendor allows unattended use is your call; `doctor` flags it as `unattended: grey`.

## Sources

| Source | Keys |
| --- | --- |
| `github` | `repos`: `owner/name` globs such as `acme/*`; optional `search`: extra GitHub search qualifiers, each ANDed with `is:open archived:false` (their items are neither `mine` nor `review_requested`); optional `host` for GitHub Enterprise (`github.acme.com`), which `gh` must be logged in to |
| `asana` | `workspace` gid, optional `projects` (gids), `repo_map` (project gid → `owner/name`), `token_env` (default `ASANA_TOKEN`) |
| `linear` | optional `repo_map` (team key → `owner/name`), `token_env` (default `LINEAR_API_KEY`) |
| `jira` | `site` host (`acme.atlassian.net`), `email` of the token's account, optional `cloud_id` (for a scoped token), `jql` (a condition ANDed with my unresolved issues, no `ORDER BY`), `repo_map` (project key → `owner/name`), `token_env` (default `JIRA_API_TOKEN`) |
| any other name | `command` printing your items as JSON, `fields`, `secrets`, `setup`: see [Custom sources](./custom-sources.md) |

::: warning Experimental `github.host` has only run in tests so far, never against a real GitHub Enterprise. `init`, `doctor` and artifact downloads still use `gh`'s default host. Tried it? [Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went. :::

Every source but `github` also takes a [`link`](#linking-prs).

Every built-in source also takes a `context` command, for what an item points at: a Sentry issue, a Figma frame, a runbook. awaywork runs it per item before the worker, in the config file's folder like a custom source's `command`, never in the clone. It writes its files into `$AWAYWORK_CONTEXT_DIR`, a fresh folder outside the clone, and awaywork copies them into `.away/context/<item>/extra/` next to `item.md`, where the worker reads them. The item reaches it as `AWAYWORK_ITEM_KEY`, `AWAYWORK_ITEM_URL` and `AWAYWORK_ITEM_FILE`, a path to the item as JSON.

```yaml
sources:
  github:
    repos: [acme/*]
    context:
      command: ./fetch-sentry.sh   # reads $AWAYWORK_ITEM_URL, writes $AWAYWORK_CONTEXT_DIR/sentry.md
      secrets: [SENTRY_TOKEN]      # kept out of the agent's env
```

Its `secrets` are withheld from the worker like a repo's, but whatever it writes reaches the agent as is: don't write a secret into the output (`curl -v` into a file, say). Its limits are in [What runs in the clone](#what-runs-in-the-clone). `extra/` belongs to this command. A custom source does this inside its own `command`.

Asana has no read-only personal token: the token can do anything you can. awaywork only reads with it and never hands it to the agent, unless you list it in an [MCP server](#mcp-servers)'s `secrets`. Create one just for awaywork so you can revoke it alone.

Linear takes a personal API key (Settings > Account > Security & access). awaywork only reads with it and never hands it to the agent, unless you list it in an [MCP server](#mcp-servers)'s `secrets`: when Linear offers the choice, give the key read access only.

Jira Cloud takes an Atlassian API token (id.atlassian.com > Security > API tokens). Prefer "Create API token with scopes", app Jira, scope `read:jira-work`: `init` then finds the site's `cloud_id` and awaywork calls `api.atlassian.com`, as scoped tokens require. A token without scopes can do anything you can; awaywork only reads with it. Tokens expire after at most a year.

Jira custom fields that share a name are keyed by name and id, such as `fields.Team (customfield_10040)`.

## Branch names

`branch` is a template rendered per unit, set globally, per repo or per rule (the most specific wins). It needs `{key}`, `{title}` (the item's title as a slug of at most 40 characters) or both: `feat/work` would name every unit the same, so it's refused. `{type}` is optional; it fills in the conventional-commit type of the first skill that commits, per [slice](./chains.md#stack) of a chain (see [`metadata.type`](./skills.md#write-your-own)).

| Item                               | `{key}`       |
| ---------------------------------- | ------------- |
| GitHub PR or issue `acme/api#12`   | `acme-api-12` |
| Asana task with custom ID `ENG-12` | `ENG-12`      |
| Linear issue `ENG-12`              | `ENG-12`      |
| Jira issue `ENG-12`                | `ENG-12`      |

Per-rule templates follow your repo's conventions:

```yaml
queue:
  - { skill: fix, where: { type: pr, mine: true, checks: failing }, branch: "fix/{title}" }
  - { skill: implement, where: { type: issue }, branch: "feat/{title}" }
```

The name is cosmetic: awaywork finds its own PRs by their footer, and yours as [Linking PRs](#linking-prs) says. Jira is the exception, since it links a PR only by the key in its branch or title: for Jira items keep the key in one of them, e.g. `feat/{key}-{title}`, or Jira loses the PR.

The guardrail is that awaywork only pushes a branch that doesn't exist on the remote yet, unless a rule opts in to [`push`](./chains.md#push). When the name is taken, the unit takes the first free one of `<branch>-2` to `<branch>-10`, and every step of its chain works on it; a [stacked slice](./chains.md#stack) renders its own name, with its own `{type}`, and takes the next free one when that's taken, as it always is with `away/{key}`. Not when awaywork already tried there: when a PR on the taken branch, open or closed unmerged, has a footer naming one of the unit's items, the unit is skipped as `awaywork tried this in <PR>; delete <branch> to run it again`. That record lives on GitHub, so it holds on a runner that keeps no [attempts](./how-it-works.md#units). A merged one landed, so the next pickup is a new round and takes a suffix. A taken branch with no PR whose tip has the `Awaywork:` trailer is a push whose PR failed, so it skips the unit too, until you delete it; one without the trailer, your own work in progress, is passed over for a suffix.

## Linking PRs

Trackers don't tell awaywork which PR is a task's, so it looks through your open PRs:

- A PR awaywork opened is linked by the items its footer names, whatever its branch or title. It never falls back to names, so an awaywork PR for ENG-13 that mentions ENG-12 isn't ENG-12's. A footer naming no items counts as none, so it is linked like yours.
- One you wrote is linked when its branch or title holds the item's key as a whole word, in any case, or its body holds the source's `link` line. A bare key in the body doesn't count: "follow-up to ENG-12" would mark ENG-12 as taken.

`link` is one line in the tracker's own words, rendered from the item's `{key}`, `{id}` and `{url}`. awaywork writes it into its draft PRs too, so the tracker links them whatever the branch is called.

| Source | Default `link` | Why |
| --- | --- | --- |
| `linear` | `Part of {key}` | A non-closing magic word: merging leaves the issue to your workflow |
| `asana` | `{url}` | Asana links a PR whose description holds the task URL, in any of its forms; so does awaywork |
| `jira` | none | Jira links on the branch or title only |
| custom | none | Whatever your tracker reads, e.g. `Refs {key}` or `{url}` |

```yaml
sources:
  linear: { link: "Closes {key}" }   # merging closes the issue
```

## Repos and instructions

`repos.<owner/name>` holds the `setup` and `test` commands for that repo, plus an instructions file. `setup` runs once per unit, in the fresh clone before any agent starts, outside the model; the agent is told it already ran. A chain's later steps share that clone and don't run it again, so dependencies a step adds aren't installed for the steps after it: a `when` or `until` command that needs them installs them itself, like `pnpm i --frozen-lockfile && pnpm test`. Anything setup leaves running is stopped when it exits. A setup that fails, takes over 15 minutes or reaches the window's end skips the unit, with the tail of its output in the report.

`secrets` names the env vars setup needs, such as a private registry token: setup gets them and no other secret, the agent never sees them, and the GitHub Actions workflow passes them from repository secrets. Their values are masked in setup's output. Setup gets the placeholder `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` (`none`) too, so a `gh` call in it fails with a 401 even against a public repo, and so does git over https through gh's credential helper (a private dependency in `pnpm install`); list `GH_TOKEN` in `secrets` to give it yours (gh reads `GH_TOKEN` first). On a PR someone else opened, setup runs the author's install scripts, so it gets none of them, and it runs only when the author has write access or org membership; otherwise the agent is told it didn't run. It gets none of them either on the branch of an awaywork PR a rule took up again, which a worker wrote. Read them from the repo's config, e.g. `${NPM_TOKEN}` in `.npmrc`, rather than writing them to your home directory, which the agent shares.

`verify` runs in the clone once each slice ends, outside the model, before it is published; it's a repo setting. Use it for lint, format or the repo's tests. A failure doesn't stop the publish: the PR body or the push's summary gets the tail of its output. Pass or fail, that tail lands in `verify.log` next to what the slice published, the run's `~/.local/state/awaywork/runs/<id>/units/<unit>/out/` (`out-2/` on for a [stacked slice](./chains.md#stack)), not in your terminal. It runs once per commit, with none of the secrets. A `report` delivery has nothing to publish and skips it.

`image` is the Docker image the repo's units run in under [`isolation: container`](#in-a-container).

`test` is given to the agent in its prompt. `instructions` at the top level, per repo and per rule are **file paths**, relative to the config file. A repo can also carry `.awaywork/instructions.md`, read from the clone unless the unit is on a PR someone else opened.

### What runs in the clone

Every command in your config that touches a unit's clone, side by side. All of them run in a shell outside the model, in the clone, except `context`, which runs in the config file's folder and whose output awaywork copies into the clone; none gets `GH_TOKEN` or any other forge token.

| Command | When | Secrets | A failure |
| --- | --- | --- | --- |
| `repos.<repo>.setup` | Once per unit, in the fresh clone before the first step's agent; not again for later steps or [stacked slices](./chains.md#stack), and not at all on an untrusted author's PR | That repo's `secrets` only, and none on someone else's PR or an awaywork PR's branch a rule took up | Exit non-zero, over 15 minutes or the window's end skips the unit, with the tail of its output in the report |
| `sources.<id>.context.command` | Per item, before setup and the first step's agent, in the config file's folder; its files go to `extra/` of the item's context; not on a dry run | Its own `secrets` only | Logged; the unit runs without `extra/`. Over two minutes or the window's end, over 1 MB, or a symlink or other non-file in the output counts as a failure |
| `repos.<repo>.test` | Never by awaywork: it's a line in the agent's prompt, and the agent runs it if it wants | The agent's: its provider's secret and those of the MCP servers its rule names | Up to the agent |
| `repos.<repo>.verify` | Once per slice, when it ends with commits, before it's published; not for `deliver: report` | None | The tail of its output goes into the PR body or the push's summary; the work is still published |
| `when.command` | Before a step's agent starts, in the chain's clone; not on an untrusted author's PR | None | The step is passed over; over 15 minutes or the window's end ends the chain instead, which publishes what it has |
| `until.command` | After every step of a loop; not on an untrusted author's PR, where the loop ends | None | The loop goes on; uncommitted changes fail it too; the window's end ends the chain, and a loop that ends failing puts the tail in the PR body |

`verify`, `when` and `until` share their results: the same command on the same commit runs once. [Loops](./chains.md#loops) has the rest of their rules.

`skills` at the top level adds skills to every unit, like a rule's `skills`; see [Skills](./skills.md#where-skills-come-from).

PR titles, bodies and commit messages have no config: the agent follows the repo's PR template, its recent commit style and your instructions (e.g. "prefix PR titles with the task key").

## Queue rules

| Key | Meaning |
| --- | --- |
| `skill` | The skill that does the work (`awaywork skills list`) |
| `source` | Only items from this source |
| `where` | Conditions on `type` and the source's fields |
| `provider` | One or a list; overrides the global order for this rule |
| `model` | A model per provider, e.g. `{ claude: sonnet, codex: gpt-5-codex }`; overrides the provider's `model` for this rule. A list of two, `{ claude: [sonnet, opus] }`, retries a failed step on the second; see [Retry on the next model](#retry-on-the-next-model) |
| `skills` | Extra skills the agent may use |
| `mcp` | MCP servers the agent gets, by name; see [MCP servers](#mcp-servers) |
| `instructions` | One or more instruction files for this rule |
| `with` | Parameters for the skill, listed in its prompt; see [Write your own](./skills.md#write-your-own) |
| `deliver` | Where the chain's commits go: `draft_pr` (default), `push` onto your own open PR's branch (see [`push`](./chains.md#push)), or `report`, where no step commits |
| `branch` | Branch template for this rule |
| `order` | Which matching item goes first: `oldest` or `newest` created, or last `updated`; default the source's order |
| `units` | At most this many units per run from this rule; a chain counts once |
| `then` | Steps that run after this rule's skill, in the same clone; see [`then`](./chains.md#then) |
| `when` | Quota checks, `runs_until_reset` and `headroom`, that skip the rule's whole chain; see [`when`](./chains.md#when) |

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

Strings compare ignoring case, like `matches`, so `section: In progress` catches a section called `In Progress`. Numbers and booleans compare exactly, and fixed values like `type` and `checks` stay lowercase.

`title`, `description` and `approved` (whether you ran [`awaywork approve`](./how-it-works.md#units) on the item) are keys on every source. An invalid regex is a config error, and `plan` names the match an item failed; for `any`, it names what each entry failed. An empty `any` entry is a config error, since it matches everything. A missing field equals nothing, and is neither older nor newer than anything; spans count back from when the plan runs. An unknown key is a config error that lists the keys each source offers. The [field table](./how-it-works.md#items) lists them too.

A PR awaywork opened only matches a rule whose top-level `where` names `ours` (inside `any` it is a config error), so rules written for your own PRs leave it waiting for your review. To act on it once you've reviewed it:

```yaml
- skill: fix
  where: { type: pr, mine: true, ours: true, my_unresolved_threads: { not: 0 } }
```

The unit's draft PR stacks on the awaywork PR, on a branch named after it (`away/acme-api-9` for #9). Once you merge the stacked PR, the next pickup of #9 takes a `-2` branch; while the stacked PR is open or closed unmerged, it is skipped as `awaywork tried this in <PR>; delete away/acme-api-9 to run it again`. Resolve the threads it answered too: merging moves #9, and with your threads still open the rule takes it up again for the same threads. The rule runs on the threads you started, but the agent reads every unresolved thread, as on your other PRs. `ours` comes from the GitHub source: a custom source's `ours` field holds nothing back.

### `order`

Within a rule, units run in the order the source returns items; for GitHub that is newest first, so with little quota the oldest can wait run after run. `order: oldest` runs them first. Items without the timestamp go last.

### Retry on the next model

```yaml
- skill: fix
  where: { type: pr, mine: true, checks: failing }
  model: { claude: [sonnet, opus] }
```

Every step runs on `sonnet`. One that fails there (a failed turn or the turn cap) runs once more, right away, on `opus`. That holds for a one-step rule like this one and for each step of a [`then`](./chains.md#then) chain or loop, where a step's own `model` can bring its own pair. A provider set to a plain name never retries.

The retry starts from the clone as the failed step found it: that attempt's commits, edits and `.away/out/` changes are dropped (gitignored files like `node_modules` and `.away/context/` stay as it left them), and only that step runs again, on the same provider, without checking its [`when`](./chains.md#when) again. Only a failure retries: not a quota stop, the time limit, Ctrl-C, or a chain that already published a [stacked slice](./chains.md#stack). If the provider has no budget left for the retry, the failed attempt stands, as without a list.

Both attempts show in the report and count against the budget. Towards [giving up](./how-it-works.md#units) on an item the retry speaks for the step, unless a quota, session or window stop cut it short: then the first failure counts. `notify` hears only about the retry:

```markdown
| 1 | acme-api-1 | fix → review | claude | done, 13 turns | https://example.com/acme/api/pull/away/acme-api-1 (1 commits), verdict approve |
|  | └ acme-api-1 | fix | claude | failed, 3 turns (retried on the next model) | 1 commit |
|  | └ acme-api-1 | fix | claude | done, 5 turns | 1 commit |
|  | └ acme-api-1-review | review | claude | done, 5 turns | a report, verdict approve |
```

A rule can run more steps after its skill, such as a review and a fix until the review approves: see [Chains](./chains.md).

## Notify

`notify.command` runs in a shell, as you and with your environment, on two events. `AWAYWORK_EVENT` says which:

- `run`, once when a run ends, dry runs included: the morning report's path is in `AWAYWORK_REPORT` and the run id in `AWAYWORK_RUN_ID`; the same results as JSON sit next to it, in `$(dirname "$AWAYWORK_REPORT")/report.json`.
- `unit`, once for every step of a unit, as soon as the unit published, before the next unit starts. A dry run fires none, and Ctrl-C stops the running one and fires no more. Its env has `AWAYWORK_RUN_ID`, `AWAYWORK_UNIT` (the step's, e.g. `acme-api-12-review-1`), `AWAYWORK_SKILL` and `AWAYWORK_STATUS` (`done`, `failed`, `skipped`...), plus `AWAYWORK_PR_URL` on every step of a unit, or of a [slice](./chains.md#stack), that opened a draft PR (not on a [`push`](./chains.md#push), so a command that readies or labels `$AWAYWORK_PR_URL` never touches your own PR), and `AWAYWORK_REPORT`, the path of what the step wrote: its report, or for a step that commits, the PR body as it left it.

The command gets both events. One that's only for the morning report starts with `[ "$AWAYWORK_EVENT" = run ] || exit 0`, or it also fires on every step.

There are no built-in integrations. A command that fails or takes over a minute is logged and the run goes on, and still succeeds:

```
  notify failed for acme-api-1: Command failed with exit code 3: ...
```

Anything it leaves running in the background is stopped when it exits. A command that only cares about one event exits early on the other:

```yaml
notify:                         # ntfy, the morning report only
  command: >-
    [ "$AWAYWORK_EVENT" = run ] || exit 0;
    curl -sf -H "Title: awaywork $AWAYWORK_RUN_ID" -H "Markdown: yes"
    --data-binary @"$AWAYWORK_REPORT" "https://ntfy.sh/$NTFY_TOPIC"
  secrets: [NTFY_TOPIC]
```

```yaml
notify:                         # a Slack incoming webhook, the morning report only
  command: >-
    [ "$AWAYWORK_EVENT" = run ] || exit 0;
    jq -Rs '{text:.}' "$AWAYWORK_REPORT" |
    curl -sf -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK_URL"
  secrets: [SLACK_WEBHOOK_URL]
```

```yaml
notify:                         # a line per step
  command: >-
    [ "$AWAYWORK_EVENT" = unit ] || exit 0;
    echo "$AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL" >> ~/awaywork.log
```

`secrets` names the env vars the command reads: workers never see them, and the GitHub Actions workflow passes them from repository secrets.

### PR labels, reviewers and ready for review

A draft PR gets the agent's title and body and nothing else: no labels, no reviewers, always a draft, into the base awaywork picked. None of that is config. The `unit` event has the PR's URL, so `gh` does it:

```yaml
notify:
  command: |
    set -e
    [ "$AWAYWORK_EVENT" = unit ] && [ -n "$AWAYWORK_PR_URL" ] || exit 0
    # every step of the PR fires; once one got through, it's no longer a draft
    draft=$(gh pr view "$AWAYWORK_PR_URL" --json isDraft -q .isDraft)
    [ "$draft" = true ] || exit 0
    gh pr edit "$AWAYWORK_PR_URL" --add-label awaywork --add-reviewer octocat
    gh pr ready "$AWAYWORK_PR_URL"
```

`set -e` stops at a `gh` that fails, a missing label say: the hook's failure is logged, the PR stays a draft, and the next step tries again.

`gh pr edit "$AWAYWORK_PR_URL" --base develop` moves the base too; leave it out on a chain with [`stack`](./chains.md#stack), whose PRs sit on each other, and on a rule that takes up an awaywork PR, whose new PR sits on that one's branch.

That's your command with your token, not a worker: workers never comment or ping anyone. A requested reviewer gets a notification, and so can the CODEOWNERS a ready PR asks, so treat those two like a comment you'd post.

## MCP servers

Declare servers once under `mcp`, then give them to the rules or steps that need them with `mcp: [names]`. No step gets a server its rule or step doesn't name: a `then` step gets its rule's unless it names its own, and `mcp: []` gives it none.

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

The shape is a subset of Claude Code's `.mcp.json`, translated for each agent: a `command` with `args` and `env`, or a `url` with `headers`. `secrets` names the env vars the server needs. A stdio server receives its secrets in its env under those same names. An HTTP server gets each one in a header, as `${NAME}`, or as `Bearer ${NAME}` for `Authorization`. A secret can't appear in `command`, `args` or `url`, where it would show in the process list, nor in `env`, where Codex takes only literal values. Names starting with `GH_` or `GITHUB_` are reserved: workers never get GitHub tokens, and Actions refuses `GITHUB_` secrets. `tools` limits what the agent may call: anything outside the list is refused. Only units whose rule names a server get its secrets. `awaywork schedule` maps them into the Actions workflow, and `awaywork doctor` shows whether each one is set.

Servers start for your own PRs and for issues and tasks, but not on someone else's PR or an issue it closes, nor when one of their secrets is unset. Only token-based servers work unattended: OAuth-only servers need a login a runner doesn't have, and workers never get your claude.ai connectors. A server's secret is one the agent can read. A server's tools are tools that injected instructions can call. See [Safety](./safety.md#mcp-servers).

## Isolation

```yaml
isolation: user # default: none; or container
```

`none` runs setup, the agent and the checks as you. Everything in [Safety](./safety.md) keeps your credentials out of the agent's way, not out of its reach: it can read what you can ([Not a sandbox](./safety.md#not-a-sandbox)). `user` runs them as `awaywork`, a user with nothing of yours, which on your Linux box or a self-hosted Linux runner you make once. `awaywork doctor` tells you how, here for a user `runner` (uid and gid 1001), with your own name and ids in yours:

```text
FAIL  isolation: user, but can't run as the awaywork user (sudo: unknown user awaywork); make the worker user once:
    sudo useradd --no-create-home --user-group --shell /usr/sbin/nologin awaywork
    echo awaywork | sudo tee -a /etc/cron.deny /etc/at.deny
    sudo visudo -f /etc/sudoers.d/awaywork   # with these two lines:
    runner ALL=(awaywork) NOPASSWD:SETENV: ALL
    runner ALL=(root) NOPASSWD: /usr/bin/chown -R -h -P awaywork\: /tmp/awaywork-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9], /usr/bin/chown -R -h -P 1001\:1001 /tmp/awaywork-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]
```

The user has no home and no login shell: each clone gets a fresh `HOME`, and nothing logs in as it. The first sudoers line lets you run anything as the worker, the second only the two `chown`s that hand it a clone and its `HOME` and take them back; why that's safe is in [Safety](./safety.md#a-worker-user-on-your-linux-machine). Then:

```text
ok    isolation: user: setup, the agent and the checks run as awaywork
```

A few things change with it:

- **The agent gets a login, not yours.** The worker's `HOME` is a fresh folder for each clone, so your keychain login isn't there: give Claude a `CLAUDE_CODE_OAUTH_TOKEN` in the env file (`claude setup-token`). Until you do, `doctor` says `warn  claude: the awaywork user can't use your login: set CLAUDE_CODE_OAUTH_TOKEN`. Codex needs nothing: awaywork copies your own `auth.json` into the worker's `HOME` for the run and saves it back after, under the lock every Codex run takes, since a refresh rotates it.
- **Tools live outside your home.** The worker can't run what nvm, `~/.local/bin` or `~/.cargo` put in your home. Install the agents' CLIs and the repos' toolchains system-wide; `doctor` warns about every folder on your `PATH` it can't enter.
- **Your home is closed.** The worker reads whatever in it is readable by others, so `doctor` warns until `chmod o-rwx ~`.
- **Linux only.** On macOS it refuses to run: `isolation: user runs on Linux only, not darwin`.
- **Always on a GitHub-hosted runner**, whatever the config says: there `none` and `container` are ignored, and the action makes the user.
- **One developer per worker user.** Whoever has the `chown` line can chown any awaywork clone folder, someone else's too.

### In a container

```yaml
isolation: container
repos:
  acme/api:
    image: ghcr.io/acme/api-dev:latest # what setup, the agent and the checks run in
    setup: pnpm i --frozen-lockfile
```

`container` is the one for your Mac, and for more than a user hides on Linux. Setup, every agent run and every check start in a fresh container of the repo's `image` through Docker (Docker Desktop, Colima, or the engine on Linux). It mounts the clone, at its own path, and the skills plugin, read-only, and nothing else: not your home, not the docker socket. It runs as your uid and gid, so what it writes in the clone stays yours, with every capability dropped and `no-new-privileges`, so a `sudo` the image hands out goes nowhere. Each container is gone before awaywork looks at the clone again, `docker rm -f` included on a timeout, the window's end or Ctrl-C, since killing the `docker run` client stops nothing inside. `doctor` checks that Docker answers, that each repo's image is here (or pulls it) and that the agents' CLIs run in it, here with a test image of stand-ins:

```text
ok    isolation: container: setup, the agent and the checks run in a fresh container of the repo's image (Docker 27.4.0)
ok    isolation: acme/leak: awaywork-leak has claude 2.1.290 (Claude Code stand-in), codex codex-cli 0.162.1 (stand-in)
```

And when one isn't there:

```text
FAIL  isolation: acme/leak: awaywork-nope:1 isn't here and couldn't be pulled (Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp 54.156.126.76:443: i/o timeout)
```

The image is yours to build, and what's in it is all the units get:

- **The agent CLIs and the toolchain.** `claude`, `codex` or your command provider's binary, whichever the repo's rules use, plus whatever setup and the checks run, and the commands of the [MCP servers](#mcp-servers) its rules name: stdio servers start inside, as the agent's children. Not `gh` or `glab`: awaywork's own forge calls run outside. Install things system-wide rather than under `/root`, since the container runs as your uid, and mind the `ENTRYPOINT`: awaywork skips it and runs its commands as they are.
- **Every repo gets one.** Under `container`, a `repos` entry without an `image` is a config error (`repos.acme/api.image: required with isolation: container: the image its units run in`), and a unit in a repo with no entry at all is skipped: `no image for acme/web: isolation: container needs one in its repos entry`. Nothing falls back to running as you.
- **Pulled once.** A missing image is pulled by the first `docker run` (or by `doctor`); after that awaywork uses it as it is, so `docker pull` to update it.
- **Only the env it needs.** A container gets the image's own environment, plus what awaywork sets (the `none` placeholders, its git config, the prompt's path) and that phase's secrets, by name, never on argv: setup its repo's `secrets`, the agent its provider's and its MCP servers'. Nothing else of yours, your ssh agent included, so a variable a tool needs goes in `secrets` or in the image.
- **A `HOME` in the clone.** It's `.away/home`, fresh with each clone: what setup puts there, a `pip install --user` or a browser download, reaches the chain's agents and checks, and goes with the clone, so caches don't survive the night. Bake them into the image.
- **Logins.** Claude needs a `CLAUDE_CODE_OAUTH_TOKEN` in the env file (`claude setup-token`): your keychain login isn't there, and `doctor` warns without it. Codex gets your `auth.json` (`~/.codex`, or `$CODEX_HOME`) copied into its `HOME` for the run, and the copy goes back over yours afterwards, under the same lock as its probes, when it changed: a refresh rotates the refresh token, and the old one stops working within a day ([Providers](../providers.md#codex)). Quota probes and `--version` checks stay on your machine, with your own logins.
- **Clones in your home.** They stay in the run dir under `~/.local/state/awaywork/runs/`, unlike `user`'s `/tmp/awaywork-*`: Colima shares only your home and `/tmp/colima` with its VM, Docker Desktop shares `/Users`, `/tmp` and a few more, so a clone in your home is the one place both see.
- **What it costs.** An image per repo to keep current; a container start per command (a few hundred ms on Colima); file access through the VM's sharing on macOS, slow for an `npm install`; and no Xcode or anything else macOS-only, since the containers are Linux.

## Secrets

The config holds env var **names** only. Values come from the environment or `~/.config/awaywork/env` (the environment wins).

| Variable | Used by |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude, when not using the local login (`claude setup-token`) |
| `ASANA_TOKEN` (or your `token_env`) | Asana |
| `LINEAR_API_KEY` (or your `token_env`) | Linear |
| `JIRA_API_TOKEN` (or your `token_env`) | Jira |
| A custom source's `secrets` | That source's command |
| `GH_TOKEN` | GitHub in Actions; locally `gh`'s own login |
| A built-in source's `context.secrets` | That source's `context` command |
| Your `notify.secrets` | The notify command |
| Your `repos.<owner/name>.secrets` | That repo's `setup` |
| Your `mcp.<name>.secrets` | That MCP server, for the units whose rule names it |
