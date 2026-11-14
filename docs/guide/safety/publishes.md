---
description: "Every write awaywork makes and its guard: new branches, your own PR, its own draft, PR bodies, gates, tracker writes, the store, thread issues, reports and pending reviews."
---

# What awaywork publishes

Integrity rules never move, whatever the config says:

- The model never picks where its work goes and never holds a write token: awaywork does every write, where the config says.
- Nothing force-pushes, merges, approves, pushes onto someone else's branch, or comments on someone's behalf.
- awaywork pushes only [branches that didn't exist](#new-branches-only), unless a rule opts in to fast-forwarding [your own PR's branch](#onto-your-own-pr) (`deliver: push`), or it fast-forwards [its own draft](#its-own-draft), while the draft's head is still the one it left, to continue work it started.
- [PRs it opens](#prs-it-opens) are drafts unless the rule says `deliver: pr`, and go only into the default branch or your own PR's branch.
- It [writes to a tracker](#tracker-writes) only on items a rule matched as yours, its comments marked as awaywork's, at a destination the config names, and puts [files](#files-in-the-store) only in the store the config names.
- It opens a [new issue or page](#thread-issues) only as a rule's thread, one per item a rule matched as yours, assigned to you, at the host the config names, and closes only its own threads.
- A review it leaves (`deliver: pending_review`) [stays your pending one](#reports-and-pending-reviews), which only you see until you submit it.
- Every PR and pushed commit [says it came from awaywork](#the-trailer).

Reach, how loud a PR is, is the rule's choice and quiet by default: a draft that pings nobody, unless a rule opts in to a ready PR or a push onto your PR. On someone else's PR there's only a report, or with `deliver: pending_review` your pending review, both seen by you alone. [Where results go](../results.md) lays out who sees what.

## New branches only

- Only a branch that doesn't exist on the remote, checked before the worker and again at push; a taken name gets `-2` to `-10`. Never someone else's branch, never a rewrite. A plan's task in [another repo](../workflows/tasks.md#across-repos) pushes there the same way, only to a repo the config names.
- Every push, the exceptions below included, uses `--force-with-lease` as a compare-and-swap, not to force: the remote takes the new head only while the branch is absent, or at the clone's start commit, and awaywork checks the head descends from it. A rewrite, or bringing back commits you dropped meanwhile, is refused.
- Nothing is published when the new commits include a merge (but `sync`'s own) or the branch lost the start commit: the harness forbids both, and either carries commits that aren't the unit's.

## Onto your own PR

`deliver: push` adds commits to **your own open PR's** branch as a fast-forward, while the branch is where the clone started.

Right before the push awaywork rereads the PR and refuses if it isn't yours, is closed or merged, has auto-merge on, or its branch is on a fork, the default branch, protected, or another person's open PR's branch too. It's refused on someone else's PR and on items without a PR of yours. The commits land unreviewed where your CI and teammates run, so opt in only where that's fine.

Under [`sync`](../config/chains.md#sync) the push is one merge of the PR's base, which awaywork made before any repo code ran:

- The head must still be exactly that commit; the base's commits go as they are, the trailer on the merge alone. An amend or a commit on top is refused.
- On a conflict, the merge carries the model's resolution, committed by awaywork from the worker's tree on exactly the PR's and base's heads, only the files git's merge holds, so nothing untracked gets in. It went through `verify` and the gates, which read the model's changes on top of git's merge and always the conflicted paths, and the PR is held for review.
- Neither setup nor the worker merges or commits: a moved `HEAD` pushes nothing, nor does a resolution that keeps nothing of the base or reverts a file the base changed outside the conflicts.

## Its own draft

To [continue](../workflows/questions.md#continue) its work, the next run fast-forwards awaywork's **own draft** the same way, only while its head is the commit awaywork left and you, or awaywork as you, edited the body last.

- That last check is why the footer can be trusted: someone with write access who pushed onto your draft could otherwise point it at their commit, and awaywork would build on it, ungated, and mark it ready. Anyone's footer can still hold the draft's dependents back, which only makes them wait.
- Right before the push, made even with no new commits, it rereads the PR with the same checks, so a draft that moved, was marked ready, or had its body edited by someone else since the plan is untouched.
- It marks the draft ready only under `deliver: pr`, `verify` and the gates reading every commit on it: the agent's word can hold a draft back, never push it past a gate. Where [the rule](../workflows/questions.md#continue) doesn't hold, finish it by hand.

## PRs it opens

- One PR per unit, a **draft** unless `deliver: pr`, into the default branch or your own PR's branch (including an awaywork PR a rule naming `ours` took up). Never into someone else's PR or a fork's: those get a report or pending review. A fork PR is cloned from the repo's pull ref, and the unit fails if that ref moved past the head its source read; nothing goes to the fork.
- It never merges, approves or requests reviewers, and writes to PRs and issues only as [Tracker writes](#tracker-writes) says. Your [`notify` command](../results.md#pr-labels-reviewers-and-ready-for-review) can, as you.
- A `deliver: pr` PR opens ready, so GitHub asks the code owners. It opens as a draft when a step failed or stopped or the run ended first, a step asked with `ask` or said `continue`, `verify` failed, a loop ended before its `until`, or a [gate](../workflows/gates.md) fired.
- A PR stacked on an awaywork PR joins that PR's GitHub stack, or starts one, only while that PR tops its stack or has none. Linking edits neither, but GitHub merges stacks bottom-up (merging one merges those below) and rebases the ones above.
- Only when the agent wrote `pr.md`, for a PR or a push, and only once the chain ended. A run killed before that publishes nothing more.

## The PR body

- After `ask` or `continue`, awaywork puts `Status: ask, questions on <item>` or `Status: continue (1 of 3): …` under the title, above any gates, and records status, count, pushed head and where the draft's commits start in the footer. The line is for you; the footer is the record, since the model could write such a line but nothing after the footer.
- With gates, the top of the body is awaywork's: the decision card when one fired, else `Gates: none fired (…)`, ending in a `---` rule. The agent's text, any card it made up included, is below the rule: that's all it guarantees. A `<` in a gate's line is escaped, so it can't hide the rest in a comment.

## Gates and judges

Gates fail closed. A `command` gate fires when it can't run, times out, is stopped or isn't run on an untrusted author's PR, and, without running, when a file it names differs from the chain's start.

It runs afresh with `$AWAYWORK_FROM` and a read-only copy of the steps' `.away/out/`, ignoring replace refs, reading attributes from the start and a fresh global config the steps can't edit, unlike `verify`, `when` and `until`. It still runs repo code the agent may have changed, and a process that outlived the watchdog could swap the script after the comparison, so `changed` gates are the trustworthy kind ([Gates](../workflows/gates.md)).

A `skill` gate's judge is a model and can be fooled, which only makes it fail to fire: it adds lines to the card, never clears a script's gate.

- Its git sees the commits as pushed. On a plan or report it reads a read-only copy of what the step left, and the post is what the step left either way.
- If it leaves a commit, a moved HEAD, an uncommitted change or a changed `.away/out/` file, awaywork restores the clone and fires the gate; an error, stop or failure to run fires it too. Only a process that outlived the watchdog could change a file after that check.
- It runs as on [someone else's PR](./index.md#other-people-s-prs-are-data), the clone being the agent's: its skill is yours or built in, never the repo's, though Codex still reads the `AGENTS.md` and skills the agent could edit ([Judges](../workflows/gates.md#judges)).

## Tracker writes

Tracker writes are awaywork's, never the agent's. The model writes only the text, never where it goes.

### What it writes

Only these:

- A step's [questions](../workflows/questions.md#questions), as one comment on the first of the unit's items from the rule's source that is **yours**; a `deliver: plan` rule's [plan](../workflows/plans.md) the same way, once `plan.yml` passed its checks.
- Your `approve` reply, when you run `awaywork approve` on an item whose plan or result waits, through the same check.
- A [waiting](../workflows/posts.md#posts-that-wait) report's result, posted as `on_done` does; the move it holds happens only after your own approving reply, while the card is still where the post saw it. A teammate's comment never answers a post.
- What [`on_done`](../config/queue-rules.md#on-done) asks: once the chain published, the unit's result on each of its items that is yours, from the rule's source, then a move to the status, state, section or label the config names. A chain that left no commits writes neither when one of the [rule's own gates](../workflows/gates.md#gates-of-a-rule-s-own) fired.
- A plan's [task](../workflows/tasks.md) isn't a tracker item: its questions, a [report task](../workflows/tasks.md#report-tasks)'s result and its rule's `on_done` go to its card, whose ownership is reread every run.

The item's description can steer that text, mentions included (on GitHub it isn't filtered by author like comments), the same exposure as a PR body.

### On whose items

- Yours is your own PR, an issue assigned to you, a Jira, Linear or Asana item (read only when assigned to you) or a custom source's item.
- Never a PR you were asked to review, an item only an extra `search` found, a new item but a [thread issue](#thread-issues), or a destination a model picked.
- It writes as you, with the source's token (GitHub through `gh`, trackers with their `token_env`, which needs write scope). A failed write is reported, never fails the unit.

Right before writing, awaywork checks the item is still yours:

| Source | Writes | Before each write | Knows who edited a comment last |
| --- | --- | --- | --- |
| GitHub | Yes | An issue is reread and refused once no longer assigned to you; a PR's author can't change, so your PR stays yours | Yes |
| Jira, Linear, Asana | Yes | Reread and refused once no longer assigned to you | Jira yes; Linear and Asana no |
| Custom source | Through its `write` | Its `write` checks that itself | No |
| A custom source without `write` | No: leaves items alone | — | — |

### How its comments are marked

- Its comments end with `— awaywork`, counted as its own only when that line comes from your account.
- So pasting the line can't fake an item waiting for an answer, approve a plan, or put text under the `awaywork's questions` or `awaywork's plan` heading the agent reads.
- Nor can editing your comment where the source knows who edited (the table above): there a comment someone else edited last isn't yours. Where it doesn't, a teammate allowed to edit yours could add the line.

## Files in the store

Files go only to the [store](../workflows/store.md) the config names, put by awaywork's call of your command after the step. The model picks neither store nor URL, and a post links only what awaywork put, below the model's text. Files come back only off awaywork's own posts and the PRs it opened for you, into the item's context as data, outside the tracked tree. Lasting links, redacting what it stores and skipping what shouldn't go there are your script's job; a skip keeps nothing off the post.

## Thread issues

A new issue only as a rule's [thread](../workflows/posts.md#threads): one per item a `thread: github` rule matched as yours, in its repo on the configured forge, assigned to you, through the `gh` login PRs use.

- awaywork's posts for the item go there, marked as usual, and only your replies there are answers.
- It finds the issue again only among open issues your account opened whose marker names the item, so someone else's issue with the marker is never taken for it (it stays an ordinary item).
- It closes only that issue, with a marked comment, once the card's source says it's done. Whether the card is yours is read off the card, every run.
- A [custom thread host](../config/custom-sources.md#thread-hosts) opens, comments on and closes threads through its `write`, and says which replies are yours with `mine`; awaywork sends it only the card's key, title and link and its own posts. It must keep each post one comment, since part of a post is the model's text and a split-off piece could pass for your reply.

## Publishing from the clone

awaywork fetches the clone's HEAD into a repo of its own, adds the trailer, diffs and pushes there. The unit's commits are those after what the clone held before setup.

- The clone's config, attributes, hooks and refs, which the agent can write, don't steer the push, pick which commits get the trailer, or run anything: after setup and each agent run, and around each check, awaywork restores the original config and deletes `.git/info/attributes`.
- Its git runs no hook, ignores replace refs, diffs only from commits it resolved itself (so `changed` gates and `when: { changed }` see what's pushed), and runs no git in a submodule, even with your global `submodule.recurse` or `diff.submodule`.
- A `.git` with a symlink outside its hooks, an alternates file, a `commondir` or `info/grafts` stops it: no more git, checks or `verify` in that clone, nothing published.
- In the clone it only reads the body or report, writes `diff.patch` beside it, tops the body with the gates' section and appends the chain's notes, the items' link lines, a GitHub issue's `Closes` line (for a chain from the default branch) and a stacked PR's "merge that first" line. It refuses symlinks there and touches only regular files; a process that outlived the watchdog could still swap a path after that check.

## Reports and pending reviews

- `report` delivery pushes nothing.
- `pending_review` pushes nothing either: awaywork leaves the last report and the line comments from `review.json` on the PR as your **pending** review, at the commit the clone read. Only you see it, and nobody is notified, until you submit, edit or discard it. awaywork never submits, approves or requests changes. It works on any PR, forks included; on your own you can submit it only as a comment.
- When a step failed or stopped or the run ended first, it delivers the report alone with the reason, so a cut-short review doesn't sit ready to submit. Likewise when GitHub refuses the review, as when you already have a pending one there, which stays. GitHub refuses a whole review over one comment off the diff, so then every comment goes in the body.

## The trailer

Every PR has a footer with the run id and its items, and an `Awaywork: <run id>` commit trailer, pushed commits too. Adding it re-creates each commit, dropping signatures: a branch requiring signed commits refuses the push.
