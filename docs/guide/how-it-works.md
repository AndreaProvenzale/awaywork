---
description: How a run works, from items to units, the queue of rules, deduplication, quota ceilings and routing, the worker's workspace, and delivery as a draft PR, a report or a push onto your own PR.
---

# How it works

```
collect ──> match ──> dedupe ──> budget ──> dispatch ──> publish ──> report
(sources)   (queue    (one unit  (quota     (workers,    (forge,     (morning
             rules ->  per        probes,    one per      no model)   report)
             skills)   feature)   caps)      unit)
└──────────────── foreman, no model call ────────────────┘
```

Only the workers call a model. Everything else is plain code you can
inspect with `awaywork plan` before a run.

## Items

A source returns your open items with facts about each: a `type` (`pr`,
`issue`, `task`), a `title` and `description`, and source fields.

| Source | Items | Fields a rule can match |
|---|---|---|
| GitHub | PRs you authored, PRs awaiting your review, issues assigned to you, in the configured repos | `repo`, `label`, `author`, `trusted` (the author is an owner, member or collaborator), `mine`, `ours` (awaywork opened it), `draft`, `checks` (`failing`, `pending`, `passing`), `unresolved_threads`, `my_unresolved_threads` (the unresolved ones you started), `files` (paths the PR touches, the first 500; test with `matches`), `changed_lines` (additions plus deletions), `review_requested`, `created`, `updated` |
| Asana | Tasks assigned to you in a workspace, optionally some projects | `project`, `section`, `blocked` (a dependency is incomplete), `tags`, `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated`, `due` |
| Linear | Issues assigned to you that are neither completed nor canceled | `team` (key), `state`, `labels`, `priority` (e.g. `High`), `blocked` (an open blocker), `project`, `repo` (from `repo_map`), `created`, `updated` |
| Jira Cloud | Unresolved issues assigned to you, optionally narrowed by `jql` | `project` (key), `status`, `labels`, `priority`, `blocked` (an open "is blocked by" link), `issuetype` (e.g. `Bug`), `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated` |

## The queue

The queue is an ordered list of rules. Each item takes the **first** rule
it matches; an item that matches none is skipped. A rule names the
`skill` that does the work.

```yaml
queue:
  - skill: fix-ci
    where: { type: pr, mine: true, checks: failing }
  - skill: implement
    where: { type: issue, label: awaywork }
```

Within a rule, items come in the source's order (GitHub: newest first)
unless the rule sets `order`.

With no `queue` in the config, the default one applies, keeping only the
rules whose source is configured:

| # | Skill | Source | Where |
|---|---|---|---|
| 1 | `fix-ci` | GitHub | my PR, checks failing |
| 2 | `qa-feedback` | Asana | section `QA` |
| 3 | `qa-feedback` | Linear | state `QA` |
| 4 | `qa-feedback` | Jira | status `QA` |
| 5 | `address-review` | GitHub | my PR, unresolved threads |
| 6 | `address-review` | GitHub | my awaywork PR, unresolved threads I started |
| 7 | `review` | GitHub | my review requested, trusted author |
| 8 | `continue` | Asana | section `In progress` |
| 9 | `continue` | Linear | state `In Progress` |
| 10 | `continue` | Jira | status `In Progress` |
| 11 | `plan` | Asana | section `Current sprint` |
| 12 | `plan` | Linear | state `Todo` |
| 13 | `plan` | Jira | status `To Do` |

`awaywork init` writes the queue out, with your real Asana section,
Linear state and Jira status names, so you can edit it.

## Units

Items that share a key or a linked PR (repo and branch) are one unit, one
piece of work on one feature, ranked at its best item's rule. An Asana
task linked to your PR becomes one unit with that PR. An awaywork PR
is linked to the items its footer names; one you wrote, by the key in
its branch or title, or the source's [`link`](./configuration.md#linking-prs)
line in its body.

- The unit works in its linked PR's repo, else the item's `repo` field;
  with neither it is skipped.
- A unit that links an open awaywork PR is skipped as **waiting for
  review**: awaywork doesn't add to work you haven't read from an
  earlier run. An awaywork PR only matches rules whose `where` names
  `ours`, like the default `address-review` on threads you left on it:
  that rule then takes the unit, even over a better-ranked item linked to
  the PR, and its draft PR stacks on the awaywork PR.
- A PR awaywork pushed onto (a `deliver: push` rule) is skipped as
  **waiting for review** too, while its head is still the commit
  awaywork pushed (kept in the state dir, so not on a runner).
- A unit none of whose items changed since a worker last finished the
  same skill on it is skipped as **unchanged since run `<id>`**, so a
  review or a unit that gave up isn't redone every run. A rule's `then`
  chain counts as one attempt, recorded only when every unit of the chain
  finished; commits left unpushed retry. "Changed" is the item's
  `updated` time; attempts live in `~/.local/state/awaywork/attempts.json`,
  and a unit picked with `run --unit` isn't skipped.
- A unit whose chain didn't finish 3 runs in a row (a failure, a stop,
  commits left unpushed) is skipped as **gave up after 3 attempts** until
  one of its items changes or it matches another skill. A plan report
  followed by a failed implement is one failure; a finished attempt
  clears the count, and skipped, dry-run and aborted units don't count,
  nor does a loop after a report that ended on one.
  `run --unit` runs it anyway.
- `awaywork skip <source:key>` (e.g. `github:acme/api#5`) leaves an
  item, and any unit it joins, alone until `awaywork unskip` or the
  `--until` date; `plan` lists it under Skipped with the `--reason`.
  Skips live in `~/.local/state/awaywork/skips.json`, and
  `run --unit` runs the item anyway.
- Units run one at a time, in queue order; a rule's
  [`then`](./configuration.md#then) steps run right after its unit. A
  [loop](./configuration.md#loops) repeats its steps in one clone and
  publishes once, when it ends. A step with a
  [`when`](./configuration.md#when) runs only when its condition holds.
- A draft PR stacks only on a PR it builds on: the draft PR a `then`
  step follows, or the awaywork PR a rule took up. Its body names the
  PR to merge first, and on a repo with GitHub's
  [stacked PRs](https://gh.io/stacks) awaywork links the two into a
  stack. Every other draft PR starts from the default branch, so you can
  merge, park or close each one on its own.
- Optional [caps](./configuration.md#windows-limits-and-budget) limit the units
  per run, per repo and per rule.

## Budget

Each provider gets a ceiling for the run on its long window (the week for
Claude, the week or month for Codex). The ceiling is the lowest of:

- `used + per_run`, when `per_run` is set;
- `1 - reserve` (default reserve 10%);
- pacing: `used + (1 - reserve - used) / runs to reset`, where runs to
  reset counts the window openings left before the reset, including the
  one under way when the run is in a window; so a run just before the
  reset may spend more than one just after.

A worker stops once the provider reports its long window past the ceiling
or its short (5 h) window past `session_max` (default 90%). Claude reports
quota during the run, so it stops mid-run; Codex is read after each run,
so it stops between units. A provider whose quota can't be read gets a
fixed `fallback` of units and turns per run.

## Routing

A rule's `provider` list, else the global `providers` order. The first
provider under its ceiling takes the unit. When a window fills, the next
unit goes to the next provider.

## The worker

Each unit runs in a fresh clone on a new branch cut from its base: the
draft PR a `then` step follows, else the linked PR's branch, else the
default branch. A PR from a fork is fetched from the repo's
`refs/pull/<number>/head`, and the unit fails if that is no longer the
head commit its source read. A branch name
that's taken on the remote gets a `-2` to `-10` suffix, unless
awaywork already tried there ([Branch names](./configuration.md#branch-names)).
A loop's rounds reuse the clone of the unit the loop started from.

- `.away/context/` holds the prefetched item: PR view, diff,
  unresolved threads and failed-check logs, or the issue or task with
  its comments.
- The skills go where the agent looks for them (`.claude/skills/`,
  `.agents/skills/`).
- The prompt is, in order: the fixed [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md),
  the skill, then your instructions (global, per repo, in-repo
  `.awaywork/instructions.md` unless someone else opened the PR, per
  rule).
- The agent has no forge token, no source's or other provider's secret,
  and a `gh` config without a login.
- A turn cap bounds the run (200, or `fallback.turns` without a quota
  reading), `limits.unit_minutes` caps its wall-clock time when set (status
  `stopped: time`), and a watchdog stops it below 1.5 GB of free memory or 2 GB of
  disk, then kills every process it left behind.

## Delivery

| `deliver` | What happens |
|---|---|
| `draft_pr` | The worker commits and writes `.away/out/pr.md` (first line the title). awaywork adds an `Awaywork: <run id>` trailer, pushes the new branch and opens a draft PR into that base. No `pr.md`, no publish. Never into someone else's PR or a PR from a fork: there a rule is skipped with the reason, and a `then` step is left out with the rest of the chain; a report still works. |
| `report` | The worker writes `.away/out/report.md`; nothing is pushed. It goes into the morning report. |
| `push` | Opt-in per rule, only on a unit whose base is your own open PR. The worker commits and writes `.away/out/report.md`; awaywork adds the trailer and pushes the commits onto your PR's branch as a fast-forward, only while the PR is yours, open, in the repo, without auto-merge, and its head is still the commit the clone started from, and its branch isn't the default branch, protected, or the branch of someone else's open PR in the repo. The PR body isn't touched; the report goes into the morning report. No `report.md`, no push. |

Either way, a skill that defines verdicts also writes one word to
`.away/out/verdict`, such as `approve`. The report shows it next to
the unit's result, and a [loop](./configuration.md#loops) can end on it.

`review` and `plan` default to `report`, every other skill to `draft_pr`;
a rule can override either. `push` is never a skill's default. A draft
PR's body gets its items' [`link`](./configuration.md#linking-prs) lines,
and ends with a footer naming awaywork, the run and the unit's items,
which is how the next plan recognises it and links it to them.

## The morning report

`awaywork report` prints the last run: units done and skipped with the
reason, each provider's windows before and after against the ceiling, and
the report-only outputs. On a terminal its tables are aligned and statuses
coloured; piped, it is the markdown as saved, so in GitHub Actions it lands
in the job summary.
`awaywork report --list` lists recent runs with their units, draft PRs
and reports; `awaywork report <id>` prints one of them. A
[`notify` command](./configuration.md#notify) can send it elsewhere.

`awaywork stats` adds up every run since this feature, kept in each run's
`units.json`: per rule (by its position in the queue in that run), skill and
provider, the units, how many were done, failed or stopped, the share of the
long quota window their workers used, and the draft PRs opened. `--json`
prints the same totals. The quota share is an estimate: it starts at the
worker's first reading, includes any other use of the account meanwhile, and
is `-` when the window reset mid-unit or the worker read the quota only once,
as Codex does after its run. In a loop only the host unit carries the draft
PR, so the loop's `review` and `address-review` rows show no PRs.
`units.json` is written when the run ends, so a run that is killed leaves none.
Runs from before have no `units.json` and are left out.
