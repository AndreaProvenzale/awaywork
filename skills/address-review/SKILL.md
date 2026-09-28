---
name: address-review
description: Address the unresolved review threads on the developer's pull request. Use when a PR has open review comments.
---

# Address review

The unit is a pull request with unresolved review threads. Answer every
one of them.

- Start from `threads.md`. Bot findings repeat per run: the file groups
  copies by title, and one fix answers every copy.
- Humans before bots. Fix failing checks first if `checks.md` has any.
- Keep each fix to what the thread asks. Never touch code no thread
  points at.
- A thread that needs a product or business decision is escalated, not
  coded. A finding you believe is wrong is disputed, with the reason.

In the PR body, a table: `Thread | Status (fixed / disputed / escalated) |
Commit | Note`, each thread linked. Then one paste-ready reply per thread,
for the developer to post.
