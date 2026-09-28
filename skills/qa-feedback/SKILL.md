---
name: qa-feedback
description: Fix the issues QA reported on a task that already has a pull request. Use when a task is back from QA.
---

# QA feedback

The unit is a task that QA sent back, with the developer's pull request
linked. The feedback is in the task's comments.

- List every issue QA reported, one line each, before changing code.
- Reproduce each with a test when you can; fix it on this branch.
- An issue you cannot reproduce or that needs a device is flagged with
  what you checked, not guessed at.
- A report that asks for new behavior rather than a fix is escalated.

In the PR body, a table: `QA issue | Status (fixed / not reproduced /
needs device / escalated) | Commit | Note`.
