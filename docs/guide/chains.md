---
description: Chains in awaywork, steps that run after a rule's skill in the same clone, covering then, review-and-fix loops, when conditions, stacked PRs, pushing onto your own PR and keeping it in line with its base.
---

# Chains

One skill per item is plenty for a red check. For an issue you'd rather see implemented, reviewed by the other agent and fixed before you look, a rule chains more steps after its skill, in the same clone and on the same branch.

No new chain features until real runs ask for them: only fixes and simplifications.

## `then`

Steps run right after the rule's skill, one after the other, in the same clone and on the same branch. The whole chain is one unit: it publishes once, when it ends, as one PR, one push or one report, unless a step says [`stack`](#stack). A step is a skill name, or a map when you want to set more:

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

- A step takes `provider`, `model`, `skills`, `mcp` and `instructions`, plus `with`, [`when`](#when) and [`stack`](#stack). It inherits the first five from the rule unless it sets its own, and `[]` clears a list: above, `implement` gets `sentry`, `review` gets no MCP server and keeps `opus` should it route to Claude. `with`, `when` and `stack` are the step's own. Top-level `instructions` and `skills` still apply, as to every unit.
- A skill commits unless its metadata says it reports, as the built-in `plan` and `review` do. The rule's `deliver` says where the chain's commits go: one draft PR (`draft_pr`, the default), one PR ready for review (`pr`), a [`push`](#push) onto your own PR, or `report`, where no step commits. A chain that committed nothing publishes its steps' reports, joined, as one report. Steps have no `deliver` or `branch` of their own: a committing skill that should only report is a [skill of your own](./skills.md#write-your-own).
- Each step finds what the one before left in `.away/context/previous/`: its `report.md` and `verdict`, what the chain did so far in `pr.md`, its commits in `diff.patch`, and, in a loop, the `until` command's output in `check.log`.
- `model` takes two per provider, `{ claude: [sonnet, opus] }`: a step that fails on the first [runs once more on the second](./configuration.md#retry-on-the-next-model), and the chain goes on from there.
- A step that leaves nothing for the next one ends the chain: a committing step that commits nothing, or a report step that writes no report. So does a step that asks: it writes `.away/out/questions.md` and `ask` to `.away/out/status` (`implement` on an item too vague to build), and awaywork posts the questions on your item, publishing any commits it made, a PR as a draft; your reply there runs the unit again, within minutes with [`run: soon`](./configuration.md#run-soon) ([Questions](./how-it-works.md#questions)). So does a step that writes `continue`: its commits open as a draft a later run goes on with ([Continue](./how-it-works.md#continue)). The steps after it are passed over and the chain counts as finished. A step that fails or stops, and the window's end, end it too: the chain publishes what it has. A PR it opened, or commits it [pushed](#push) onto your PR, wait for your review; otherwise the chain runs again the next run. Ctrl-C publishes nothing.
- The PR body is the `pr.md` the steps kept current, plus an `## Awaywork chain` section with how each loop went, its failing check if any, and the latest report of each report step:

  ```markdown
  Rate-limit the export endpoint

  Closes #12. ...

  ## Awaywork chain

  Loop: 2 rounds of review ⇄ fix; until held: verdict approve; last verdict approve.

  <details><summary>Report: acme-api-12-review-2</summary>

  Approve.

  </details>
  ```

- A chain is one row in `plan`, with its steps under it. Every step is routed (`plan` routes every round of a loop up to its `max`), and budgeted live:

  ```
  Units 1
       item    rule  skill                 provider  deliver   title
    1  api#12  #1    implement (built-in)  claude    draft_pr  Rate-limit the export endpoint
       then loop review ⇄ fix until verdict approve, at most 3 rounds
         review (built-in) on codex
         fix (built-in) on claude
       then docs (user) on claude, when the branch changes src/**
  ```

- A chain counts once against the [caps](./configuration.md#windows-limits-and-budget) and its rule's `units`, as soon as its first step has a provider, and once more per [stacked slice](#stack). A chain whose first slice is over a cap is skipped whole, naming the cap; a later slice over it is left out.
- On someone else's PR or a PR from a fork, a chain that could commit (a step's skill commits and `deliver` isn't `report` or `pending_review`) is skipped with the reason. `deliver: report` turns it into a review chain, and `pending_review` leaves its last report on the PR as your pending review.
- A skill runs at most once outside loops, and once across the chain's loops: a loop may repeat the rule's skill, as in `fix` then `loop: [review, fix]`.
- Steps are named `<unit>-<skill>`, and `<unit>-<skill>-<round>` in a loop. Each leaves a folder under the run's `units/<unit>/`, numbered in the order the steps ran, next to `out/` with what the chain published (and `out-2/` on, one per [stacked slice](#stack)):

  ```
  units/acme-api-12/
    1-implement/   context/  prompt.md  worker.log  out/  replay.json
    2-review/
    3-fix/
    4-review/
    5-docs/
    out/           pr.md  diff.patch
  ```

  [`awaywork replay`](../reference/cli.md#awaywork-replay) rebuilds a unit's first step: the later ones start from commits that only ever existed in the clone.

## Loops

A `loop` step repeats its steps, round after round, until a condition holds or `max` rounds ran. Review and fix until the review approves, with the other agent reviewing:

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

- Rounds are steps like any other: they work in the chain's clone, and their commits publish with the rest of the chain. The PR body says how the loop went.
- `until` is checked after every step and ends the loop as soon as it holds; with both keys, both must. `verdict` is the latest word a step wrote to `.away/out/verdict` (built-in `review` writes `approve`, `comments` or `changes`); it takes a word, a list for any of, or `{ not: … }`. It waits for a step in the loop to write a verdict, so `{ not: changes }` doesn't hold after a step that wrote none. `command` is a shell command awaywork runs in the clone after the step, outside the model; it holds when it exits 0. `max` is at most 5.
- A command runs like `setup` on a branch a worker wrote: without the repo's `secrets`, for at most 15 minutes, and not past the window's end. `setup` doesn't run again before it, so a command that needs dependencies a step added installs them itself, like `pnpm i --frozen-lockfile && pnpm test`. It runs again only once a step committed. In `until` it doesn't hold while the clone has uncommitted changes beyond what `setup` and earlier checks left, since the branch wouldn't publish them; a `when` command sees them, as the step will.
- A command isn't run on a PR whose author isn't trusted. A command that isn't run doesn't hold for `when`, and ends the loop either way. One that runs past its 15 minutes fails, like one that exits non-zero. One stopped by the window's end ends the chain, which publishes what it has as in [`then`](#then); a `when` it stopped doesn't pass over its step. After Ctrl-C the chain publishes nothing and is tried again. When the loop ends with the command failing, the tail of its output goes into the PR body.
- A step that leaves nothing for the next one ends only its loop: a `fix` that disputes every finding commits nothing, and the next `review` would only repeat itself. The steps after the loop still run.
- Loops can follow loops, and a step with a `when` can come right before one.

## `when`

A step, in a chain or a loop, runs only when its `when` holds. Otherwise it is passed over and the chain goes on as if the step weren't there, unless the step [starts a slice](#stack):

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

- `verdict` is the latest verdict written in the chain, by any step before this one. It matches as in `until`, except that `{ not: … }` also holds when no verdict was written.
- `command` runs as in `until`, in the chain's clone before the step's agent starts. Prefix `!` to run a step only when a check fails, such as a fixer with `when: { command: "! pnpm test" }`; it finds the output in `.away/context/previous/when.log`. A check that times out says nothing: it ends the chain without passing over the step, and the chain publishes what it has as in [`then`](#then).
- `changed` is a glob or a list; it holds when the chain's commits change a matching path, measured from where the chain started: the repo's default branch or the awaywork PR a rule took up, as the clone first saw it, so a ref the agent moves changes nothing. Globs are git's, from the repo root, with no leading `/`: `*` stays in one directory and `**` crosses them, so `*.md` matches `README.md` but not `docs/a.md`, and `src/auth/**` everything under it.
- Every key set must hold. `plan` shows each step's `when`, and the report says which one didn't hold.
- A passed-over step doesn't end a loop, unless its command didn't run: it wouldn't in a later round either. A round whose steps were all passed over ends it too, since the next would be the same.

A rule's `when` is about quota instead, and skips its whole chain:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    when: { headroom: 20% }     # only on spare quota
    then:
      - { loop: [review, fix], until: { verdict: approve }, max: 5 }
```

- `runs_until_reset` holds when at most that many window openings are left before the provider's long window resets: `1` holds in the last window before the reset, and in a manual run when at most one window is left. `headroom` (e.g. `20%`) holds when at least that share of the window is left under this run's ceiling, so a long chain runs only on spare quota. Both read the quota the run last saw, as the budget does, and don't hold when the quota can't be read.
- They're rule keys only: on a step they're a config error, and a rule takes no `verdict`, `command` or `changed`. `plan` notes when the quota doesn't hold on the probe or has no reading.

## `stack`

A chain is one PR by default: an `implement` and its review rounds are one change. When it does two separable things, `stack: true` on a step starts a new **slice**, with a branch and a PR of its own, stacked on the slice before:

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

That publishes `away/acme-api-12` with the implement, review and fix rounds, then a PR for `docs` on `away/acme-api-12-2`, into `away/acme-api-12`.

- A slice publishes as soon as its last step ends, before the next one starts. The next slice's branch is cut from its tip in the same clone, so `setup` doesn't run again, and its commits are pushed on top of the slice before's as pushed, each with the `Awaywork:` trailer.
- Every slice renders the rule's [`branch`](./configuration.md#branch-names) with the `{type}` of its own first skill that commits: with `branch: "{type}/{key}"` and `metadata.type: docs` on your skill, the example gives `feat/acme-api-12` and `docs/acme-api-12`. A name that's taken, as every later slice's is with the default `away/{key}`, becomes the first free `-2` to `-10`. A branch the chain published this run never counts as awaywork having tried there.
- The last slice's PR body carries `Closes <issue>` for a GitHub issue when the chain was cut from the default branch, so merging the stack closes it; earlier slices close nothing, and neither does a chain on your own PR, which closes the issue itself. If the last slice is passed over (its `when` doesn't hold, or its first step commits nothing), a cap leaves it out, or the chain ends before it, no PR carries `Closes` and the issue stays open: close it by hand once the stack merges. Workers write no link or stack lines.
- A stacked PR's body ends with `Stacked on <PR>: merge that first.`, and on a repo with GitHub's [stacked PRs](https://gh.io/stacks) the two are linked. Its first step finds the slice before's PR body, as published, in `.away/context/previous/pr.md`, next to what the step before left, and its prompt names the PR.
- On a loop, `stack: true` starts the slice at the loop's first round. A loop sits inside one slice, so a step in a loop can't have it.
- `stack` needs `deliver: draft_pr`, the default, or `pr`. With `pr`, each slice opens ready for review or as a draft on its own. `plan` skips a chain where it's on a step whose skill reports, or after steps that all report: there would be nothing to put in the PR, or nothing to stack on.
- A stacked slice whose first step commits nothing ends the chain; the slices before it stay published. So does a stacked step whose [`when`](#when) doesn't hold: the rest of the chain is passed over. A failing step or the window's end ends the chain too, and the open slice publishes what it has. Ctrl-C drops the open slice, and the ones that already ended stay published.
- `when: { changed }` still diffs from where the chain started, so it sees the earlier slices' commits too.
- A plan's tasks stack the same way with [`after: { api: opened }`](./how-it-works.md#the-feature-block), but each task is a unit of its own, with its own clone, `setup` and branch, cloned from the task before's branch.
- Each slice counts once against the [caps](./configuration.md#windows-limits-and-budget), as soon as its first step has a provider. A chain keeps the slices that fit and leaves out the rest, naming the cap under it in `plan` and on its row in the report.
- `plan` starts a slice with `stack` where the other steps say `then`:

  ```
  Units 1
       item    rule  skill                 provider  deliver   title
    1  api#12  #1    implement (built-in)  claude    draft_pr  Rate-limit the export endpoint
       then loop review ⇄ fix until verdict approve, at most 3 rounds
         review (built-in) on codex
         fix (built-in) on claude
       stack docs (user) on claude
  ```

  `awaywork report` has the chain's row, with each slice's PR in turn:

  ```
  Units 1
       item    skill                                        status          result
    1  api#12  implement → loop(review ⇄ fix) → stack docs  done, 70 turns  https://github.com/acme/api/pull/42, verdict approve; https://github.com/acme/api/pull/43
       Adds a per-client token bucket to the export endpoint; bursts get a 429 with Retry-After.
  ```

  `report --unit 1` adds how the loop went and a row per step, which is where a chain that failed at `review-2` says so:

  ```
  1  api#12  Rate-limit the export endpoint
    skill   implement → loop(review ⇄ fix) → stack docs
    status  done, 70 turns
    loop    2 rounds of review ⇄ fix; until held: verdict approve
    result  https://github.com/acme/api/pull/42, verdict approve; https://github.com/acme/api/pull/43
    item    https://github.com/acme/api/issues/12
    steps   acme-api-12           implement  claude  done, 14 turns  1 commit
            acme-api-12-review-1  review     codex   done, 14 turns  a report, verdict changes
            acme-api-12-fix-1     fix        claude  done, 14 turns  1 commit
            acme-api-12-review-2  review     codex   done, 14 turns  a report, verdict approve
            acme-api-12-docs      docs       claude  done, 14 turns  1 commit

  Adds a per-client token bucket to the export endpoint; bursts get a 429 with Retry-After.
  ```

  `report.md` lists each slice with its steps under it:

  ```markdown
  | # | Unit | Skill | Provider | Status | Result |
  |---|---|---|---|---|---|
  | 1 | [api#12 Rate-limit the export endpoint](https://github.com/acme/api/issues/12) | implement → loop(review ⇄ fix) → stack docs | claude, codex | done, 70 turns | https://github.com/acme/api/pull/42 (2 commits), verdict approve; https://github.com/acme/api/pull/43 (1 commit) |
  |  | └ slice 1 | implement → loop(review ⇄ fix) | claude, codex | done, 56 turns (loop: 2 rounds of review ⇄ fix; until held: verdict approve) | https://github.com/acme/api/pull/42 (2 commits), verdict approve |
  |  |   └ acme-api-12 | implement | claude | done, 14 turns | 1 commit |
  |  |   └ acme-api-12-review-1 | review | codex | done, 14 turns | a report, verdict changes |
  |  |   └ acme-api-12-fix-1 | fix | claude | done, 14 turns | 1 commit |
  |  |   └ acme-api-12-review-2 | review | codex | done, 14 turns | a report, verdict approve |
  |  | └ slice 2 | docs | claude | done, 14 turns | https://github.com/acme/api/pull/43 (1 commit) |
  |  |   └ acme-api-12-docs | docs | claude | done, 14 turns | 1 commit |
  ```

- [`notify`](./configuration.md#notify)'s unit event gives every step its own slice's PR in `AWAYWORK_PR_URL`, and `stats` counts each slice's PR.

::: warning Squash-merging the base Once the first PR is squash-merged and its branch deleted (as GitHub's "Automatically delete head branches" does), GitHub retargets the stacked one to the default branch; with the branch kept, it still targets the merged branch. Either way it still carries the first one's commits. Merging the default branch into it usually resolves cleanly, since the content is the same. Workers never rebase, and nobody does that merge for you. :::

## `push`

By default awaywork only pushes branches that don't exist yet. `deliver: push` is the opt-in to add commits onto your own open PR instead of stacking a draft PR on it, e.g. to have review threads addressed in place:

```yaml
queue:
  - skill: fix
    where: { type: pr, mine: true, unresolved_threads: { gt: 0 } }
    deliver: push
```

- Only onto an open PR you authored, awaywork's own included (they are opened with your login). On someone else's PR, a PR from a fork, or an item with no PR of yours, a chain that could commit is skipped with the reason.
- The chain pushes once, when it ends: every step's commits, a [loop](#loops)'s rounds included.
- A fast-forward only: awaywork pushes only commits on top of where the clone started, and refuses when the branch moved since, so it never rewrites history. It reads the PR again right before the push and refuses when it is no longer yours or open, or has auto-merge on, which would merge unreviewed commits, and when its branch lives on a fork, is the default branch, is protected, or also backs someone else's open PR in the repo. New commits that include a merge aren't pushed either, but for [`sync`](#sync)'s own merge of the PR's base. The commits get the `Awaywork:` trailer, which drops a commit's signature.
- The agent writes `.away/out/pr.md`, as for a PR, and the steps keep it current; without it nothing is pushed. The PR body stays as it is: `pr.md`, with the chain's notes, goes into the morning report.
- A skill's frontmatter can't default to `push`: only a rule opts in.
- After a push, the PR waits for your review: no rule takes it while its head is still the commit awaywork pushed, unless the push was a [`sync`](#sync)'s clean merge. Any commit on top releases it, yours or a bot's, and so does a rebase or an amend. Without that, the push itself would update the PR and run the rule again every run. The pushed head is kept in awaywork's state dir, which a [GitHub Actions runner](./scheduling.md#in-github-actions) doesn't keep: there, a push rule pushes again every run its `where` holds.
- Got a bot that commits on every push, like an autofixer or a snapshot updater? Its commit lands right on top of awaywork's and releases the hold, so the rule pushes again every run its `where` holds: keep that repo out of the rule's `where`, e.g. `repo: { not: acme/web }`.

## `sync`

Your PR is green, but `main` moved on, and you'd rather it stayed mergeable without clicking "Update branch" every morning. `sync` is a built-in skill where awaywork merges the PR's base into its branch itself and pushes the merge onto your PR, the way a `push` rule pushes. A model only steps in when the merge [conflicts](#conflicts), to resolve them.

```yaml
queue:
  - skill: sync
    where: { type: pr, mine: true, behind: { gt: 0 } }
    deliver: push
```

`behind` counts the commits on the PR's base that its branch doesn't have, a [GitHub field](./how-it-works.md#items). There's a `conflicts` field too, GitHub's own "this branch has conflicts" flag, but leave it out of the `where`: GitHub resets it to unknown right after a push to the base, so `conflicts: false` would miss exactly the PRs that just fell behind, and `sync` reads it on its own. A PR that doesn't read `conflicts: true` gets no provider, since no model runs, and `awaywork plan` lists it with none:

```
Units 1
     item                  rule  skill            provider  deliver  title
  1  awaywork-sandbox#188  #1    sync (built-in)  -         push     sync probe: clean merge
```

The run pushes one merge commit, `Merge <base> into <branch>` with the `Awaywork:` trailer:

```
Run 20261103-193652: 0 draft PRs, 0 reports, 1 unit
     item                  skill  status  result
  1  awaywork-sandbox#188  sync   done    pushed onto https://github.com/AndreaProvenzale/awaywork-sandbox/pull/188
     Merge awaywork-sync-base into awaywork-sync-feature: 2 commits, awaywork-sync-base at f25506b.
```

- The clone is on your PR's branch, and awaywork runs `git merge --no-ff` of the base as the clone fetched it, first thing, before anything of the repo's runs, with your commit identity and none of your signing config. A clean merge runs no worker and spends no quota, a provider planned or not, and gets no gates: they check what a model wrote, and nothing did.
- A clean merge isn't always a correct one: git happily merges two branches that each added the same block, and you get it twice. So the repo's [`verify`](./configuration.md#repos-and-instructions) still runs before the push, `setup` first, on the merged tree (and only then: nothing else here runs repo code), and a failure goes into the morning report while the push still happens. Your `fix` rule on `checks: failing` picks up whatever broke.
- What's pushed is that merge commit and nothing else. If `setup` or `verify` amend it, commit on top or move the branch, nothing is pushed, and the report says the clone's head isn't awaywork's merge any more.
- A branch already up to date pushes nothing, and says `already up to date with <base>`. That counts as a finished attempt, so the PR is skipped as unchanged until it or its base changes: a push to the base doesn't touch the PR's `updated`, so awaywork keeps the base's head it tried and syncs again once it moved.
- No review hold after a clean merge: there's nothing of a model's to review, so the next `sync`, once the base moves again, or a `fix` on the CI the merge started, can take the PR right away.
- It's a rule of its own: it must say `deliver: push`, and a `then` or a `when` on it, or `sync` as a step of another rule, is a config error. Everything `push` checks still holds, and it's GitHub only, like `push`.

### Conflicts

When the PR reads `conflicts: true` at plan time, the unit gets a provider, quota and all, like any other:

```
Units 1
     item                  rule  skill            provider  deliver  title
  1  awaywork-sandbox#191  #1    sync (built-in)  resolver  push     resolve probe: conflicting sync
```

awaywork still makes the merge, before anything of the repo's runs, but leaves the conflict in the clone, markers and all, and hands the worker a list of what conflicts in `.away/context/merge.md`:

```markdown
awaywork merged `awaywork-resolve-base` (at 95202a5, 2 commits) into `awaywork-resolve-feature`, and these files conflict:

- resolve-probe/a.txt

The commits on `awaywork-resolve-base` that touch them, newest first:

- da5074a resolve probe: theirs
```

The worker resolves the files, keeping both sides' intent, fixes what the merge broke elsewhere (a function the base renamed, say), runs its targeted checks and writes `.away/out/pr.md`. It doesn't commit: awaywork makes the merge commit itself, from the worker's working tree, on exactly your branch's head and the base's head it merged, whatever the worker did to `.git`. Then it's a `push` like any other: `verify`, the [gates](./configuration.md#gates), the summary in the morning report with the decision card on top when one fired:

```
     item                  skill  status  result
  1  awaywork-sandbox#191  sync   done    pushed onto https://github.com/AndreaProvenzale/awaywork-sandbox/pull/191, gate resolved fired
     - resolved: resolve-probe/a.txt
```

- Gates and judges read the resolution, not the base: awaywork keeps git's automatic merge, markers included, as a local commit that's never pushed, and the gates diff from that. A `changed` gate fires on paths the model changed on top of it, and always on the conflicted ones, whatever the model left there: keeping your side of a binary file, or of a file the base deleted, changes nothing git wrote, and it's still the call that got made. A gated path only the base touched doesn't fire, as `resolve-probe/base.txt` didn't above. `$AWAYWORK_FROM` is that commit too, so diff it to `HEAD` with two dots: it sits beside the merge, not under it, and `$AWAYWORK_FROM...HEAD` reads every commit the base brought. A judge's prompt lists the conflicted paths.
- The summary opens with `Resolved:` and the conflicted paths, then `Also changed:` and whatever else the push carries on top of git's merge, the worker's fallout fixes and `setup`'s edits to tracked files alike, above the worker's own lines. So you see it all, gates or not.
- The merge takes the files git's merge holds, as the worker left them, deletions included, and nothing else: a new file, from `setup`, the worker or its checks, stays out, and the summary lists it as `Left out, untracked: generated.txt, scratch.log`. A resolution that needs a new file asks instead.
- The push is held for your review, as any `push` is: no rule takes the PR while its head is still the merge awaywork pushed.
- Nothing is pushed when `setup` or the worker committed or moved `HEAD`, when a conflicted file still holds a `<<<<<<<` or `>>>>>>>` line (longer ones too, as `conflict-marker-size` makes them), when the resolution keeps nothing of the base (a `git merge --abort` would do that), when it puts a file the base changed outside the conflicts back as your branch had it, deleted files included (`the resolution undoes main's change to x.txt, not pushed`: the base's work comes in, and a fallout fix gives that file new content, it doesn't revert it), or when the worker failed, stopped or asked: a question goes on the PR, as any [question](./how-it-works.md#questions) does. Each counts as an attempt, as for any unit.
- A conflicted lockfile often breaks `setup`, which runs on the conflicted tree before the worker: then the worker gets a note saying so in `merge.md`, and goes on anyway.
- `conflicts` reads unknown for a while after a push to the base, so the first run after one may plan the PR with no provider, and then hit the conflict. That run aborts the merge, pushes nothing and says where, as `conflicts with awaywork-resolve-base in resolve-probe/a.txt, and no provider to resolve them`, and the PR doesn't count as tried: the next run, once GitHub reads the conflict, plans a provider for it. So does a run whose providers had no quota left.
- A conflicted submodule pointer is no file to resolve: awaywork aborts the merge with no worker and no quota spent, and says `conflicts with main in vendor/lib (a submodule): merge it by hand`. That counts as a finished attempt, as `already up to date` does.
- So does a conflicted file whose name isn't valid UTF-8, which awaywork can't point a check at: `conflicts with main in a file whose name isn't UTF-8: merge it by hand`.
- The skill's instructions are in its body, so you can [eject](./skills.md#tweak-a-built-in) `sync` and tweak how it resolves; keep `metadata.merge: base` in its frontmatter.
