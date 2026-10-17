---
description: Install awaywork, write a config, preview the next run with plan, run one unit, then put it on a schedule.
---

# Getting started

## Requirements

- Node 22 or later, and `git`.
- [`gh`](https://cli.github.com) logged in (`gh auth login`). GitHub is both a source of work and where awaywork pushes branches and opens draft PRs.
- At least one agent CLI, installed and logged in with your subscription:
  - [Claude Code](https://code.claude.com): `claude` logged in, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
  - [Codex](https://developers.openai.com/codex): `codex login`.
- Optionally an Asana personal access token, a Linear personal API key or an Atlassian API token for Jira Cloud, if your tasks live there. Linear and Jira are beta: no real run has used them yet.

## Install

```sh
npm install -g awaywork
awaywork --help
```

## Configure

```sh
awaywork init
```

`init` finds the installed agents and your `gh` login, then asks which providers and sources to use and which rules to start the queue with. For Asana it lists your workspaces, projects and real section names, and asks which repo each project's code lives in; for Linear it lists your teams and their real workflow states, and asks which repo each team's code lives in; for Jira it asks your site and email, lists your projects and the site's statuses, and asks which repo each project's code lives in. It writes `~/.config/awaywork/config.yml`; a token you type is saved to `~/.config/awaywork/env` (mode 600), never to the config. Last, it asks where to run it on a schedule: this machine, GitHub Actions or later, and hands off to [`schedule install`](#on-a-schedule). `awaywork init --yes` asks nothing and takes the defaults instead.

Or write a minimal config by hand:

```yaml
providers: [claude]
sources:
  github: { repos: [acme/*] }
```

With no `queue`, the [default queue](./how-it-works.md#the-queue) applies. Assigned GitHub issues need a rule of their own, e.g. `implement` for issues labelled `awaywork` (see [Configuration](./configuration.md)). The label isn't enough on its own: awaywork reads only the issues assigned to you, so assign yourself too.

Check it:

```sh
awaywork doctor   # the config, binaries, credentials, quota, sources
```

## Preview the next run

```sh
awaywork plan
```

`plan` reads your sources and each provider's quota and prints what a run would do, without running an agent:

```
Queue (default: no queue in config)
  #1  fix     source=github type=pr mine=true checks=failing
  #2  fix     source=github type=pr mine=true unresolved_threads!=0
  #3  fix     source=github type=pr mine=true ours=true my_unresolved_threads!=0
  #4  review  source=github type=pr review_requested=true trusted=true

Providers
  provider  window     used  ceiling  set by  resets in  session / stop at
  claude    seven_day  36%   54%      pacing  3 runs     2% / 90%
    other limits: reserve cap 90%

Units
     unit        repo      rule  skill              provider  deliver   branch
  1  acme-api-1  acme/api  #1    fix (built-in)     claude    draft_pr  away/acme-api-1
     github acme/api#1: Add rate limits
  2  acme-api-2  acme/api  #4    review (built-in)  claude    report    away/acme-api-2
     github acme/api#2: Cache invalidation

Skipped
  github acme/api#3: matched no rule; closest #1 fix: checks is passing, wants failing
```

`awaywork plan --rules` shows the same rules with what each takes now, and skips the quota probe:

```
Queue (default: no queue in config)
  #1  fix     source=github type=pr mine=true checks=failing
       1 taken: acme/api#1
  #2  fix     source=github type=pr mine=true unresolved_threads!=0
       0 taken
  #3  fix     source=github type=pr mine=true ours=true my_unresolved_threads!=0
       0 taken
  #4  review  source=github type=pr review_requested=true trusted=true
       1 taken: acme/api#2
  1 unmatched: acme/api#3
```

An item goes to the first rule it matches, so a later rule that matches it too gets a line like `1 taken by #1: acme/api#1`. To reorder, move the rules in `awaywork config edit`.

## Run one unit

```sh
awaywork run --dry-run         # clone, context and prompt, no agent
awaywork run --unit acme-api-1 # one real unit
awaywork run --repo 'acme/*'   # only units in matching repos
awaywork run --rule 4          # only units of queue rule #4
awaywork report                # the morning report of the last run
awaywork report --list         # recent runs, to pick an id for report <id>
```

`--unit` takes the unit id from `plan` or an item key such as `acme/api#1`, in any case. A step of a rule's `then` runs its whole chain, from the first step.

`--repo <glob>` and `--rule <n>` (rules count from 1, as `plan` shows them) work on `plan` and `run`, and together they both have to hold. They cut the plan after it's made, so the caps and ceilings are what the full run would set: limiting to one repo doesn't free room for it.

The run directory, `~/.local/state/awaywork/runs/<id>/`, keeps the plan, the worker's log, its context files and the report. The id is the run's start time in UTC.

## On a schedule

```sh
awaywork schedule install      # asks where; this machine is launchd, systemd or cron
```

The job starts when a window opens (default `01:00`) and stops when it ends (`07:00`). To run in GitHub Actions instead, pick it when asked, or pass `--with github-actions`; see [Scheduling](./scheduling.md).
