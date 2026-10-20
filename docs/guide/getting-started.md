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
- Optionally an Asana personal access token, a Linear personal API key or an Atlassian API token for Jira Cloud, if your tasks live there.

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

`plan` reads your sources and each provider's quota and shows what a run would do, without running an agent. In a terminal you get a view to browse, here with the `no_rule` skips unfolded and `over_cap` selected:

```
Providers
  provider  window     used  ceiling  set by       resets in  session / stop at
  claude    seven_day  5%    90%      reserve cap  1 run      2% / 90%
    other limits: pacing 90%

▾ Needs you
  T-4  no repo: no linked PR or repo field  https://tracker.acme.dev/T-4
       Export invoices as CSV

▾ Units
     item   rule  skill              provider  deliver   title
  1  api#1  #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
     + api#5: same feature, matched #3
  2  web#3  #1    fix (built-in)     claude    draft_pr  WIP: new billing page
  3  api#2  #2    review (built-in)  claude    report    Cache user sessions

▾ Skipped 2: 1 no_rule, 1 over_cap
  ▾ no_rule 1
    T-7: matched no rule; closest #3 implement: type is task, wants issue
  ▸ over_cap 1

⏎ unfold  o open  l log  d diff  s skip  a approve  ? help  q quit
```

`⏎` on an item pages why it's planned or skipped, `o` opens it, `s` skips it in the coming runs; `?` lists the rest, and [the morning report](./how-it-works.md#the-morning-report) has the table. Piped or in CI it prints plain text:

```
$ awaywork plan | cat
Providers
  provider  window     used  ceiling  set by       resets in  session / stop at
  claude    seven_day  5%    90%      reserve cap  1 run      2% / 90%
    other limits: pacing 90%

Units
     item   rule  skill              provider  deliver   title
  1  api#1  #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
     + api#5: same feature, matched #3
  2  web#3  #1    fix (built-in)     claude    draft_pr  WIP: new billing page
  3  api#2  #2    review (built-in)  claude    report    Cache user sessions

Needs you
  T-4  no repo: no linked PR or repo field  https://tracker.acme.dev/T-4
       Export invoices as CSV

Skipped 2: 1 no_rule, 1 over_cap

awaywork plan --skipped [kind]  lists them
awaywork plan --why <key>       says why an item is planned or not
```

Each unit names its item (`api#1` is acme/api#1; a tracker's key stays as is), the rule it matched, its skill, provider and delivery. **Needs you** lists the skipped items only you can unblock, here a task with no repo to work in. The rest is the config doing its job, counted by kind: `plan --skipped` lists them with the reason, after the Needs you ones, `plan --skipped no_rule` only one kind, and `plan --why <key>` explains one item, with the queue when it matched no rule:

```
$ awaywork plan --why T-7
tracker T-7  Onboarding emails
  https://tracker.acme.dev/T-7
  skipped: no_rule
    matched no rule; closest #3 implement: type is task, wants issue

Queue
  #1  fix        type=pr mine=true
  #2  review     type=pr review_requested=true
  #3  implement  type=issue
  #4  fix        column=QA
```

For a planned item it shows the unit, rule, skill, provider and branch instead. With no `queue` in your config, `plan` opens with a line saying it runs the default one.

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
awaywork run --unit api#1      # one real unit
awaywork run --repo 'acme/*'   # only units in matching repos
awaywork run --rule 4          # only units of queue rule #4
awaywork report                # browse the last run; piped, its morning report
awaywork report --list         # recent runs, to pick an id for report <id>
awaywork report --unit 2       # one unit in full: its files, PR body or report
```

`--unit` takes an item as `plan` shows it (`api#1`), its key (`acme/api#1`, or `github:acme/api#1`) or the unit id (`acme-api-1`), in any case. A step of a rule's `then` runs its whole chain, from the first step.

`--repo <glob>` and `--rule <n>` (rules count from 1, as `plan` shows them) work on `plan` and `run`, and together they both have to hold. The caps and ceilings stay the full run's, but only matching units count against them: with `limits.units: 3`, `--repo acme/api` plans up to three acme/api units.

The run directory, `~/.local/state/awaywork/runs/<id>/`, keeps the plan, the worker's log, its context files and the report. The id is the run's start time in UTC.

## On a schedule

```sh
awaywork schedule install      # asks where; this machine is launchd, systemd or cron
```

The job starts when a window opens (default `01:00`) and stops when it ends (`07:00`). To run in GitHub Actions instead, pick it when asked, or pass `--with github-actions`; see [Scheduling](./scheduling.md).
