<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://andreaprovenzale.github.io/awaywork/brand/lockup-horizontal-dark.svg">
    <img src="https://andreaprovenzale.github.io/awaywork/brand/lockup-horizontal.svg" alt="awaywork" height="56">
  </picture>
</h1>

**You're away, your agents work**

> A harness that runs your coding agents on your real tasks, under rules you set. It paces your quota and keeps you in control of what truly matters.

You log off with red CI, 11 PR comments and a QA ticket that just says "broken on Safari"; your agents pick them up.

awaywork is a CLI. It pulls items from your forge and task tracker, and rules you write pick what runs and with which skill. The vendors' stock agent CLIs do the work headless, with your login. You get draft PRs, reports and questions on your own items, and you decide at the points that matter: approving a plan, answering a question, settling what a gate flagged, merging.

## Quick start

```sh
npm i -g awaywork
awaywork init                 # opens Claude Code on /away, which sets it up with you
awaywork plan                 # a dry look at the next run; only a tiny quota probe
awaywork run --unit <item>    # one item for real
awaywork schedule install     # asks: this machine (launchd, systemd or cron), GitHub Actions or a container
```

No Claude Code? Codex gets the same skill through [its plugin](docs/guide/agents.md#codex-and-friends) and other agents from the package, and `awaywork init --yes` writes the detected defaults without asking, for a container or CI. Or [write the config by hand](docs/guide/getting-started.md#configure): a few lines of YAML.

`awaywork report` opens what a run left. Arrow to a unit, `⏎` reads it, `o` opens its PR:

```
☾ >_ awaywork  You're away, your agents work

Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40
away run (inside a window): session_max
claude: seven_day 5% to 17%, ceiling 42.9%; session 2% to 31%, stop at 90%

▾ Needs you 1
  ▾ tracker T 1
    T-4  Export invoices as CSV  add repo

▾ Units 3
       item  skill   status          result
  ▾ acme/api 2
    1  #1    fix     done, 14 turns  https://github.com/acme/api/pull/14
       Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a…
    3  #2    review  done, 6 turns   report, verdict approve
       Approve: the session cache keys on the user id and expires with the token.
  ▾ acme/web 1
    2  #3    fix     done, 9 turns   nothing
       No code changes: the red check is the visual diff job, which fails on main too since #212.

▸ Skipped 2: 1 no_rule, 1 over_cap

⏎ read  o open  l log  d diff  s skip  a approve  ? help  q quit
```

## What it can do

| Capability | What you get |
| --- | --- |
| [Rules and the default queue](docs/guide/how-it-works.md#the-queue) | An ordered list: each item takes the first rule it matches. Write none and the default queue applies |
| [Skills](docs/guide/skills.md) | Plain Markdown: `fix`, `implement`, `review`, `plan` and more built in. Eject one or write your own |
| [Chains and loops](docs/guide/chains.md) | More steps after a rule's skill, in the same clone: conditions, review-and-fix loops, pushing onto your PR |
| [Plans](docs/guide/how-it-works.md#plans) | A feature split into tasks on your card. Once you approve, they run as PRs or reports, across repos too |
| [Gates](docs/guide/configuration.md#gates) | A glob, a script or a judge spots a change that wants a human and puts a decision card on top of the PR or post |
| [Posts that wait](docs/guide/how-it-works.md#posts-that-wait) | A result lands on your item and waits; your approve hands the item to the next rule |
| [Threads](docs/guide/how-it-works.md#threads) | A card that can't take awaywork's posts gets a GitHub issue for them, assigned to you, or a page on a host of your own |
| [Store](docs/guide/configuration.md#store) | Files a post pins go wherever your command puts them, and the next unit gets them back |
| [Results](docs/guide/results.md) and [notify hooks](docs/guide/configuration.md#notify) | How far each rule's result reaches, and your own command for Notion, Slack and the like |
| [`/away` pane](docs/guide/agents.md#claude-code) | Beside the chat in Claude Code: what needs you and what ran, with keys to skip, approve or start an item |
| [Quota pacing](docs/guide/how-it-works.md#budget) | A ceiling per run spreads your quota over its window and keeps a reserve. Agents whose quota can't be read get fixed caps |

## Guardrails

- **The agent holds no write token.** Only its own login reaches it, plus the secrets of any MCP servers a rule names: no forge token, no other agent's login. PR diffs, threads and CI logs are prefetched into files, and awaywork does every write, where the config says.
- **Not a sandbox on your machine.** There the agent runs as you and can read what you can, your `gh` login and ssh agent included. On GitHub's hosted runners, in awaywork's container image and on Linux with `isolation: user` it runs as a user of its own, which can't; with `isolation: container`, in a fresh container per command that sees only the clone, on your Mac too.
- **It pushes only branches that didn't exist** (`away/<key>` unless configured), unless a rule opts in to fast-forwarding your own PR's branch (`deliver: push`), or it fast-forwards its own draft, while the draft's head is still the one it left, to continue work it started.
- **It never force-pushes, merges or approves,** touches someone else's branch, or comments on someone's behalf.
- **It writes to a tracker only on items a rule matched as yours,** at a destination the config names, its comments signed `— awaywork`: a step's questions, a rule's plan or a unit's result. Your reply there runs it again. A rule can opt in to moving your item once its work is published (`on_done`).
- **It opens a new issue or page only as a rule's thread,** one per item a rule matched as yours, assigned to you, at the host the config names, and closes only its own threads.
- **Files go only in the store the config names.**
- **A review stays yours.** With `deliver: pending_review` it's your pending review, which only you see until you submit it.
- **It runs the vendor's own binary with your login.** It never calls the backing API with a subscription credential, and never stores or proxies someone else's.
- **A watchdog cleans up** after every worker and kills units that eat all the RAM or disk.

More in [Safety](docs/guide/safety.md).

## Supported

| Agents | Sources | Runs on |
| --- | --- | --- |
| Claude Code, Cursor (with a `CURSOR_API_KEY`, even locally), Codex (experimental, not on GitHub-hosted runners) | GitHub, Asana, Linear, Jira Cloud | launchd, systemd, cron, GitHub Actions, Docker |

More agents and task trackers are on the way, or bring your own: [add a provider](docs/extend/providers.md), [add a source](docs/extend/sources.md), or point a [custom source](docs/guide/custom-sources.md) at any script that prints JSON. Needs Node 22+, `git`, and `gh auth login`, or `twg` and an SSH key for [Bitbucket Cloud](docs/guide/configuration.md#bitbucket-and-jira).

## Docs

The site: https://andreaprovenzale.github.io/awaywork/. Setting it up with an agent? Point it at [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt).

| Page |  |
| --- | --- |
| [Getting started](docs/guide/getting-started.md) | Install, first plan, first unit, first schedule |
| [How it works](docs/guide/how-it-works.md) | Queue, units, budget, delivery, plans, the report |
| [Configuration](docs/guide/configuration.md) | The config file by example. The schema holds across minor releases, [experimental keys aside](docs/guide/configuration.md#stability) |
| [Chains](docs/guide/chains.md) | More steps after a rule's skill: loops, conditions, stacked PRs, pushing onto your PR |
| [Where results go](docs/guide/results.md) | Who sees what, and notify hooks for Notion, Slack and the like |
| [Custom sources](docs/guide/custom-sources.md) | Any task tracker, through a command that prints your items as JSON |
| [Skills](docs/guide/skills.md) | Built-ins, ejecting, writing your own |
| [Scheduling](docs/guide/scheduling.md) | launchd, systemd, cron, GitHub Actions, a container |
| [Safety](docs/guide/safety.md) | Guardrails and vendor terms |
| [With an AI agent](docs/guide/agents.md) | The `/away` plugin and pane, and your agent writing your queue |
| [Suggested rules](docs/guide/suggest.md) | Rules, routines and `AGENTS.md` lines from your own sessions and PRs |
| [CLI reference](docs/reference/cli.md) | Every command |
| [Config reference](docs/reference/config.md) | Every key with its type and default |
| [Adding a provider](docs/extend/providers.md), [a source](docs/extend/sources.md) | Contributing adapters |
| Research: [providers](docs/providers.md), [sources](docs/sources.md) | What each vendor and tracker allows, with evidence |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
