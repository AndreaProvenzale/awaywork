---
description: Run night-shift every night on your machine with launchd, systemd or cron, or in GitHub Actions with repository secrets.
---

# Scheduling

A scheduled run is `nightshift run --scheduled`: it does nothing outside
the `night` window and starts no unit after `night.end`. A unit still
running at `night.end` stops there with status `stopped: night ended`,
and what it left is published as for a quota stop.

## On your machine

```sh
nightshift schedule install                 # macOS: launchd
nightshift schedule install --with systemd  # Linux: a user timer
nightshift schedule install --with cron
nightshift schedule status                  # scheduler, time, config and log
nightshift schedule remove
```

| Scheduler | Writes | Missed while asleep or off |
|---|---|---|
| launchd | `~/Library/LaunchAgents/nightshift.plist` | Runs at the next wake |
| systemd | `~/.config/systemd/user/nightshift.{service,timer}` | Runs at the next boot (`Persistent=true`) |
| cron | a tagged line in your crontab | Skipped |

- The job keeps the `PATH` of the shell that installed it, so it finds the
  same `claude`, `codex` and `gh`. It runs the binary on that `PATH`, not
  a shell alias or function wrapping it.
- Secrets come from `~/.config/night-shift/env`, since a scheduled job
  starts without your login shell's variables.
- systemd user timers run only while you are logged in;
  `loginctl enable-linger` lifts that.
- Output goes to `~/.local/state/night-shift/schedule.log`; the morning
  report is `nightshift report`.
- The job bakes in `night.start`. When you change it, `config edit` and
  `doctor` warn until `schedule install` runs again.

The machine must be awake at `night.start`. On a laptop, a sleep schedule
that wakes it (macOS: `pmset repeat wakeorpoweron`) or a machine that
stays on does that.

## In GitHub Actions

Run it on a hosted runner instead, from a repo of your own (a private
"night-shift" repo works well):

```sh
cd my-night-shift-repo
nightshift schedule install --with github-actions
```

This writes `.github/workflows/night-shift.yml`: a nightly cron at
`night.start` in your current timezone, plus `workflow_dispatch` for a
manual run; `nightshift schedule remove` deletes it. It also copies your
config to `.night-shift/config.yml` unless the repo has one, and offers to
set each repository secret the config needs whose value is in your
environment or `~/.config/night-shift/env`, with `gh secret set`. Values
are never printed. Then:

1. Commit the workflow and `.night-shift/config.yml`.
2. Add the repository secrets it lists as unset, e.g. `GH_TOKEN`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `ASANA_TOKEN`, your `notify.secrets`, your `after_unit.secrets`, your
   repos' `secrets`, your MCP servers' `secrets` and your custom sources' `secrets`.
3. Run it once by hand from the Actions tab.

`GH_TOKEN` is your own token, since the work is yours: a classic personal
access token with the `repo` and `workflow` scopes. `repo` reads your PRs,
issues, checks and Actions logs, pushes new branches and opens draft PRs
in the configured repos; `workflow` lets it push branches that change
workflow files.

The workflow calls night-shift's action, `AndreaProvenzale/night-shift@v1`,
which installs the nightshift-agent version you generated it with. The
action frees about 20 GB of preinstalled SDKs first (runners otherwise
die quietly on large repos), commits as the token's user, and appends the
morning report to the job summary. Fixes to those steps reach you through
`v1`; to upgrade night-shift itself, raise `version` in the workflow.
The action gets the job's env, secrets included: if you'd rather not
follow `v1`, pin it to a commit SHA of this repo instead. A
[custom source](./custom-sources.md)'s `setup` runs as a step of its own
before the action, in the config's folder.

The workflow works once night-shift has a stable release on npm, which
also creates the `v1` tag.

A workflow generated before the action existed runs its steps inline and
misses those fixes; `doctor`, run inside the repo, warns until you
`schedule remove` and `schedule install --with github-actions` again.

A stdio [MCP server](./configuration.md#mcp-servers) runs on the runner,
so its `command` must be there: `npx` and `node` are, other binaries
need a setup step. An HTTP server must be reachable from GitHub's runners.

A runner starts with an empty state dir, so it keeps no attempts or
skips: an item unchanged since last night runs again, none is given up
on, and `nightshift skip` on your machine doesn't reach it. Nor does it
keep the head a [`deliver: push`](./configuration.md#push) left, so the
PR doesn't wait for your review: the rule pushes again every night its
`where` holds.

### Credentials on a runner

| Provider | Secret | Notes |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; lasts a year |
| Codex | `CODEX_AUTH_JSON` | The contents of `~/.codex/auth.json`. Best effort: Codex rotates it about every 8 days, and an ephemeral runner can't save the refreshed file, so the secret eventually goes stale. Prefer running Codex locally. |
