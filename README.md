# night-shift

> Your AI coding subscription resets every week, used or not.
> night-shift puts Claude Code, Codex and friends to work while you sleep.

You log off with red CI, 11 PR comments and a QA ticket that just says
"broken on Safari". Your coding agent logs off with 60% of its weekly quota
unused. Both are a waste.

night-shift is a CLI that clocks in when you clock out. It pulls your
leftovers from your forge and task tracker and runs your agents' stock
CLIs on them headless, logged in as you. It paces itself so you still have
quota left in the morning. You wake up to draft PRs and a report. Nothing
gets merged or force-pushed, and nobody gets a comment "from you".

## Quick start

```sh
npm i -g nightshift-agent
nightshift init     # finds your agents and forge login, asks the rest
nightshift plan     # a dry look at tonight, zero tokens spent
```

```
$ nightshift plan
Queue
  #1  fix-ci     type=pr mine=true checks=failing
  #2  review     type=pr review_requested=true

Providers
  claude  seven_day 36% used, ceiling 51% set by per_night (reserve 90%, pacing 54%; 3 nights to reset); session 2%, workers stop at 90%

Units
     unit        repo      rule  skill             provider  deliver   branch
  1  acme-api-1  acme/api  #1    fix-ci (builtin)  claude    draft_pr  night/acme-api-1
     github acme/api#1: Add rate limits
  2  acme-api-2  acme/api  #2    review (builtin)  claude    report    night/acme-api-2
     github acme/api#2: Cache invalidation
```

Looks sane? Run one unit for real, then hand over the night:

```sh
nightshift run --unit acme-api-1
nightshift schedule install    # launchd, systemd or cron; `ci init` for GitHub Actions
```

Next morning:

```
$ nightshift report
| # | Unit       | Skill  | Provider | Status        | Result                                  |
|---|------------|--------|----------|---------------|-----------------------------------------|
| 1 | acme-api-1 | fix-ci | claude   | done, 5 turns | github.com/acme/api/pull/42 (1 commits) |
| 2 | acme-api-2 | review | claude   | done          | report below                            |

- claude: seven_day 36% to 45%, ceiling 51%; session 10% to 10%, stop at 90%
```

**Docs:** https://andreaprovenzale.github.io/night-shift/ ·
**Setting it up with an agent?** Point it at [`llms.txt`](https://andreaprovenzale.github.io/night-shift/llms.txt).

## What it picks up

The queue works top-down and the first rule that matches wins. These are the
defaults:

| When | Skill | You get |
|---|---|---|
| your PR has red checks | `fix-ci` | draft PR |
| a task lands in `QA` | `qa-feedback` | draft PR |
| your PR has unresolved threads | `address-review` | draft PR |
| someone requested your review | `review` | report |
| a task is `In progress` | `continue` | draft PR |
| a task is in `Current sprint` | `plan` | report |

Adding a rule takes a few lines of YAML:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: night-shift }
    provider: codex
```

`nightshift queue` reorders rules from the keyboard. Skills are plain
markdown: `nightshift skills eject fix-ci` and hack away.

## How much quota it burns

Tonight's ceiling on the weekly window:

```
ceiling = used + (1 - reserve - used) / nights_until_reset
```

Early in the week that's a small slice, and it gets greedier as the reset
gets closer. Every worker reads the live rate-limit events from its own
stream and stops at the ceiling, or when the short session window passes
90%. There's no token estimation and no guessing.

## The paranoid bit

- **The model never sees a forge token.** PR diffs, threads and CI logs are
  prefetched into files. night-shift itself does the push.
- **It only pushes branches it creates** (`night/<key>`). No force pushes,
  merges or comments, and it never touches anyone else's branch.
- **It runs the vendor's own binary with your login.** It never calls the
  backing API with a subscription token and never proxies credentials.
- **A watchdog cleans up** after every worker and kills units that eat all
  the RAM or disk.

More in [Safety](docs/guide/safety.md).

## Supported

| Agents | Sources | Runs on |
|---|---|---|
| Claude Code, Codex | GitHub, Asana | launchd, systemd, cron, GitHub Actions |

More agents and task trackers are on the way, or bring your own:
[add a provider](docs/extend/providers.md), [add a source](docs/extend/sources.md).
Needs Node 22+, `git`, and `gh auth login`.

## Docs

| Guide | |
|---|---|
| [Getting started](docs/guide/getting-started.md) | Install, first plan, first unit, first night |
| [How it works](docs/guide/how-it-works.md) | Queue, units, budget, delivery |
| [Configuration](docs/guide/configuration.md) | The config file by example; [reference](docs/reference/config.md) |
| [Skills](docs/guide/skills.md) | Built-ins, ejecting, writing your own |
| [Scheduling](docs/guide/scheduling.md) | launchd, systemd, cron, GitHub Actions |
| [Safety](docs/guide/safety.md) | Guardrails and vendor terms |
| [With an AI agent](docs/guide/agents.md) | Let your coding agent set night-shift up |
| [CLI reference](docs/reference/cli.md) | Every command |
| [Adding a provider](docs/extend/providers.md), [a source](docs/extend/sources.md) | Contributing adapters |

Research and design notes: [providers](docs/providers.md),
[sources](docs/sources.md), [design](docs/design.md), [plan](docs/plan.md),
[lessons](docs/lessons.md), [e2e](docs/e2e.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
