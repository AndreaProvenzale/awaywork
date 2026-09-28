---
name: fix-ci
description: Fix the failing checks on the developer's pull request. Use when a PR's CI is red.
---

# Fix CI

The unit is a pull request with failing checks. Make them pass.

- Start from `checks.md`: each failed job with the tail of its log. Find
  the first real error, not the last line.
- Reproduce it locally with the narrowest command that shows it, fix the
  cause, and rerun that command.
- A red AI-review check can mean the bot ran out of turns, not that it
  found anything. Say so instead of changing code for it.
- A failure unrelated to this PR's diff (a flaky test, an outage, a
  broken main) is reported, not fixed.

In the PR body, list each failing check with its status (fixed, flaky,
unrelated, not reproduced), the commit that fixes it, and the command
you ran to verify.
