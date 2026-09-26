# night-shift

Spend the coding-agent quota you didn't use today on your leftovers
overnight. night-shift is a CLI that runs Claude Code and Codex headless,
with your own login, on red CI, review threads, QA feedback, requested
reviews and plans. In the morning you find draft PRs and a report.

```sh
npm install -g nightshift-agent
nightshift init            # pick agents, sources and a queue
nightshift plan            # what tonight would do, no agent runs
nightshift schedule install
```

**Docs:** https://andreaprovenzale.github.io/night-shift/ ·
**For AI agents:** [`llms.txt`](https://andreaprovenzale.github.io/night-shift/llms.txt)

## What a night looks like

1. **Plan**, no model call. Reads your open PRs, requested reviews,
   assigned issues and tracker tasks; an ordered queue of rules turns
   them into units of work; each agent's remaining quota sets tonight's
   ceiling.
2. **Work.** One unit at a time, the vendor's own CLI runs headless in a
   fresh clone, with the context prefetched into files and a skill that
   says what to do. A worker stops at the ceiling.
3. **Publish**, no model call. A new branch and a draft PR per unit, or a
   report for reviews and plans. `nightshift report` shows the night.

| Rule, by default | Skill | Delivers |
|---|---|---|
| My PR, checks failing | `fix-ci` | draft PR |
| Asana task in `QA` | `qa-feedback` | draft PR |
| My PR, unresolved threads | `address-review` | draft PR |
| My review requested | `review` | report |
| Asana task in `In progress` | `continue` | draft PR |
| Asana task in `Current sprint` | `plan` | report |

Rules, skills, providers per rule, branch names and budgets are all
config. `nightshift queue` reorders rules with the keyboard.

## Safety

- The model gets no GitHub or tracker token. Context is prefetched into
  files; night-shift pushes and opens the PR itself.
- Only branches that don't exist yet are pushed. Never force, merge,
  comment, or touch someone else's branch.
- Only the vendor's unmodified binary, with your own credentials. No
  backing API calls with a subscription token, no credential proxying.
- A watchdog kills every process a worker left behind and stops a unit
  that runs out of memory or disk.

Details in [Safety](docs/guide/safety.md).

## Supported

| | v1 |
|---|---|
| Agents | Claude Code, Codex |
| Sources | GitHub (also the forge), Asana |
| Runs on | launchd, systemd, cron, GitHub Actions |

Requires Node 22+, `git`, and `gh` logged in. [Providers](docs/providers.md)
and [sources](docs/sources.md) hold the research on what else could be
added and on what terms.

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

Research and design notes: [design](docs/design.md), [plan](docs/plan.md),
[lessons](docs/lessons.md), [e2e](docs/e2e.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
