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

An item is one open thing of yours a source returns: a PR, an issue, a task. Each comes with facts a rule can match:

- `type`: `pr`, `issue` or `task`; `title` and `description`.
- `approved`: the skill of the newest result awaywork posted on it that you approved, or that [went ahead](./workflows.md#posts-that-wait).
- `state`: `open`, or `merged` or `closed` for the [finished items](./configuration.md#finished-items) a rule asks for; `closed` is when it finished.
- `planned`: it's a [task](./workflows.md#tasks) of a plan you approved.
- The source's own fields:

| Source | Items | Fields |
| --- | --- | --- |
| GitHub | Open PRs you authored, PRs awaiting your review, issues assigned to you, plus any extra `search` (e.g. `label:awaywork`, `mentions:@me`), in the configured repos; your merged and closed ones too when a rule asks | `repo`, `label`, `author`, `trusted`, `mine`, `ours`, `draft`, `checks`, `unresolved_threads`, `my_unresolved_threads`, `files`, `changed_lines`, `conflicts`, `behind`, `review_requested`, `created`, `updated` |
| Asana | Incomplete tasks assigned to you in a workspace, optionally some projects; completed ones too when a rule asks | `project`, `section`, `blocked` (a dependency is incomplete), `tags`, `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated`, `due` |
| Linear | Issues assigned to you that are neither completed nor canceled; completed and canceled ones too when a rule asks | `team` (key), `status` (the workflow state), `labels`, `priority` (e.g. `High`), `blocked` (an open blocker), `project`, `repo` (from `repo_map`), `created`, `updated` |
| Jira Cloud | Unresolved issues assigned to you, optionally narrowed by `jql`; resolved ones too when a rule asks | `project` (key), `status`, `labels`, `priority`, `blocked` (an open "is blocked by" link), `issuetype` (e.g. `Bug`), `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated` |
| Routines | One task per [routine](./configuration.md#routines) in your config: its latest occurrence | `name`, `repo`, `created`, `updated` (both the occurrence) |

GitHub's fields that need a word:

- `trusted`: the author is an owner, member or collaborator. `mine`: a PR you authored or an issue assigned to you. `ours`: awaywork opened it.
- `checks`: `failing`, `pending` or `passing`.
- `unresolved_threads`: those [shown to the agent](./safety.md#public-repos). `my_unresolved_threads`: the unresolved ones you started.
- `files`: the paths the PR touches, the first 500; test with `matches`. `changed_lines`: additions plus deletions.
- `conflicts`: it doesn't merge cleanly into its base; unset while GitHub is still working that out.
- `behind`: commits on its base its branch doesn't have, on your own open PRs in the repo.

## The queue

The queue is an ordered list of rules. Each item takes the **first** rule it matches; an item that matches none is skipped. A rule names the `skill` that does the work.

```yaml
queue:
  - skill: fix
    where: { type: pr, mine: true, checks: failing }
  - skill: implement
    where: { type: issue, label: awaywork }
```

The label isn't enough on its own: the GitHub source reads only the issues assigned to you, so a labelled issue nobody assigned to you plans nothing. Within a rule, items come in the source's order (GitHub: newest first) unless the rule sets `order`.

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

The section and status names are guesses. The [`/away` setup](./away.md#set-up) replaces them with your tracker's real ones and writes the queue out so you can edit it.

## Units

A unit is one piece of work on one feature: the items that share a key or a linked PR (repo and branch), ranked at its best item's rule. An Asana task linked to your PR becomes one unit with that PR.

An awaywork PR is linked to the items its footer names. One you wrote is linked by the key in its branch or title, or the source's [`link`](./configuration.md#linking-prs) line in its body.

- The unit works in its linked PR's repo, else the item's `repo` field; with neither it is skipped.
- Units run one at a time, in queue order. A unit is a chain: the rule's skill, then its [`then`](./chains.md#then) steps, one after the other in one clone, publishing once when the chain ends. A [loop](./chains.md#loops) repeats steps, and a step with a [`when`](./chains.md#when) runs only when its condition holds.
- A chain's first step on an item gets the item's latest report in `.away/context/previous/report.md` (the last one of the latest chain on it that left a report), and the prompt says it is from an earlier run. That is how an approved `implement` finds the plan, on a retry too: a failed `implement` that wrote no report doesn't replace the plan. Later steps get the step before.
- A PR stacks only on the awaywork PR a rule took up, or on the PR of the [task](./workflows.md#the-feature-block) it waits on. Its body names the PR to merge first, and on a repo with GitHub's [stacked PRs](https://gh.io/stacks) awaywork links the two into a stack. Every other PR starts from the default branch or your PR's branch, so you can merge, park or close each one on its own.
- Optional [caps](./configuration.md#windows-limits-and-budget) limit the units per run, per repo and per rule; a chain counts once.

### Skipped units

A unit that makes no work this run is skipped, with the reason in `awaywork plan`:

- **Waiting for review:** it links an open awaywork PR. awaywork doesn't add to work you haven't read from an earlier run.
  - An awaywork PR only matches rules whose `where` names `ours`, like the default `fix` on threads you left on it. That rule then takes the unit, even over a better-ranked item linked to the PR, and its draft PR stacks on the awaywork PR.
  - A GitHub issue's draft PR into the default branch says `Closes` it, which links the two, so the issue waits for review while that draft is open.
  - A draft awaywork left for a later run, whose footer says the agent goes on there, doesn't wait: the unit [continues](./workflows.md#continue) on it.
  - A PR awaywork pushed onto (a `deliver: push` rule) waits too, while its head is still the commit awaywork pushed, kept in the state dir, so not on a runner. Not after a [`sync`](./chains.md#sync)'s clean merge: it holds nothing for you to review.
- **Waiting for your answer:** the item's newest comment is awaywork's [questions](./workflows.md#questions), until someone replies on it.
- **Waiting for your approval:** a `deliver: plan` rule took it and awaywork's [plan](./workflows.md#plans) on it waits for your reply. Your feedback plans it again; your approval [fans it out](./workflows.md#tasks) into its tasks. A report rule's result that [waits](./workflows.md#posts-that-wait) holds its rule the same way, and once you approved it the next rule takes the item.
- **Unchanged since run `<id>`:** none of its items changed since a worker last finished the same skill on it, unless it said [`continue`](./workflows.md#continue), so a review or a unit that gave up isn't redone every run. "Changed" is the item's `updated` time, and for a [`sync`](./chains.md#sync) its base's head too.
- **Gave up after 3 attempts; next try on `<date>`:** its chain didn't finish 3 runs in a row (a failure, an error, a `unit_minutes` timeout, commits left unpushed). The next try is a week after the last one, even if its items changed in between, so a Sentry error that keeps firing doesn't get a fresh try every night. That try is one try: fail again and it waits another week.
- **Skipped by you:** `awaywork skip <source:key>` (e.g. `github:acme/api#5`) leaves an item, and any unit it joins, alone until `awaywork unskip` or the `--until` date. `plan --skipped skipped_by_you` lists it with the `--reason`. Skips live in `~/.local/state/awaywork/skips.json`.

How attempts count:

- A unit's chain is one attempt, finished when every step that ran was done and no publish left anything behind; commits left unpushed retry.
- A plan report followed by a failed implement is one failure. A finished attempt clears the count, and matching another skill starts a new one.
- Skipped, dry-run and aborted units don't count. Neither does a stop the item didn't cause (quota, session limit, window end) or may not have (a watchdog stop for low memory or disk): it tries again next run.
- Attempts live in `~/.local/state/awaywork/attempts.json`.

A unit you pick with `run --unit` runs anyway, unchanged, skipped by you or given up; a given-up one runs as its one try.

## Budget

Each provider gets a ceiling for the run on its long window: the week for Claude, the week or month for Codex. Cursor's usage shows in its dashboard only, so it runs on the fallback. The ceiling is the lowest of:

- `used + per_run`, when `per_run` is set;
- `1 - reserve` (default reserve 10%);
- pacing: `(1 - reserve) × elapsed / length`, an even spend from 0 at the window's start to `1 - reserve` at its reset. Day 3 of 7 with a 10% reserve gives 38.6%. What a night leaves unused piles up for the next run.

A run inside a window reads pacing at the next window's opening or at the reset, whichever comes first, since nobody else spends what piles up before then. A run outside every window reads it when it starts.

A worker stops once the provider reports its long window past the ceiling or its short (5 h) window past the session limit. Claude reports quota during the run, so it stops mid-run; Codex is read after each run, so it stops between units. A provider whose quota can't be read gets a fixed `fallback` of units and turns per run.

The session limit depends on where the run started:

- Inside a window you're away: `session_max` (default 90%).
- Outside every window, say an `awaywork run` by hand during the day, you're present: `present_session_max` (default 40%). A provider whose quota can't be read sits the run out, since its fallback caps count runs and not your usage.

The session limit reads the whole 5-hour window, your own sessions included, so a present run backs off when you've been busy. `plan` works out which one a run started now would get and says so above the providers.

## Routing

A rule's `provider` list, else the global `providers` order. The first provider under its ceiling takes the unit. When a window fills, the next unit goes to the next provider.

## The worker

Each unit runs in a fresh clone on a new branch cut from its base: the linked PR's branch, else the default branch. `setup` runs there once, before any agent, and every step of the unit's chain then works in that clone, on that branch.

- A PR from a fork is fetched from the repo's `refs/pull/<number>/head`, and the unit fails if that is no longer the head commit its source read.
- A branch name that's taken on the remote gets a `-2` to `-10` suffix, unless awaywork already tried there ([Branch names](./configuration.md#branch-names)).
- `.away/context/` holds the prefetched item: PR view, diff, unresolved threads and failed-check logs, or the issue or task with its comments.
- The skills go where the agent looks for them (`.agents/skills/` for Codex, a plugin for Claude Code and Cursor).
- The prompt is, in order: the fixed [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md), the skill, then your instructions (global, per repo, in-repo `.awaywork/instructions.md` unless someone else opened the PR, per rule).
- The agent has no forge token and no source's or other provider's secret. It gets an empty `GH_CONFIG_DIR` with placeholder `GH_TOKEN` and `GH_ENTERPRISE_TOKEN`, an empty `TWG_CONFIG_DIR` and no other `TWG_` variable, no ssh agent, no system git config, and a global one with only your commit identity and git-lfs's filter ([Safety](./safety.md#what-the-agent-can-reach)).
- On a GitHub-hosted runner it runs as a user of its own, and so do setup and the checks ([Safety](./safety.md#a-worker-user-on-github-hosted-runners)).
- A turn cap bounds the run: 200, or `fallback.turns` without a quota reading. `limits.unit_minutes` caps its wall-clock time when set (status `stopped: time`).
- A watchdog stops it below 1.5 GB of free memory or 2 GB of disk, then kills every process it left behind. The same floors are checked before each unit: a machine that's short skips the unit with the reason (`disk below 2 GB`), and every later one while it stays short, spending no quota. The next scheduled run picks up once there's room.

## Delivery

A rule's `deliver` says what its unit leaves:

| `deliver` | Leaves |
| --- | --- |
| `draft_pr` | A draft PR. The default |
| `pr` | A PR ready for review. Opt-in |
| `report` | A report in the morning report; nothing pushed |
| `pending_review` | Your pending review on the PR it worked on. Opt-in, GitHub only |
| `plan` | A plan posted on your item, waiting for your approval. Opt-in |
| `push` | Commits fast-forwarded onto your own PR. Opt-in |

- **`draft_pr`:** the worker commits and writes `.away/out/pr.md` (first line the title), which a chain's later steps keep current. awaywork adds an `Awaywork: <run id>` trailer, pushes the new branch and opens one draft PR into that base. No `pr.md`, no publish. Never into someone else's PR or a PR from a fork: there a chain that could commit is skipped with the reason; a report still works.
- **`pr`:** the same as `draft_pr`, same bases and checks, but the PR opens ready for review, so it pings whoever a ready PR pings, code owners included.

  It still opens as a draft, the report saying why, when one of the chain's steps failed or stopped or the run ended before one ran, it [asked questions](./workflows.md#questions) with `ask` in its status file, its [`verify`](./configuration.md#repos-and-instructions) failed, one of its [loops](./chains.md#loops) ended before its `until` held, or one of its [gates](./workflows.md#gates) fired.

- **`report`:** no step commits. Each writes `.away/out/report.md`; nothing is pushed. A chain's reports, joined, go into the morning report.
- **`pending_review`:** only on a unit whose base is a PR, anyone's or a fork's. A `report` that also lands on that PR: when the chain ends, the last report and the line comments its step wrote to `.away/out/review.json` become your pending review, at the commit the clone read. Nobody else sees it until you submit it.
  - When GitHub refuses the line comments, say one is off the PR's diff, they all go in the review's body.
  - When a step failed or stopped or the run ended before one ran, or GitHub refuses the review anyway (you already have a pending review there, say), the report is delivered alone with the reason.
- **`plan`:** a `report` whose step also writes `.away/out/plan.yml`, the work split into tasks. When the chain ends, awaywork checks it and posts the report and the plan as one comment on your item, which waits for your approval there. See [Plans](./workflows.md#plans).
- **`push`:** only on a unit whose base is your own open PR. The worker commits and writes `.away/out/pr.md`, as for a PR; awaywork adds the trailer and pushes the chain's commits onto your PR's branch as a fast-forward. The PR body isn't touched; `pr.md` goes into the morning report. No `pr.md`, no push.
  - It pushes only while the PR is yours, open, in the repo, without auto-merge, and its head is still the commit the clone started from, and its branch isn't the default branch, protected, or the branch of someone else's open PR in the repo.
  - Under [`sync`](./chains.md#sync), the one commit is awaywork's own merge of the PR's base: no worker runs, unless the merge [conflicts](./chains.md#conflicts) and a worker resolves it without committing.

A skill commits unless its metadata says it reports, as `review` and `plan` do; the rule's `deliver` says where the commits go, and a chain that committed nothing reports whatever its `deliver`. `pr`, `push`, `pending_review` and `plan` are never a skill's default.

A PR's body gets its items' [`link`](./configuration.md#linking-prs) lines, and ends with a footer naming awaywork, the run and the unit's items, which is how the next plan recognises it and links it to them.

Either way, a skill that defines verdicts also writes one word to `.away/out/verdict`, such as `approve`. The report shows it next to the unit's result, and a [loop](./chains.md#loops) can end on it.

The harness also asks every step for one word in `.away/out/status` when it stops: `done` when it finished, `ask` when it wrote [questions](./workflows.md#questions), `continue` when it made progress and needs [another run](./workflows.md#continue). awaywork acts on `ask` and `continue`. `done` only lets a draft it goes on with turn ready, and a step that writes no status file is read as it always was, from what it left.
