---
description: Install night-shift, write a config, preview tonight with plan, run one unit, then schedule every night.
---

# Getting started

## Requirements

- Node 22 or later, and `git`.
- [`gh`](https://cli.github.com) logged in (`gh auth login`). GitHub is
  both a source of work and where night-shift pushes branches and opens
  draft PRs.
- At least one agent CLI, installed and logged in with your subscription:
  - [Claude Code](https://code.claude.com): `claude` logged in, or
    `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
  - [Codex](https://developers.openai.com/codex): `codex login`.
- Optionally an Asana personal access token, if your tasks live there.

## Install

```sh
npm install -g nightshift-agent
nightshift --help
```

## Configure

```sh
nightshift init
```

`init` finds the installed agents and your `gh` login, then asks which
providers and sources to use and which rules to start the queue with. For
Asana it lists your workspaces, projects and real section names, and asks
which repo each project's code lives in. It writes
`~/.config/night-shift/config.yml`; a token you type is saved to
`~/.config/night-shift/env` (mode 600), never to the config. Last, it
asks where to run every night: this machine, GitHub Actions or later, and
hands off to [`schedule install`](#every-night).
`nightshift init --yes` asks nothing and takes the defaults instead.

Or write a minimal config by hand:

```yaml
providers: [claude]
sources:
  github: { repos: [my-org/*] }
```

With no `queue`, the [default queue](./how-it-works.md#the-queue) applies.
Assigned GitHub issues need a rule of their own, e.g. `implement` for
issues labelled `night-shift` (see [Configuration](./configuration.md)).

Check it:

```sh
nightshift config check
nightshift doctor   # binaries, credentials, quota, sources
```

## Preview tonight

```sh
nightshift plan
```

`plan` reads your sources and each provider's quota and prints what a
night would do, without running an agent:

```
Queue
  #1  fix-ci     type=pr mine=true checks=failing
  #2  review     type=pr review_requested=true

Providers
  provider  window     used  ceiling  set by     resets in  session / stop at
  claude    seven_day  36%   51%      per_night  3 nights   2% / 90%
    other limits: reserve cap 90%, pacing 54%

Units
     unit        repo      rule  skill              provider  deliver   branch
  1  acme-api-1  acme/api  #1    fix-ci (built-in)  claude    draft_pr  night/acme-api-1
     github acme/api#1: Add rate limits
  2  acme-api-2  acme/api  #2    review (built-in)  claude    report    night/acme-api-2
     github acme/api#2: Cache invalidation

Skipped
  github acme/api#3: matched no rule; closest #1 fix-ci: checks is passing, wants failing
```

`nightshift queue` shows the same rules with tonight's matches and lets
you reorder them with the keyboard; `nightshift queue move 3 1` moves
rule #3 to the top without one.

## Run one unit

```sh
nightshift run --dry-run         # clone, context and prompt, no agent
nightshift run --unit acme-api-1 # one real unit
nightshift report                # the morning report of the last run
nightshift report --list         # recent runs, to pick an id for report <id>
```

`--unit` takes the unit id from `plan` or an item key such as
`acme/api#1`, in any case.

The run directory, `~/.local/state/night-shift/runs/<id>/`, keeps the
plan, the worker's log, its context files and the report.

## Every night

```sh
nightshift schedule install      # launchd; --with systemd or cron on Linux
```

The job starts at `night.start` (default `01:00`) and starts no unit after
`night.end` (`07:00`). To run in GitHub Actions instead, add
`--with github-actions`; see [Scheduling](./scheduling.md).
