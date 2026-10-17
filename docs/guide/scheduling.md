---
description: Run awaywork in its windows on your machine with launchd, systemd or cron, or in GitHub Actions on GitHub's runners or your own.
---

# Scheduling

A scheduled run is `awaywork run --scheduled`: it does nothing outside the [`windows`](./configuration.md#windows-limits-and-budget) and starts no unit after the one it is in ends. A unit still running at the window's end stops there with status `stopped: window ended`, and what it left is published as for a quota stop.

In a terminal, `awaywork schedule install` asks where it runs:

```
◆  Where should it run on a schedule?
│  ● this machine
│  ○ GitHub Actions, from the repo in this directory
│  ↑/↓ to navigate • Enter: confirm
└
```

`--with` answers that up front, and without a terminal (a script, a coding agent) it asks nothing and takes this machine. `awaywork init` ends with the same question, plus _later_.

## On your machine

```sh
awaywork schedule install                 # macOS: launchd
awaywork schedule install --with systemd  # Linux: a user timer
awaywork schedule install --with cron
awaywork schedule status                  # scheduler, time, config and log
awaywork schedule remove
```

| Scheduler | Writes | Missed while asleep or off |
| --- | --- | --- |
| launchd | `~/Library/LaunchAgents/awaywork.plist` | Runs at the next wake |
| systemd | `~/.config/systemd/user/awaywork.{service,timer}` | Runs at the next boot (`Persistent=true`) |
| cron | a tagged line in your crontab | Skipped |

- The job keeps the `PATH` of the shell that installed it, so it finds the same `claude`, `codex` and `gh`. It runs the binary on that `PATH`, not a shell alias or function wrapping it.
- Secrets come from `~/.config/awaywork/env`, since a scheduled job starts without your login shell's variables.
- One `awaywork run` at a time: a manual run during the scheduled one exits 1 with `already running (pid 4242, run 20261012-203418)` and the lock path. A lock left by a dead process is taken over; `--dry-run` doesn't take it.
- systemd user timers run only while you are logged in; `loginctl enable-linger` lifts that. Without a user session (after `sudo -iu` or `su -`, say) `--with systemd` fails and changes nothing; log in directly, or use `--with cron`, which needs no session. From such a shell `schedule status` and `doctor` can't reach the timer and report no schedule.
- Output goes to `~/.local/state/awaywork/schedule.log`, each run starting with a line dated in local time; the morning report is `awaywork report`. Both list what went wrong before any unit started, like a source command that failed:

  ```
  awaywork run at 2026-10-12 22:34:18
  warning: source chores: Command failed with exit code 1: ./chores.sh

  CHORES_TOKEN is not set
  Run 20261012-203418: 0 units planned, state in ~/.local/state/awaywork/runs/20261012-203418
  ```

  A secret the config names shows up as `***` there, so the report is safe to hand to `notify`. Run ids are the start time in UTC, so they sort the same across daylight saving and travel.

- The job bakes in the window starts, one trigger each. When you change them, `config edit` and `doctor` warn until `schedule install` runs again.

### Waking up for it

A sleeping machine runs nothing. Once a run starts it keeps the machine from idling back to sleep (`caffeinate -i` on macOS, `systemd-inhibit --what=idle` on Linux when it works there), so the missing piece is the wake itself. In a terminal, `schedule install` offers one after the job:

```
◆  Wake this Mac when the window opens (sudo pmset repeat wake MTWRFSU 01:00:00)?
│  ● Yes / ○ No
└
```

- macOS: `pmset` keeps a single repeating wake, so this needs every window to start at the same time, and it replaces the repeating power events you already had, a scheduled sleep or shutdown too. The question lists them and then defaults to No, unless all it replaces is a wake. Keep a laptop on the charger; with the lid closed on battery it may not wake fully.
- Linux: a root timer, `/etc/systemd/system/awaywork-wake.timer` with `WakeSystem=true`, resumes from suspend at each window start. A background job may block idle but not sleep, so a desktop that suspends on its own timer (GNOME's automatic suspend, say) can still put it down mid-run; turn that off on AC power.
- sudo wants a password, so without a terminal install only says how. `schedule remove` leaves the wake and prints the command that removes it.

## In GitHub Actions

Run it from a repo of your own instead (a private "awaywork" repo works well), on GitHub's runners or on a machine of yours. On a team, each person keeps their own control repo, so nobody's token sits in a repo a teammate can write to. Teammates can point theirs at the same repos, since each run only sees its own token's `@me`. A team base config those repos extend is an open issue, [#119](https://github.com/AndreaProvenzale/awaywork/issues/119).

```
$ cd my-awaywork-repo
$ awaywork schedule install
☾ >_ awaywork  You're away, your agents work

│
◇  Where should it run on a schedule?
│  GitHub Actions, from the repo in this directory
│
◇  Which runner?
│  self-hosted
Wrote .github/workflows/awaywork.yml
Copied ~/.config/awaywork/config.yml to .awaywork/config.yml
Before the first run:
  commit .github/workflows/awaywork.yml and .awaywork/config.yml
  add these repository secrets: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
  GH_TOKEN is a classic personal access token of yours with the `repo`, `workflow` and `read:org` scopes (…)
```

The runner is GitHub-hosted by default: a fresh VM each run, with no Codex. Self-hosted is a machine of yours, see [Running Codex](#running-codex). Without a terminal, `awaywork schedule install --with github-actions` asks nothing: it keeps the runner the workflow already has, GitHub-hosted for a new one, and offers no secret.

This writes `.github/workflows/awaywork.yml`: a cron at each window's start in your current timezone, plus `workflow_dispatch` for a manual run; `awaywork schedule remove` deletes it. It also copies your config to `.awaywork/config.yml` and your [skills](./skills.md#where-skills-come-from), if any, to `.awaywork/skills/` next to it, so your personal skills reach the runner. It offers to set each repository secret the config needs whose value is in your environment or `~/.config/awaywork/env`, with `gh secret set`. Values are never printed. Then:

1. Commit the files it lists.
2. Add the repository secrets it lists as unset, e.g. `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ASANA_TOKEN`, your `notify.secrets`, your repos' `secrets`, your MCP servers' `secrets` and your custom sources' `secrets`.
3. Run it once by hand from the Actions tab.

`doctor`, run inside the repo, checks that every secret the workflow names exists in the repo or its org, and fails naming the missing ones. A workflow that doesn't parse fails, since it won't run either. When gh can't list the repo's or the org's secrets (no access, no remote, not logged in), it warns why instead of guessing what's missing. The action fails before anything else when `GH_TOKEN` is empty, which is how a job whose secrets didn't reach it shows.

`GH_TOKEN` is your own token, since the work is yours: a classic personal access token with the `repo`, `workflow` and `read:org` scopes. `repo` reads your PRs, issues, checks and Actions logs, pushes new branches and opens draft PRs in the configured repos; `workflow` lets it push branches that change workflow files; `read:org` tells teammates who keep their org membership private from outsiders, whose text [gets hidden](./safety.md#public-repos).

The workflow calls awaywork's action at the release you generated it with, say `AndreaProvenzale/awaywork@v0.3.1`, which installs that same version (the `version` input). On a GitHub-hosted runner it first frees about 20 GB of preinstalled SDKs (runners otherwise die quietly on large repos). It commits as the token's user, through the job's env rather than git config, appends the morning report to the job summary and uploads the run as an [artifact](#reports-from-the-runner). To upgrade, upgrade awaywork and run `schedule install --with github-actions` again: the CLI and the action move together, and fixes to the action's steps reach you the same way. Editing by hand, change the tag in `uses:` and `version` together. The job's `GITHUB_TOKEN` can only read (`permissions: contents: read`), checkout keeps no credential (`persist-credentials: false`), and only the action's step gets the secrets. Every step inside the action sees them, which is why it's pinned: new action code never meets your secrets until you re-run `schedule install`. Want it tighter than a tag? Pin `uses:` to that release's commit SHA instead. A [custom source](./custom-sources.md)'s `setup` runs as a step of its own before the action, in the config's folder, without the secrets.

Run `schedule install --with github-actions` again after changing your config or skills, or to refresh the workflow. Of the workflow, config and skills, one that matches is up to date; one that differs shows the diff and is replaced only if you say yes, so a hand edit never goes silently. Without a terminal nobody can say yes: it keeps the repo's copy, prints the diff and exits 1, so run it again in a terminal to replace it. The skills folder is replaced as a whole: a skill only the repo has, say one you added by hand, goes with it. With no skills of your own, the repo's stay.

A workflow generated before the action existed runs its steps inline and misses those fixes; `doctor`, run inside the repo, warns until you run `schedule install --with github-actions` again.

A stdio [MCP server](./configuration.md#mcp-servers) runs on the runner, so its `command` must be there: `npx` and `node` are, other binaries need a setup step. An HTTP server must be reachable from GitHub's runners.

A GitHub-hosted runner starts with an empty state dir, so it keeps no attempts or skips: an item unchanged since the last run runs again, none is given up on, and `awaywork skip` on your machine doesn't reach it. Nor does it keep the head a [`deliver: push`](./chains.md#push) left, so the PR doesn't wait for your review: the rule pushes again every run its `where` holds. A self-hosted runner keeps `~/.local/state/awaywork` of the user it runs as, so all of that carries over between runs as on your machine.

GitHub also ends a job on its hosted runners at 6 hours, whatever your window says. So there a run stops 5h40 after `awaywork run` starts, or at the window's end when that comes first, and the 20 minutes left go to publishing and the report; the workflow sets `timeout-minutes: 360` to match. A longer window, like `18:00-07:00`, effectively lasts about 6 hours there, and `plan` on the runner says so:

```
Warnings
  GitHub-hosted runners end a job at 6 hours, so a run stops 5h40 after it starts, before 18:00-07:00 ends
```

The stop works like any window end: a running unit stops with `stopped: window ended` and publishes what it has. A run from the Actions tab gets the same cap. On a self-hosted runner a run lasts the whole window: GitHub's default of 360 minutes applies to self-hosted jobs too, so that workflow sets `timeout-minutes: 1440`. One installed without it gets the line on your next `schedule install --with github-actions`.

Pick one per machine, though: a local schedule or a runner. Nothing keeps two runs apart, so with both on one machine they start together when a window opens and work the same items on the same state dir. Moving to the runner, run `awaywork schedule remove` outside the control repo first; inside it, that deletes the workflow too.

### Run one item now

Something just caught fire and you don't want to wait for the window? The workflow takes a `unit` input, an item key:

```
$ gh workflow run awaywork -f unit=API-12
```

That runs only `API-12`, outside any window, and retries it even if an earlier attempt failed. The input is the key and nothing else: the item is fetched again from its source and must still match one of your rules, so "only your items", the budget ceiling and the prompt stay as they are.

Worth knowing:

- The workflow's `concurrency: awaywork` doesn't cancel anything. A dispatch during the nightly run waits for it, and GitHub keeps only the newest pending run, so a second dispatch replaces the first.
- It spends daytime quota, next to your own sessions. The ceiling still holds.
- "Run it when Sentry escalates" needs a relay: Sentry's alert webhooks can't, as far as we know, send the auth header and body GitHub's dispatch API wants. awaywork ships none, and holds no credentials for one; a small function of yours that calls `gh workflow run` is enough.

### Reports from the runner

The runner's runs dir doesn't come back to your machine, so each run also uploads its `report.md` and `units.json` as an artifact named after the workflow and the run, like `awaywork-20261014-223527`. Inside the control repo, `awaywork report` and `report --list` fetch those through `gh` and mix them with your local runs, newest first. They find a workflow's runs by its file name, so keep its `name:` as `schedule install` wrote it:

```
$ cd my-awaywork-repo
$ awaywork report --list
20261015-160012  9 units, 3 draft PRs, 2 reports  (github: awaywork)
20261014-223527  14 units, 2 draft PRs, 6 reports  (github: awaywork)
20261012-203418  0 units, 0 draft PRs, 0 reports
```

`awaywork report` prints the newest of either, `report <id>` any of them. A run is downloaded once, into `~/.local/state/awaywork/remote/<owner>/<repo>/<artifact>/`, and never into `runs/`, so `stats`, `replay` and attempts stay about your own machine. Artifacts expire with the repo's retention (90 days unless you changed it), and an expired run drops off the list. If `gh` can't get to GitHub, you get one `warning:` line and your local runs. Outside the control repo, `report` only knows your local runs.

### Credentials on a runner

| Provider | Secret | Notes |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; lasts a year |
| Codex | none | Self-hosted runners only, on the machine's own login |

### Running Codex

Codex is experimental and doesn't run on GitHub-hosted runners: it uses the machine's own `codex login`, which Codex rotates in place, and a fresh runner has none to keep. With a GitHub-hosted runner, `schedule install` says so and leaves it out of the workflow, and a run there routes its units to your other providers:

```
codex won't run in this workflow: a GitHub-hosted runner has no Codex login, and one copied there goes stale since Codex rotates it in place; run Codex locally or on a self-hosted runner
```

So run it one of two ways:

- **Locally**, with launchd, systemd or cron, as in [On your machine](#on-your-machine).
- **On a self-hosted runner**: a machine of yours [added as the control repo's runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners), logged in with `codex login` as the user the runner runs as. On a headless box, `codex login --device-auth` does it without a browser ([Codex's docs](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)). Pick self-hosted at _Which runner?_: the workflow says `runs-on: self-hosted` and keeps Codex, with no secret for it. Every self-hosted runner the repo can use matches that, an organization's too, so a colleague's box could pick up your job: give your runner a [label of its own](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels) and add it, as in `runs-on: [self-hosted, alice-mac]`. Install says so while it's plain `self-hosted`, and keeps the labels on a re-run.

On a self-hosted runner the job runs on your machine, so the action keeps its hands off it: no freeing disk, no provider CLIs installed over yours, no git config written. It installs awaywork alone into the job's temp dir, which the runner empties every job, and runs the `codex` and `claude` already on the runner's `PATH`, next to `git` and `gh`. A runner installed [as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application) doesn't read your shell profile: its `PATH` is the one `./config.sh` saved to `.path` in the runner's folder, which [`runsvc.sh`](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/runsvc.sh) exports, and other variables sit in `.env` next to it. So a `codex` or `claude` from nvm or Homebrew can be missing there: configure the runner from a shell where `codex --version` works, or add their folders to `.path` and restart the service (`./svc.sh stop`, then `./svc.sh start`). Claude still reads `CLAUDE_CODE_OAUTH_TOKEN` there. GitHub recommends self-hosted runners only for private repos, since a fork's pull request could otherwise run code on your machine: keep the control repo private.
