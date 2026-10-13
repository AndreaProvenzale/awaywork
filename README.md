# awaywork

> Your AI coding subscription resets every week, used or not.
> While you're away, awaywork puts Claude Code, Codex and friends to work.

You log off with red CI, 11 PR comments and a QA ticket that just says
"broken on Safari". Your coding agent logs off with 60% of its weekly quota
unused. Both are a waste.

awaywork is a CLI that clocks in when you clock out. It pulls your
leftovers from your forge and task tracker and runs your agents' stock
CLIs on them headless, logged in as you. It paces itself so you still have
quota left in the morning. You wake up to draft PRs and a report. Nothing
gets merged or force-pushed, and nobody gets a comment "from you".

## Quick start

```sh
npm i -g awaywork
awaywork init     # finds your agents and forge login, asks the rest
awaywork plan     # a dry look at the next run; only a tiny quota probe
```

```
$ awaywork plan
Queue
  #1  fix     type=pr mine=true checks=failing
  #2  review  type=pr review_requested=true trusted=true

Providers
  provider  window     used  ceiling  set by   resets in  session / stop at
  claude    seven_day  36%   51%      per_run  3 runs     2% / 90%
    other limits: reserve cap 90%, pacing 54%

Units
     unit        repo      rule  skill              provider  deliver   branch
  1  acme-api-1  acme/api  #1    fix (built-in)     claude    draft_pr  away/acme-api-1
     github acme/api#1: Add rate limits
  2  acme-api-2  acme/api  #2    review (built-in)  claude    report    away/acme-api-2
     github acme/api#2: Cache invalidation
```

Looks sane? Run one unit for real:

```sh
awaywork run --unit acme-api-1
```

Then schedule it for when you're away:

```sh
awaywork schedule install    # asks: this machine (launchd, systemd or cron) or GitHub Actions
```

GitHub Actions runs from a repo of your own, on GitHub's runners or on a
machine of yours, which is how Codex runs there; add the secrets it lists.

Next morning:

```
$ awaywork report
| # | Unit       | Skill  | Provider | Status        | Result                                  |
|---|------------|--------|----------|---------------|-----------------------------------------|
| 1 | acme-api-1 | fix    | claude   | done, 5 turns | github.com/acme/api/pull/42 (1 commits) |
| 2 | acme-api-2 | review | claude   | done          | report below                            |

- claude: seven_day 36% to 45%, ceiling 51%; session 10% to 10%, stop at 90%
```

**Docs:** https://andreaprovenzale.github.io/awaywork/ ·
**Setting it up with an agent?** Point it at [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt).

## What it picks up

The queue works top-down and the first rule that matches wins. These are the
defaults:

| When | Skill | You get |
|---|---|---|
| your PR has red checks | `fix` | draft PR |
| a task lands in `QA` | `fix` | draft PR |
| your PR has unresolved threads | `fix` | draft PR |
| you left threads on an awaywork PR | `fix` | draft PR on it |
| someone requested your review | `review` | report |
| a task is `In progress` | `implement` | draft PR |
| a task is in `Current sprint` | `plan` | report |

Adding a rule takes a few lines of YAML:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    provider: codex
```

The label isn't enough on its own: awaywork reads only the issues
assigned to you, so assign yourself too.

`awaywork queue` reorders rules from the keyboard. Skills are plain
markdown: `awaywork skills eject fix` and hack away.

## How much quota it burns

Each run's ceiling on the weekly window:

```
ceiling = used + (1 - reserve - used) / runs_until_reset
```

Early in the week that's a small slice, and it gets greedier as the reset
gets closer. Every worker reads the live rate-limit events from its own
stream and stops at the ceiling, or when the short session window passes
90%. There's no token estimation and no guessing.

## The paranoid bit

- **Only its own login reaches the agent,** plus the secrets of any MCP
  servers a rule names. No forge token, no other agent's login. PR diffs,
  threads and CI logs are prefetched into files. awaywork itself does the
  push. It's not a sandbox, though: the agent runs as you, with your ssh
  agent, and can read what you can.
- **It only pushes branches it creates** (`away/<key>`), unless a rule
  opts in to fast-forward your own PR. No force pushes, merges or
  comments, and it never touches anyone else's branch.
- **It runs the vendor's own binary with your login.** It never calls the
  backing API with a subscription token and never proxies credentials.
- **A watchdog cleans up** after every worker and kills units that eat all
  the RAM or disk.

More in [Safety](docs/guide/safety.md).

## Supported

| Agents | Sources | Runs on |
|---|---|---|
| Claude Code, Codex (experimental, not on hosted runners) | GitHub, Asana, Linear (beta), Jira Cloud (beta) | launchd, systemd, cron, GitHub Actions |

More agents and task trackers are on the way, or bring your own:
[add a provider](docs/extend/providers.md), [add a source](docs/extend/sources.md),
or point a [custom source](docs/guide/custom-sources.md) at any script that prints JSON.
Needs Node 22+, `git`, and `gh auth login`.

## Docs

| Guide | |
|---|---|
| [Getting started](docs/guide/getting-started.md) | Install, first plan, first unit, first schedule |
| [How it works](docs/guide/how-it-works.md) | Queue, units, budget, delivery |
| [Configuration](docs/guide/configuration.md) | The config file by example; [reference](docs/reference/config.md) |
| [Skills](docs/guide/skills.md) | Built-ins, ejecting, writing your own |
| [Scheduling](docs/guide/scheduling.md) | launchd, systemd, cron, GitHub Actions |
| [Safety](docs/guide/safety.md) | Guardrails and vendor terms |
| [With an AI agent](docs/guide/agents.md) | Let your coding agent set awaywork up |
| [CLI reference](docs/reference/cli.md) | Every command |
| [Adding a provider](docs/extend/providers.md), [a source](docs/extend/sources.md) | Contributing adapters |

Research notes: [providers](docs/providers.md),
[sources](docs/sources.md), [e2e](docs/e2e.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
