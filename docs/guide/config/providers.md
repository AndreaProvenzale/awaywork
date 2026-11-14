---
description: "When runs start and how much one does (windows, limits, budget), and the agents awaywork runs: their settings, which login each uses, and bringing your own CLI."
---

# Providers and budget

## Windows, limits and budget

A run is one window opening, or one `awaywork run` by hand:

```yaml
windows:
  - { start: "01:00", end: "07:00" }          # the default
  - { days: [sat, sun], start: "10:00", end: "18:00" }
```

A scheduled run starts at `start`; no unit starts after `end`, and a running one stops there. `days` (`sun` to `sat`) are the days it opens on.

Pacing follows the clock, not the number of windows. A run may spend up to where an even spend over the long window stands at the next window's opening, or at the reset if that comes first, so more windows split the week finer rather than spend more. How the [budget](../how-it-works.md#budget) shares combine is in How it works; start with `per_run: 5%` for a week to see what a unit costs.

Limits cap what you'd have to review, per run and for every provider. None is set by default:

```yaml
limits: { units: 8, units_per_repo: 3, unit_minutes: 90 }
```

Units past a cap are skipped in queue order, the cap named in `awaywork plan` and the report. The keys are in the [reference](../../reference/config.md#limits).

Details:

- Times are the machine's local time. In GitHub Actions they're the timezone you ran `schedule install` in, a run may start [up to an hour late in summer time](../scheduling/actions.md), and a hosted runner stops it at about 6 hours.
- [`awaywork watch`](../scheduling/machine.md) rereads windows every minute: no reinstall, unless you move the [wake](../scheduling/machine.md#waking-up-for-it).
- `windows: []` means none: the daemon idles, and the Actions workflow runs only when dispatched. Windows shouldn't overlap.
- A run started outside every window stops workers at `present_session_max` (40%) instead of `session_max`, and skips providers whose quota it can't read.
- `per_run` caps each run, and `runs_until_reset` counts window openings.
- `budget` applies to every provider; a different budget takes a second config.
- A [`then`](./chains.md#then) chain is one unit. Each of a plan's tasks is one, in its own [repo](../workflows/tasks.md#across-repos), so a cap can cut a card's [block](../workflows/tasks.md#the-feature-block); the next run carries on.
- Only units whose first step got a provider count. Caps apply per `awaywork run`, like `fallback.units`, which every step draws on. A unit named with `--unit` goes past them.
- A rule's own `units` caps that rule; a `deliver: plan` rule's `plan_tasks` (8) caps its [plan](../workflows/plans.md)'s tasks.

## Providers

A list, in routing order. A bare name uses the defaults; a map sets `model` (passed as is: `claude --model`, `codex exec -m`, `agent --model`) and its own settings:

```yaml
providers:
  - claude: { model: opus, settings: claude-worker.json }
  - codex: { config: { model_reasoning_effort: high } }
  - cursor
```

Workers skip your user-level agent config. What you do want them to have, on every unit including someone else's PR, goes here:

- `claude: { settings }`: a settings file, relative to the config, passed as `--settings`. Auto-memory stays off, and workers run in `dontAsk` mode: a tool not pre-approved, by awaywork or your `permissions.allow`, is denied.
- `codex: { config }`: each key passed as `codex exec -c key=value`.

Cursor takes only `model` (its `auto` when unset). Details:

- It needs `CURSOR_API_KEY` in the env file, even on your machine: each run gets a fresh `HOME` in the clone, `.away/agent-home`, so none of your `~/.cursor` comes along, `agent login` included. Make a key in Cursor's dashboard.
- awaywork writes that `HOME`'s permissions: any shell command, read and write, plus the `tools` of the rule's [MCP servers](./mcp.md). Never `--force`.
- Its commits can carry `Co-authored-by: Cursor <cursoragent@cursor.com>`, as Claude Code's can.
- A Cursor subagent is one turn toward the cap and one `task:` line in `worker.log`, whatever it does inside; `limits.unit_minutes` bounds it.
- Its usage shows only in its dashboard, so it runs on the [fallback](../how-it-works.md#budget) caps and sits out runs started outside a window.
- On a GitHub-hosted runner the action installs it: [Running Cursor](../scheduling/actions.md#running-cursor).
- An older command provider of yours named `cursor` must be renamed: `providers[0].cursor: built in, so it takes no command; give your own provider another name`.

### Which login

Work and personal subscriptions on one machine? Pin each config's logins:

```yaml
providers:
  - claude: { config_dir: ~/.claude-work }
  - codex: { config_dir: ~/.codex-work }
forge: { github: { user: octocat-acme } }
```

`config_dir` is passed as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`; log in there once (`CLAUDE_CONFIG_DIR=~/.claude-work claude /login`, `CODEX_HOME=~/.codex-work codex login`). `forge.github.user` picks a `gh auth status` account: its `gh auth token --user` becomes `GH_TOKEN` for everything awaywork does on GitHub, no `gh auth switch`. `doctor` names each login and fails with the fix:

<!-- Generated by `pnpm docs:gen` from scripts/screens.ts. Do not edit. -->

```text config-doctor-logins
✔  gh login: octocat-acme, pinned by forge.github.user
✔  claude login: <email>, max, in ~/.claude-work, pinned by providers[0].claude.config_dir
✖  codex login: ~/.codex-work doesn't exist; log in there with CODEX_HOME=~/.codex-work codex login
```

Details:

- `~/.claude` means Claude Code's default login, found only with `CLAUDE_CONFIG_DIR` unset, so that's what awaywork does.
- Unpinned, a run uses the environment: for a [scheduled job](../scheduling/machine.md), the env file and each binary's default, not a shell function that switches logins.
- The environment wins: `CLAUDE_CODE_OAUTH_TOKEN` over `config_dir`, `GH_TOKEN` or `GITHUB_TOKEN` over `user` (`GH_ENTERPRISE_TOKEN` with a `host`). So one config also runs in Actions or a container. `doctor` warns when that token is someone else's: `gh login: octocat from GH_TOKEN, not forge.github.user octocat-acme: a token in the environment wins; make it octocat-acme's, or unset it`.
- Cursor's login is `CURSOR_API_KEY`, everywhere.
- Under `isolation: user` or `container`, Claude's `config_dir` is refused (`set CLAUDE_CODE_OAUTH_TOKEN instead`). Codex's works: the `auth.json` it lends comes from there.
- A pin that can't be made stops `run`, `plan`, `approve`, `replay`, `sources` and `schedule install` before they touch anything (`forge.github.user: octocat-acme isn't logged in to gh; log in with gh auth login, as octocat-acme`), and `watch` starts nothing new until it can; working pins still apply to runs already going.

### Bring your own CLI

opencode, Amp and friends need no code in awaywork. Name a provider and give it a command; your CLI, your login:

```yaml
providers:
  - claude
  - opencode:
      command: opencode run --auto "$(cat "$AWAYWORK_PROMPT")"
      probe: ./opencode-quota.sh # optional; without it, windows only
limits:
  unit_minutes: 45
```

It runs in the clone like any worker, the prompt in the file `$AWAYWORK_PROMPT`, output to `worker.log`; exit 0 is a finished unit. (`--auto` approves whatever your opencode config doesn't deny; check your version's `--help`.) There's no turn cap, so `limits.unit_minutes` is required. The keys are in the [reference](../../reference/config.md#providers-key).

A `probe` prints the quota as JSON. awaywork paces against the `long` window; `short` only feeds the session stop:

```json
{
  "windows": [
    { "name": "5h", "span": "short", "used": 0.2, "resetsAt": 1793021152, "minutes": 300 },
    { "name": "7d", "span": "long", "used": 0.3, "resetsAt": 1793539552, "minutes": 10080 }
  ]
}
```

Details:

- `secrets` are withheld from other workers and listed in Actions; `skills_dir` (default `.agents/skills`) is where the unit's skills go.
- No `model` key (put it in the command) and no `mcp`: a rule it may run can't name MCP servers, so route those elsewhere with `provider`.
- Nothing installs it on a GitHub-hosted runner, so there `plan` routes around it and `schedule install` leaves it out.
- `fallback.turns` doesn't apply; its 60 is for Claude, Codex and Cursor without a quota reading.
- Without a `probe` (or one with no `long` window) it runs on the `fallback` caps and sits out every run outside the windows, `run --unit` included. With no live rate-limit events, it can't stop mid-unit at the ceiling.
- The probe runs in the config's folder once per `plan` or `run`, after each unit and in `doctor`, with 60 s and your whole environment. `used` is 0 to 1, `resetsAt` unix seconds, `minutes` optional (a `long` window without it is 7 days).
- Whether the vendor allows unattended use is your call; `doctor` flags it `unattended: grey`.
