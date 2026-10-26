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

A source returns your open items with facts about each: a `type` (`pr`, `issue`, `task`), a `title` and `description`, `approved` (whether you ran [`awaywork approve`](#units) on it), `state` (`open`, or `merged` or `closed` for the [finished items](./configuration.md#finished-items) a rule asks for) and `closed` (when it finished), and source fields.

| Source | Items | Fields a rule can match |
| --- | --- | --- |
| GitHub | Open PRs you authored, PRs awaiting your review, issues assigned to you, plus any extra `search` (e.g. `label:awaywork`, `mentions:@me`), in the configured repos; your merged and closed ones too when a rule asks | `repo`, `label`, `author`, `trusted` (the author is an owner, member or collaborator), `mine`, `ours` (awaywork opened it), `draft`, `checks` (`failing`, `pending`, `passing`), `unresolved_threads` (those [shown to the agent](./safety.md#public-repos)), `my_unresolved_threads` (the unresolved ones you started), `files` (paths the PR touches, the first 500; test with `matches`), `changed_lines` (additions plus deletions), `review_requested`, `created`, `updated` |
| Asana | Incomplete tasks assigned to you in a workspace, optionally some projects; completed ones too when a rule asks | `project`, `section`, `blocked` (a dependency is incomplete), `tags`, `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated`, `due` |
| Linear | Issues assigned to you that are neither completed nor canceled; completed and canceled ones too when a rule asks | `team` (key), `status` (the workflow state), `labels`, `priority` (e.g. `High`), `blocked` (an open blocker), `project`, `repo` (from `repo_map`), `created`, `updated` |
| Jira Cloud | Unresolved issues assigned to you, optionally narrowed by `jql`; resolved ones too when a rule asks | `project` (key), `status`, `labels`, `priority`, `blocked` (an open "is blocked by" link), `issuetype` (e.g. `Bug`), `repo` (from `repo_map`), `fields.<custom field>`, `created`, `updated` |

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

The section and status names are guesses; `awaywork init` replaces them with your tracker's real ones and writes the queue out so you can edit it.

## Units

Items that share a key or a linked PR (repo and branch) are one unit, one piece of work on one feature, ranked at its best item's rule. An Asana task linked to your PR becomes one unit with that PR. An awaywork PR is linked to the items its footer names; one you wrote, by the key in its branch or title, or the source's [`link`](./configuration.md#linking-prs) line in its body.

- The unit works in its linked PR's repo, else the item's `repo` field; with neither it is skipped.
- A unit that links an open awaywork PR is skipped as **waiting for review**: awaywork doesn't add to work you haven't read from an earlier run. An awaywork PR only matches rules whose `where` names `ours`, like the default `fix` on threads you left on it: that rule then takes the unit, even over a better-ranked item linked to the PR, and its draft PR stacks on the awaywork PR. A GitHub issue's draft PR into the default branch says `Closes` it, which links the two, so the issue is skipped as waiting for review while that draft is open.
- A PR awaywork pushed onto (a `deliver: push` rule) is skipped as **waiting for review** too, while its head is still the commit awaywork pushed (kept in the state dir, so not on a runner).
- A unit whose item's newest comment is awaywork's [questions](#questions) is skipped as **waiting for your answer**, until someone replies on the item.
- A unit a `deliver: plan` rule took waits on awaywork's [plan](#plans) on its item: skipped as **waiting for your approval** until someone replies, planned again on feedback, and skipped as **plan approved** once you approved it.
- A unit none of whose items changed since a worker last finished the same skill on it is skipped as **unchanged since run `<id>`**, so a review or a unit that gave up isn't redone every run. A unit's chain counts as one attempt, finished when every step that ran was done and no publish left anything behind; commits left unpushed retry. "Changed" is the item's `updated` time; attempts live in `~/.local/state/awaywork/attempts.json`, and a unit picked with `run --unit` isn't skipped.
- A unit whose chain didn't finish 3 runs in a row (a failure, an error, a `unit_minutes` timeout, commits left unpushed) is skipped as **gave up after 3 attempts; next try on `<date>`**, a week after the last one, even if its items changed in between: a Sentry error that keeps firing doesn't get a fresh try every night. That week-later try is one try: fail again and it waits another week. A plan report followed by a failed implement is one failure; a finished attempt clears the count, matching another skill starts a new one, and skipped, dry-run and aborted units don't count. Neither does a stop the item didn't cause (quota, session limit, window end) or may not have (a watchdog stop for low memory or disk): it tries again next run. `run --unit` runs it anyway, as its one try.
- `awaywork skip <source:key>` (e.g. `github:acme/api#5`) leaves an item, and any unit it joins, alone until `awaywork unskip` or the `--until` date; `plan --skipped skipped_by_you` lists it with the `--reason`. Skips live in `~/.local/state/awaywork/skips.json`, and `run --unit` runs the item anyway.
- `awaywork approve <source:key>` marks an item approved, for items with no tracker section, state or label to say so (those already work through `where`). Rules read it as the key `approved`, like `title`: `skill: implement, where: { approved: true }` waits for it, so you can approve a `plan` report today and have `implement` take the item tonight. An item takes the first rule it matches, so that rule goes above the one that plans the item (or give the `plan` rule `approved: false`), as in the example below. The approval clears once the unit planned with it finishes, as an attempt counts it: a failed step or work left unpublished keeps it for the retry. An approval you give during a run stays. Approvals live in `~/.local/state/awaywork/approvals.json`. On an item waiting on a [plan](#plans), it approves the plan instead, with a reply on the item; it reads the item's source only when a `deliver: plan` rule can take items from it, so without one it stays offline.
- A chain's first step on an item gets the item's latest report in `.away/context/previous/report.md` (the last one of the latest chain on it that left a report), and the prompt says it is from an earlier run. That is how an approved `implement` finds the plan, on a retry too: a failed `implement` that wrote no report doesn't replace the plan. Later steps get the step before, as always.
- Units run one at a time, in queue order. A unit is a chain: the rule's skill, then its [`then`](./chains.md#then) steps, one after the other in one clone, publishing once when the chain ends, or once per slice when a step says [`stack`](./chains.md#stack). A [loop](./chains.md#loops) repeats steps, and a step with a [`when`](./chains.md#when) runs only when its condition holds.
- A PR stacks only on the awaywork PR a rule took up, or on the slice before it in its own chain. Its body names the PR to merge first, and on a repo with GitHub's [stacked PRs](https://gh.io/stacks) awaywork links the two into a stack. Every other PR starts from the default branch or your PR's branch, so you can merge, park or close each one on its own.
- Optional [caps](./configuration.md#windows-limits-and-budget) limit the units per run, per repo and per rule; each slice of a chain counts once.

A queue that plans the sprint's tasks and implements the ones you approve:

```yaml
queue:
  - skill: implement
    where: { approved: true }
  - skill: plan
    source: asana
    where: { section: Current sprint }
```

While `implement`'s draft PR is open the task waits for review; once you merge it, move the task out of the section, or `plan` takes it again.

## Budget

Each provider gets a ceiling for the run on its long window (the week for Claude, the week or month for Codex). The ceiling is the lowest of:

- `used + per_run`, when `per_run` is set;
- `1 - reserve` (default reserve 10%);
- pacing: `used + (1 - reserve - used) / runs to reset`, where runs to reset counts the window openings left before the reset, including the one under way when the run is in a window; so a run just before the reset may spend more than one just after.

A worker stops once the provider reports its long window past the ceiling or its short (5 h) window past `session_max` (default 90%). Claude reports quota during the run, so it stops mid-run; Codex is read after each run, so it stops between units. A provider whose quota can't be read gets a fixed `fallback` of units and turns per run.

## Routing

A rule's `provider` list, else the global `providers` order. The first provider under its ceiling takes the unit. When a window fills, the next unit goes to the next provider.

## The worker

Each unit runs in a fresh clone on a new branch cut from its base: the linked PR's branch, else the default branch. A PR from a fork is fetched from the repo's `refs/pull/<number>/head`, and the unit fails if that is no longer the head commit its source read. A branch name that's taken on the remote gets a `-2` to `-10` suffix, unless awaywork already tried there ([Branch names](./configuration.md#branch-names)). `setup` runs there once, before any agent, and every step of the unit's chain then works in that clone, on that branch.

- `.away/context/` holds the prefetched item: PR view, diff, unresolved threads and failed-check logs, or the issue or task with its comments.
- The skills go where the agent looks for them (`.claude/skills/`, `.agents/skills/`).
- The prompt is, in order: the fixed [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md), the skill, then your instructions (global, per repo, in-repo `.awaywork/instructions.md` unless someone else opened the PR, per rule).
- The agent has no forge token, no source's or other provider's secret, an empty `GH_CONFIG_DIR` with placeholder `GH_TOKEN` and `GH_ENTERPRISE_TOKEN`, an empty `TWG_CONFIG_DIR` and no other `TWG_` variable, no ssh agent, no system git config, and a global one with only your commit identity and git-lfs's filter ([Safety](./safety.md#what-the-agent-can-reach)). On a GitHub-hosted runner it runs as a user of its own, and so do setup and the checks ([Safety](./safety.md#a-worker-user-on-github-hosted-runners)).
- A turn cap bounds the run (200, or `fallback.turns` without a quota reading), `limits.unit_minutes` caps its wall-clock time when set (status `stopped: time`), and a watchdog stops it below 1.5 GB of free memory or 2 GB of disk, then kills every process it left behind. The same floors are checked before each unit: a machine that's short skips the unit with the reason (`disk below 2 GB`), and every later one while it stays short, spending no quota; the next scheduled run picks up once there's room.

## Delivery

| `deliver` | What happens |
| --- | --- |
| `draft_pr` | The default. The worker commits and writes `.away/out/pr.md` (first line the title), which a chain's later steps keep current. awaywork adds an `Awaywork: <run id>` trailer, pushes the new branch and opens one draft PR into that base. No `pr.md`, no publish. Never into someone else's PR or a PR from a fork: there a chain that could commit is skipped with the reason; a report still works. |
| `pr` | Opt-in per rule: the same as `draft_pr`, same bases and checks, but the PR opens ready for review, so it pings whoever a ready PR pings, code owners included. It still opens as a draft when one of the slice's steps failed or stopped or the run ended before one ran, its [`verify`](./configuration.md#repos-and-instructions) failed, one of its [loops](./chains.md#loops) ended before its `until` held, or one of its [gates](./configuration.md#gates) fired, and the report says why. |
| `report` | No step commits. Each writes `.away/out/report.md`; nothing is pushed. A chain's reports, joined, go into the morning report. |
| `pending_review` | Opt-in per rule, only on a unit whose base is a PR, anyone's or a fork's. A `report` that also lands on that PR: when the chain ends, the last report and the line comments its step wrote to `.away/out/review.json` become your pending review, at the commit the clone read. Nobody else sees it until you submit it. When GitHub refuses the line comments, say one is off the PR's diff, they all go in the review's body. When a step failed or stopped or the run ended before one ran, or GitHub refuses the review anyway (you already have a pending review there, say), the report is delivered alone with the reason. GitHub only. |
| `plan` | Opt-in per rule. A `report` whose step also writes `.away/out/plan.yml`, the work split into tasks: when the chain ends, awaywork checks it and posts the report and the plan as one comment on your item, which waits for your approval there. See [Plans](#plans). |
| `push` | Opt-in per rule, only on a unit whose base is your own open PR. The worker commits and writes `.away/out/pr.md`, as for a PR; awaywork adds the trailer and pushes the chain's commits onto your PR's branch as a fast-forward, only while the PR is yours, open, in the repo, without auto-merge, and its head is still the commit the clone started from, and its branch isn't the default branch, protected, or the branch of someone else's open PR in the repo. The PR body isn't touched; `pr.md` goes into the morning report. No `pr.md`, no push. |

Either way, a skill that defines verdicts also writes one word to `.away/out/verdict`, such as `approve`. The report shows it next to the unit's result, and a [loop](./chains.md#loops) can end on it.

A skill commits unless its metadata says it reports, as `review` and `plan` do; the rule's `deliver` says where the commits go, and a chain that committed nothing reports whatever its `deliver`. `pr`, `push`, `pending_review` and `plan` are never a skill's default. A PR's body gets its items' [`link`](./configuration.md#linking-prs) lines, and ends with a footer naming awaywork, the run and the unit's items, which is how the next plan recognises it and links it to them.

## Questions

A step that can't go on without a person's answer writes its questions to `.away/out/questions.md` and commits nothing, like `implement` on an issue too vague to build. The chain ends there, and awaywork posts them as one comment on the unit's item from the rule's own tracker, the one [`on_done`](./configuration.md#on-done) would move, when that item is yours: your PR, an issue assigned to you, a tracker item. The model writes the questions; awaywork adds the last two paragraphs. On GitHub it shows up as you:

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
    api#5  waiting for your answer
           Add rate limits
  ```

- Any comment after it that the agent would see ends the wait: yours, or a teammate's. On GitHub that's an owner, member or collaborator of the repo; a tracker shows every comment on an item assigned to you. Bots don't count (GitHub's bots, Jira's apps, Linear's apps and integrations): a coverage report or an automation's comment after the questions shows in `item.md` but leaves the unit waiting. Asana and custom sources don't mark bots, so there an integration's comment ends the wait too. The next run takes the unit with the same rule, and `item.md` shows awaywork's comment headed `awaywork's questions`, the replies after it. A step that still can't go on asks again.
- It counts as awaywork's only when its `— awaywork` line comes from your own account, so a stranger pasting one doesn't hold your item ([Safety](./safety.md#what-awaywork-publishes)).
- On an item that isn't yours, a source that can't write (Bitbucket, a custom source without `write`), or a post that fails, the questions stay in the morning report with the reason, and the unit is still done. Either way the unit's result reads `asked questions`, the report lists them under Questions, and `awaywork run` prints `questions posted on <url>` under the unit, linking the comment itself on GitHub and the item elsewhere:

  ```text
    1  api#5  implement  done, 3 turns  asked questions
       Add rate limits
       questions posted on https://github.com/acme/api/issues/5#issuecomment-2417736801
  ```

- A step that committed went on, so its `questions.md` is left in its `out/` and nothing is posted. A chain that asked doesn't run its rule's [`on_done`](./configuration.md#on-done).

## Plans

A feature that spans a few PRs doesn't fit in one unit, and a hand-written list of cards is the chore you wanted gone. Give the feature's card a rule with `deliver: plan`, and its step splits the work into tasks instead of starting on it:

```yaml
queue:
  - skill: plan
    where: { label: awaywork-feature }
    deliver: plan
    on_done: { move: Plan review }
```

Every step of the rule reports, as under `report`, and the prompt asks for `.away/out/plan.yml` too: `tasks:`, at most `limits.plan_tasks` of them (8 by default), each with an `id` (lowercase letters, digits and dashes), a `title`, and optionally a `description`, a `skill`, a `repo` (the card's own, for now) and `after`, which maps other task ids to `opened` or `merged`. The built-in `plan` skill writes it; any skill can. awaywork checks it in plain code, outside the model (ids unique, under the cap, every `after` naming another task, no cycles, no key it doesn't know), then posts the report and the file as one comment on your item, the one [questions](#questions) would go to. The model writes the report and the file; awaywork adds the fence and the last two paragraphs:

````
VAT export lands in two PRs: the endpoint first, then the button that calls it.

- `api`: `GET /exports/vat` in `src/routes/exports.ts`, paged like `/exports/sales`, with a test next to `sales.test.ts`.
- `web`: an Export button on the reports page, behind the `vat_export` flag; it waits for the endpoint's PR to open.

Open question: should the export include voided invoices? I left them out.

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

- Until someone answers, the card is skipped as **waiting for your approval**, under Needs you:

  ```
  Needs you 1
    ENG-2101  waiting for your approval of the plan
              Export VAT report
  ```

- **Approve** with a reply from your own account whose first line is `approve`, in any case; the lines below it are notes for the tasks. `awaywork approve <source:key> [notes]`, or `a` in the report, posts that reply for you, marked like every comment awaywork writes, through the same ownership check, and refuses a plan someone already answered:

  ```text
  $ awaywork approve tracker:ENG-2101 Leave voided invoices out.
  plan approved: replied approve, with your notes, on https://acme.atlassian.net/browse/ENG-2101
  ```

  For now that's where it stops: the card is skipped as `plan approved, tasks api, web`, which needs nothing from you, and nothing runs the tasks yet.

- **Anything else is feedback:** your reply that doesn't start with a bare `approve` (`approve if web waits` included), a teammate's, a code owner's. Only you approve. Your reply changed the card, so the next run plans again with the whole thread in `item.md`, the plan headed `awaywork's plan`, and posts a new plan, which needs a fresh approval. A re-plan that isn't posted is skipped as unchanged until the card changes again. A plan's answer is the first comment after it that isn't a bot's.
- The plan is read off the card on every run, never the state dir: it's awaywork's newest plan comment, so a fresh runner waits too. Edit it to fix a task and the next run checks your edit again; an edit that breaks it skips the card as **plan refused** with the reason, under Needs you, instead of planning over your edit. A plan comment someone else edited isn't awaywork's anymore ([Safety](./safety.md#what-awaywork-publishes)), so the card has no plan and gets a new one. GitHub reads the card's whole thread, past its last 50 comments, so an old plan up a long thread still counts.
- A plan that fails its checks, in the file or as the next run reads it back from the comment, a missing `plan.yml`, or a comment over 30 KB is never posted: the reason stays in the morning report, as `plan not posted: plan.yml: task id "api" is used twice`, and `on_done` doesn't fire. Same for an item that isn't yours, a source that can't write, or a post that fails. A step that asks [questions](#questions) instead posts those, and the card waits for your answer as usual.
- A `deliver: plan` rule can't `stack`, and one that matches only merged or closed items, or names a `source` that can't write, is a config error.

## The morning report

`awaywork report` opens the last run from its `report.json`: a row per unit with its result and a line of what it concluded, what needs you, and the skipped items folded by kind (right under Skipped when there's one kind, or none in a run from before skips had kinds), under each provider's long window before and after against the ceiling. Arrow through it, unfold what you care about, and read, open or skip things with one key. Here `web#3` is selected (it's in reverse video on your screen), the skipped kinds are unfolded one level, and `d` just said why it did nothing:

```
☾ >_ awaywork  You're away, your agents work

Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40
claude: seven_day 5% to 17%, ceiling 90%; session 2% to 31%, stop at 90%

▾ Needs you 1
  T-4  no repo: no linked PR or repo field
       Export invoices as CSV

▾ Units 3
     item   skill   status          result
  1  api#1  fix     done, 14 turns  https://github.com/acme/api/pull/14
     Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a 5…
  2  web#3  fix     done, 9 turns   nothing
     No code changes: the red check is the visual diff job, which fails on main too since #212.
  3  api#2  review  done, 6 turns   report, verdict approve
     Approve: the session cache keys on the user id and expires with the token.

▾ Skipped 2: 1 no_rule, 1 over_cap
  ▸ no_rule 1
  ▸ over_cap 1

⏎ read  o open  l log  d diff  s skip  a approve  ? help  q quit
diff: this unit left no diff
```

The footer dims the keys the selected row has nothing behind, like `d` on a unit that committed nothing, or `l` on a run [from the runner](./scheduling.md#reports-from-the-runner), which keeps no logs. `awaywork plan` opens the same view on the next run, without `l` and `d`: a plan has no logs or diffs yet. Rows run to the terminal's width; Needs you leaves out the closest rule, and `⏎` has it. Both open at once, with a line per step while they load: a run fetched from GitHub, or for `plan` each source and provider, as in [Getting started](./getting-started.md#preview-the-next-run).

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
  T-4  no repo: no linked PR or repo field
       Export invoices as CSV

Skipped 2: 1 no_rule, 1 over_cap

Quota
  claude: seven_day 5% to 17%, ceiling 90%; session 2% to 31%, stop at 90%

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

An item key that is all digits, like an Asana gid, wins over a row number. A name that fits two units, `api#1` under two owners say, is refused with each one's `source:key`, here and in `run --unit` and `plan --why`. `report --skipped [kind]` lists the skipped items with the reason, as `plan --skipped` does. A long reason, like a failed setup's output, gets its first line in the row and all of it under `--unit`. A unit with `then` steps is one row, its chain in the skill column and each [stacked slice](./chains.md#stack)'s result in turn.

The run dir also keeps `report.md`, the same run as markdown: the units table with every step under its chain and a line per unit that wrote a summary, Needs you, the skipped items folded by kind, and each report folded under its unit. That's the one GitHub Actions puts in the job summary and [`notify`](./configuration.md#notify) gets. A run from before `report.json` prints its `report.md`. `awaywork report --json` prints the run's results as [JSON](./agents.md). `awaywork report --list` lists recent runs with their units, PRs and reports; `awaywork report <id>` prints one of them. Inside a control repo both also show the runs GitHub Actions [uploaded](./scheduling.md#reports-from-the-runner).

While a run is going there is no report yet: `awaywork report` then lists the steps done so far, the one working and the path to its `worker.log`, which you can `tail -f`.

`awaywork stats` adds up every run since this feature, kept in each run's `units.json`: per rule (by its position in the queue in that run), skill and provider, the units, how many were done, failed or stopped, the share of the long quota window their workers used, and the PRs opened. `--json` prints the same totals. The quota share is an estimate: it starts at the quota read before the unit (the plan's probe, then the previous unit's last reading on that provider), includes any other use of the account meanwhile, and is `-` when the window reset mid-unit or the worker read no quota. It counts a chain's steps one by one, and only each slice's first step carries its PR, so the rows of the skills after it show no PRs. `units.json` is written when the run ends, so a run that is killed leaves none. Runs from before have no `units.json` and are left out.
