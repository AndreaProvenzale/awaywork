---
description: Where awaywork stops for you and how work goes on from your answer, covering questions on your item, drafts that continue, gates and decision cards, plans split into tasks across repos, posts that wait for your approve, threads, and the files a store keeps.
---

# Workflows

Where a run stops for a person, and how the work goes on from your answer. Pick the one that fits:

- [Questions](#questions): a step can't go on without your answer, so it asks on your item.
- [Continue](#continue): work too big for one run goes on in the next one, on the same draft.
- [Gates](#gates): changes that need a human (a migration, a new route, a bumped dependency) get a decision card on the PR.
- [Plans](#plans): a feature that spans a few PRs, or a few repos, is split into tasks you approve first.
- [Posts that wait](#posts-that-wait): a report you want to read before the next stage starts.
- [Threads](#threads): the card can't take awaywork's posts, so the conversation moves to a GitHub issue.
- [Store](#store): big plans, contracts and screenshots live outside the post, and [come back](#files-that-come-back) to the next step.

## Questions

A step that can't go on without a person's answer, like `implement` on an issue too vague to build, asks on your item and the unit waits for a reply. The step writes its questions to `.away/out/questions.md` and `ask` to `.away/out/status`, and the chain ends there.

awaywork posts them as one comment on the unit's item from the rule's own tracker, the one [`on_done`](./configuration.md#on-done) would move, when that item is yours: your PR, an issue assigned to you, a tracker item. The model writes the questions; awaywork adds the last two paragraphs. On GitHub it shows up as you:

```
octocat commented

Before I write code for "Add rate limits":

1. Per user or per API key? The issue says "per client", and src/auth.ts has both.
2. Should a burst over the limit get a 429, or wait for the bucket to refill?

Reply here to answer: awaywork's next run takes this up again with your reply.

— awaywork
```

While that comment is the item's newest, the unit is skipped as **waiting for your answer**, under Needs you in `awaywork plan`. awaywork reads that off the item, not the state dir, so a fresh runner waits too, and its own comment bumping the item's `updated` time doesn't count as a change:

```
Needs you 1
  acme/api
    #5  Add rate limits  answer question
```

Any comment after it that the agent would see ends the wait, yours or a teammate's. The next run takes the unit with the same rule, and `item.md` shows awaywork's comment headed `awaywork's questions`, the replies after it. On a rule with [`run: soon`](./configuration.md#run-soon) that's within minutes of your reply, not at the next window. A step that still can't go on asks again.

- On GitHub a comment the agent sees is an owner's, member's or collaborator's; a tracker shows every comment on an item assigned to you.
- Bots don't count (GitHub's bots, Jira's apps, Linear's apps and integrations): a coverage report or an automation's comment after the questions shows in `item.md` but leaves the unit waiting. Asana and custom sources don't mark bots, so there an integration's comment ends the wait too.
- A comment counts as awaywork's only when its `— awaywork` line comes from your own account, so a stranger pasting one doesn't hold your item ([Safety](./safety.md#what-awaywork-publishes)).

When the questions can't be posted, they stay in the morning report with the reason, and the unit is still done: on an item that isn't yours, on a source that can't write (Bitbucket, a custom source without `write`) on a rule without a [thread](#threads), or when the post fails.

Either way the unit's result reads `asked questions`, the report lists them under Questions, and `awaywork run` prints `questions posted on <url>` under the unit, linking the comment itself on GitHub and the item elsewhere:

```text
  1  api#5  implement  done, 3 turns  asked questions
     Add rate limits
     questions posted on https://github.com/acme/api/issues/5#issuecomment-2417736801
```

### A step that committed and asks

Its commits open as a draft (`draft: asked questions` in the report), headed by a status line for you, with `status=ask` in the footer:

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

Under `push` the commits are pushed onto your PR, and it asks the same. Once someone answers, the next run goes on with that draft, as for [`continue`](#continue), `run: soon` included.

### Without a status file

awaywork guesses as it always did: a step that committed went on, so its `questions.md` is left in its `out/` and nothing is posted. A word other than `done`, `ask` or `continue`, or `ask` without `questions.md`, reads as no file, with a line in the run's log saying so. A chain that asked doesn't run its rule's [`on_done`](./configuration.md#on-done).

## Continue

Work too big for one run doesn't have to be squeezed into one. A step commits what's solid and writes `continue` to `.away/out/status`: progress made, run me again. The chain stops there, so a review or a fix doesn't run on half-done work, and publishes what it has.

Under `draft_pr` or `pr`, its commits open as a draft (`draft: the agent will continue` in the report), headed by awaywork's status line and counted in the footer:

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

The footer is where awaywork reads it back, never the state dir, so a fresh runner goes on too: the status, the times the unit said `continue`, the head it pushed and the commit the draft's own commits start after. The visible line is for you.

The rule:

- A `continue` goes on in the next run that would take the item anyway: a window run, a scheduled one or a manual `awaywork run`, never `run: soon`.
- It goes on only where awaywork can fast-forward its own GitHub draft: its head unchanged since awaywork left it, the PR opened by you and its body last edited by you, under 3 continues. Otherwise the draft is yours, with a "finish by hand" note.
- A draft that [asked](#questions) goes on the same way once someone answers, `run: soon` included, as any item change.

Going on, the unit clones the draft's branch and its prompt says so. `.away/context/previous/report.md` holds the last report, or the draft's body when no run of it is kept on the machine. Its commits are fast-forwarded onto the draft, no new PR and no suffixed branch, and the new `pr.md` replaces its title and body:

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

### When it won't go on

The run's report says `<why>: finish <PR> by hand`, the draft opens without the status line, and questions it asked stay in the report. A chain that committed nothing has no draft, so its questions are posted. The next plan skips the unit with the same why:

```text
Needs you 1
  acme/web
    #7  Export screen  finish by hand
        awaywork's draft says continue, but it moved from 1f8a231,…
```

The whys are `awaywork goes on with its own draft on GitHub only`, `someone else opened or edited it last`, `it moved from <sha>, where awaywork left it` and `it continued 3 times`. The footer still holds the draft's [dependents](#tasks) back. Mark it ready to take it over: a ready PR, or a draft without a status in its footer, waits for your review like any awaywork PR. A `run: soon` run skips a `continue` as `goes on from <PR> in the next window run`.

- **A report** that says `continue` posts its result where a result goes, a [report task](#report-tasks)'s or `on_done: { comment: result }`'s, with `Status: continue (1 of 3)`. It runs again from it, its report reaching the next run as `previous/report.md`, up to the same cap. Clear a capped report's count with `awaywork skip`, or by deleting awaywork's `continue` results on the item. Otherwise it only reports.
- A `continue` with nowhere to keep its count, a committing step with no commits on a new branch or a `push`, `pending_review` or `plan` rule, reads as no status file, with a line in the run's log.
- A chain that says `continue` doesn't run its rule's `on_done` move: the unit isn't done.

## Gates

Some changes want a human before they go anywhere: a migration, a new public route, a bumped dependency. A gate spots one and changes what gets delivered: a decision card on top of the PR, and a `deliver: pr` PR held as a draft. Each gate has a name and one of:

- `changed`: git globs from the repo root that fire when the chain's commits touch a matching path;
- `command`: a script that fires when it exits non-zero, its stdout becoming the gate's line;
- `skill`: a [judge](#judges).

```yaml
gates:
  schema: { changed: ["**/migrations/**", "**/*.prisma"] }
  routes: { command: scripts/route-diff.sh } # non-zero exit = fires, stdout = the line
  deps: { changed: [package.json, pnpm-lock.yaml] }
  risk: { skill: judge } # a model reads the chain's commits and may fire it
repos:
  acme/backend:
    gates:
      schema: { changed: ["src/db/schema/**"] } # joins the top-level schema globs
      queues: { changed: ["src/jobs/**"] } # only this repo has it
```

Top-level gates apply to every repo, and a repo's `gates` can only add to them. A gate both define fires on either's globs, and when both have a `command` or a `skill`, both run and either one fires it. There's no way for a repo to turn off or loosen a top-level gate.

A command gate diffs the chain's commits from `$AWAYWORK_FROM`: the commit the chain started from, or git's automatic merge on a [`sync`](./chains.md#conflicts) a model resolved.

```sh
#!/bin/sh
# scripts/route-diff.sh: fires when the chain adds a route
routes=$(git diff --text "$AWAYWORK_FROM" HEAD -- src/routes | grep -E '^\+ *router\.(get|post)')
[ -z "$routes" ] || { echo "$routes"; exit 1; }
```

Diff from `$AWAYWORK_FROM`, never from a branch like `origin/main`: the clone's refs are the agent's to move. What else the agent could use to blank the diff, and what awaywork does about it:

- Replace refs: the command's git ignores them.
- Attributes, where a `* -diff` turns the diff into `Binary files … differ`: awaywork deletes `.git/info/attributes` before the command runs, and git reads `.gitattributes` files, committed or not, from the commit the chain started from rather than the worktree. Older git ignores that last part, hence the `--text`.
- The steps' git config, where a `diff.external` or a textconv driver blanks the diff: the command's git reads a fresh global config awaywork writes instead, with your identity and git-lfs's filter but no attributes file.

### The decision card

Gates run on every chain that publishes commits, once its steps are done, right after `verify`, judges last, on the chain's own commits. A fired gate puts a decision card first in the PR body, right under the title, above the agent's own text and awaywork's chain notes:

```markdown
## Needs a decision

### Gates (from scripts)

- schema: migrations/20261023_add_vat_mode.ts
- routes: + GET /exports/vat   + POST /exports/vat/retry

---
```

When none fired, that spot holds one line naming the gates that ran, closed by the same rule:

```markdown
Gates: none fired (schema, routes, deps)

---
```

So whenever a repo has gates, awaywork's section comes first in the body and anything the agent wrote is below the rule, a card it made up included. That's what it guarantees, and no more. A repo without gates gets no section. A `changed` line lists the first three matching paths and how many more; a `command` line is its stdout on one line, cut at 300 characters, or why it failed when it printed nothing.

What a fired gate changes, by `deliver`:

- `pr` opens the PR as a draft, and the report says which gates fired, like `draft: gate schema fired`.
- `draft_pr` was a draft anyway: only the card is new.
- `push` still pushes onto your PR. Its body is yours, so the section tops the push's summary in the morning report instead: `1 commit pushed onto feat/vat-export, gate schema fired, report below`.
- `report`, `plan` and `pending_review` commit nothing, so none of these gates runs: a plan or report rule takes [gates of its own](#gates-of-a-rule-s-own).

A `deliver: pr` run where the schema gate fired ends like this, the card's lines under the unit:

```text
Run 20261024-031502: 1 draft PR, 0 reports, 1 unit
     item         skill      status          result
  1  backend#412  implement  done, 14 turns  https://github.com/acme/backend/pull/88, draft: gate schema fired
     - schema: migrations/20261023_add_vat_mode.ts
```

### Gates fail closed

A command that can't run, times out, is stopped or isn't run on an untrusted author's PR fires its gate with the reason, like ``- routes: `scripts/route-diff.sh` not checked: timed out after 15 min``.

The agent could also rewrite the script that judges its work. So right before a command runs, awaywork compares each file it names with the same path at the commit the clone started from, before `setup` or any agent ran, or, on an awaywork PR a rule took up, where that PR left the default branch.

A file that differs, is new or is gone fires the gate without running the command, as ``- routes: `scripts/route-diff.sh` changed, not run``. That holds whether the change is committed, left uncommitted, hidden from `git status`, or made by `verify`.

- That only works when the command names its script by its path from the repo root, as a word of its own: `scripts/route-diff.sh` in `bash ./scripts/route-diff.sh` or `(scripts/route-diff.sh) && echo ok` counts, but `cd scripts && sh route-diff.sh` doesn't.
- A file the command names that wasn't there when the chain started always fires it, so don't name one the command writes.
- Only the named files are compared, and a command gate runs repo code the agent may have changed: a helper the script sources, the repo code it calls, a module its interpreter loads from next to it. `python3 scripts/gate.py` imports a `scripts/json.py` the agent committed before the real `json`, so run Python with `-I`; Node looks for `node_modules` up from the script the same way.

A `changed` gate is the one to trust: awaywork computes it from the commits it pushes. See [Safety](./safety.md#what-awaywork-publishes).

### Judges

A `skill` gate is a judge: a model that reads the chain's commits and fires the gate when it finds something a human must decide. Once the scripts ran, awaywork runs that skill in the chain's clone as one more model run, routed on the rule's providers and models like a step, and tells it which commit to diff from and to change nothing.

The built-in `judge` looks for schema and data changes, public routes and API contracts, money and rounding, auth, infra, performance-sensitive paths, dependency changes, anything irreversible. Name your own skill to judge by your rules; it comes from your skills or the built-ins, never the repo's.

A gate's `instructions`, files relative to the config file, reach its judge's prompt: your rules for what needs a decision, `risk: { skill: judge, instructions: [judges/money.md] }`. The rule's instructions and the repo's stay hidden from it, as they're written for the agent it judges.

A judge that writes `fires` to `.away/out/verdict` fires its gate, the first ten lines of its `report.md` going into a Judge part of the card, after the scripts':

```markdown
## Needs a decision

### Gates (from scripts)

- schema: migrations/20261023_add_vat_mode.ts

### Judge

- risk: VAT rounding moved from the invoice total to each line → totals change on open invoices

---
```

- Any other verdict, or none, adds nothing. Scripts set the minimum and a judge can only add: it can't clear a script's gate, even one with its name.
- It reads what the agent wrote, `// reviewed: safe` comments included, so it can be fooled, and then it just doesn't fire.
- It can't change what gets published. When it leaves a commit, a moved HEAD, an uncommitted change or a changed file in `.away/out/`, awaywork puts it all back as it was and fires the gate with `the judge changed the clone; awaywork dropped its changes`. A worker process that outlived the watchdog could still change a file after that.
- It fails closed too: a judge that errors, times out, is stopped or can't run fires with `judge didn't run: <why>`, so a run out of quota drafts its `deliver: pr` PR.

Each judge is one more model run per published chain, on the same quota as the steps. The run's log says `acme-backend-412: gate risk, judge on claude`, and the judge's worker log sits next to what the chain published, as `out/judge-risk-judge.log`.

### Gates of a rule's own

A `deliver: plan` or `deliver: report` rule takes `gates` of its own, on top of the top-level ones, which never run there: there's no diff. They run once the step left its report, on what it left, and one that fires makes the [post wait](#posts-that-wait) for your approve, with the decision card on top of it:

```yaml
queue:
  - skill: plan
    deliver: plan
    wait: false # goes ahead unless a gate fires
    gates:
      product: { skill: judge, instructions: [judges/product.md] } # your rules, from the config only
      size: { command: scripts/plan-size.sh } # reads $AWAYWORK_OUT_DIR/plan.yml
```

- A command gets `$AWAYWORK_OUT_DIR`, a read-only copy of the step's `.away/out/`: its `report.md`, the post's text, a plan's `plan.yml` and any other file it wrote.
- A judge gets the same copy, and its prompt says it judges those files against the item, not a diff. The built-in `judge` looks there for product calls: acceptance criteria that can go two ways, UX or copy, scope the card doesn't settle, data kept or shown to someone new, a contract another team owns.
- Whatever a gate changes, the post is what the step left: awaywork puts `.away/out/` back before posting, and a judge that changed it fires.
- None fired: the post carries `Gates: none fired (product, size)` on top and goes ahead under `wait: false`, its mark line naming the gates that ran clear.
- A rule gate takes `command` or `skill`, never `changed`, and no name a top-level or repo gate has; on any other `deliver` gates are a config error for now.

## Plans

A feature that spans a few PRs doesn't fit in one unit, and a hand-written list of cards is the chore you wanted gone. Give the feature's card a rule with `deliver: plan`, and its step splits the work into tasks you approve before any starts:

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

The second rule takes the plan's [tasks](#tasks) once you approve it. Every step of the plan rule reports, as under `report`, and the prompt asks for `.away/out/plan.yml` too. The built-in `plan` skill writes it; any skill can.

### `plan.yml`

`tasks:` holds at most `limits.plan_tasks` tasks (8 by default), each with:

- `id`: lowercase letters, digits and dashes;
- `title`, and optionally a `description`;
- `skill`: one a `planned` rule takes, `implement` when unset;
- `repo`: the card's when unset, or another the config names, see [Across repos](#across-repos);
- `ships`: the files its PR will hold that tasks in other repos need;
- `after`: other task ids mapped to `merged`, `opened` (see [The feature block](#the-feature-block)) or the name of a check on that task's PR (see [Waiting on a check](#waiting-on-a-check)).

Next to `tasks:`, an optional `contract:` names one file the step wrote under `.away/out/`, an OpenAPI diff or a schema the tasks share, which awaywork posts with the plan.

The prompt lists the skills the `planned` rules take, marking `(reports)` the ones whose rule opens no PR: a skill whose metadata reports, like `review`, or a chain whose steps all report. Those make [report tasks](#report-tasks), which nothing can wait on.

awaywork checks the file in plain code, outside the model:

- ids unique and not [retired](#tasks), under the cap;
- every skill taken by a `planned` rule, no `after` naming a report task;
- every repo one the config names, `ships` paths inside the repo;
- every `after` naming another task, no cycles, a task's `opened` and check tasks in its repo on one chain;
- a `contract` under `.away/out/`, no key it doesn't know.

### The plan comment

awaywork posts the report, the contract and the file as one comment on your item, the one [questions](#questions) would go to. The model writes the report and the file; awaywork adds the fence, a [contract](#across-repos)'s heading and fence when there's one, and the last two paragraphs:

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

Until you answer, the card is skipped as **waiting for your approval**, under Needs you:

```
Needs you 1
  tracker ENG
    ENG-2101  Export VAT report  approve
              plan
```

### Your answer

- **Approve** with a reply from your own account whose first line is `approve`, in any case; the lines below it are notes for the tasks. `awaywork approve <source:key> [notes]`, or `a` in the report, posts that reply for you, marked like every comment awaywork writes, through the same ownership check, and refuses a plan you already answered. The next run [fans it out](#tasks):

  ```text
  $ awaywork approve tracker:ENG-2101 Leave voided invoices out.
  plan approved: replied approve, with your notes, on https://acme.atlassian.net/browse/ENG-2101
  ```

- **Anything else of yours is feedback:** a reply that doesn't start with a bare `approve` (`approve if web waits` included). Your reply changed the card, so the next run plans again with the whole thread in `item.md`, the plan headed `awaywork's plan`, and posts a new plan, which waits for a fresh approval whatever `wait` says. A re-plan that isn't posted is skipped as unchanged until the card changes again.
- **Only you answer.** A plan's answer is your first reply after it, read off the card: a teammate's comment, a code owner's or a bot's is context in `item.md`, never an answer, and a later comment of yours changes nothing. Edit your reply to change your mind before the next run reads it; a reply someone else edited isn't yours anymore.
- **`wait: false`** posts the plan and goes on. The post says so on its mark line (`— awaywork · went ahead`) and that a reply to it changes nothing; it counts as its own answer, and the next run fans it out with no notes. Its [gates](#gates-of-a-rule-s-own) still run, and one that fires makes it wait, its decision card on top of the plan.

### Details

- The plan is read off the card on every run, never the state dir: it's awaywork's newest plan comment, so a fresh runner waits too. GitHub reads the card's whole thread, past its last 50 comments, so an old plan up a long thread still counts.
- Edit the plan comment to fix a task and the next run checks your edit again. An edit that breaks it skips the card as **plan refused** with the reason, under Needs you, instead of planning over your edit. A plan comment someone else edited isn't awaywork's anymore ([Safety](./safety.md#what-awaywork-publishes)), so the card has no plan and gets a new one.
- A plan is never posted when it fails its checks, in the file or as the next run reads it back from the comment, when `plan.yml` or the contract is missing, or when the comment is over 30 KB, the contract included (a [lean](#files-that-come-back) one pins them instead). The reason stays in the morning report, as `plan not posted: plan.yml: task id "api" is used twice`, and `on_done` doesn't fire.
- The same goes for an item that isn't yours, a source that can't write on a rule without a [thread](#threads), or a post that fails. A step that asks [questions](#questions) instead posts those, and the card waits for your answer as usual.
- A `deliver: plan` rule that matches only merged or closed items, names a `source` that can't write without [`thread: github`](#threads), or has no rule whose `where` names `planned` to take its tasks, is a config error.

### Tasks

Approve the plan and it fans out: each task becomes a child item keyed `ENG-2101/api`, which goes down the queue like any item, on its own branch, `away/ENG-2101-api`, and opens its own PR. The card makes no unit of its own anymore.

- A task only matches rules whose top-level `where` names `planned`, and only the first of them whose `skill` is the task's; a rule naming `planned` takes nothing else. So caps, attempts, `skip`, gates and chains work on tasks as on anything else.
- Tasks without `after` run in parallel; `after` orders them, and a card's tasks run back to back, as one [block](#the-feature-block).
- A task carries the card's source, URL, owner and fields, the card's repo unless the plan names another, and the card's whole thread, so `where: { planned: true, labels: backend }` works.

Its `item.md` is awaywork's own, the task first:

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
[...]
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

A task's PR links back to the card but never closes it, and its footer names only the task, so the card never links its tasks' PRs and isn't folded into one of them:

```markdown
VAT export endpoint

Adds `GET /exports/vat`, paged like `/exports/sales`, with a test.

Part of https://acme.atlassian.net/browse/ENG-2101

---
<!-- awaywork run=20261026-220012 item=tracker:ENG-2101%2Fapi -->
Opened by awaywork (run `20261026-220012`): a coding agent worked on this unattended. Review it like any other contribution.
```

#### The plan sticks to the card

Once awaywork's plan comment is on an open card of yours, the card goes to the `deliver: plan` rule it matches, else to the first one for its source whatever that rule's `where` says now, and no other rule takes it whole. `awaywork plan --rules` lists it under that rule, with `(plan)` after its key when the rule's `where` no longer holds it.

So a `planned` rule's `on_done: { move: In Progress }` can move the card out of a plan rule on `status: To Do` and the remaining tasks still run, where a catch-all `implement` rule further down would otherwise pick the card up as one unit.

- It leaves the plan flow when it's closed or reassigned (who owns it is read every run), and `awaywork skip` on the card holds it and all its tasks.
- Someone else's edit to the card's only plan comment makes that comment not awaywork's, so the card goes back to ordinary matching.
- With no `deliver: plan` rule left for its source, the card is matched like any other, so a catch-all may take it whole next to its open task PRs.

#### Task details

- **Questions from a task** go on the card, headed `Questions from task api`, through the same ownership check as any write; `item.md` heads them `awaywork's questions from task api`. While any task's questions wait, the whole feature does: every task of the card is skipped as `waiting for your answer to task api's questions`. The first comment after them that's neither a bot's nor awaywork's answers them, so one reply under two tasks' questions answers both.
- **A task's PR is its result**: a task that opens one posts nothing else on the card. A [report task](#report-tasks) posts its report there instead.
- **Writes go to the card.** A `planned` rule's `on_done` moves the card, and a task never writes anywhere else. Whether the card is yours is read off it every run: reassign it and nothing fans out or writes (`plan approved, but the card isn't yours: its tasks don't run`).
- **A task PR closed without merging** after the plan was posted makes the card plan again, though closing the PR didn't touch the card.

  Its id is retired: the prompt names it and its PR, along with the tasks whose PR is open or merged, and a plan reusing a retired id isn't posted (`plan not posted: plan.yml: task id "web" is retired: its PR https://github.com/acme/api/pull/42 was closed without merging`). The new plan needs a fresh approval, even under `wait: false`, and no task runs until then; a task that keeps its id keeps its PR, merged or open.

- **A task's branch is its name for good.** When something else holds `away/ENG-2101-api`, the task is skipped with `delete it to run this task` rather than taking `-2`, which its PR lookup wouldn't find.
- A configured [`branch`](./configuration.md#branch-names) template renders from the task's key alone, so a re-plan that retitles a task keeps its PR: `{title}` or `{type}` in the template a `planned` rule uses, its own or the one it inherits, is a config error. A re-plan may also hand a task another skill, and so another `planned` rule, so every `planned` rule for a source sets the same `branch`, or none does.
- A task branch awaywork pushed whose PR then failed to open still reads `no PR yet` on the card and in `awaywork plan`, since the PR is the task's state. The run skips it, `away/ENG-2101-api exists on acme/api without a PR; delete it to run again`, in each morning report; delete the branch and the next run starts the task over.
- A task takes no approval of its own: the plan's covers it, so it has no `approved`, `awaywork approve tracker:ENG-2101/api` is refused, and a `planned` rule takes no `wait` or gates of its own.
- On [Bitbucket](./configuration.md#bitbucket-and-jira) it all works the same, through twg. A declined or superseded PR counts as closed unmerged, when it was last updated, and a stacked task's PR goes into the branch of the one below, since Bitbucket has no stacks. A task whose draft says `continue`, or asks, holds its dependents back as on GitHub, but it's yours to [finish](#continue).

### Report tasks

Not every task ends in a PR. For QA evidence, a write-up or a prototype link, give the skill a `planned` rule that reports, and the plan can hand it a task:

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

The task runs like any other, `after` included. Its result is its report, posted on the card once its chain finished, the way [`on_done: { comment: result }`](./configuration.md#on-done) would, without being asked. `item.md` heads it `awaywork's result of task qa`. Like any comment of awaywork's it's no answer to anyone's questions, a plan's included, and it doesn't count as a change to the card:

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
  - id: web
    title: Export button
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
  [...]
  after api opened (PR #41 open)
  planned
    [...]
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

#### Stacking details

- **One chain.** A task's `opened` tasks, its check ones too, lie on one chain, each after the one before, and it stacks on the last of them. With `api` after `{ schema: opened }`, `web` after `{ api: opened, schema: opened }` stacks on `api`, which holds `schema`. Two that aren't on one chain leave nowhere to stack, so the plan isn't posted: `task web: its opened tasks api, schema aren't on one chain: make each after the one before, e.g. schema after api: opened`.
- **A merged PR in the stack.** The task stacks on the first PR down the stack that hasn't merged. With `api`'s PR merged into `schema`'s branch, `web` after `{ api: opened }` stacks on `schema`, as `after api, stacks on schema's #10`, and it's cut from the default branch only once the whole stack merged.
- **`merged` and `opened` mix** on one task: `merged` says when it can start, `opened` where. `web` after `{ schema: merged, api: opened }` waits as `waiting for task schema's PR to merge`, and once it merged, stacks on `api`. `merged` means on the default branch: when `api` stacks on `schema` and merges into `schema`'s branch first, `web` after `{ api: merged }` waits as `waiting for task schema's PR to merge, api's merged into it`.
- A task waiting on an `opened` task that doesn't run this run (it's waiting for an answer, unchanged, gave up, left out by a cap) is skipped as `waiting for task api's PR to open`. Caps and the window's end can cut a block; the next run carries on from the task with no PR.
- **No secrets in a stacked setup.** A stacked task is a unit like any other, with its own clone, `setup` and branch. That clone starts on a branch a worker wrote, so `setup` gets none of the repo's `secrets`, as on any awaywork PR a rule takes up again ([Safety](./safety.md#what-the-agent-can-reach)). A repo whose `setup` needs a secret, a private registry token for `pnpm install` say, can't use `opened`: every stacked task fails setup, run after run. Use `merged` there.
- **Merge the stack bottom-up.** Once `api`'s PR merges and its branch is deleted, GitHub retargets `web`'s to the default branch; awaywork does nothing there. A squash merge leaves `web` carrying `api`'s commits: merging the default branch into it usually resolves cleanly, since the content is the same.

### Across repos

A feature rarely stays in one repo: the endpoint goes in `acme/backend`, the button that calls it in `acme/web`. A task's `repo` can be any repo the forge source's `repos` globs cover (`sources.github.repos`), or one named under [`repos`](./configuration.md#repos-and-instructions); unset, it's the card's. A card with no repo of its own needs a `repo` on every task.

Anything else isn't posted: `task x: repo evil/x isn't the card's (acme/backend) or one the config names`. Case counts, since the repo's settings and caps go by its exact name: `task web: repo Acme/Web isn't acme/* as configured`.

The plan step can also write a contract, the interface the tasks agree on, and name it in `plan.yml`. A task can list in `ships` the files its PR will hold that tasks in other repos need, like the spec a client is generated from:

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
    [...]
```

```yaml
contract: .away/out/openapi.yaml
tasks:
…
```

To approve, reply with approve as the first line; the lines below it reach the tasks as notes. Any other reply is feedback: awaywork plans again with it.

— awaywork
````

It's part of the plan, so you approve it with the rest:

- It counts toward the 30 KB unless the plan is [lean](#files-that-come-back), it must read back from the comment as the file it was, and your edits to it are checked again on every read.
- A contract the file names but the step didn't write isn't posted (`plan not posted: plan.yml: contract .away/out/openapi.yaml is missing or empty`), and an edit that drops it from the comment refuses the plan (`plan refused: contract .away/out/openapi.yaml isn't in the plan comment`).
- Every task finds it in `.away/context/<task>/contract/openapi.yaml`, next to its `item.md`, and its prompt says it was approved with the plan.

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

`plan --why ENG-2101/web` says the same: `task web of the plan on ENG-2101, in acme/web`, `after api opened in acme/backend (no PR yet)` and `waits for api's PR in acme/backend`.

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

A task in the same repo gets no `shipped/`: a stacked one already has the files in its branch, and a `merged` one is cut from a default branch that holds them. On Bitbucket a shipped file is read through twg (`twg bb repo file`), at the PR's branch or, once merged, its head commit.

The card, run by run:

| What happened | The card | Its tasks |
| --- | --- | --- |
| You approved | `fanned out: api no PR yet, web no PR yet` | `api` opens its PR in `acme/backend`, then `web` runs in `acme/web`, cut from its default branch, with the contract and `api`'s `openapi.yaml` |
| `api`'s PR has no `openapi.yaml` | `fanned out: api PR open, web no PR yet` | `web` is skipped as `api's PR has no openapi.yaml`, every run, until `api`'s PR has it |
| `api` merged before `web` ran | `fanned out: api merged, web no PR yet` | `web` runs, with `openapi.yaml` as `api`'s merged PR left it |
| Both PRs are open | `fanned out: api PR open, web PR open` | both wait for your review, each in its repo |

### Waiting on a check

Some work needs more than an open PR: the button wants the endpoint deployed to try against. Vercel, Netlify and Expo report their previews as checks on the PR, so name the check in `after`, exactly as the PR shows it:

```yaml
tasks:
  - id: api
    title: VAT export endpoint
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

The check reads `pending`, `failing` or `not reported` (no check by that name on the head, check the spelling), or `no PR yet`. A failing check keeps waiting, since a [`fix`](./configuration.md#queue-rules) rule may fix it, or you re-plan.

A check never passes in the run that opened the PR, so a task after one never joins that run's [block](#the-feature-block): `api` opens its PR tonight, and `web` runs the first run after its preview is up. Once it passed, `awaywork plan` says so, and `plan --why` adds the check's repo and PR (`after api's check Vercel Preview in acme/backend (PR #41 open, passed)`):

```text
Units 1
     item          rule  skill                 provider  deliver  title
  1  ENG-2101/web  #2    implement (built-in)  fake      pr       Export button
     in acme/web
     after api's check Vercel Preview (passed)
```

- In the same repo a check's name stacks like `opened`: `web` is cloned from `api`'s branch and its PR stacks on `api`'s (`after api's check Vercel Preview (passed), stacks on #41`), and it counts with the `opened` tasks toward the [one chain](#stacking-details). In another repo it only waits, and gets what the task ships, as `opened` does there.
- awaywork reads a PR's checks only when some task names one of them, so a plan without check names costs no extra calls, and a read that fails skips the card, like a task PR it couldn't read. `plan --json` has them on the card, under `taskPrs.api.checks`.
- On Bitbucket, checks are the build statuses on the PR's head commit, by name, read with `twg bb prs get --statuses`; `SUCCESSFUL` passes, `INPROGRESS` is pending, `FAILED` and `STOPPED` are failing. Check the status name is the same on every build before you put it in `after`: one that carries a build number never matches.

The card, run by run:

| What happened | The card | Its tasks |
| --- | --- | --- |
| You approved | `fanned out: api no PR yet, web waits for api's check Vercel Preview` | `api` opens its PR; `web` is skipped as `waiting for api's check Vercel Preview (no PR yet)` |
| The preview is building, or failed | `fanned out: api PR open, web waits for api's check Vercel Preview` | `web` is skipped as `(pending)` or `(failing)` |
| The preview is up | `fanned out: api PR open, web no PR yet` | `web` runs, cut from `acme/web`'s default branch, with `api`'s `openapi.yaml` |
| `api` merged first | `fanned out: api merged, web no PR yet` | `web` runs: a merged PR counts as passed |

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
- **Approved, it hands the item on.** The item's `approved` becomes the post's skill, read off the thread, so `where: { approved: story }` takes it even on a tracker awaywork can't move cards on; a newer post that waits leaves it on the one before.

  The rule that posted it is done with the item and passes it down the queue. With no rule after it, the item is skipped as `#1 story doesn't run again: you approved its result; to run it again, delete that post on <url>`. Deleting awaywork's post is how you run that stage again, with `awaywork run --unit <key>` when the card didn't change since.

- **`on_done` waits too.** A post that waits holds its `move` and records the card's status. The first run that sees your `approve`, a window, `soon` or manual one, makes the move the post names, even if `on_done` changed since, before planning any unit, with no model run.

  It moves only while the card is still in the status the post saw (on GitHub, while the label isn't on it yet) and no newer awaywork post is on the item. A dry run only says it would; the run's report lists the move, or why it failed, under Held moves. Moving or reassigning the card yourself releases the post:

  ```text
    on_done: moved ENG-2101 to Ready for design, its post approved
  ```

- **Gone ahead.** A report rule with [gates of its own](#gates-of-a-rule-s-own) and no `wait` goes ahead when they ran clear: it posts its result with the gates line on top (`Gates: none fired (taste)`), its mark line saying `— awaywork · went ahead · gates=taste`, and `on_done` moves the card at once. That post counts as approved. A gate that fires makes the post wait, with the decision card on top of it, as on a PR.
- A report rule that waits, or has gates of its own, needs a source that can write, or a [thread](#threads): one that names a `source` that can't is a config error, and `doctor` warns about any it may match. `wait` and rule gates on a `pr`, `draft_pr`, `push` or `pending_review` rule are a config error for now: the PR is already the decision.

The simplest two-stage queue plans the sprint's tasks as reports and implements the ones you approve:

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

`plan` posts its report on the task and waits for your reply. On your `approve`, the next run hands the task to `implement`, which finds the plan as its earlier report. While `implement`'s draft PR is open the task waits for review; once you merge it, move the task out of the section, and neither rule takes it again.

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

The rule's first post opens it, titled with the card's key and title, and posts there. A custom source's card:

```
CARD-1: Export VAT report

awaywork posts here for [CARD-1](https://tracker.example/CARD-1), Export VAT report: its plans, results and questions. Reply here to answer them; the card still decides whether it's yours.

<!-- awaywork thread item=tracker:CARD-1 -->
```

- **Found again, not remembered.** Each run lists the open issues you opened in the card's repo and takes the one whose marker names the card, so nothing goes in the state dir and a runner without state finds it too. It isn't an item: the GitHub source leaves out issues carrying the marker, or a plan rule would take the thread itself.
- **It's the card's thread now.** Its comments follow the card's in `item.md` and everywhere awaywork reads posts, so plans, posts that wait, held moves, [pins](#files-that-come-back) and questions work there as on a card.

  From then on every post awaywork makes for the card goes there, other rules' and the plan's tasks' too, so keep a card's rules on one thread. A reply there counts as a change to the card, awaywork's own posts don't, so your feedback runs the step again though the card didn't move.

- **Your reply decides**, as on a card: reply `approve` on the issue, or `awaywork approve jira:ENG-2101` (the thread's own key, `github:acme/api#57`, works too). A teammate's `approve` there is context. Skips point at the thread:

  ```
  Needs you 1
    CARD-1: waiting for your approval of story's result on https://github.com/acme/api/issues/212
  ```

- **The card still decides.** Whether it's yours is read off the card every run: reassign it and its thread neither fans out nor takes answers. `on_done` moves stay on the card: a card that can't move holds no move on a post that waits, and a plain post's move reports `couldn't move ENG-2101 to "Ready": jira can't write to its items`.
- **Its end.** Once the card's source says it's done, closed or merged, read back a week, the next run comments and closes the issue; a dry run says `would close`:

  ```text
    closed https://github.com/acme/api/issues/212, CARD-1's thread: the card is closed
  ```

  Every task merged isn't the end: the card says `all tasks done: close or move the card` until you do, and its thread stays open with it. Close the thread yourself and the next post opens a new one. A thread whose card leaves your items without reading as done (reassigned, moved to another `repo`, or closed while no run read back that week) stays open: close it yourself.

- **Or a host of your own.** `thread: <source>` names a custom source with `thread: true` instead, a Notion database or a folder of Markdown files in your vault, which opens and lists the threads itself: see [Thread hosts](./custom-sources.md#thread-hosts). That's the one for a Bitbucket config.
- `thread: github` needs repos on GitHub: on a Bitbucket config it's a config error. It goes on the plan's rule, never a `planned` one: tasks post where their plan did. Thread writes use the `gh` login awaywork opens PRs with, never the worker's.
- A GitHub issue pings its assignee; a host that notifies nobody, a folder of Markdown files say, wants a [notify](./configuration.md#notify) hook next to it, or a plan there waits unseen.

## Store

A post on the card is a fine place for a decision and a bad one for a 400-line plan, a contract or three screenshots: the team reads that thread at standup, and on a fresh runner whatever stayed in the run dir is gone. `store` is one command awaywork hands each file a post pins. It puts the file wherever you like, Notion, a bucket, a folder, and prints a link. The post gets a short summary and those links, and the next unit that reads the thread gets the files back, on any machine.

```yaml
store:
  command: node store.mjs # runs in the config file's folder, like a custom source's command
  secrets: [STORE_TOKEN] # withheld from workers, listed in Actions
  read: { max_mb: 10, files: ["*.md", "*.yml", "*.png"] } # what comes back; default 10 MB of everything
```

The command gets one JSON op on stdin per call, and runs with your environment like a [custom source](./custom-sources.md)'s:

- `{"op": "put", "item": "ENG-2101", "unit": "eng-2101", "path": "/…/units/eng-2101/out/plan.yml", "kind": "plan"}` prints `{"url": "…"}`. `path` is a copy awaywork made out of the clone, readable while the put runs. `kind` is `plan`, `contract`, `report`, or the file's name under `.away/out/` for anything else the step left, so one script can send recordings to a bucket and plans to Notion.
- `{"op": "get", "url": "…"}` prints the file's bytes, exactly as put. A store that only puts sets `get: false`, and awaywork reads the file back with a plain HTTP GET of its URL, given the command's 10 minutes. With no `get` to refuse a URL, a file that no longer matches its pin never reaches a step there: the edit reruns the step, but the step doesn't get the edited file.

Right after each put awaywork gets the file back once and compares its sha256. A pin is that hash, so a store that hands back other bytes, a CMS adding a newline, Notion turning markdown into a page and back, would make every post look edited. Such a file isn't pinned, and the morning report says `report.md not stored: the store gave back different bytes than awaywork put`. Keep such a store's page for people, and the bytes awaywork reads somewhere that keeps them as they are.

The model never sees a URL before awaywork writes it, and never picks where a file goes. A tiny store that keeps the files in a folder next to it, at `file://` URLs, which is enough for one machine:

```js
// store.mjs: keeps each file awaywork puts in a folder next to it, at a file:// URL.
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const op = JSON.parse(readFileSync(0, 'utf8'))
if (op.op === 'put') {
  const to = join(dirname(fileURLToPath(import.meta.url)), 'files', randomUUID(), basename(op.path))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(op.path, to)
  console.log(JSON.stringify({ url: pathToFileURL(to).href }))
} else {
  const path = fileURLToPath(op.url)
  // A pin line anyone could write names this URL: read only this store's files.
  if (!path.startsWith(join(dirname(fileURLToPath(import.meta.url)), 'files', '/')))
    throw new Error(`not in this store: ${op.url}`)
  process.stdout.write(readFileSync(path))
}
```

Three things are the script's job, not awaywork's:

- **A URL that lasts.** The link is read back days later, from the post. An S3 presigned link expires within a week, so sign it again in `get` from a key you put in the URL, or pick a host whose links don't expire.
- **Secrets in what leaves.** A log or a recording can hold a token the agent saw on screen. Redact before the file leaves the machine, or keep those kinds out of the store.
- **Only its own URLs.** awaywork reads pins only off its own posts and the PRs it opened for you, and on GitHub and Jira it skips any of those someone else edited last, so a teammate can't swap in a pin there. Asana, Linear and a custom source don't say who edited a comment, so a teammate who can edit yours can edit a pin line too. A `get` that refuses any URL it didn't print, as above, keeps the store from fetching whatever they name.

  A store with `get: false` has nothing to refuse with. A file that doesn't match its pin is left out of the step, which catches someone changing the file in the store. It doesn't catch someone rewriting the pin line, since the hash sits on that same line: a new URL with its own hash passes, and awaywork already fetches that URL at every `plan`. On those sources, `get: false` trusts whoever can edit the post.

When the store fails:

- A put that fails leaves the file in the run dir, pins nothing for it and gets a line in the morning report (`fail.bin not stored: Command failed with exit code 1: …`, or `printed 11 characters that aren't JSON, not {"url": "…"}`, never quoting what it printed); the post and the PR still go out.
- A lean report whose own `report.md` didn't make it posts the whole report in place of its summary, its other pins kept, and the morning report says so; over 30 KB that fails like any result.
- A get that fails on a post the unit depends on (the one an approval covers, its own when it runs again, a PR's footer) skips that unit, with why, as `fix store`, and counts no attempt.
- On any other post it only costs that post's files and a line in the morning report (`left out awaywork's post of …: couldn't read plan.yml from the store: …`), so an expired `plan.yml` on an older plan stops nothing.

What comes back and when is in [Files that come back](#files-that-come-back).

## Files that come back

With a [store](#store), a plan or report rule's post is lean. The step writes `.away/out/summary.md`, a few lines for whoever reads the thread (its prompt asks for it), and awaywork posts that, its own facts and a pin per file the step left, everything else in the store. One from the example store:

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

A lean plan shows its tasks instead of `plan.yml`, which is pinned with its contract and report, so only its summary and task list count toward the 30 KB comment limit:

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

- `post: full` keeps the whole comment, the report inline, and pins only the other files.
- A step that wrote no `summary.md` gets its report's first five lines and a line saying so in the morning report.
- Pins sit below everything the model wrote, right above the mark, so a `Pinned` line in a report pins nothing.
- A PR step's files, screenshots say, are pinned in the PR body's footer the same way.
- Without a store nothing changes: posts are full, and the files stay in the run dir, where the [notify](./configuration.md#notify) hook reads them.

### What comes back

Before a unit's worker starts, awaywork reads its items' threads and gets the pinned files into `.away/context/<item>/files/<post>/`, a folder per post named by its place in the thread, e.g. `2-story/`. It gets:

- the files of the post an approval covers (a task's plan, the result `approved: story` names);
- its own newest post when it runs again on your feedback or a `continue`, and every post newer than that;
- on a unit on a PR awaywork opened for you, its footer's.

A post in there the unit doesn't depend on, an older plan or a newer report, costs only its own files and a morning report line when a get fails. The post an approval covers, its own when it runs again and the footer skip the unit instead.

- A footer file that changed since awaywork pinned it is left out, with a line in the morning report: nothing reruns on a PR body. A stranger's PR carrying awaywork's marker gets nothing read back at all.
- The worker still holds no token, and its prompt calls those files data, like `item.md`: someone else wrote them.
- A lean plan's tasks read its `plan.yml` and contract through `get`; what a task `ships` still comes from its PR's head.
- `read.max_mb` caps what one unit reads back, 10 by default, and the rest stay links, named in the morning report. A pin carries its file's size, so one over the cap isn't even fetched. `read.files` narrows it by name, `*.md` matching `notes/a.md` too.

### An edit is feedback

awaywork hashes each file as it puts it and checks the hash when it reads it back. Every `plan`, run and watch poll reads back the files of the posts that decide a rule, within the cap: a plan's, and a waiting or approved report's. One that doesn't match makes its post stale, and that counts as your feedback, whoever edited the file.

The step runs again, though the card didn't change, with the edited file in context and its path in `files/EDITED`, one per line, which its prompt calls feedback on the step's work, and posts again. A rule that waits needs a fresh `approve` on that new post, so you only approve what awaywork has seen. On a store with `get: false` the edit reruns the step but doesn't reach it: with no `get` to refuse a URL, awaywork leaves that file out.

Here a teammate edited `report.md` in the store, and the next run went again:

```
  1  api#206  story  done    report
     Full report of story.
     report.md of awaywork's post of 2026-11-07T19:31:26Z changed in the store since awaywork pinned it
     result posted on https://github.com/acme/api/issues/206#issuecomment-6712036203; it waits for your approve
```

So edit the plan in Notion freely, then approve what comes back. A full post on the card keeps the card's rule: your edit of the plan comment counts, someone else's voids it.
