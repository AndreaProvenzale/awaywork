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
manual run; `nightshift schedule remove` deletes it. Then:

1. Commit your config as `.night-shift/config.yml`.
2. Add the repository secrets it lists, e.g. `GH_TOKEN`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `ASANA_TOKEN` and your `notify.secrets`.
3. Run it once by hand from the Actions tab.

`GH_TOKEN` is your own token, since the work is yours: it reads your PRs,
issues, checks and Actions logs, pushes new branches and opens draft PRs
in the configured repos.

The workflow calls night-shift's action, `AndreaProvenzale/night-shift@v1`,
which installs the nightshift-agent version you generated it with. The
action frees about 20 GB of preinstalled SDKs first (runners otherwise
die quietly on large repos), commits as the token's user, and appends the
morning report to the job summary. Fixes to those steps reach you through
`v1`; to upgrade night-shift itself, raise `version` in the workflow.

### Credentials on a runner

| Provider | Secret | Notes |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; lasts a year |
| Codex | `CODEX_AUTH_JSON` | The contents of `~/.codex/auth.json`. Best effort: Codex rotates it about every 8 days, and an ephemeral runner can't save the refreshed file, so the secret eventually goes stale. Prefer running Codex locally. |
