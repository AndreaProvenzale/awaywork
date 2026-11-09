---
description: Install awaywork, write a config, preview the next run with plan, run one unit, then put it on a schedule.
---

# Getting started

## Requirements

- Node 22 or later, and `git`.
- [`gh`](https://cli.github.com) logged in (`gh auth login`). GitHub is both a source of work and where awaywork pushes branches and opens draft PRs.
  - Code on Bitbucket Cloud instead? Atlassian's `twg` logged in and an SSH key, see [Bitbucket and Jira](./configuration.md#bitbucket-and-jira).
- At least one agent CLI, installed and logged in with your subscription:
  - [Claude Code](https://code.claude.com): `claude` logged in, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
  - [Codex](https://developers.openai.com/codex): `codex login`.
  - [Cursor](https://cursor.com/docs/cli/overview): its `agent` CLI and a `CURSOR_API_KEY` from the dashboard, even on your own machine. awaywork runs it in a `HOME` of its own, where your `agent login` doesn't reach. Until the key is set, the setup leaves Cursor out.
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

`init` doesn't ask you a wall of questions: it opens Claude Code on `/away set up awaywork`, and the [`/away` skill](./agents.md#claude-code) does the setup with you. No awaywork plugin in Claude Code yet? It offers to install it first:

```text
$ awaywork init
◇  Install the awaywork plugin for Claude Code? It runs claude plugin marketplace add AndreaProvenzale/awaywork, then
│  claude plugin install awaywork@awaywork
│  Yes
✔ Successfully added marketplace: awaywork (declared in user settings)
✔ Successfully installed plugin: awaywork@awaywork (scope: user)
│
●  Opening Claude Code on /away set up awaywork; /exit comes back here
```

Say no and that one session loads the plugin from the npm package instead (`--plugin-dir`), nothing installed. Then `/away` looks around on its own: `awaywork doctor` for your agent CLIs and `gh` login, and the folders your recent Claude Code and Codex sessions ran in, mapped to repos by their git remotes. One message asks the rest:

```text
⏺ I looked around your machine. Here's what I found, and what I need from you to write the config.
  [...]
  Repos from your last 30 days of sessions, grouped by owner
  1. acme: api (about 126 sessions, counting its worktrees) and web (1). This is the owner with the
     most sessions.
  2. acme-labs: site (41). Your gh login may not reach this org.
  3. widgets: art (30). It shows up as the ssh alias git@github-work:widgets/art, so I need you to
     confirm that repo name before I use it.
  4. Not GitHub, so left out: billing (Bitbucket Cloud). Setup doesn't write a Bitbucket source.

  Work and personal usually get separate configs, so one config covers the owners you pick.

  Questions
  1. Providers: claude first, then codex. Is that right?
  2. Repos: acme/api and acme/web. Do you want acme/* or other owners instead?
  3. Trackers: do tasks also come from Asana, Linear or Jira? No. For Jira I'd need your Cloud site,
     Atlassian email, and whether the API token is scoped.
  4. Window: 01:00–07:00 your local time.
  5. First rules: the default is awaywork's default rules. I can suggest rules from your recent
     sessions and PRs instead, but that needs your yes.
     - What I'd read for the default owner: 123 Claude Code sessions (229 MB) in the api folder, plus
       2 sessions (1.7 MB) in its fix-ci worktree folder and 1 in an agent worktree. It also covers 50
       memory files and your global ~/.claude/CLAUDE.md. There are no Codex sessions there.
     - Everything I read goes to Anthropic, my vendor.
     - A yes also covers suggest's consent for this run, for the owners you chose.

❯ Only acme/api as the repo; everything else the defaults.
```

It drafts the config, checks each rule on your real items with `awaywork plan --rules`, and writes `~/.config/awaywork/config.yml` only on your yes:

```text
⏺ Here is the draft config, checked against acme/api. I haven't written it to your config yet.

  Rules (the first matching rule wins):
  1. Fix your PRs whose checks fail. It takes nothing today.
  2. Fix your PRs that have unresolved review threads. It takes nothing today.
  3. Fix your PRs that have unresolved threads you opened on a PR awaywork made. It takes nothing today.
  4. Review PRs where your review is requested, from trusted authors. It takes nothing today.

  Nothing matches today, which doesn't show the rules are wrong. [...]

  Should I write this config as it is?
```

A tracker token never goes through the chat: it tells you to run `awaywork secret LINEAR_API_KEY` (or `! pbpaste | awaywork secret LINEAR_API_KEY` right in Claude Code), which saves it to `~/.config/awaywork/env` (mode 600). It ends with the commands for you to run, `awaywork plan`, `awaywork run --unit <id>` and `awaywork schedule install`, and runs none of them. `/exit` drops you back in your shell.

Run `init` again with a config there and `/away` tells you where it stands and what you could change. No Claude Code? `init` says what to do instead: Codex gets the same plugin (see [Codex and friends](./agents.md#codex-and-friends)), any agent that loads skills can take them from the package, and `awaywork init --yes` asks nothing and writes the detected defaults, for a container or CI.

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

`plan` reads your sources and each provider's quota and shows what a run would do, without running an agent. In a terminal it opens at once and shows each step as it loads:

```
☾ >_ awaywork  You're away, your agents work

⠸ Planning the next run
  ✔ github        5 items
  ✔ tracker       2 items
  ✔ linking PRs   2/2
  ⠸ claude quota

q quit
```

Then the same screen is a view to browse, here with the skipped tracker items unfolded and the `acme/api` ones selected:

```
☾ >_ awaywork  You're away, your agents work

Providers
  present run (outside the windows): present_session_max
  provider  window     used  ceiling  set by  resets in  session / stop at
  claude    seven_day  5%    25.7%    pacing  5 runs     2% / 40%
    other limits: reserve cap 90%

▾ Needs you 1
  ▾ tracker T 1
    T-4  Export invoices as CSV  add repo

▾ Units 3
       item  rule  skill              provider  deliver   title
  ▾ acme/api 2
    1  #1    #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
       + api#5: same feature, matched #3
    3  #2    #2    review (built-in)  claude    report    Cache user sessions
  ▾ acme/web 1
    2  #3    #1    fix (built-in)     claude    draft_pr  WIP: new billing page

▾ Skipped 2: 1 no_rule, 1 over_cap
  ▾ tracker T 1
    T-7  Onboarding emails  no rule
         closest #3 implement: type is task, wants issue
  ▸ acme/api 1

⏎ unfold  o open  s skip  a approve  ? help  q quit
```

`⏎` on an item pages why it's planned or skipped, `o` opens it, `s` skips it in the coming runs; `?` lists the rest, and [the morning report](./how-it-works.md#the-morning-report) has the table. Piped or in CI it prints plain text:

```
$ awaywork plan | cat
Providers
  present run (outside the windows): present_session_max
  provider  window     used  ceiling  set by  resets in  session / stop at
  claude    seven_day  5%    25.7%    pacing  5 runs     2% / 40%
    other limits: reserve cap 90%

Units 3
     item   rule  skill              provider  deliver   title
  1  api#1  #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
     + api#5: same feature, matched #3
  2  web#3  #1    fix (built-in)     claude    draft_pr  WIP: new billing page
  3  api#2  #2    review (built-in)  claude    report    Cache user sessions

Needs you 1
  tracker T
    T-4  Export invoices as CSV  add repo

Skipped 2: 1 no_rule, 1 over_cap

awaywork plan --skipped [kind]  lists them
awaywork plan --why <key>       says why an item is planned or not
```

Each unit names its item (`api#1` is acme/api#1; a tracker's key stays as is), the rule it matched, its skill, provider and delivery. **Needs you** lists the skipped items only you can unblock, under their repo or their tracker and project key, each ending on what to do: here `add repo`, for a task with no repo to work in. The rest is the config doing its job, counted by kind: `plan --skipped` lists them with the reason, after the Needs you ones, `plan --skipped no_rule` only one kind, and `plan --why <key>` explains one item, with the queue when it matched no rule:

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

`--unit` takes an item as `plan` shows it (`api#1`), its key (`acme/api#1`, or `github:acme/api#1`) or the unit id (`acme-api-1`), in any case. A step of a rule's `then` runs its whole chain, from the first step. A unit you name goes past `limits.units`, `limits.units_per_repo` and its rule's `units`; the rest of the plan stays capped as it was.

`--unit` holds your terminal until the unit ends, hours sometimes. `--detach` starts it and hands the terminal back, one line when it's started, with its output in that run's `run.log`:

```text
$ awaywork run --unit api#1 --detach
Started api#1 as run 20261109-095329; awaywork report 20261109-095329 shows it once it ends
```

An item no rule takes needs a skill named for it, [`--skill`](./skills.md#run-one-on-an-item-no-rule-takes), which also works detached. It plans first, so a unit that can't start says so and exits 1: not in the plan, the run lock taken, or no provider for it. No Ctrl-C now, so to stop it kill the pid in `~/.local/state/awaywork/run.lock`: it ends the way Ctrl-C would, report included.

Outside your windows that's a present run: workers stop at 40% of the 5-hour window, and a provider whose quota awaywork can't read, like a command provider without a `probe`, sits it out. Run it inside a window or add a probe.

`--repo <glob>` and `--rule <n>` (rules count from 1, as `plan` shows them) work on `plan` and `run`, and together they both have to hold. The caps and ceilings stay the full run's, but only matching units count against them: with `limits.units: 3`, `--repo acme/api` plans up to three acme/api units.

The run directory, `~/.local/state/awaywork/runs/<id>/`, keeps the plan, the worker's log, its context files and the report. The id is the run's start time in UTC. Run dirs stay 30 days, then a run removes them; [`keep_runs`](./configuration.md#old-runs) changes that.

## On a schedule

```sh
awaywork schedule install      # asks where; this machine is launchd, systemd or cron
```

The job keeps `awaywork watch` running, which starts a run when a window opens (default `01:00`) and stops it when the window ends (`07:00`). To run in GitHub Actions instead, pick it when asked, or pass `--with github-actions`; see [Scheduling](./scheduling.md).
