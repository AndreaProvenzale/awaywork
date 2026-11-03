---
name: sync
description: Keep the developer's own PR in line with its base branch. Use when their PR is behind its base; awaywork makes the merge itself.
metadata:
  merge: base
---

# Sync

The unit is the developer's own pull request whose base branch moved on. awaywork merges the base into the PR's branch itself, with no agent: a clean merge is pushed onto the PR, a merge that conflicts is aborted and reported, and a branch already up to date is left alone. Nothing here is for a worker to do.
