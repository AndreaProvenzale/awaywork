---
name: fix
description: "Fix the problems reported on an item: failing checks, review threads, QA feedback, an error report. Use when something is broken or was sent back."
metadata:
  type: fix
---

# Fix

The unit is an item with problems listed in its context: failing checks in `checks.md`, unresolved review threads in `threads.md`, QA comments or an error event (a stack trace, say) in `item.md`, or, in a loop, the findings of the review in `previous/report.md`. Sort out every one.

- List every problem, one line each, before changing code. Fix failing checks first when there are any.
- Checks: find the first real error, not the last line. Reproduce it with the narrowest command, fix the cause, rerun it. A red AI-review check can mean the bot ran out of turns: say so, change no code for it. A failure unrelated to the diff (a flaky test, an outage, a broken main) is reported, not fixed.
- Threads and review findings: humans before bots. Bot findings repeat per run: the file groups copies by title, and one fix answers every copy. Keep each fix to what the thread or finding asks; touch no other code.
- QA feedback and error reports: reproduce with a test when you can. What you can't reproduce, or what needs a device, is flagged with what you checked. A request for new behavior rather than a fix is escalated.
- A problem that needs a product or business decision is escalated, not coded. One you believe is wrong is disputed, with the reason.

In the PR body, a table: `Problem | Status (fixed / not reproduced / unrelated / disputed / escalated) | Commit | Note`, each problem linked when it has a URL. When the problems are review threads, add one paste-ready reply per thread for the developer to post. In a loop, keep the body's existing content and add the table for this round's findings.
