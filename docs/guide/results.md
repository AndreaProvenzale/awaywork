---
description: Where a unit's results go and who sees them, from the morning report and pending reviews to draft and ready PRs, and the notify hook that runs your command after each step and each run.
---

# Where results go

The model writes the content, the config picks the destination, and awaywork or your own [notify](#notify) hook does the write, never the model. The integrity rules in [Safety](./safety/publishes.md) never move. How far a result reaches is your call per rule, quiet by default.

## Reach and ownership

Who sees the result, and whose thing it lands on:

| Reach | Your PR, issue or task | Someone else's PR |
| --- | --- | --- |
| Only you | awaywork: `report` into the morning report, `pending_review` on your own PR (submittable only as a comment). Your hook: a note to yourself, like [ntfy](../examples/ntfy-report.md) | awaywork: `report`, `pending_review`. Your hook: the same note |
| Visible, nobody asked to look | awaywork: `draft_pr` (default), `push` onto your PR's branch. Your hook: PR labels, a Notion page, a Slack message | awaywork: nothing, it stays private. Your hook: a Notion page, a Slack message |
| Pings someone | awaywork: `pr`, a ready PR, which asks the code owners. Your hook: reviewers | awaywork: nothing; you submit the pending review. Your hook: a Slack @mention |

The `deliver` values are in [Delivery](./how-it-works.md#delivery), set per rule in [Queue rules](./config/queue-rules.md).

## Built in

- **Ready PRs:** `deliver: pr`, a draft still when the chain went wrong, a step asked or said `continue`, or a [gate](./workflows/gates.md) fired. A draft a later run [finishes](./workflows/questions.md#continue) turns ready.
- **Decision cards:** a fired gate tops the PR body with a "Needs a decision" card, or a plan or report rule's post for [its own gates](./workflows/gates.md#gates-of-a-rule-s-own); with none fired, a `Gates: none fired (…)` line. On a `push` the body isn't awaywork's, so the card tops the report's summary and the push still happens.
- **Review comments:** `pending_review` leaves the report and line comments as your pending review, unseen until you submit it.
- **[Questions](./workflows/questions.md#questions):** posted as a comment on your own item, your reply the answer; commits made first open as a draft that says so. On an item not yours they stay in the report.
- **[Plans](./workflows/plans.md):** `deliver: plan` posts `plan.yml`'s tasks under the report and contract on your card and waits: a reply starting `approve` approves, anything else replans; `wait: false` goes ahead unless a gate fires.
- **[Posts that wait](./workflows/posts.md#posts-that-wait):** a `report` rule with `wait: true` posts on your card and waits like a plan, holding its `on_done` move; your `approve` hands the card to the rule whose `where` says `approved: <skill>`.
- **[Lean posts](./workflows/store.md#files-that-come-back):** with a [store](./workflows/store.md), a plan or report posts `summary.md` and a link per file; the next unit gets the files back on any machine, and an edited file counts as feedback.
- **[Task PRs](./workflows/tasks.md):** each approved task opens its own PR, per its `planned` rule's `deliver`, in the card's repo or [another](./workflows/tasks.md#across-repos) the config names, with `Part of <card>` instead of `Closes`.
- **Task posts:** a task has no item, so it writes to the card: questions headed `Questions from task api`, a reporting task's report headed `Result of task qa`, and a `planned` rule's `on_done` move.
- **[`on_done`](./config/queue-rules.md#on-done):** `move` sends your own items to a status, state, section or label once the chain published, never someone else's PR; `comment: result` first posts the result (a report, or a link to the PR) with a `Status: done` line. A report that said `continue` posts `Status: continue (1 of 3)` and runs again.

## Notify

`notify.command` runs as you, with your environment, on two events in `AWAYWORK_EVENT`:

- **`run`**, when a run ends, dry runs included: `AWAYWORK_REPORT` is the morning report's path, with `report.json` beside it, and `AWAYWORK_RUN_ID` the run.
- **`unit`**, for every step of a unit once it published, before the next unit. None on a dry run; Ctrl-C stops the running one and fires no more.

```yaml
notify:                         # a line per step
  command: >-
    [ "$AWAYWORK_EVENT" = unit ] || exit 0;
    echo "$AWAYWORK_UNIT $AWAYWORK_STATUS $AWAYWORK_PR_URL" >> ~/awaywork.log
```

The command gets both events, so filter as above. `secrets` names the env vars it reads: workers never see them, and Actions passes them from repository secrets. Both events have `AWAYWORK_RUN_ID`; a `unit` event also has:

| Variable | Holds |
| --- | --- |
| `AWAYWORK_UNIT`, `AWAYWORK_SKILL`, `AWAYWORK_STATUS` | The step (`acme-api-12-review-1`), its skill, how it ended (`done`, `failed`, `skipped`...) |
| `AWAYWORK_PR_URL` | On every step of a unit that opened a PR; never on a [`push`](./config/chains.md#push), so a hook can't touch your own PR |
| `AWAYWORK_REPORT` | What the step wrote: its report, or the PR body |
| `AWAYWORK_ITEM_URL`, `AWAYWORK_ITEM_KEY`, `AWAYWORK_SOURCE` | One line per item, in order |
| `AWAYWORK_REPO` | `owner/name` |
| `AWAYWORK_VERDICT`, `AWAYWORK_OUT_DIR` | The step's verdict, and its kept `.away/out/`, which also holds earlier steps' files: check `$AWAYWORK_SKILL` first |

There are no built-in integrations. A failure or a run over a minute is logged (`notify failed for acme-api-1: Command failed with exit code 3: ...`) and the run still succeeds; anything left in the background is stopped. Recipes, ntfy, Slack and Notion among them, are in [Where results go](#examples).

### PR labels, reviewers and ready for review

Ready for review is [`deliver: pr`](./config/queue-rules.md). Otherwise a PR gets the agent's title and body, no labels or reviewers, into the base awaywork picked. `gh` in the hook adds the rest:

```yaml
notify:
  command: |
    set -e
    [ "$AWAYWORK_EVENT" = unit ] && [ -n "$AWAYWORK_PR_URL" ] || exit 0
    gh pr edit "$AWAYWORK_PR_URL" --add-label awaywork
    # every step of the PR fires: ask octocat once, and never on a draft
    skip=$(gh pr view "$AWAYWORK_PR_URL" --json isDraft,reviewRequests -q '.isDraft or any(.reviewRequests[]; .login == "octocat")')
    [ "$skip" = false ] || exit 0
    gh pr edit "$AWAYWORK_PR_URL" --add-reviewer octocat
```

- `set -e` stops at a failing `gh`; the next step tries again.
- `--base develop` moves the base too. Leave it out on a plan's [stacked tasks](./workflows/tasks.md#the-feature-block) and on a rule that takes up an awaywork PR: their PRs sit on another PR's branch, and moving the base breaks the stack.
- It's your token, not a worker's. A reviewer, and the CODEOWNERS a ready PR asks, get notified: treat that like a comment you'd post.

## Examples

Each is a `notify` block. A config has one `notify.command`, so put several in a script and point `command` at its full path. The `unit` event fires for every step, so each recipe first picks its steps. `AWAYWORK_ITEM_URL`, `AWAYWORK_ITEM_KEY` and `AWAYWORK_SOURCE` hold one line per item; most units have one.

- [The morning report on your phone](../examples/ntfy-report.md)
- [A Notion page per plan](../examples/notion-plans.md)
- [A Slack message when a review is ready](../examples/slack-reviews.md)
- [Acting on a skill's own output](../examples/skill-output.md)

## What awaywork won't do

- **Post to Notion or Slack itself:** every service has its own API and token, and your hook covers it in a few lines, with your token.
- **Submit a review, approve, or comment on someone else's PR:** its author wrote what the model read, so can steer what it says. A pending review waits for you to read it.
- **Let a skill pick where its result goes:** a skill writes into `.away/out/` and holds no write token. The rule's `deliver` and your hook decide.
