---
description: A rule for low-risk work whose PRs open ready unless a gate fires, and a GitHub workflow of your own that turns on auto-merge for them.
---

# Auto-merge low-risk PRs

A rule and a workflow to adapt.

Docs and copy edits need nobody once the checks pass. awaywork never merges, so the merging is yours: a workflow in the repo, under your token, that acts on the PRs awaywork leaves ready. awaywork's part is making "ready" mean "no gate fired".

```yaml
gates:
  risk: { skill: judge }

queue:
  - skill: implement
    where: { type: issue, label: low-risk, repo: acme/api }
    deliver: pr
    gates:
      code: { changed: ["src/**", "**/migrations/**", package.json, pnpm-lock.yaml] }
```

`deliver: pr` opens the PR ready for review. A [gate](../guide/workflows/gates.md) that fires keeps it a draft with the decision card on top, so a change outside docs and copy, or one the judge doubts, waits for you. A step that asked questions, a failed `verify` or a loop that ended early draft it too ([results](../guide/results.md#each-deliver)). The top-level `risk` judge runs on every PR awaywork opens, this rule's included.

The workflow, in `.github/workflows/auto-merge.yml`:

```yaml
name: auto-merge
on:
  pull_request:
    types: [opened, ready_for_review]

jobs:
  enable:
    if: startsWith(github.head_ref, 'away/') && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    steps:
      - run: gh pr merge --auto --squash "$PR_URL"
        env:
          GH_TOKEN: ${{ secrets.AUTO_MERGE_TOKEN }}
          PR_URL: ${{ github.event.pull_request.html_url }}
```

- **`away/` is the default [branch](../guide/config/repos.md#branch-names) prefix**, and awaywork pushes only branches that didn't exist. If you set `branch`, change the prefix here to match.
- **Ready, not draft** is the signal. A draft a gate held turns ready when you mark it, and the workflow then enables auto-merge: your decision, same path.
- **`AUTO_MERGE_TOKEN`** is a token of yours or a GitHub App's, with write access to the repo's pull requests and contents. Never awaywork's. A merge by the workflow's own `GITHUB_TOKEN` starts no further workflows, so use your own if something runs on `main`.
- **The repo needs "Allow auto-merge" on, and branch protection with required checks on `main`.** Without the setting `--auto` fails; with no required checks the PR merges at once. Required reviews hold it until someone approves.
- **`pull_request` runs the workflow as the PR has it**, so a PR that edits the workflow runs its own edit. Put the workflow's folder under CODEOWNERS with required reviews, or add it to the rule's `changed` globs so the PR stays a draft.

## What it costs

awaywork won't push onto a PR with auto-merge on, since that would merge commits nobody reviewed ([`push`](../guide/config/chains.md#push)). A `fix` rule with `deliver: push` stops on these PRs, so a red check there needs a new PR or you turning auto-merge off (`gh pr merge --disable-auto`). Auto-merge waits on a red check, so nothing lands meanwhile.
