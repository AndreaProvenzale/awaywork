---
name: implement
description: Implement an issue or task, or take the next steps on one the developer already has a pull request for. Use when a ready or in-progress item needs code.
metadata:
  type: feat
---

# Implement

The unit is an issue or task, with or without the developer's pull request. When a plan is in `.away/context/previous/`, from this run or an earlier one, follow it.

- Read the item and its comments, then the code involved. Ground every change in files and functions that exist; reuse what is there.
- When the item already has the developer's pull request, your branch is cut from it. Read the PR description and diff first, work out what is done and what is left, and do only the unambiguous next steps, in the style of the existing commits. Never undo or rewrite what the developer did. Leave anything that needs a decision for them.
- When an item without a PR is ambiguous, implement the most likely reading and say so. When it is too ambiguous to implement, write the questions to `.away/out/questions.md` and `ask` to `.away/out/status` instead of guessing; what you committed so far still goes out, a PR as a draft. When the item's comments hold awaywork's questions and the replies to them, go by the replies.
- Add or update tests for what you change.
- When the work is too big for one run, commit what's solid, write `continue` to `.away/out/status`, and say in the PR body what's left: a later run goes on from there, on your branch. When this unit goes on with awaywork's own draft, read its body and commits first, do what's left, and write the PR body for the whole PR.

In the PR body: the item named, what you implemented, the reading you chose where it was ambiguous, and what you ran to verify. On the developer's PR, also what you left for them and why.
