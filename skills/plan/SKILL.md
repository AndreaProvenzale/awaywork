---
name: plan
description: Plan tomorrow's work on a task that has no pull request yet. Use to prepare an implementation plan without writing code.
metadata:
  deliver: report
---

# Plan

The unit is a task with no pull request yet. The developer reads your plan in the morning; write no code.

- Read the code the task touches; ground every step in what exists.
- When the task is ambiguous, list the question in the report. Only when no reading is likely enough to plan on, `ask` instead of a plan.

The report:

1. The goal in two sentences, as you understood it.
2. Files to change, with the change in each.
3. Ordered steps, each small enough for one commit.
4. Open questions for whoever owns the task.
5. Test plan: what to run and what to check by hand.

Under `deliver: plan`, the unit also asks for `.away/out/plan.yml`, in the shape its Deliver line gives: split the ordered steps into tasks there, each one PR, in the repo its code lives in, or one report for a skill that reports, such as gathering QA evidence. When tasks share an interface, an endpoint one adds and another calls, write it down once as the contract, and list in `ships` the files a task in another repo needs from its PR. When a task needs another's work deployed, its preview up, name that check in `after`, spelled as the PR shows it. The report is then the narrative the developer reads to approve them; when the comments hold awaywork's earlier plan and a reply to it, plan again by the reply, and when the Deliver line names retired tasks, whose PRs were closed unmerged, plan again without them.
