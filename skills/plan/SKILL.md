---
name: plan
description: Plan tomorrow's work on a task that has no pull request yet. Use to prepare an implementation plan without writing code.
metadata:
  deliver: report
---

# Plan

The unit is a task with no pull request yet. The developer reads your plan in the morning; write no code.

- Read the code the task touches. Ground every step in files and functions that exist; reuse what is there.
- When the task is ambiguous, pick the most likely reading, say so, and list the question. Only when no reading is likely enough to plan on, write the questions that block you to `.away/out/questions.md` instead of a plan. When the item's comments hold awaywork's questions and the replies to them, go by the replies.

The report:

1. The goal in two sentences, as you understood it.
2. Files to change, with the change in each.
3. Ordered steps, each small enough for one commit.
4. Open questions for whoever owns the task.
5. Test plan: what to run and what to check by hand.

Under `deliver: plan`, the unit also asks for `.away/out/plan.yml`, in the shape its Deliver line gives: split the ordered steps into tasks there, each one PR. The report is then the narrative the developer reads to approve them; when the comments hold awaywork's earlier plan and a reply to it, plan again by the reply, and when the Deliver line names retired tasks, whose PRs were closed unmerged, plan again without them.
