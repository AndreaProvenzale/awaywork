---
name: review
description: Prepare a code review the developer was asked for. Use when a PR is waiting for the developer's review.
metadata:
  deliver: report
---

# Review

The unit is someone else's pull request that the developer was asked to
review, or one awaywork opened earlier in this run. Nothing you write is
posted: the developer reads your draft in the morning and decides what
to say.

- Read the PR description, diff, threads and checks in the context
  folder, or `previous/` for this run's PR. The clone is at the PR's
  branch; read the code around the diff.
- In a loop, the branch holds this run's work so far: review everything
  it adds over its base, not only the last step's `diff.patch`.
- Judge the change against what it claims to do: does it do that, and
  only that?
- Look for correctness bugs, missing edge cases, broken contracts,
  security issues, and deviations from the repo's own instructions. Skip
  nits a linter would catch.
- Verify each finding in the code before writing it down.

The report:

1. Verdict in one line: approve, approve with comments, or request
   changes. Write the same as one word, `approve`, `comments` or
   `changes`, to `.away/out/verdict`.
2. Findings ranked by severity, each with `path:line`, the problem, a
   concrete failure scenario, and a suggested fix.
3. Paste-ready review comments, one per finding.
