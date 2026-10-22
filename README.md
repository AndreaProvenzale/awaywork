<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://andreaprovenzale.github.io/awaywork/brand/lockup-horizontal-dark.svg">
    <img src="https://andreaprovenzale.github.io/awaywork/brand/lockup-horizontal.svg" alt="awaywork" height="56">
  </picture>
</h1>

> Your AI coding subscription resets every week, used or not. While you're away, awaywork puts Claude Code, Codex and friends to work.

You log off with red CI, 11 PR comments and a QA ticket that just says "broken on Safari". Your coding agent logs off with 60% of its weekly quota unused. Both are a waste.

awaywork is a CLI that clocks in when you clock out. It pulls your leftovers from your forge and task tracker and runs your agents' stock CLIs on them headless, logged in as you. It paces itself so you still have quota left in the morning. You wake up to draft PRs and a report. Nothing gets merged or force-pushed, and nobody gets a comment "from you".

## Quick start

```sh
npm i -g awaywork
awaywork init     # finds your agents and forge login, asks the rest
awaywork plan     # a dry look at the next run; only a tiny quota probe
```

```
$ awaywork plan | cat
Providers
  provider  window     used  ceiling  set by       resets in  session / stop at
  claude    seven_day  5%    90%      reserve cap  1 run      2% / 90%
    other limits: pacing 90%

Units 3
     item   rule  skill              provider  deliver   title
  1  api#1  #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
     + api#5: same feature, matched #3
  2  web#3  #1    fix (built-in)     claude    draft_pr  WIP: new billing page
  3  api#2  #2    review (built-in)  claude    report    Cache user sessions

Needs you 1
  T-4  no repo: no linked PR or repo field
       Export invoices as CSV

Skipped 2: 1 no_rule, 1 over_cap

awaywork plan --skipped [kind]  lists them
awaywork plan --why <key>       says why an item is planned or not
```

Looks sane? Run one unit for real:

```sh
awaywork run --unit api#1
```

Then schedule it for when you're away:

```sh
awaywork schedule install    # asks: this machine (launchd, systemd or cron) or GitHub Actions
```

GitHub Actions runs from a repo of your own, on GitHub's runners or on a machine of yours, which is how Codex runs there; add the secrets it lists.

Next morning, `awaywork report` opens the run in your terminal. Arrow to a unit, `⏎` reads its PR body or report, `o` opens the PR, `l` and `d` page its log and diff, `s` skips an item for the coming runs:

```
☾ >_ awaywork  You're away, your agents work

Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40
claude: seven_day 5% to 17%, ceiling 90%; session 2% to 31%, stop at 90%

▾ Needs you 1
  T-4  no repo: no linked PR or repo field
       Export invoices as CSV

▾ Units 3
     item   skill   status          result
  1  api#1  fix     done, 14 turns  https://github.com/acme/api/pull/14
     Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a 5…
  2  web#3  fix     done, 9 turns   nothing
     No code changes: the red check is the visual diff job, which fails on main too since #212.
  3  api#2  review  done, 6 turns   report, verdict approve
     Approve: the session cache keys on the user id and expires with the token.

▸ Skipped 2: 1 no_rule, 1 over_cap

⏎ read  o open  l log  d diff  s skip  a approve  ? help  q quit
```

Piped or in CI, `plan` and `report` print plain text, like the `plan` above.

**Docs:** https://andreaprovenzale.github.io/awaywork/ · **Setting it up with an agent?** Point it at [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt).

## What it picks up

The queue works top-down and the first rule that matches wins. These are the defaults:

| When                               | Skill       | You get        |
| ---------------------------------- | ----------- | -------------- |
| your PR has red checks             | `fix`       | draft PR       |
| a task lands in `QA`               | `fix`       | draft PR       |
| your PR has unresolved threads     | `fix`       | draft PR       |
| you left threads on an awaywork PR | `fix`       | draft PR on it |
| someone requested your review      | `review`    | report         |
| a task is `In progress`            | `implement` | draft PR       |
| a task is in `Current sprint`      | `plan`      | report         |

Adding a rule takes a few lines of YAML:

```yaml
queue:
  - skill: implement
    where: { type: issue, label: awaywork }
    provider: codex
```

The label isn't enough on its own: awaywork reads only the issues assigned to you, so assign yourself too.

`awaywork plan --rules` shows what each rule takes right now. Skills are plain markdown: `awaywork skills eject fix` and hack away.

## How much quota it burns

Each run's ceiling on the weekly window:

```
ceiling = used + (1 - reserve - used) / runs_until_reset
```

Early in the week that's a small slice, and it gets greedier as the reset gets closer. Every worker reads the live rate-limit events from its own stream and stops at the ceiling, or when the short session window passes 90%. There's no token estimation and no guessing.

## The paranoid bit

- **Only its own login reaches the agent,** plus the secrets of any MCP servers a rule names. No forge token, no other agent's login. PR diffs, threads and CI logs are prefetched into files. awaywork itself does the push. On your machine it's not a sandbox, though: the agent runs as you and can read what you can, your gh login and ssh agent included. On GitHub's hosted runners, and on Linux with `isolation: user`, it runs as a user of its own, which can't; with `isolation: container`, in a fresh container per command that sees only the clone, on your Mac too.
- **It only pushes branches it creates** (`away/<key>`), unless a rule opts in to fast-forward your own PR. No force pushes, merges or comments, and it never touches anyone else's branch.
- **It runs the vendor's own binary with your login.** It never calls the backing API with a subscription token and never proxies credentials.
- **A watchdog cleans up** after every worker and kills units that eat all the RAM or disk.

More in [Safety](docs/guide/safety.md).

## Supported

| Agents | Sources | Runs on |
| --- | --- | --- |
| Claude Code, Codex (experimental, not on hosted runners) | GitHub, Asana, Linear, Jira Cloud | launchd, systemd, cron, GitHub Actions |

More agents and task trackers are on the way, or bring your own: [add a provider](docs/extend/providers.md), [add a source](docs/extend/sources.md), or point a [custom source](docs/guide/custom-sources.md) at any script that prints JSON. Needs Node 22+, `git`, and `gh auth login`.

## Docs

| Guide |  |
| --- | --- |
| [Getting started](docs/guide/getting-started.md) | Install, first plan, first unit, first schedule |
| [How it works](docs/guide/how-it-works.md) | Queue, units, budget, delivery |
| [Configuration](docs/guide/configuration.md) | The config file by example; [reference](docs/reference/config.md). The schema holds across minor releases, [experimental keys aside](docs/guide/configuration.md#stability) |
| [Chains](docs/guide/chains.md) | More steps after a rule's skill: loops, conditions, stacked PRs, pushing onto your PR |
| [Skills](docs/guide/skills.md) | Built-ins, ejecting, writing your own |
| [Scheduling](docs/guide/scheduling.md) | launchd, systemd, cron, GitHub Actions |
| [Safety](docs/guide/safety.md) | Guardrails and vendor terms |
| [With an AI agent](docs/guide/agents.md) | Let your coding agent set awaywork up |
| [CLI reference](docs/reference/cli.md) | Every command |
| [Adding a provider](docs/extend/providers.md), [a source](docs/extend/sources.md) | Contributing adapters |

Research notes: [providers](docs/providers.md), [sources](docs/sources.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
