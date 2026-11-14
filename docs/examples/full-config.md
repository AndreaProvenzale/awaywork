---
description: Most awaywork config keys in one file, with their defaults.
---

# A full config

Each part has its own page under [Configuration](../guide/config/index.md); every key, with its type and default, is in the [reference](../reference/config.md).

```yaml
windows:                        # when scheduled runs start; this one is the default
  - { start: "01:00", end: "07:00" }
limits:                         # per run, every provider; unset by default
  units: 8
  units_per_repo: 3
  unit_minutes: 90              # stop a worker after this many minutes
keep_runs: 30d                  # default; older run dirs go when run or watch starts
watch: { every: 5m, debug: false }  # defaults; how often run: soon rules poll, and true logs every run line in watch.log
budget:                         # defaults; for every provider
  reserve: 10%                  # never go past 1 - reserve of any window
  per_run: 15%                  # at most this share of the long window per run
  session_max: 90%              # stop a worker past this share of the short window
  present_session_max: 40%      # the same, in a run outside every window
  fallback: { units: 4, turns: 60 }   # when the quota can't be read
providers:                      # order = routing preference
  - claude: { model: opus, settings: claude-worker.json }   # default: the binary's own model
  - codex: { config: { model_reasoning_effort: high } }
repos:                          # the only repos awaywork works in
  acme/*:                       # a bare key lists them, no settings
  acme/api:
    branch: feat/{key}-{title}
    setup: pnpm install --frozen-lockfile   # run before the worker
    secrets: [NPM_TOKEN]        # only setup sees these
    test: pnpm vitest run {files}
    instructions: notes/acme-api.md
sources:
  github: {}                    # your PRs, reviews and issues in those repos
  asana:
    workspace: "123"
    token_env: ASANA_TOKEN
    repo_map: { "1201": acme/api }   # project gid -> the repo its tasks' code lives in
    every: 15m                  # poll it for run: soon rules at most this often
branch: away/{key}             # default; {key} or {title} is required
instructions: [notes/me.md]     # every unit
skills: [house-style]           # every unit, next to a rule's skills; yours, in skills/ beside this file
queue:                          # first matching rule wins; top = highest priority
  - skill: fix
    where: { type: pr, mine: true, checks: failing }
    branch: fix/{key}
    run: soon                   # within minutes, not only in the windows
  - skill: implement
    source: github
    where: { type: issue, label: awaywork, repo: acme/api }
    order: oldest
    units: 2                    # at most 2 of these per run
  - skill: review
    where: { type: pr, review_requested: true, trusted: true }
    model: { claude: sonnet }
  - skill: implement
    source: asana
    where: { section: Ready, tags: backend }
    provider: codex
    skills: [our-api-conventions]   # yours too
    instructions: notes/backend.md
```
