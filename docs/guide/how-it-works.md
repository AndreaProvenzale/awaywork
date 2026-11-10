---
description: How a run works, from items to units, the queue of rules, deduplication, quota ceilings and routing, the worker's workspace, and delivery as a draft PR, a report, a pending review or a push onto your own PR.
---

# How it works

```
collect ──> match ──> dedupe ──> budget ──> dispatch ──> publish ──> report
(sources)   (queue    (one unit  (quota     (workers,    (forge,     (morning
             rules ->  per        probes,    one per      no model)   report)
             skills)   feature)   caps)      unit)
└──────────────── foreman, no model call ────────────────┘
```

Only the workers call a model. Everything else is plain code you can inspect with `awaywork plan` before a run.

## Items

A source returns your open items with facts about each: a `type` (`pr`, `issue`, `task`), a `title` and `description`, `approved` (the skill of the newest result awaywork posted on it that you approved, or that [went ahead](./workflows.md#posts-that-wait)), `state` (`open`, or `merged` or `closed` for the [finished items](./configuration.md#finished-items) a rule asks for), `closed` (when it finished) and `planned` (a [task](./workflows.md#tasks) of a plan you approved), and source fields.

| Source | Items | Fields a rule can match |
| --- | --- | --- |
| GitHub | Open PRs you authored, PRs awaiting your review, issues assigned to you, plus any extra `search` (e.g. `label:awaywork`, `mentions:@me`), in the configured repos; your merged and closed ones too when a rule asks | `repo`, `label`, `author`, `trusted` (the author is an owner, member or collaborator), `mine`, `ours` (awaywork opened it), `draft`, `checks` (`failing`, `pending`, `passing`), `unresolved_threads` (those [shown to the agent](./safety.md#public-repos)), `my_unresolved_threads` (the unresolved ones you started), `files` (paths the PR touches, the first 500; test with `matches`), `changed_lines` (additions plus deletions), `conflicts` (it doesn't merge cleanly into its base; unset while GitHub is still working that out), `behind` (commits on its base its branch doesn't have, on your own open PRs in the repo), `review_requested`, `created`, `updated` |
| Asana | Incomplete tasks assigned to you in a workspace, optionally some projects; completed ones too when a rule asks | `project`, `section`, `blocked` (a dependency is incomplete), `tags`, `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated`, `due` |
| Linear | Issues assigned to you that are neither completed nor canceled; completed and canceled ones too when a rule asks | `team` (key), `status` (the workflow state), `labels`, `priority` (e.g. `High`), `blocked` (an open blocker), `project`, `repo` (from `repo_map`), `created`, `updated` |
| Jira Cloud | Unresolved issues assigned to you, optionally narrowed by `jql`; resolved ones too when a rule asks | `project` (key), `status`, `labels`, `priority`, `blocked` (an open "is blocked by" link), `issuetype` (e.g. `Bug`), `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated` |
| Routines | One task per [routine](./configuration.md#routines) in your config: its latest occurrence | `name`, `repo`, `created`, `updated` (both the occurrence) |

## The queue

The queue is an ordered list of rules. Each item takes the **first** rule it matches; an item that matches none is skipped. A rule names the `skill` that does the work.

```yaml
queue:
  - skill: fix
    where: { type: pr, mine: true, checks: failing }
  - skill: implement
    where: { type: issue, label: awaywork }
```

The label isn't enough on its own: the GitHub source reads only the issues assigned to you, so a labelled issue nobody assigned to you plans nothing.

Within a rule, items come in the source's order (GitHub: newest first) unless the rule sets `order`.

With no `queue` in the config, the default one applies, keeping only the rules whose source is configured:

| #   | Skill       | Source | Where                                        |
| --- | ----------- | ------ | -------------------------------------------- |
| 1   | `fix`       | GitHub | my PR, checks failing                        |
| 2   | `fix`       | Asana  | section `QA`                                 |
| 3   | `fix`       | Linear | status `QA`                                  |
| 4   | `fix`       | Jira   | status `QA`                                  |
| 5   | `fix`       | GitHub | my PR, unresolved threads                    |
| 6   | `fix`       | GitHub | my awaywork PR, unresolved threads I started |
| 7   | `review`    | GitHub | my review requested, trusted author          |
| 8   | `implement` | Asana  | section `In progress`                        |
| 9   | `implement` | Linear | status `In Progress`                         |
| 10  | `implement` | Jira   | status `In Progress`                         |
| 11  | `plan`      | Asana  | section `Current sprint`                     |
| 12  | `plan`      | Linear | status `Todo`                                |
| 13  | `plan`      | Jira   | status `To Do`                               |

The section and status names are guesses; the setup `awaywork init` hands to `/away` replaces them with your tracker's real ones and writes the queue out so you can edit it.

## Units

Items that share a key or a linked PR (repo and branch) are one unit, one piece of work on one feature, ranked at its best item's rule. An Asana task linked to your PR becomes one unit with that PR. An awaywork PR is linked to the items its footer names; one you wrote, by the key in its branch or title, or the source's [`link`](./configuration.md#linking-prs) line in its body.

- The unit works in its linked PR's repo, else the item's `repo` field; with neither it is skipped.
- A unit that links an open awaywork PR is skipped as **waiting for review**: awaywork doesn't add to work you haven't read from an earlier run. An awaywork PR only matches rules whose `where` names `ours`, like the default `fix` on threads you left on it: that rule then takes the unit, even over a better-ranked item linked to the PR, and its draft PR stacks on the awaywork PR. A GitHub issue's draft PR into the default branch says `Closes` it, which links the two, so the issue is skipped as waiting for review while that draft is open. Except for a draft awaywork left for a later run, whose footer says the agent goes on there: the unit [continues](./workflows.md#continue) on it.
- A PR awaywork pushed onto (a `deliver: push` rule) is skipped as **waiting for review** too, while its head is still the commit awaywork pushed (kept in the state dir, so not on a runner). Not after a [`sync`](./chains.md#sync)'s clean merge: it holds nothing for you to review.
- A unit whose item's newest comment is awaywork's [questions](./workflows.md#questions) is skipped as **waiting for your answer**, until someone replies on the item.
- A unit a `deliver: plan` rule took waits on awaywork's [plan](./workflows.md#plans) on its item: skipped as **waiting for your approval** until you reply, planned again on your feedback, and [fanned out](./workflows.md#tasks) into its tasks once you approved it. A report rule's result that [waits](./workflows.md#posts-that-wait) holds its rule the same way, and once you approved it the next rule takes the item.
- A unit none of whose items changed since a worker last finished the same skill on it is skipped as **unchanged since run `<id>`**, unless it said [`continue`](./workflows.md#continue), so a review or a unit that gave up isn't redone every run. A unit's chain counts as one attempt, finished when every step that ran was done and no publish left anything behind; commits left unpushed retry. "Changed" is the item's `updated` time, and for a [`sync`](./chains.md#sync) its base's head too; attempts live in `~/.local/state/awaywork/attempts.json`, and a unit picked with `run --unit` isn't skipped.
- A unit whose chain didn't finish 3 runs in a row (a failure, an error, a `unit_minutes` timeout, commits left unpushed) is skipped as **gave up after 3 attempts; next try on `<date>`**, a week after the last one, even if its items changed in between: a Sentry error that keeps firing doesn't get a fresh try every night. That week-later try is one try: fail again and it waits another week. A plan report followed by a failed implement is one failure; a finished attempt clears the count, matching another skill starts a new one, and skipped, dry-run and aborted units don't count. Neither does a stop the item didn't cause (quota, session limit, window end) or may not have (a watchdog stop for low memory or disk): it tries again next run. `run --unit` runs it anyway, as its one try.
- `awaywork skip <source:key>` (e.g. `github:acme/api#5`) leaves an item, and any unit it joins, alone until `awaywork unskip` or the `--until` date; `plan --skipped skipped_by_you` lists it with the `--reason`. Skips live in `~/.local/state/awaywork/skips.json`, and `run --unit` runs the item anyway.
- A chain's first step on an item gets the item's latest report in `.away/context/previous/report.md` (the last one of the latest chain on it that left a report), and the prompt says it is from an earlier run. That is how an approved `implement` finds the plan, on a retry too: a failed `implement` that wrote no report doesn't replace the plan. Later steps get the step before, as always.
- Units run one at a time, in queue order. A unit is a chain: the rule's skill, then its [`then`](./chains.md#then) steps, one after the other in one clone, publishing once when the chain ends. A [loop](./chains.md#loops) repeats steps, and a step with a [`when`](./chains.md#when) runs only when its condition holds.
- A PR stacks only on the awaywork PR a rule took up, or on the PR of the [task](./workflows.md#the-feature-block) it waits on. Its body names the PR to merge first, and on a repo with GitHub's [stacked PRs](https://gh.io/stacks) awaywork links the two into a stack. Every other PR starts from the default branch or your PR's branch, so you can merge, park or close each one on its own.
- Optional [caps](./configuration.md#windows-limits-and-budget) limit the units per run, per repo and per rule; a chain counts once.

A queue that plans the sprint's tasks and implements the ones you approve:

```yaml
queue:
  - skill: plan
    source: asana
    where: { section: Current sprint }
    deliver: report
    wait: true # your approve hands it on
  - skill: implement
    where: { section: Current sprint, approved: plan }
```

`plan` posts its report on the task and waits for your reply; `approve` and tonight's run hands the task to `implement`, which finds the plan as its earlier report. While `implement`'s draft PR is open the task waits for review; once you merge it, move the task out of the section, and neither rule takes it again.

## Budget

Each provider gets a ceiling for the run on its long window (the week for Claude, the week or month for Codex; Cursor's usage shows in its dashboard only, so it runs on the fallback). The ceiling is the lowest of:

- `used + per_run`, when `per_run` is set;
- `1 - reserve` (default reserve 10%);
- pacing: `(1 - reserve) × elapsed / length`, an even spend from 0 at the window's start to `1 - reserve` at its reset. A run inside a window reads it at the next window's opening or at the reset, whichever comes first, since nobody else spends what piles up before then; a run outside every window reads it when it starts. Day 3 of 7 with a 10% reserve gives 38.6%. What a night leaves unused piles up for the next run.

A worker stops once the provider reports its long window past the ceiling or its short (5 h) window past the session limit. Claude reports quota during the run, so it stops mid-run; Codex is read after each run, so it stops between units. A provider whose quota can't be read gets a fixed `fallback` of units and turns per run.

The session limit depends on where the run started. Inside a window you're away, and it's `session_max` (default 90%). Outside every window, say an `awaywork run` by hand during the day, you're present: it's `present_session_max` (default 40%), and a provider whose quota can't be read sits the run out, since its fallback caps count runs and not your usage. The session limit reads the whole 5-hour window, your own sessions included, so a present run backs off when you've been busy. `plan` works out which one a run started now would get and says so above the providers.

## Routing

A rule's `provider` list, else the global `providers` order. The first provider under its ceiling takes the unit. When a window fills, the next unit goes to the next provider.

## The worker

Each unit runs in a fresh clone on a new branch cut from its base: the linked PR's branch, else the default branch. A PR from a fork is fetched from the repo's `refs/pull/<number>/head`, and the unit fails if that is no longer the head commit its source read. A branch name that's taken on the remote gets a `-2` to `-10` suffix, unless awaywork already tried there ([Branch names](./configuration.md#branch-names)). `setup` runs there once, before any agent, and every step of the unit's chain then works in that clone, on that branch.

- `.away/context/` holds the prefetched item: PR view, diff, unresolved threads and failed-check logs, or the issue or task with its comments.
- The skills go where the agent looks for them (`.agents/skills/` for Codex, a plugin for Claude Code and Cursor).
- The prompt is, in order: the fixed [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md), the skill, then your instructions (global, per repo, in-repo `.awaywork/instructions.md` unless someone else opened the PR, per rule).
- The agent has no forge token, no source's or other provider's secret, an empty `GH_CONFIG_DIR` with placeholder `GH_TOKEN` and `GH_ENTERPRISE_TOKEN`, an empty `TWG_CONFIG_DIR` and no other `TWG_` variable, no ssh agent, no system git config, and a global one with only your commit identity and git-lfs's filter ([Safety](./safety.md#what-the-agent-can-reach)). On a GitHub-hosted runner it runs as a user of its own, and so do setup and the checks ([Safety](./safety.md#a-worker-user-on-github-hosted-runners)).
- A turn cap bounds the run (200, or `fallback.turns` without a quota reading), `limits.unit_minutes` caps its wall-clock time when set (status `stopped: time`), and a watchdog stops it below 1.5 GB of free memory or 2 GB of disk, then kills every process it left behind. The same floors are checked before each unit: a machine that's short skips the unit with the reason (`disk below 2 GB`), and every later one while it stays short, spending no quota; the next scheduled run picks up once there's room.

## Delivery

| `deliver` | What happens |
| --- | --- |
| `draft_pr` | The default. The worker commits and writes `.away/out/pr.md` (first line the title), which a chain's later steps keep current. awaywork adds an `Awaywork: <run id>` trailer, pushes the new branch and opens one draft PR into that base. No `pr.md`, no publish. Never into someone else's PR or a PR from a fork: there a chain that could commit is skipped with the reason; a report still works. |
| `pr` | Opt-in per rule: the same as `draft_pr`, same bases and checks, but the PR opens ready for review, so it pings whoever a ready PR pings, code owners included. It still opens as a draft when one of the chain's steps failed or stopped or the run ended before one ran, or [asked questions](./workflows.md#questions) with `ask` in its status file, its [`verify`](./configuration.md#repos-and-instructions) failed, one of its [loops](./chains.md#loops) ended before its `until` held, or one of its [gates](./workflows.md#gates) fired, and the report says why. |
| `report` | No step commits. Each writes `.away/out/report.md`; nothing is pushed. A chain's reports, joined, go into the morning report. |
| `pending_review` | Opt-in per rule, only on a unit whose base is a PR, anyone's or a fork's. A `report` that also lands on that PR: when the chain ends, the last report and the line comments its step wrote to `.away/out/review.json` become your pending review, at the commit the clone read. Nobody else sees it until you submit it. When GitHub refuses the line comments, say one is off the PR's diff, they all go in the review's body. When a step failed or stopped or the run ended before one ran, or GitHub refuses the review anyway (you already have a pending review there, say), the report is delivered alone with the reason. GitHub only. |
| `plan` | Opt-in per rule. A `report` whose step also writes `.away/out/plan.yml`, the work split into tasks: when the chain ends, awaywork checks it and posts the report and the plan as one comment on your item, which waits for your approval there. See [Plans](./workflows.md#plans). |
| `push` | Opt-in per rule, only on a unit whose base is your own open PR. The worker commits and writes `.away/out/pr.md`, as for a PR; awaywork adds the trailer and pushes the chain's commits onto your PR's branch as a fast-forward, only while the PR is yours, open, in the repo, without auto-merge, and its head is still the commit the clone started from, and its branch isn't the default branch, protected, or the branch of someone else's open PR in the repo. The PR body isn't touched; `pr.md` goes into the morning report. No `pr.md`, no push. Under [`sync`](./chains.md#sync), the one commit is awaywork's own merge of the PR's base: no worker runs, unless the merge [conflicts](./chains.md#conflicts) and a worker resolves it without committing. |

Either way, a skill that defines verdicts also writes one word to `.away/out/verdict`, such as `approve`. The report shows it next to the unit's result, and a [loop](./chains.md#loops) can end on it.

The harness also asks every step for one word in `.away/out/status` when it stops: `done` when it finished, `ask` when it wrote [questions](./workflows.md#questions), `continue` when it made progress and needs [another run](./workflows.md#continue). `ask` and `continue` are the ones awaywork acts on; `done` only lets a draft it goes on with turn ready, and a step that writes no status file is read as it always was, from what it left.

A skill commits unless its metadata says it reports, as `review` and `plan` do; the rule's `deliver` says where the commits go, and a chain that committed nothing reports whatever its `deliver`. `pr`, `push`, `pending_review` and `plan` are never a skill's default. A PR's body gets its items' [`link`](./configuration.md#linking-prs) lines, and ends with a footer naming awaywork, the run and the unit's items, which is how the next plan recognises it and links it to them.
