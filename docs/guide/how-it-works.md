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

A source returns your open items with facts about each: a `type` (`pr`, `issue`, `task`), a `title` and `description`, `approved` (the skill of the newest result awaywork posted on it that you approved, or that [went ahead](#posts-that-wait)), `state` (`open`, or `merged` or `closed` for the [finished items](./configuration.md#finished-items) a rule asks for), `closed` (when it finished) and `planned` (a [task](#tasks) of a plan you approved), and source fields.

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
- A unit that links an open awaywork PR is skipped as **waiting for review**: awaywork doesn't add to work you haven't read from an earlier run. An awaywork PR only matches rules whose `where` names `ours`, like the default `fix` on threads you left on it: that rule then takes the unit, even over a better-ranked item linked to the PR, and its draft PR stacks on the awaywork PR. A GitHub issue's draft PR into the default branch says `Closes` it, which links the two, so the issue is skipped as waiting for review while that draft is open. Except for a draft awaywork left for a later run, whose footer says the agent goes on there: the unit [continues](#continue) on it.
- A PR awaywork pushed onto (a `deliver: push` rule) is skipped as **waiting for review** too, while its head is still the commit awaywork pushed (kept in the state dir, so not on a runner). Not after a [`sync`](./chains.md#sync)'s clean merge: it holds nothing for you to review.
- A unit whose item's newest comment is awaywork's [questions](#questions) is skipped as **waiting for your answer**, until someone replies on the item.
- A unit a `deliver: plan` rule took waits on awaywork's [plan](#plans) on its item: skipped as **waiting for your approval** until you reply, planned again on your feedback, and [fanned out](#tasks) into its tasks once you approved it. A report rule's result that [waits](#posts-that-wait) holds its rule the same way, and once you approved it the next rule takes the item.
- A unit none of whose items changed since a worker last finished the same skill on it is skipped as **unchanged since run `<id>`**, unless it said [`continue`](#continue), so a review or a unit that gave up isn't redone every run. A unit's chain counts as one attempt, finished when every step that ran was done and no publish left anything behind; commits left unpushed retry. "Changed" is the item's `updated` time, and for a [`sync`](./chains.md#sync) its base's head too; attempts live in `~/.local/state/awaywork/attempts.json`, and a unit picked with `run --unit` isn't skipped.
- A unit whose chain didn't finish 3 runs in a row (a failure, an error, a `unit_minutes` timeout, commits left unpushed) is skipped as **gave up after 3 attempts; next try on `<date>`**, a week after the last one, even if its items changed in between: a Sentry error that keeps firing doesn't get a fresh try every night. That week-later try is one try: fail again and it waits another week. A plan report followed by a failed implement is one failure; a finished attempt clears the count, matching another skill starts a new one, and skipped, dry-run and aborted units don't count. Neither does a stop the item didn't cause (quota, session limit, window end) or may not have (a watchdog stop for low memory or disk): it tries again next run. `run --unit` runs it anyway, as its one try.
- `awaywork skip <source:key>` (e.g. `github:acme/api#5`) leaves an item, and any unit it joins, alone until `awaywork unskip` or the `--until` date; `plan --skipped skipped_by_you` lists it with the `--reason`. Skips live in `~/.local/state/awaywork/skips.json`, and `run --unit` runs the item anyway.
- A chain's first step on an item gets the item's latest report in `.away/context/previous/report.md` (the last one of the latest chain on it that left a report), and the prompt says it is from an earlier run. That is how an approved `implement` finds the plan, on a retry too: a failed `implement` that wrote no report doesn't replace the plan. Later steps get the step before, as always.
- Units run one at a time, in queue order. A unit is a chain: the rule's skill, then its [`then`](./chains.md#then) steps, one after the other in one clone, publishing once when the chain ends. A [loop](./chains.md#loops) repeats steps, and a step with a [`when`](./chains.md#when) runs only when its condition holds.
- A PR stacks only on the awaywork PR a rule took up, or on the PR of the [task](#the-feature-block) it waits on. Its body names the PR to merge first, and on a repo with GitHub's [stacked PRs](https://gh.io/stacks) awaywork links the two into a stack. Every other PR starts from the default branch or your PR's branch, so you can merge, park or close each one on its own.
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
| `pr` | Opt-in per rule: the same as `draft_pr`, same bases and checks, but the PR opens ready for review, so it pings whoever a ready PR pings, code owners included. It still opens as a draft when one of the chain's steps failed or stopped or the run ended before one ran, or [asked questions](#questions) with `ask` in its status file, its [`verify`](./configuration.md#repos-and-instructions) failed, one of its [loops](./chains.md#loops) ended before its `until` held, or one of its [gates](./configuration.md#gates) fired, and the report says why. |
| `report` | No step commits. Each writes `.away/out/report.md`; nothing is pushed. A chain's reports, joined, go into the morning report. |
| `pending_review` | Opt-in per rule, only on a unit whose base is a PR, anyone's or a fork's. A `report` that also lands on that PR: when the chain ends, the last report and the line comments its step wrote to `.away/out/review.json` become your pending review, at the commit the clone read. Nobody else sees it until you submit it. When GitHub refuses the line comments, say one is off the PR's diff, they all go in the review's body. When a step failed or stopped or the run ended before one ran, or GitHub refuses the review anyway (you already have a pending review there, say), the report is delivered alone with the reason. GitHub only. |
| `plan` | Opt-in per rule. A `report` whose step also writes `.away/out/plan.yml`, the work split into tasks: when the chain ends, awaywork checks it and posts the report and the plan as one comment on your item, which waits for your approval there. See [Plans](#plans). |
| `push` | Opt-in per rule, only on a unit whose base is your own open PR. The worker commits and writes `.away/out/pr.md`, as for a PR; awaywork adds the trailer and pushes the chain's commits onto your PR's branch as a fast-forward, only while the PR is yours, open, in the repo, without auto-merge, and its head is still the commit the clone started from, and its branch isn't the default branch, protected, or the branch of someone else's open PR in the repo. The PR body isn't touched; `pr.md` goes into the morning report. No `pr.md`, no push. Under [`sync`](./chains.md#sync), the one commit is awaywork's own merge of the PR's base: no worker runs, unless the merge [conflicts](./chains.md#conflicts) and a worker resolves it without committing. |

Either way, a skill that defines verdicts also writes one word to `.away/out/verdict`, such as `approve`. The report shows it next to the unit's result, and a [loop](./chains.md#loops) can end on it.

The harness also asks every step for one word in `.away/out/status` when it stops: `done` when it finished, `ask` when it wrote [questions](#questions), `continue` when it made progress and needs [another run](#continue). `ask` and `continue` are the ones awaywork acts on; `done` only lets a draft it goes on with turn ready, and a step that writes no status file is read as it always was, from what it left.

A skill commits unless its metadata says it reports, as `review` and `plan` do; the rule's `deliver` says where the commits go, and a chain that committed nothing reports whatever its `deliver`. `pr`, `push`, `pending_review` and `plan` are never a skill's default. A PR's body gets its items' [`link`](./configuration.md#linking-prs) lines, and ends with a footer naming awaywork, the run and the unit's items, which is how the next plan recognises it and links it to them.

## Questions

A step that can't go on without a person's answer writes its questions to `.away/out/questions.md` and `ask` to `.away/out/status`, like `implement` on an issue too vague to build. The chain ends there, and awaywork posts them as one comment on the unit's item from the rule's own tracker, the one [`on_done`](./configuration.md#on-done) would move, when that item is yours: your PR, an issue assigned to you, a tracker item. The model writes the questions; awaywork adds the last two paragraphs. On GitHub it shows up as you:

```
andrea commented

Before I write code for "Add rate limits":

1. Per user or per API key? The issue says "per client", and src/auth.ts has both.
2. Should a burst over the limit get a 429, or wait for the bucket to refill?

Reply here to answer: awaywork's next run takes this up again with your reply.

— awaywork
```

- While that comment is the item's newest, the unit is skipped as **waiting for your answer**, under Needs you in `awaywork plan`. awaywork reads that off the item, not the state dir, so a fresh runner waits too, and its own comment bumping the item's `updated` time doesn't count as a change.

  ```
  Needs you 1
    acme/api
      #5  Add rate limits  answer question
  ```

- Any comment after it that the agent would see ends the wait: yours, or a teammate's. On GitHub that's an owner, member or collaborator of the repo; a tracker shows every comment on an item assigned to you. Bots don't count (GitHub's bots, Jira's apps, Linear's apps and integrations): a coverage report or an automation's comment after the questions shows in `item.md` but leaves the unit waiting. Asana and custom sources don't mark bots, so there an integration's comment ends the wait too. The next run takes the unit with the same rule, and `item.md` shows awaywork's comment headed `awaywork's questions`, the replies after it. On a rule with [`run: soon`](./configuration.md#run-soon) that's within minutes of your reply, not at the next window. A step that still can't go on asks again.
- It counts as awaywork's only when its `— awaywork` line comes from your own account, so a stranger pasting one doesn't hold your item ([Safety](./safety.md#what-awaywork-publishes)).
- On an item that isn't yours, a source that can't write (Bitbucket, a custom source without `write`) on a rule without a [thread](#threads), or a post that fails, the questions stay in the morning report with the reason, and the unit is still done. Either way the unit's result reads `asked questions`, the report lists them under Questions, and `awaywork run` prints `questions posted on <url>` under the unit, linking the comment itself on GitHub and the item elsewhere:

  ```text
    1  api#5  implement  done, 3 turns  asked questions
       Add rate limits
       questions posted on https://github.com/acme/api/issues/5#issuecomment-2417736801
  ```

- A step that committed and wrote `ask` asks too. Its commits open as a draft (`draft: asked questions` in the report), headed by a status line for you, with `status=ask` in the footer:

  ```text
  Add rate limits

  Status: ask, questions on https://github.com/acme/api/issues/5

  ---

  Token bucket per API key, in src/auth.ts. …

  ---
  <!-- awaywork run=20261026-220012 item=github:acme%2Fapi%235 status=ask -->
  Opened by awaywork (run `20261026-220012`): a coding agent worked on this unattended. Review it like any other contribution.
  ```

  The footer is where awaywork keeps the status: the agent could write a `Status:` line of its own, but not after the footer.

  Under `push` they're pushed onto your PR, and it asks the same. Once someone answers, the next run goes on with that draft, as for [`continue`](#continue), `run: soon` included.

- Without a status file, awaywork guesses as it always did: a step that committed went on, so its `questions.md` is left in its `out/` and nothing is posted. A word other than `done`, `ask` or `continue`, or `ask` without `questions.md`, reads as no file, with a line in the run's log saying so. A chain that asked doesn't run its rule's [`on_done`](./configuration.md#on-done).

## Continue

Work too big for one run doesn't have to be squeezed into one. A step that commits what's solid and writes `continue` to `.away/out/status` says so: progress made, run me again. The chain stops there, so a review or a fix doesn't run on half-done work, and publishes what it has. Under `draft_pr` or `pr`, its commits open as a draft (`draft: the agent will continue` in the report), headed by awaywork's status line and counted in the footer:

```text
Export screen

Status: continue (1 of 3): awaywork's next window run goes on here

Gates: none fired (schema)

---

Done.

…

---
<!-- awaywork run=20261026-232730 item=github:acme%2Fapi%231%2Fapp status=continue continued=1 head=1f8a2313462c9a1f49af169ae1822d14c8adcde3 from=16548667d8e02a7a03e25135ff6054b195de8e51 -->
Opened by awaywork (run `20261026-232730`): a coding agent worked on this unattended. Review it like any other contribution.
```

The footer is where awaywork reads it back, never the state dir, so a fresh runner goes on too: the status, the times the unit said `continue`, the head it pushed and the commit the draft's own commits start after. The visible line is for you. The rule:

> A `continue` goes on in the next run that would take the item anyway: a window run, a scheduled one or a manual `awaywork run`, never `run: soon`. It goes on only where awaywork can fast-forward its own GitHub draft: its head unchanged since awaywork left it, the PR opened by you and its body last edited by you, under 3 continues. Otherwise the draft is yours, with a "finish by hand" note. A draft that [asked](#questions) goes on the same way once someone answers, `run: soon` included, as any item change.

Going on, the unit clones the draft's branch, its prompt says so, and `.away/context/previous/report.md` holds the last report, the draft's body when no run of it is kept on the machine. Its commits are fast-forwarded onto the draft, no new PR and no suffixed branch, and the new `pr.md` replaces its title and body:

```text
Units 2
     item            rule     skill                 provider  deliver  title
  1  acme/api#1/app  #2 soon  implement (built-in)  claude    pr       Export screen
     in acme/web
     goes on with its draft https://github.com/acme/web/pull/13, which said continue (1 of 3)
```

Once the agent says `done`, or writes no status file, and `verify`, the gates and the loops pass on every commit of the draft, a `deliver: pr` draft is marked ready for review; under `draft_pr` it stays a draft, its status line gone. The agent's word can only hold a PR back:

```text
| 1 | [acme/api#1/app Export screen](https://github.com/acme/api/issues/1) | implement → loop(review ⇄ fix) | claude | done, 2 turns (loop: 1 round of review ⇄ fix; until held: verdict approve) | https://github.com/acme/web/pull/13 (1 commit, ready for review), verdict approve |
```

When awaywork won't go on, the run's report says `<why>: finish <PR> by hand`, the draft opens without the status line, and questions it asked stay in the report. A chain that committed nothing has no draft, so its questions are posted. The next plan skips the unit with the same why:

```text
Needs you 1
  acme/web
    #7  Export screen  finish by hand
        awaywork's draft says continue, but it moved from 1f8a231,…
```

The whys are `awaywork goes on with its own draft on GitHub only`, `someone else opened or edited it last`, `it moved from <sha>, where awaywork left it` and `it continued 3 times`. The footer still holds the draft's [dependents](#tasks) back. Mark it ready to take it over: a ready PR, or a draft without a status in its footer, waits for your review like any awaywork PR. A `run: soon` run skips a `continue` as `goes on from <PR> in the next window run`.

- **A report** that says `continue` posts its result where a result goes, a [report task](#report-tasks)'s or `on_done: { comment: result }`'s, with `Status: continue (1 of 3)`, and runs again from it, its report reaching the next run as `previous/report.md`, up to the same cap. Clear a capped report's count with `awaywork skip`, or by deleting awaywork's `continue` results on the item. Otherwise it only reports.
- A `continue` with nowhere to keep its count, a committing step with no commits on a new branch or a `push`, `pending_review` or `plan` rule, reads as no status file, with a line in the run's log.
- A chain that says `continue` doesn't run its rule's `on_done` move: the unit isn't done.

## Plans

A feature that spans a few PRs doesn't fit in one unit, and a hand-written list of cards is the chore you wanted gone. Give the feature's card a rule with `deliver: plan`, and its step splits the work into tasks instead of starting on it:

```yaml
queue:
  - skill: plan
    where: { label: awaywork-feature }
    deliver: plan
    on_done: { move: Plan review }
  - skill: implement
    where: { planned: true }
    deliver: pr
```

The second rule takes the plan's [tasks](#tasks) once you approve it. Every step of the plan rule reports, as under `report`, and the prompt asks for `.away/out/plan.yml` too: `tasks:`, at most `limits.plan_tasks` of them (8 by default), each with an `id` (lowercase letters, digits and dashes), a `title`, and optionally a `description`, a `skill` (one a `planned` rule takes, `implement` when unset), a `repo` (the card's when unset, or another the config names, see [Across repos](#across-repos)), `ships`, the files its PR will hold that tasks in other repos need, and `after`, which maps other task ids to `merged`, `opened` (see [The feature block](#the-feature-block)) or the name of a check on that task's PR (see [Waiting on a check](#waiting-on-a-check)), the `opened` and check ones of a task in its repo on one chain. Next to `tasks:`, an optional `contract:` names one file the step wrote under `.away/out/`, an OpenAPI diff or a schema the tasks share, which awaywork posts with the plan. The prompt lists the skills the `planned` rules take, marking `(reports)` the ones whose rule opens no PR: a skill whose metadata reports, like `review`, or a chain whose steps all report. Those make [report tasks](#report-tasks), which nothing can wait on. The built-in `plan` skill writes it; any skill can. awaywork checks it in plain code, outside the model (ids unique and not [retired](#tasks), under the cap, every skill taken by a `planned` rule, no `after` naming a report task, every repo one the config names, `ships` paths inside the repo, every `after` naming another task, no cycles, a task's `opened` and check tasks in its repo on one chain, a `contract` under `.away/out/`, no key it doesn't know), then posts the report, the contract and the file as one comment on your item, the one [questions](#questions) would go to. The model writes the report and the file; awaywork adds the fence, a [contract](#across-repos)'s heading and fence when there's one, and the last two paragraphs:

````
VAT export lands in two PRs: the endpoint first, then the button that calls it.

- `api`: `GET /exports/vat` in `src/routes/exports.ts`, paged like `/exports/sales`, with a test next to `sales.test.ts`.
- `web`: an Export button on the reports page, behind the `vat_export` flag; it waits for the endpoint to merge.

Open question: should the export include voided invoices? I left them out.

```yaml
tasks:
  - id: api
    title: VAT export endpoint
    description: Add GET /exports/vat to src/routes/exports.ts, paged like /exports/sales.
  - id: web
    title: Export button
    description: Add an Export button to the reports page behind the vat_export flag.
    after: { api: merged }
```

To approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.

— awaywork

````

The run says where it went, and the rule's [`on_done`](./configuration.md#on-done) fires once it's posted:

```text
  1  ENG-2101  plan   done    report
     VAT export lands in two PRs: the endpoint first, then the button that calls it.
     plan posted on https://acme.atlassian.net/browse/ENG-2101, tasks api, web
     on_done moved ENG-2101 to "Plan review"
```

- Until you answer, the card is skipped as **waiting for your approval**, under Needs you:

  ```
  Needs you 1
    tracker ENG
      ENG-2101  Export VAT report  approve
                plan
  ```

- **Approve** with a reply from your own account whose first line is `approve`, in any case; the lines below it are notes for the tasks. `awaywork approve <source:key> [notes]`, or `a` in the report, posts that reply for you, marked like every comment awaywork writes, through the same ownership check, and refuses a plan you already answered:

  ```text
  $ awaywork approve tracker:ENG-2101 Leave voided invoices out.
  plan approved: replied approve, with your notes, on https://acme.atlassian.net/browse/ENG-2101
  ```

  The next run [fans it out](#tasks).

- **Anything else of yours is feedback:** your reply that doesn't start with a bare `approve` (`approve if web waits` included). Your reply changed the card, so the next run plans again with the whole thread in `item.md`, the plan headed `awaywork's plan`, and posts a new plan, which waits for a fresh approval whatever `wait` says. A re-plan that isn't posted is skipped as unchanged until the card changes again.
- **Only you answer.** A plan's answer is your first reply after it, read off the card: a teammate's comment, a code owner's or a bot's is context in `item.md`, never an answer, and a later comment of yours changes nothing. Edit your reply to change your mind before the next run reads it; a reply someone else edited isn't yours anymore.
- **`wait: false`** posts the plan and goes on: the post says so on its mark line (`— awaywork · went ahead`) and that a reply to it changes nothing, counts as its own answer, and the next run fans it out with no notes. Its [gates](./configuration.md#gates-of-a-rules-own) still run, and one that fires makes it wait, its decision card on top of the plan.
- The plan is read off the card on every run, never the state dir: it's awaywork's newest plan comment, so a fresh runner waits too. Edit it to fix a task and the next run checks your edit again; an edit that breaks it skips the card as **plan refused** with the reason, under Needs you, instead of planning over your edit. A plan comment someone else edited isn't awaywork's anymore ([Safety](./safety.md#what-awaywork-publishes)), so the card has no plan and gets a new one. GitHub reads the card's whole thread, past its last 50 comments, so an old plan up a long thread still counts.
- A plan that fails its checks, in the file or as the next run reads it back from the comment, a missing `plan.yml` or contract, or a comment over 30 KB, the contract included (a [lean](#files-that-come-back) one pins them instead), is never posted: the reason stays in the morning report, as `plan not posted: plan.yml: task id "api" is used twice`, and `on_done` doesn't fire. Same for an item that isn't yours, a source that can't write on a rule without a [thread](#threads), or a post that fails. A step that asks [questions](#questions) instead posts those, and the card waits for your answer as usual.
- A `deliver: plan` rule that matches only merged or closed items, names a `source` that can't write without [`thread: github`](#threads), or has no rule whose `where` names `planned` to take its tasks, is a config error.

### Tasks

Approve the plan and it fans out. The card makes no unit of its own anymore: each task becomes a child item keyed `ENG-2101/api`, which goes down the queue like any item, on its own branch, `away/ENG-2101-api`, and opens its own PR. A task only matches rules whose top-level `where` names `planned`, and only the first of them whose `skill` is the task's; a rule naming `planned` takes nothing else. So caps, attempts, `skip`, gates and chains work on tasks as on anything else. Tasks without `after` run in parallel; `after` orders them, and a card's tasks run back to back, as one [block](#the-feature-block).

A task carries the card's source, URL, owner and fields, and the card's repo unless the plan names another, so `where: { planned: true, labels: backend }` works, and the card's whole thread. Its `item.md` is awaywork's own, the task first:

```markdown
# ENG-2101/api: VAT export endpoint

https://acme.atlassian.net/browse/ENG-2101

Add GET /exports/vat to src/routes/exports.ts, paged like /exports/sales.

## The plan

This is task `api` of the plan you approved on ENG-2101. Each task is its own item, with its own branch and PR. Its tasks:

- `api`: VAT export endpoint (this task)
- `web`: Export button, after api merged

Your notes on approving it:

Leave voided invoices out.

## The card: ENG-2101, Export VAT report

## Comments

### awaywork's plan (me), 2026-10-26T08:30:43.973Z
…
```

The run after `approve`, from `awaywork plan`:

```text
Units 1
     item          rule  skill                 provider  deliver  title
  1  ENG-2101/api  #2    implement (built-in)  fake      pr       VAT export endpoint

Skipped 2: 1 fanned_out, 1 waiting_for_task
```

```text
$ awaywork plan --skipped
Skipped 2: 1 fanned_out, 1 waiting_for_task
  ENG-2101: fanned out: api no PR yet, web waits for api
  ENG-2101/web: waiting for task api's PR to merge
```

Nothing about the feature lives in the state dir. Every run reads the plan off the card and each task's PR off the forge: the PR on the task's branch whose footer names the task, open, merged or closed. The card, run by run:

| What happened | The card | Its tasks |
| --- | --- | --- |
| You approved | `fanned out: api no PR yet, web waits for api` | `api` runs and opens its PR; `web` is skipped as `waiting for task api's PR to merge` |
| `api`'s PR is open | `fanned out: api PR open, web waits for api` | `api` waits for your review, under Needs you, like any awaywork PR |
| `api` said `continue` | `fanned out: api draft says continue, web waits for api` | the next window run [goes on](#continue) with `api`'s draft |
| `api` merged | `fanned out: api merged, web no PR yet` | `web` runs, cut from the default branch, which has `api` in it |
| `web`'s PR closed unmerged | plans again | none run until you approve the new plan |
| Every task done | `all tasks done: close or move the card`, under Needs you | none: each merged, or a [report task](#report-tasks) posted its `done` result |

The plan sticks to the card. Once awaywork's plan comment is on an open card of yours, the card goes to the `deliver: plan` rule it matches, else to the first one for its source whatever that rule's `where` says now, and no other rule takes it whole. `awaywork plan --rules` lists it under that rule, with `(plan)` after its key when the rule's `where` no longer holds it. So a `planned` rule's `on_done: { move: In Progress }` can move the card out of a plan rule on `status: To Do` and the remaining tasks still run, where a catch-all `implement` rule further down would otherwise pick the card up as one unit. It leaves the plan flow when it's closed or reassigned (who owns it is read every run), and `awaywork skip` on the card holds it and all its tasks. Someone else's edit to the card's only plan comment makes that comment not awaywork's, so the card goes back to ordinary matching. And with no `deliver: plan` rule left for its source, the card is matched like any other, so a catch-all may take it whole next to its open task PRs.

A task's PR links back to the card but never closes it, and its footer names only the task, so the card never links its tasks' PRs and isn't folded into one of them:

```markdown
VAT export endpoint

Adds `GET /exports/vat`, paged like `/exports/sales`, with a test.

Part of https://acme.atlassian.net/browse/ENG-2101

---
<!-- awaywork run=20261026-220012 item=tracker:ENG-2101%2Fapi -->
Opened by awaywork (run `20261026-220012`): a coding agent worked on this unattended. Review it like any other contribution.
```

- **Questions from a task** go on the card, headed `Questions from task api`, through the same ownership check as any write; `item.md` heads them `awaywork's questions from task api`. While any task's questions wait, the whole feature does: every task of the card is skipped as `waiting for your answer to task api's questions`. The first comment after them that's neither a bot's nor awaywork's answers them, so one reply under two tasks' questions answers both.
- **A task's PR is its result**: a task that opens one posts nothing else on the card. A [report task](#report-tasks) posts its report there instead.
- **Writes go to the card.** A `planned` rule's `on_done` moves the card, and a task never writes anywhere else. Whether the card is yours is read off it every run: reassign it and nothing fans out or writes (`plan approved, but the card isn't yours: its tasks don't run`).
- **A task PR closed without merging** after the plan was posted makes the card plan again. Its id is retired: the prompt names it and its PR, along with the tasks whose PR is open or merged, and a plan reusing a retired id isn't posted (`plan not posted: plan.yml: task id "web" is retired: its PR https://github.com/acme/api/pull/42 was closed without merging`). The new plan needs a fresh approval, even under `wait: false`, and no task runs until then; a task that keeps its id keeps its PR, merged or open. The card plans again though closing the PR didn't touch it.
- A task's branch is its name for good: when something else holds `away/ENG-2101-api`, the task is skipped with `delete it to run this task` rather than taking `-2`, which its PR lookup wouldn't find. A configured [`branch`](./configuration.md#branch-names) template renders from the task's key alone, so a re-plan that retitles a task keeps its PR: `{title}` or `{type}` in the template a `planned` rule uses, its own or the one it inherits, is a config error. A re-plan may also hand a task another skill, and so another `planned` rule, so every `planned` rule for a source sets the same `branch`, or none does.
- A task branch awaywork pushed whose PR then failed to open still reads `no PR yet` on the card and in `awaywork plan`, since the PR is the task's state. The run skips it, `away/ENG-2101-api exists on acme/api without a PR; delete it to run again`, in each morning report; delete the branch and the next run starts the task over.
- A task takes no approval of its own: the plan's covers it, so it has no `approved`, `awaywork approve tracker:ENG-2101/api` is refused, and a `planned` rule takes no `wait` or gates of its own.
- On [Bitbucket](./configuration.md#bitbucket-and-jira) it all works the same, through twg: a declined or superseded PR counts as closed unmerged, when it was last updated, and a stacked task's PR goes into the branch of the one below, since Bitbucket has no stacks. A task whose draft says `continue`, or asks, holds its dependents back as on GitHub, but it's yours to [finish](#continue).

### Report tasks

Not every task ends in a PR. QA evidence, a write-up, a prototype link: give the skill a `planned` rule that reports, and the plan can hand it a task.

```yaml
queue:
  - skill: plan
    where: { label: awaywork-feature }
    deliver: plan
  - skill: implement
    where: { planned: true }
    deliver: pr
  - skill: qa-evidence
    where: { planned: true }
    deliver: report
```

```yaml
tasks:
  - { id: app, title: Export screen }
  - { id: qa, title: QA evidence, skill: qa-evidence, after: { app: opened } }
```

The task runs like any other, `after` included, and its result is its report, posted on the card once its chain finished, the way [`on_done: { comment: result }`](./configuration.md#on-done) would, without being asked. `item.md` heads it `awaywork's result of task qa`. Like any comment of awaywork's it's no answer to anyone's questions, a plan's included, and it doesn't count as a change to the card:

```text
Result of task qa

Export screen: CSV downloads, 3 screenshots attached.

Status: done

— awaywork
```

- It's **done** once a `done` result for it is on the card, newer than your approval of the plan: `awaywork plan` skips it as `done: its result is on <card>`, and the card reads `qa done`. Until then it runs, a failed attempt counting like any unit's. A re-plan's new approval leaves older results behind, so its tasks report again.
- A `continue` result isn't done: the task [runs again](#continue).
- **Nothing can wait on it**: no PR to stack on, no check, no merge. A plan whose `after` names a report task isn't posted (`plan not posted: plan.yml: task web: after names qa, which reports: it opens no PR to stack on, check or merge`). It can wait on others, as `qa` waits for `app` to open above.
- A `planned` rule delivers `draft_pr`, `pr` or `report`; anything else is a config error.

### The feature block

`after` says what a task waits for:

- **`merged`**: run after run, until that task's PR merges. Then the task is cut from the default branch, which has it. One PR lands before the next one starts, each reviewed on its own.
- **`opened`**: only until that task's PR opens, which happens in the same run. The task's clone starts from that task's branch and its PR stacks on that task's PR, so the whole feature is up for review in the morning, as a stack. A task in [another repo](#across-repos) only waits.
- **a check's name**, like `Vercel Preview`: `opened`, plus that check passing on the PR, which takes a later run. See [Waiting on a check](#waiting-on-a-check).

The run that sees a card runs its tasks back to back, as one block: those that can run, in the order they wait on each other, before the next unit starts, wherever the first of them ranks in the queue. A task joins the block when every `merged` task it names has merged and every `opened` one has an open or merged PR, or runs earlier in the block. So a block stops only at `merged`, which needs you to merge something.

```yaml
tasks:
  - id: api
    title: VAT export endpoint
    description: Add GET /exports/vat to src/routes/exports.ts, paged like /exports/sales.
  - id: web
    title: Export button
    description: Add an Export button to the reports page behind the vat_export flag.
    after: { api: opened }
```

The run after `approve`, from `awaywork plan`:

```text
Units 2
     item          rule  skill                 provider  deliver  title
  1  ENG-2101/api  #2    implement (built-in)  fake      pr       VAT export endpoint
  2  ENG-2101/web  #2    implement (built-in)  fake      pr       Export button
     after api, stacks on its PR

Skipped 1: 1 fanned_out
```

`api` opens `away/ENG-2101-api`, then `web` is cloned from it, and its PR goes into `away/ENG-2101-api`, its body ending with `Stacked on <api's PR>: merge that first.` Once `api`'s PR is open, a later run stacks on it the same way, and `--why` names what the task waits on and where each stands:

```text
$ awaywork plan --why ENG-2101/web
tracker ENG-2101/web  Export button
  https://acme.atlassian.net/browse/ENG-2101
  task web of the plan on ENG-2101
  after api opened (PR #41 open)
  planned
    unit      1, eng-2101-web
    rule      #2 planned=true deliver=pr
    skill     implement (built-in)
    provider  fake
    deliver   pr
    branch    away/ENG-2101-web
    stack     after api, stacks on #41
```

When the task before opens no PR, because it failed, asked questions or committed nothing, the tasks stacked on it are skipped as `api opened no PR`. When it never got to run (its `setup` failed, Ctrl-C, the window's end, or `run --unit` naming only the task after it), they're skipped as `api didn't run`, and so are the tasks stacked on those, as `web didn't run`:

```text
Units 2
     item          skill      status           result
  1  ENG-2101/api  implement  failed, 3 turns  nothing
     VAT export endpoint
  2  ENG-2101/web  implement  skipped          api opened no PR
     Export button
```

The card, run by run:

| What happened | The card | Its tasks |
| --- | --- | --- |
| You approved | `fanned out: api no PR yet, web no PR yet` | `api` opens its PR, then `web` runs on `api`'s branch and opens its PR, stacked on `api`'s |
| `api` failed | `fanned out: api no PR yet, web no PR yet` | `web` is skipped as `api opened no PR`; both run again next run |
| `api` said `continue` | `fanned out: api draft says continue, web no PR yet` | `web` is skipped as `api left a draft that says continue`; the window run that finishes `api` runs `web` right after it, stacked on its PR. A check on `api`'s PR waits as `its draft says continue` |
| A cap cut the block after `api` | `fanned out: api PR open, web no PR yet` | the next run stacks `web` on `api`'s open PR: `after api, stacks on #41` |
| `api` merged before `web` ran | `fanned out: api merged, web no PR yet` | `web` is cut from the default branch |
| Both PRs are open | `fanned out: api PR open, web PR open` | both wait for your review |

- A task's `opened` tasks, its check ones too, lie on one chain, each after the one before, and it stacks on the last of them. With `api` after `{ schema: opened }`, `web` after `{ api: opened, schema: opened }` stacks on `api`, which holds `schema`. Once that PR merged, the task stacks on the first PR down the stack that hasn't: with `api`'s PR merged into `schema`'s branch, `web` after `{ api: opened }` stacks on `schema`, as `after api, stacks on schema's #10`, and it's cut from the default branch only once the whole stack merged. Two that aren't on one chain leave nowhere to stack, so the plan isn't posted: `task web: its opened tasks api, schema aren't on one chain: make each after the one before, e.g. schema after api: opened`.
- `merged` and `opened` mix on one task: `merged` says when it can start, `opened` where. `web` after `{ schema: merged, api: opened }` waits as `waiting for task schema's PR to merge`, and once it merged, stacks on `api`. `merged` means on the default branch: when `api` stacks on `schema` and merges into `schema`'s branch first, `web` after `{ api: merged }` waits as `waiting for task schema's PR to merge, api's merged into it`.
- A task waiting on an `opened` task that doesn't run this run (it's waiting for an answer, unchanged, gave up, left out by a cap) is skipped as `waiting for task api's PR to open`. Caps and the window's end can cut a block; the next run carries on from the task with no PR.
- A stacked task is a unit like any other, with its own clone, `setup` and branch. That clone starts on a branch a worker wrote, so `setup` gets none of the repo's `secrets`, as on any awaywork PR a rule takes up again ([Safety](./safety.md#what-the-agent-can-reach)). So a repo whose `setup` needs a secret, a private registry token for `pnpm install` say, can't use `opened`: every stacked task fails setup, run after run. Use `merged` there.
- Merge the stack bottom-up: once `api`'s PR merges and its branch is deleted, GitHub retargets `web`'s to the default branch; awaywork does nothing there. A squash merge leaves `web` carrying `api`'s commits: merging the default branch into it usually resolves cleanly, since the content is the same.

### Across repos

A feature rarely stays in one repo: the endpoint goes in `acme/backend`, the button that calls it in `acme/web`. A task's `repo` can be any repo the forge source's `repos` globs cover (`sources.github.repos`), or one named under [`repos`](./configuration.md#repos-and-instructions); unset, it's the card's. Anything else isn't posted: `task x: repo evil/x isn't the card's (acme/backend) or one the config names`. Case counts, since the repo's settings and caps go by its exact name: `task web: repo Acme/Web isn't acme/* as configured`. A card with no repo of its own needs a `repo` on every task.

The plan step can also write a contract, the interface the tasks agree on, and name it in `plan.yml`. A task can list the files its PR will hold that tasks in other repos need, like the spec a client is generated from:

```yaml
contract: .away/out/openapi.yaml
tasks:
  - id: api
    title: VAT export endpoint
    description: Add GET /exports/vat to src/routes/exports.ts, as the contract says.
    ships: [openapi.yaml]
  - id: web
    title: Export button
    description: Add an Export button to the reports page, on the client generated from openapi.yaml.
    repo: acme/web
    after: { api: opened }
```

The contract goes in the plan comment, in its own fence under a heading naming it, before `plan.yml`. The fence is longer than any run of backticks in the file, so a Markdown contract with its own fences survives:

````
VAT export spans two repos: the endpoint in acme/backend, then the button in acme/web.

### Contract: openapi.yaml

```yaml
openapi: 3.1.0
paths:
  /exports/vat:
    get:
      parameters:
        - { name: month, in: query, required: true, schema: { type: string } }
      responses:
        '200': { content: { text/csv: {} } }
```

```yaml
contract: .away/out/openapi.yaml
tasks:
…
```

To approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.

— awaywork
````

It's part of the plan, so you approve it with the rest: it counts toward the 30 KB unless the plan is [lean](#files-that-come-back), it must read back from the comment as the file it was, and your edits to it are checked again on every read. A contract the file names but the step didn't write isn't posted (`plan not posted: plan.yml: contract .away/out/openapi.yaml is missing or empty`), and an edit that drops it from the comment refuses the plan (`plan refused: contract .away/out/openapi.yaml isn't in the plan comment`). Every task finds it in `.away/context/<task>/contract/openapi.yaml`, next to its `item.md`, and its prompt says it was approved with the plan.

Each task is a unit in its own repo: the clone, `setup`, `secrets`, `test`, branch template, gates and `units_per_repo` are that repo's, and its PR opens there, `Part of` the card like any task's. Questions and `on_done` still go to the card, and the forge looks the task's PR up in the task's repo.

`opened` across repos only waits. There's no branch to stack on in another repo, so `web` is cut from `acme/web`'s default branch, and since that's a branch nobody's agent wrote, its `setup` gets the repo's `secrets`. It still joins the block once `api` opened its PR earlier in the run, and it's skipped as `api opened no PR` when `api` didn't. The run after `approve`, from `awaywork plan`:

```text
Units 2
     item          rule  skill                 provider  deliver  title
  1  ENG-2101/api  #2    implement (built-in)  fake      pr       VAT export endpoint
  2  ENG-2101/web  #2    implement (built-in)  fake      pr       Export button
     in acme/web
     waits for api's PR in acme/backend

Skipped 1: 1 fanned_out
```

```text
$ awaywork plan --why ENG-2101/web
tracker ENG-2101/web  Export button
  https://acme.atlassian.net/browse/ENG-2101
  task web of the plan on ENG-2101, in acme/web
  after api opened in acme/backend (no PR yet)
  planned
    unit      2, eng-2101-web
    rule      #2 planned=true deliver=pr
    skill     implement (built-in)
    provider  fake
    deliver   pr
    branch    away/ENG-2101-web
    waits     for api's PR in acme/backend
```

The one-chain rule counts only `opened` tasks in the task's own repo: with `ui` in `acme/web` too, `web` after `{ api: opened, ui: opened }` stacks on `ui` and waits for `api`, as `after ui, stacks on its PR` and `waits for api's PR in acme/backend` under its row.

`web` gets what `api` ships in `.away/context/<task>/shipped/api/openapi.yaml`, and its prompt names it. awaywork reads it when `web` is about to run, from `api`'s PR head, open or merged, since `api` may have opened that PR a minute earlier in the same block. A file that isn't there skips `web`, counting no attempt, so the next run tries again:

```text
Units 2
     item          skill      status          result
  1  ENG-2101/api  implement  done, 12 turns  https://github.com/acme/backend/pull/41
     Adds GET /exports/vat to src/routes/exports.ts, as the contract says.
  2  ENG-2101/web  implement  skipped         api's PR has no openapi.yaml
     Export button
```

A task in the same repo gets no `shipped/`: a stacked one already has the files in its branch, and a `merged` one is cut from a default branch that holds them.

The card, run by run:

| What happened | The card | Its tasks |
| --- | --- | --- |
| You approved | `fanned out: api no PR yet, web no PR yet` | `api` opens its PR in `acme/backend`, then `web` runs in `acme/web`, cut from its default branch, with the contract and `api`'s `openapi.yaml` |
| `api`'s PR has no `openapi.yaml` | `fanned out: api PR open, web no PR yet` | `web` is skipped as `api's PR has no openapi.yaml`, every run, until `api`'s PR has it |
| `api` merged before `web` ran | `fanned out: api merged, web no PR yet` | `web` runs, with `openapi.yaml` as `api`'s merged PR left it |
| Both PRs are open | `fanned out: api PR open, web PR open` | both wait for your review, each in its repo |

On Bitbucket a shipped file is read through twg (`twg bb repo file`), at the PR's branch or, once merged, its head commit.

### Waiting on a check

Some work needs more than an open PR: the button wants the endpoint deployed to try against. Vercel, Netlify and Expo report their previews as checks on the PR, so name the check in `after`, exactly as the PR shows it:

```yaml
tasks:
  - id: api
    title: VAT export endpoint
    description: Add GET /exports/vat to src/routes/exports.ts.
    ships: [openapi.yaml]
  - id: web
    title: Export button
    description: Add an Export button to the reports page, tried against api's preview.
    repo: acme/web
    after: { api: Vercel Preview }
```

Anything in `after` but `merged` and `opened` is a check's name, matched letter for letter. It means `opened`, plus that check passing: its latest run or status on the PR's head commit succeeded (on GitHub, a check run that's neutral or skipped passes too, as for a required check). A merged PR counts as passed. Until then the task waits, run after run, saying where the check stands:

```text
$ awaywork plan --skipped
Needs you 1
  ENG-2101/api: waiting for review: awaywork PR https://github.com/acme/backend/pull/41 is open
Skipped 2: 1 fanned_out, 1 waiting_for_task
  ENG-2101: fanned out: api PR open, web waits for api's check Vercel Preview
  ENG-2101/web: waiting for api's check Vercel Preview (pending)
```

`pending`, `failing` or `not reported` (no check by that name on the head, check the spelling), or `no PR yet`. A failing check keeps waiting, since a [`fix`](./configuration.md#queue-rules) rule may fix it, or you re-plan. A check never passes in the run that opened the PR, so a task after one never joins that run's [block](#the-feature-block): `api` opens its PR tonight, and `web` runs the first run after its preview is up. Once it passed, `awaywork plan` says so:

```text
Units 1
     item          rule  skill                 provider  deliver  title
  1  ENG-2101/web  #2    implement (built-in)  fake      pr       Export button
     in acme/web
     after api's check Vercel Preview (passed)
```

```text
$ awaywork plan --why ENG-2101/web
tracker ENG-2101/web  Export button
  https://acme.atlassian.net/browse/ENG-2101
  task web of the plan on ENG-2101, in acme/web
  after api's check Vercel Preview in acme/backend (PR #41 open, passed)
  planned
    unit      1, eng-2101-web
    rule      #2 planned=true deliver=pr
    skill     implement (built-in)
    provider  fake
    deliver   pr
    branch    away/ENG-2101-web
    check     api's check Vercel Preview (passed)
```

In the same repo a check's name stacks like `opened`: `web` is cloned from `api`'s branch and its PR stacks on `api`'s (`after api's check Vercel Preview (passed), stacks on #41`), and it counts with the `opened` tasks toward the [one chain](#the-feature-block). In another repo it only waits, and gets what the task ships, as `opened` does there. awaywork reads a PR's checks only when some task names one of them, so a plan without check names costs no extra calls, and a read that fails skips the card, like a task PR it couldn't read. `plan --json` has them on the card, under `taskPrs.api.checks`.

The card, run by run:

| What happened | The card | Its tasks |
| --- | --- | --- |
| You approved | `fanned out: api no PR yet, web waits for api's check Vercel Preview` | `api` opens its PR; `web` is skipped as `waiting for api's check Vercel Preview (no PR yet)` |
| The preview is building, or failed | `fanned out: api PR open, web waits for api's check Vercel Preview` | `web` is skipped as `(pending)` or `(failing)` |
| The preview is up | `fanned out: api PR open, web no PR yet` | `web` runs, cut from `acme/web`'s default branch, with `api`'s `openapi.yaml` |
| `api` merged first | `fanned out: api merged, web no PR yet` | `web` runs: a merged PR counts as passed |

On Bitbucket, checks are the build statuses on the PR's head commit, by name, read with `twg bb prs get --statuses`; `SUCCESSFUL` passes, `INPROGRESS` is pending, `FAILED` and `STOPPED` are failing. Check the status name is the same on every build before you put it in `after`: one that carries a build number never matches.

## Posts that wait

A plan isn't the only step worth a look before the next one starts. A `deliver: report` rule with `wait: true` posts its result on the item and waits for your answer there, like a plan; your `approve` hands the item to the next stage. Plans wait by default (`wait: false` lets one go ahead), reports don't.

```yaml
queue:
  - skill: story
    where: { section: Inbox }
    deliver: report
    wait: true # your approve hands it to the next rule
    on_done: { move: Ready for design } # held until you approve
  - skill: prototype
    where: { approved: story } # works on a tracker that can't move cards too
    deliver: report
    gates:
      taste: { skill: judge, instructions: [judges/design.md] } # one that fires holds the post
```

The post is the result as `on_done: { comment: result }` writes it, posted whether or not the rule asks for that, with how to answer, and its state on the mark line:

```
Result of story

Export VAT as CSV from the reports page.

Status: done

To approve, reply with approve as the first line. Any other reply is feedback: awaywork runs this step again with it.

— awaywork · waits · move=Ready%20for%20design · saw=Inbox
```

- **It holds its rule.** Later runs skip the card as **waiting for your approval**, whatever else changes on it, and no rule below takes it meanwhile. Its linked items rank on their own, so a red-CI fix on the linked PR still runs, without the card, wherever `fix` sits in your queue:

  ```
  Needs you 1
    tracker ENG
      ENG-2101  Export VAT report  approve
                story's result
  ```

- **Your first reply decides**, as on a [plan](#plans): first line `approve` approves, anything else is feedback and runs the step again with the thread in `item.md`, its new post waiting whatever `wait` says. `awaywork approve <source:key>`, or `a` in the report, replies for you. A teammate's comment is context, never an answer, and a later comment of yours on an approved post changes nothing.
- **Approved, it hands the item on.** The item's `approved` becomes the post's skill, read off the thread, so `where: { approved: story }` takes it even on a tracker awaywork can't move cards on; a newer post that waits leaves it on the one before. The rule that posted it is done with the item and passes it down the queue: with no rule after it, the item is skipped as `#1 story doesn't run again: you approved its result; to run it again, delete that post on <url>`. Deleting awaywork's post is how you run that stage again, with `awaywork run --unit <key>` when the card didn't change since.
- **`on_done` waits too.** A post that waits holds its `move` and records the card's status. The first run that sees your `approve`, a window, `soon` or manual one, makes the move the post names, even if `on_done` changed since, before planning any unit, with no model run, only while the card is still in the status the post saw (on GitHub, while the label isn't on it yet) and no newer awaywork post is on the item. A dry run only says it would; the run's report lists the move, or why it failed, under Held moves. Moving or reassigning the card yourself releases the post:

  ```text
    on_done: moved ENG-2101 to Ready for design, its post approved
  ```

- **Gone ahead.** A report rule with [gates of its own](./configuration.md#gates-of-a-rules-own) and no `wait` goes ahead when they ran clear: it posts its result with the gates line on top (`Gates: none fired (taste)`), its mark line saying `— awaywork · went ahead · gates=taste`, and `on_done` moves the card at once. That post counts as approved. A gate that fires makes the post wait, with the decision card on top of it, as on a PR.
- A report rule that waits, or has gates of its own, needs a source that can write, or a [thread](#threads): one that names a `source` that can't is a config error, and `doctor` warns about any it may match. `wait` and rule gates on a `pr`, `draft_pr`, `push` or `pending_review` rule are a config error for now: the PR is already the decision.

## Threads

Your Jira token is `read:jira-work`, or your custom source has no `write`: the card can't take awaywork's posts, so it can't plan or wait there. `thread: github` on a rule moves the conversation to a GitHub issue awaywork opens for the card, in the card's repo (`repo_map`, or a custom item's `repo`), assigned to you, so GitHub pings you:

```yaml
queue:
  - skill: story
    source: jira # read-only
    deliver: report
    wait: true
    thread: github # posts and replies on an issue in the card's repo
  - skill: prototype
    source: jira
    where: { approved: story }
    deliver: report
    thread: github
    on_done: { comment: result }
```

The rule's first post opens it, titled with the card's key and title, and posts there; a real one from the sandbox, a custom source's card:

```
CARD-1: Export VAT report

awaywork posts here for [CARD-1](https://tracker.example/CARD-1), Export VAT report: its plans, results and questions. Reply here to answer them; the card still decides whether it's yours.

<!-- awaywork thread item=tracker:CARD-1 -->
```

- **Found again, not remembered.** Each run lists the open issues you opened in the card's repo and takes the one whose marker names the card, so nothing goes in the state dir and a runner without state finds it too. It isn't an item: the GitHub source leaves out issues carrying the marker, or a plan rule would take the thread itself.
- **It's the card's thread now.** Its comments follow the card's in `item.md` and everywhere awaywork reads posts, so plans, posts that wait, held moves, [pins](#files-that-come-back) and questions work there as on a card. From then on every post awaywork makes for the card goes there, other rules' and the plan's tasks' too, so keep a card's rules on one thread. A reply there counts as a change to the card, awaywork's own posts don't, so your feedback runs the step again though the card didn't move.
- **Your reply decides**, as on a card: reply `approve` on the issue, or `awaywork approve jira:ENG-2101` (the thread's own key, `github:acme/api#57`, works too). A teammate's `approve` there is context. Skips point at the thread:

  ```
  Needs you 1
    CARD-1: waiting for your approval of story's result on https://github.com/AndreaProvenzale/awaywork-sandbox/issues/212
  ```

- **The card still decides.** Whether it's yours is read off the card every run: reassign it and its thread neither fans out nor takes answers. `on_done` moves stay on the card: a card that can't move holds no move on a post that waits, and a plain post's move reports `couldn't move ENG-2101 to "Ready": jira can't write to its items`.
- **Its end.** Once the card's source says it's done, closed or merged, read back a week, the next run comments and closes the issue; a dry run says `would close`:

  ```text
    closed https://github.com/AndreaProvenzale/awaywork-sandbox/issues/212, CARD-1's thread: the card is closed
  ```

  Every task merged isn't the end: the card says `all tasks done: close or move the card` until you do, and its thread stays open with it. Close the thread yourself and the next post opens a new one. A thread whose card leaves your items without reading as done (reassigned, moved to another `repo`, or closed while no run read back that week) stays open: close it yourself.

- **Or a host of your own.** `thread: <source>` names a custom source with `thread: true` instead, a Notion database or a folder of Markdown files in your vault, which opens and lists the threads itself: see [Thread hosts](./custom-sources.md#thread-hosts). That's the one for a Bitbucket config.

- `thread: github` needs repos on GitHub: on a Bitbucket config it's a config error. It goes on the plan's rule, never a `planned` one: tasks post where their plan did. Thread writes use the `gh` login awaywork opens PRs with, never the worker's. A GitHub issue pings its assignee; a host that notifies nobody, a folder of Markdown files say, wants a [notify](./configuration.md#notify) hook next to it, or a plan there waits unseen.

## Files that come back

With a [store](./configuration.md#store), a plan or report rule's post is lean: the step writes `.away/out/summary.md`, a few lines for whoever reads the thread (its prompt asks for it), and awaywork posts that, its own facts and a pin per file the step left, everything else in the store. A real one, from the example store on a sandbox issue:

```
Result of story

A story in one line.

Status: done

To approve, reply with approve as the first line. Any other reply is feedback: awaywork runs this step again with it.

Pinned big.bin: file:///…/cfg/files/ba03611f-0cce-4344-9b3e-11e7413084fa/big.bin (3000 bytes, sha256 e1630f843370f402870799e14abbf2b06af2d23b0153658e1211dffabc61ad8f)
Pinned mock.png: file:///…/cfg/files/71e96381-7e32-4ee7-9aab-5f803b4de816/mock.png (7 bytes, sha256 2d4566582844690f8634a8b2534ea5221560038c6c0650c99140759bad603ae2)
Pinned report.md: file:///…/cfg/files/a63b0dec-63e2-4701-968e-8350ad439bae/report.md (22 bytes, sha256 8ce3d4416e83b1da658e0404e2cf700108a3ed2e43b077fadad9eb5ccaa95c8e)

— awaywork · waits
```

A lean plan shows its tasks instead of `plan.yml`, which is pinned with its contract and report, so the 30 KB comment limit is gone:

```
VAT export in two tasks: the api first, then web against its contract.

Tasks:
- api: VAT export endpoint
- web: Export button

To approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.

Pinned openapi.yaml: https://… (2140 bytes, sha256 …)
Pinned plan.yml: https://… (311 bytes, sha256 …)
Pinned report.md: https://… (1822 bytes, sha256 …)

— awaywork
```

`post: full` keeps today's comment, the report inline, and pins only the other files. A step that wrote no `summary.md` gets its report's first five lines and a line saying so in the morning report. Pins sit below everything the model wrote, right above the mark, so a `Pinned` line in a report pins nothing. A PR step's files, screenshots say, are pinned in the PR body's footer the same way. Without a store nothing changes: posts are full, and the files stay in the run dir, where the [notify](./configuration.md#notify) hook reads them.

**What comes back.** Before a unit's worker starts, awaywork reads its items' threads and gets the pinned files into `.away/context/<item>/files/<post>/`, a folder per post named by its place in the thread, e.g. `2-story/`: the files of the post an approval covers (a task's plan, the result `approved: story` names), its own newest post when it runs again on your feedback or a `continue`, every post newer than that, and on a unit on a PR awaywork opened for you, its footer's. A footer file that changed since awaywork pinned it is left out, with a line in the morning report: nothing reruns on a PR body, and a stranger's PR carrying awaywork's marker gets nothing read back at all. The worker still holds no token, and its prompt calls those files data, like `item.md`: someone else wrote them. The rest of the plan's special cases fold in: a lean plan's tasks read its `plan.yml` and contract through `get`; what a task `ships` still comes from its PR's head. `read.max_mb` caps what one unit reads back, 10 by default, and the rest stay links, named in the morning report; a pin carries its file's size, so one over the cap isn't even fetched; `read.files` narrows it by name, `*.md` matching `notes/a.md` too.

**An edit is feedback.** awaywork hashes each file as it puts it and checks the hash when it reads it back. Every `plan`, run and watch poll reads back the files of the posts that decide a rule, within the cap, a plan's and a waiting or approved report's, and one that doesn't match makes its post stale: it counts as your feedback, whoever edited the file. The step runs again, though the card didn't change, with the edited file in context, and posts again; a rule that waits needs a fresh `approve` on that new post, so you only approve what awaywork has seen. Here a teammate edited `report.md` in the store, and the next run went again:

```
  1  awaywork-sandbox#206  story  done    report
     Full report of story.
     report.md of awaywork's post of 2026-11-07T19:31:26Z changed in the store since awaywork pinned it
     result posted on https://github.com/AndreaProvenzale/awaywork-sandbox/issues/206#issuecomment-6712036203; it waits for your approve
```

So edit the plan in Notion freely, then approve what comes back. A full post on the card keeps the card's rule: your edit of the plan comment counts, someone else's voids it.

## The morning report

`awaywork report` opens the last run from its `report.json`: a row per unit with its result and a line of what it concluded, what needs you, and the skipped items, folded, each under its repo, under each provider's long window before and after against the ceiling. Arrow through it, unfold what you care about, and read, open or skip things with one key. Here `web#3` is selected (it's in reverse video on your screen), Skipped is unfolded one level, and `d` just said why it did nothing:

```
☾ >_ awaywork  You're away, your agents work

Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40
away run (inside a window): session_max
claude: seven_day 5% to 17%, ceiling 42.9%; session 2% to 31%, stop at 90%

▾ Needs you 1
  ▾ tracker T 1
    T-4  Export invoices as CSV  add repo

▾ Units 3
       item  skill   status          result
  ▾ acme/api 2
    1  #1    fix     done, 14 turns  https://github.com/acme/api/pull/14
       Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a…
    3  #2    review  done, 6 turns   report, verdict approve
       Approve: the session cache keys on the user id and expires with the token.
  ▾ acme/web 1
    2  #3    fix     done, 9 turns   nothing
       No code changes: the red check is the visual diff job, which fails on main too since #212.

▾ Skipped 2: 1 no_rule, 1 over_cap
  ▸ tracker T 1
  ▸ acme/api 1

⏎ read  o open  l log  d diff  s skip  a approve  ? help  q quit
diff: this unit left no diff
```

The footer dims the keys the selected row has nothing behind, like `d` on a unit that committed nothing, or `l` on a run [from the runner](./scheduling.md#reports-from-the-runner), which keeps no logs. `awaywork plan` opens the same view on the next run, without `l` and `d`: a plan has no logs or diffs yet. Items sit under their repo, or their tracker and project key, so a row shows just `#3`. A skipped one ends on what it asks of you (`review PR`, `answer question`, `approve`, `add repo`, ...) or why it waits (`no rule`, `over cap`, ...), and Needs you lists a repo's items by that, so the PRs to review sit together. The line under it is what the reason says beyond that word, if anything, without the closest rule in Needs you; `⏎` has the whole of it. Rows run to the terminal's width, keeping that word on screen. It opens on the first Needs you item, else the first unit, else the first skipped one, and leaves out a section with nothing in it; when there's nothing at all, it says why instead. Both open at once, with a line per step while they load: a run fetched from GitHub, or for `plan` each source and provider, as in [Getting started](./getting-started.md#preview-the-next-run).

| Key | Does |
| --- | --- |
| `↑` `↓`, `j` `k` | move |
| `g` `G`, Home End | first, last row |
| PgDn PgUp, Ctrl-D Ctrl-U | a screen down, up |
| `→` `←` Space | unfold, fold, as `⏎` on a heading; `←` on a row goes to its section |
| `⏎` | page the unit in full, as `report --unit` prints it, or why an item is planned or skipped, as `plan --why`; `$PAGER`, else (or if it's `cat`) `less -R -c -+F -+X`, which repaints from the top and stays open on a short text |
| `o` | open the unit's PR, else its item; a skip waiting for review opens the PR it waits on |
| `l` | page the `worker.log` of the chain's last step |
| `d` | page the diff: the commits the unit published, else the step's own |
| `s` | `awaywork skip` the item, after a `y` |
| `a` | `awaywork approve` the item, after a `y`; there's no undo |
| `?` | the keys |
| `q`, Esc, Ctrl-C | quit, also while it loads |

Piped, in CI (`CI` set), or with `--json`, `--list`, `--unit` or `--skipped`, you get plain text instead, so `awaywork report | cat` is the way to print it:

```
$ awaywork report | cat
Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40

Units 3
     item   skill   status          result
  1  api#1  fix     done, 14 turns  https://github.com/acme/api/pull/14
     Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a 500.
  2  web#3  fix     done, 9 turns   nothing
     No code changes: the red check is the visual diff job, which fails on main too since #212.
  3  api#2  review  done, 6 turns   report, verdict approve
     Approve: the session cache keys on the user id and expires with the token.

Needs you 1
  tracker T
    T-4  Export invoices as CSV  add repo

Skipped 2: 1 no_rule, 1 over_cap

Quota
  away run (inside a window): session_max
  claude: seven_day 5% to 17%, ceiling 42.9%; session 2% to 31%, stop at 90%

awaywork report 20261019-220012 --unit <n|key>    shows one
awaywork report 20261019-220012 --skipped [kind]  lists the skipped items
```

`report --unit <n>` takes the number from that table, the unit id (a step's gives its chain) or an item, and prints the unit in full, what `⏎` pages: its links, each step with its provider and what it left when there are several, the files it left (the ones still there: a run [from the runner](./scheduling.md#reports-from-the-runner) has none), then its PR body or report:

```
$ awaywork report --unit 2
2  web#3  WIP: new billing page
  skill   fix
  status  done, 9 turns
  result  nothing
  item    https://github.com/acme/web/pull/3
  files   ~/.local/state/awaywork/runs/20261019-220012/units/acme-web-3/1-fix/worker.log
          ~/.local/state/awaywork/runs/20261019-220012/units/acme-web-3/out/pr.md

Fix the billing page build

No code changes: the red check is the visual diff job, which fails on main too since #212.

## What I checked

- `pnpm test` passes locally.
- The failing job is `visual`, unrelated to this diff.
```

An item key that is all digits, like an Asana gid, wins over a row number. A name that fits two units, `api#1` under two owners say, is refused with each one's `source:key`, here and in `run --unit` and `plan --why`. `report --skipped [kind]` lists the skipped items with the reason, as `plan --skipped` does. A long reason, like a failed setup's output, gets its first line in the row and all of it under `--unit`. A unit with `then` steps is one row, its chain in the skill column.

The run dir also keeps `report.md`, the same run as markdown: the units table with every step under its chain and a line per unit that wrote a summary, Needs you, the skipped items folded by kind, and each report folded under its unit. That's the one GitHub Actions puts in the job summary and [`notify`](./configuration.md#notify) gets. A run from before `report.json` prints its `report.md`. `awaywork report --json` prints the run's results as [JSON](./agents.md). `awaywork report --list` lists recent runs with their units, PRs and reports; `awaywork report <id>` prints one of them. Both see only the runs [`keep_runs`](./configuration.md#old-runs) kept. Inside a control repo both also show the runs GitHub Actions [uploaded](./scheduling.md#reports-from-the-runner).

While a run is going there is no report yet: `awaywork report` then lists the steps done so far, the one working and the path to its `worker.log`, which you can `tail -f`.

`awaywork stats` adds up every run since this feature, kept in each run's `units.json`: per rule (by its position in the queue in that run), skill and provider, the units, how many were done, failed or stopped, the share of the long quota window their workers used, and the PRs opened. `--json` prints the same totals. The quota share is an estimate: it starts at the quota read before the unit (the plan's probe, then the previous unit's last reading on that provider), includes any other use of the account meanwhile, and is `-` when the window reset mid-unit or the worker read no quota. It counts a chain's steps one by one, and only a chain's first step carries its PR, so the rows of the skills after it show no PRs. `units.json` is written when the run ends, so a run that is killed leaves none. Runs from before have no `units.json` and are left out, as are the runs [`keep_runs`](./configuration.md#old-runs) removed.
