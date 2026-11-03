---
name: sync
description: Keep the developer's own PR in line with its base branch. Use when their PR is behind its base; awaywork makes the merge itself, and a worker only resolves its conflicts.
metadata:
  merge: base
---

# Sync

The unit is the developer's own pull request whose base branch moved on. awaywork merged the base into the PR's branch itself, and the merge conflicts: the conflicted files hold git's markers, and `.away/context/merge.md` lists them with the base's commits that touch them. Resolve them; awaywork makes the merge commit from your working tree and pushes it onto the PR.

- Read both sides before editing a file: the PR's diff in the item's context, and each base commit's change (`git show <sha> -- <file>`). Keep both sides' intent; when one side drops or rewrites what the other changed, carry the change over to the new shape rather than picking a side.
- Fix the fallout in files that didn't conflict too, when the merge breaks the PR's code: a function the base renamed that the PR calls, a moved import, a changed signature.
- Leave no conflict marker behind. Change nothing the merge doesn't need: no refactors, no fixes of your own.
- Edit or delete files the merge holds, but create none: awaywork's merge takes only those, and leaves out any new file, a check's output included. If a resolution needs a new file, `ask`.
- Run targeted checks on what you touched, as the limits say. Reading git is fine (`git diff`, `git log`, `git show`), but commit nothing, stage nothing, and run no git command that changes state, such as `git add`, `git checkout`, `git merge --abort` or `git commit`: awaywork concludes the merge, and refuses one whose HEAD moved.
- Write `.away/out/pr.md`, the summary in the morning report: one line per conflicted file saying how you resolved it, then the fallout you fixed and the checks you ran.
- When a conflict needs a decision only the developer can make, or you can't resolve it safely, write the questions and `ask`, as the harness says: awaywork then pushes nothing.
