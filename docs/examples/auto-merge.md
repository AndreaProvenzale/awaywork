---
description: A rule for low-risk work whose PRs open ready unless a gate fires, and a GitHub workflow of your own that turns on auto-merge for them.
---

# Auto-merge low-risk PRs

A rule and a workflow to adapt.

Docs edits need nobody once the checks pass. awaywork never merges, so the merging is yours: a workflow in the repo, under your token, that acts on the PRs awaywork leaves ready. awaywork's part is making "ready" mean "no gate fired".

```yaml
queue:
  - skill: implement
    where: { type: issue, label: low-risk, repo: acme/api }
    deliver: pr
    gates:
      code: { changed: ["src/**", "**/migrations/**", package.json, pnpm-lock.yaml] }
      risk: { skill: judge }
```

`deliver: pr` opens the PR ready for review. A [gate](../guide/workflows/gates.md) that fires keeps it a draft with the decision card on top, so a change outside docs, or one the judge doubts, waits for you. A step that asked questions, a failed `verify` or a loop that ended early draft it too ([results](../guide/results.md#each-deliver)).

The workflow, in `.github/workflows/auto-merge.yml`:

```yaml
name: auto-merge
on:
  pull_request_target:
    types: [opened, ready_for_review]

jobs:
  enable:
    if: >-
      startsWith(github.head_ref, 'away/')
      && !github.event.pull_request.draft
      && github.event.pull_request.user.login == 'AndreaProvenzale'
      && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - run: gh pr merge --auto --squash "$PR_URL"
        env:
          GH_TOKEN: ${{ secrets.AUTO_MERGE_TOKEN }}
          PR_URL: ${{ github.event.pull_request.html_url }}
```

- **`pull_request_target` runs the default branch's copy of the workflow**, so a PR can't rewrite it. The job checks out nothing.
- **The author check** is your login: awaywork opens PRs as you. It and the same-repo check keep teammates' and forks' `away/` branches out.
- **`away/` is the default [branch](../guide/config/repos.md#branch-names) prefix**, and awaywork pushes only branches that didn't exist. If you set `branch`, change the prefix here to match.
- **Ready, not draft** is the signal. A draft a gate held turns ready when you mark it, and the workflow then enables auto-merge: your decision, same path.
- **`AUTO_MERGE_TOKEN`** is a token of yours or a GitHub App's, pull requests and contents write. Not `GITHUB_TOKEN`: its merge starts no workflow on `main`.
- **The repo needs "Allow auto-merge" on, and branch protection with required checks on `main`.** Without the setting `--auto` fails; with no required checks the PR merges at once. Required reviews hold it until someone approves.

## What it costs

awaywork won't push onto a PR with auto-merge on, since that would merge commits nobody reviewed ([`push`](../guide/config/chains.md#push)). A `fix` rule with `deliver: push` that matches these PRs runs, then the push is refused, so a red check there needs a new PR or you turning auto-merge off (`gh pr merge --disable-auto`). Auto-merge waits on a red check, so nothing lands meanwhile.
