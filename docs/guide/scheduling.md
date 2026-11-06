---
description: Run awaywork in its windows on your machine with launchd, systemd or cron, in GitHub Actions on GitHub's runners or your own, or in a container on Coolify or any Docker host.
---

# Scheduling

A scheduled run is one [window](./configuration.md#windows-limits-and-budget) opening: it starts when the window opens and starts no unit after it ends. A unit still running at the window's end stops there with status `stopped: window ended`, and what it left is published as for a quota stop. On your machine and [in a container](#in-a-container), `awaywork watch` starts those runs; in GitHub Actions, a cron calls `awaywork run --scheduled` at each window's start.

In a terminal, `awaywork schedule install` asks where it runs:

```
◆  Where should it run on a schedule?
│  ● this machine
│  ○ GitHub Actions, from the repo in this directory
│  ○ a container (Docker Compose, e.g. Coolify), from the repo in this directory
│  ↑/↓ to navigate • Enter: confirm
└
```

`--with` answers that up front, and without a terminal (a script, a coding agent) it asks nothing and takes this machine. `awaywork init` ends with the same question, plus _later_.

## On your machine

```sh
awaywork schedule install                 # macOS: launchd
awaywork schedule install --with systemd  # Linux: a user service
awaywork schedule install --with cron
awaywork schedule status                  # the job, the daemon and its log
awaywork schedule remove
```

The job is one long-running process, `awaywork watch`, that the scheduler keeps alive. It looks at the clock every minute and starts a run when a window opens, so it lands in the window even after the machine slept through the opening, and it reads the config each time: edit your windows and the next opening follows them, no reinstall. It also runs your [`run: soon`](#soon-runs) rules within minutes, windows or not.

| Scheduler | Writes | Keeps it alive |
| --- | --- | --- |
| launchd | `~/Library/LaunchAgents/awaywork.plist` | Started at login, restarted after a crash (`KeepAlive`, `SuccessfulExit: false`) |
| systemd | `~/.config/systemd/user/awaywork.service` | Enabled at login, `Restart=on-failure` |
| cron | two tagged lines in your crontab | Started at boot (`@reboot`) and again every 5 minutes |

`schedule status` shows what it's up to:

```
$ awaywork schedule status
Scheduled with launchd, keeping awaywork watch running
Config: ~/.config/awaywork/config.yml
Log: ~/.local/state/awaywork/schedule.log
Daemon: running, pid 67014, since 2026-10-25 17:26:00
Run in progress: soon run 20261025-162625
Run in progress: soon run 20261025-162725
Next poll of chores: 2026-10-25 17:28:00
Next poll of flaky: 2026-10-25 17:30:00, backing off after 1 failed poll
Next window: none, no windows set
Daemon log: ~/.local/state/awaywork/watch.log
```

- One opening, one run. A run that finishes early isn't started again in the same window; one started inside a window, after a reboot say, picks up there, and items it already worked on don't run again.
- One daemon at a time: another copy exits right away with `awaywork watch is already running (pid 67014)`. That's what makes cron's restart line harmless.
- Your manual run or the daemon's, not both: a manual `awaywork run` while the daemon has a run in progress exits 1 with `awaywork watch holds the run lock (pid 67014); try again once its runs end, awaywork schedule status lists them`. The other way round, a window opening during your manual run waits for it, checking every minute, and says so once in its log; a soon run waits for the next poll. A lock left by a dead process is taken over; `--dry-run` doesn't take it.
- The job keeps the `PATH` of the shell that installed it, so it finds the same `claude`, `codex`, Cursor's `agent` and `gh`. It runs the binary on that `PATH`, not a shell alias or function wrapping it.
- Secrets come from `~/.config/awaywork/env`, since a scheduled job starts without your login shell's variables.
- The daemon reads the env file and its own code once, when it starts. Edited the env file or upgraded awaywork? Run `schedule install` again, which restarts it.
- systemd user services run only while you are logged in; `loginctl enable-linger` lifts that. Without a user session (after `sudo -iu` or `su -`, say) `--with systemd` fails and changes nothing; log in directly, or use `--with cron`, which needs no session. From such a shell `schedule status` and `doctor` can't reach the service and report no schedule.
- `windows: []` is fine: the daemon idles, and install sets no wake.
- `schedule install` and `schedule remove` stop the running daemon first, whatever started it (launchd, systemd, cron or you by hand): a SIGTERM, then up to 2 minutes for it to exit. That stops a run in progress: the running unit stops and publishes nothing, as in the log below, and doesn't count as an attempt, so the next run takes it again. One still running after that makes install change nothing and say so; run it again once it's gone. Run from inside the daemon, by a notify hook or a worker, they refuse instead of stopping it.
- launchd and systemd bring it back only after a crash. One you stop with a SIGTERM of your own stays down until your next login or `schedule install`; under cron it's back within 5 minutes.

The daemon's log, `~/.local/state/awaywork/watch.log`, has events only: start and stop, each run and unit starting and ending, and what went wrong, never a line per minute. Past 5 MB it moves to `watch.log.1`. Here a SIGTERM stopped it a few seconds into a unit:

```
2026-10-25 15:54:30 awaywork watch started, pid 40864, config ~/.config/awaywork/config.yml
2026-10-25 15:54:30 window run 20261025-145430 started, until 2026-10-25 15:58:00
2026-10-25 15:54:30 Run 20261025-145430: 1 unit planned, state in ~/.local/state/awaywork/runs/20261025-145430
2026-10-25 15:54:30   ch-2: plan on mine
2026-10-25 15:54:42   ch-2: stopped: aborted
2026-10-25 15:54:42 Run 20261025-145430: 0 draft PRs, 0 reports, 1 unit
     item  skill  status                      result
  1  CH-2  plan   stopped: aborted (aborted)  interrupted
     Fix the typo in the README
Report: ~/.local/state/awaywork/runs/20261025-145430/report.md
2026-10-25 15:54:42 awaywork watch stopped
```

Each run's full output, what `awaywork run` prints in a terminal, goes to `run.log` in its run dir; with `watch: { debug: true }` in the config it lands in `watch.log` as well. `schedule.log` only catches a daemon that crashed. The morning report is `awaywork report`. Both list what went wrong before any unit started, like a source command that failed:

```
warning: source chores: Command failed with exit code 1: ./chores.sh
  Error: CHORES_TOKEN is not set
Run 20261012-203418: 0 units planned, state in ~/.local/state/awaywork/runs/20261012-203418
```

A failed command gets two lines, its error and the last error line of its stderr, however much it printed. A secret the config names shows up as `***` there, so the report is safe to hand to `notify`. Run ids are the start time in UTC, so they sort the same across daylight saving and travel.

A job an older awaywork installed, one trigger per window starting `awaywork run --scheduled`, keeps working, but `schedule status` and `doctor` say it was installed by an older awaywork. Run `awaywork schedule install` once after upgrading.

### Soon runs

A rule with [`run: soon`](./configuration.md#run-soon) doesn't wait for a window. Every `watch.every`, 5 minutes by default, the daemon polls the sources its soon rules read, plans just those rules over what came back, and starts a run for the units that are due: a new item, or one changed since its last attempt, like your PR going red or your reply under awaywork's [questions](./how-it-works.md#questions). awaywork's own questions comment isn't a change. Neither is anything a run already took, until the item changes again: a unit that failed waits for that, or for the next window, instead of retrying every 5 minutes. One its run never attempted, because it found no quota, sat out a present run or was stopped, is due again an hour later, windows or not, or at the first poll after the daemon restarts.

Work on a clock of its own, every Monday at 09:00 say, is a [routine](./configuration.md#routines): an item that comes due then, which a soon rule starts at the first poll after.

Here a custom source's output changed between polls: a new item, then awaywork's questions on it at 16:19 (nothing), then a reply at 16:20. The second source was down for a bit:

```
2026-10-25 16:17:51 awaywork watch started, pid 27290, config ~/.config/awaywork/config.yml
2026-10-25 16:17:51 source flaky: poll failed, next at 2026-10-25 16:21:51: Command failed with exit code 1: ./flaky.sh
2026-10-25 16:17:51 soon run 20261025-151751 started for ch-1
2026-10-25 16:17:51 Run 20261025-151751: 1 unit planned, state in ~/.local/state/awaywork/runs/20261025-151751
2026-10-25 16:17:51 Run 20261025-151751: 0 draft PRs, 0 reports, 1 unit
     item  skill  status   result
  1  CH-1  plan   skipped  no provider left: stub sits out a present run (no quota rea…
     Fix the typo in the README
Report: ~/.local/state/awaywork/runs/20261025-151751/report.md
2026-10-25 16:21:00 soon run 20261025-152100 started for ch-1
2026-10-25 16:21:00 Run 20261025-152100: 1 unit planned, state in ~/.local/state/awaywork/runs/20261025-152100
2026-10-25 16:21:00 Run 20261025-152100: 0 draft PRs, 0 reports, 1 unit
     item  skill  status   result
  1  CH-1  plan   skipped  no provider left: stub sits out a present run (no quota rea…
     Fix the typo in the README
Report: ~/.local/state/awaywork/runs/20261025-152100/report.md
2026-10-25 16:22:00 source flaky: polled fine again, every 2m
```

- Every trigger is a run: the units one poll finds make one run, with its own run dir, plan, report and `per_run` share. A poll that finds nothing due writes nothing; with `watch: { debug: true }` it logs one line.
- Outside a window a soon run is present, as above: workers stop at `present_session_max`, and a provider whose quota can't be read sits out. Inside a window it's away, like the window run, and stops at the window's end.
- A poll reads no quota and runs no model; the quota is read when a soon run starts. What a poll costs is source calls. The base GitHub poll is 3 searches (your PRs, PRs awaiting your review, issues assigned to you), plus one per `search` entry and two more when a rule reads [finished items](./configuration.md#finished-items): about 36 searches an hour at 5 minutes, well under GitHub's limits. A tracker poll is its list call, plus a PR search for each open task that links none yet. A slow tracker, or one with a tight rate limit, gets its own `every`.
- Runs overlap now, a window run and a soon run say, but never on the same item, and only one worker runs at a time: a soon run's unit waits for the chain the window run is on, a review → fix loop included, not for the whole run. A run that waits routes on the quota it read when it planned, and its worker still stops at the ceiling. A unit another of the daemon's runs is working on is skipped as `running in run 20261025-010000` in the second run's plan and report, and no poll counts it due until that run ends. The daemon holds the run lock, and keeps the machine awake, while any of its runs is in progress. An `isolation` edit waits for the runs in progress to drain, applying to the next run that starts with none in progress, so it waits as long as runs keep overlapping: one that starts meanwhile keeps the isolation in force, and the log says once that the edit waits. Restart `awaywork watch`, or run `awaywork schedule install`, to apply it at once.
- A poll that fails backs off: as long as the source's `Retry-After` asks when it says (Jira and Asana do, on a 429), otherwise twice the interval per failure in a row up to an hour, back to normal on the first good poll. Each backoff and recovery is one line in the log. GitHub through `gh`, Linear and custom sources give awaywork no reset time, so they double.
- `notify` gets a soon run's `unit` events, not the end-of-run one: one answered question shouldn't ping you twice. A unit that sat out or its `when` passed over fires none, so the hourly retry stays quiet; a failed `setup` or a `when` check that timed out still does.

### Waking up for it

A sleeping machine runs nothing. The daemon holds nothing while idle; while a run is in progress it keeps the machine from idling back to sleep (`caffeinate -i` on macOS, `systemd-inhibit --what=idle` on Linux when it works there), so the missing piece is the wake itself. In a terminal, `schedule install` offers one after the job:

```
◆  Wake this Mac when the window opens (sudo pmset repeat wake MTWRFSU 01:00:00)?
│  ● Yes / ○ No
└
```

- macOS: `pmset` keeps a single repeating wake, so this needs every window to start at the same time, and it replaces the repeating power events you already had, a scheduled sleep or shutdown too. The question lists them and then defaults to No, unless all it replaces is a wake. Keep a laptop on the charger; with the lid closed on battery it may not wake fully.
- Linux: a root timer, `/etc/systemd/system/awaywork-wake.timer` with `WakeSystem=true`, resumes from suspend at each window start. A background job may block idle but not sleep, so a desktop that suspends on its own timer (GNOME's automatic suspend, say) can still put it down mid-run; turn that off on AC power.
- sudo wants a password, so without a terminal install only says how. `schedule remove` leaves the wake and prints the command that removes it.
- The wake is set for the windows' start at install, so moving that start needs `schedule install` again to move the wake too; `config edit` and `doctor` warn until then.

## In GitHub Actions

Run it from a repo of your own instead (a private "awaywork" repo works well), on GitHub's runners or on a machine of yours. On a team, each person keeps their own control repo, so nobody's token sits in a repo a teammate can write to. Teammates can point theirs at the same repos, since each run only sees its own token's `@me`. It's GitHub only, and one file: on a [Bitbucket](./configuration.md#bitbucket-and-jira) config, or one that [extends a base](./configuration.md#a-base-config), install refuses it, so use launchd, systemd or cron.

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

This writes `.github/workflows/awaywork.yml`: a cron at each window's start (none with `windows: []`), plus `workflow_dispatch` for a manual run. There's no daemon there, so [`run: soon`](#soon-runs) rules run in the windows like the rest, which install says once. `awaywork schedule remove` deletes it. It also copies your config to `.awaywork/config.yml` and your [skills](./skills.md#where-skills-come-from), if any, to `.awaywork/skills/` next to it, so your personal skills reach the runner. It offers to set each repository secret the config needs whose value is in your environment or `~/.config/awaywork/env`, with `gh secret set`. Values are never printed. Then:

1. Commit the files it lists.
2. Add the repository secrets it lists as unset, e.g. `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ASANA_TOKEN`, your `notify.secrets`, your repos' `secrets`, your MCP servers' `secrets` and your custom sources' `secrets`.
3. Run it once by hand from the Actions tab.

GitHub runs the cron in UTC, so `schedule install` converts each start from your current timezone at its standard time, and the job's `TZ` keeps window ends, `days` and [routines](./configuration.md#routines) in that timezone. The run never starts before the window opens, but in summer time it starts up to an hour into it: a `18:00` window in Rome fires at `17:00` UTC, which is 19:00 there from March to October, so keep windows on Actions longer than an hour or summer runs land past their end. Changed timezone? Run `schedule install` again.

`doctor`, run inside the repo, checks that every secret the workflow names exists in the repo or its org, and fails naming the missing ones. A workflow that doesn't parse fails, since it won't run either. When gh can't list the repo's or the org's secrets (no access, no remote, not logged in), it warns why instead of guessing what's missing. The action fails before anything else when `GH_TOKEN` is empty, which is how a job whose secrets didn't reach it shows.

`GH_TOKEN` is your own token, since the work is yours: a classic personal access token with the `repo`, `workflow` and `read:org` scopes. `repo` reads your PRs, issues, checks and Actions logs, pushes new branches and opens draft PRs in the configured repos; `workflow` lets it push branches that change workflow files; `read:org` tells teammates who keep their org membership private from outsiders, whose text [gets hidden](./safety.md#public-repos).

The workflow calls awaywork's action at the release you generated it with, say `AndreaProvenzale/awaywork@v0.3.1`, which installs that same version (the `version` input). On a GitHub-hosted runner it first frees about 20 GB of preinstalled SDKs (runners otherwise die quietly on large repos), and makes the [worker user](./safety.md#a-worker-user-on-github-hosted-runners) that setup, the agent and the checks run as, so they can't read your token. It commits as the token's user, through the job's env rather than git config, appends the morning report to the job summary and uploads the run as an [artifact](#reports-from-the-runner). To upgrade, upgrade awaywork and run `schedule install --with github-actions` again: the CLI and the action move together, and fixes to the action's steps reach you the same way. Editing by hand, change the tag in `uses:` and `version` together. The job's `GITHUB_TOKEN` can only read (`permissions: contents: read`), checkout keeps no credential (`persist-credentials: false`), and only the action's step gets the secrets. Every step inside the action sees them, which is why it's pinned: new action code never meets your secrets until you re-run `schedule install`. Want it tighter than a tag? Pin `uses:` to that release's commit SHA instead. A [custom source](./custom-sources.md)'s `setup` runs as a step of its own before the action, in the config's folder, without the secrets.

Run `schedule install --with github-actions` again after changing your config or skills, or to refresh the workflow. Of the workflow, config and skills, one that matches is up to date; one that differs shows the diff and is replaced only if you say yes, so a hand edit never goes silently. Without a terminal nobody can say yes: it keeps the repo's copy, prints the diff and exits 1, so run it again in a terminal to replace it. The skills folder is replaced as a whole: a skill only the repo has, say one you added by hand, goes with it. With no skills of your own, the repo's stay.

A workflow generated before the action existed runs its steps inline and misses those fixes; `doctor`, run inside the repo, warns until you run `schedule install --with github-actions` again.

A stdio [MCP server](./configuration.md#mcp-servers) runs on the runner, so its `command` must be there: `npx` and `node` are, other binaries need a setup step. On a GitHub-hosted runner it runs as the worker user, which can't enter the runner's home, where your control repo is checked out: a script there won't start, a package installed with the action's `packages` will. The same goes for a toolchain the worker runs, pnpm for one: list it in `packages`, since a setup action that installs into the home (`pnpm/action-setup` does) leaves the worker a binary it can't run. An HTTP server must be reachable from GitHub's runners.

A GitHub-hosted runner starts with an empty state dir, so it keeps no attempts, skips, approvals or earlier reports (an item waiting for your answer to awaywork's [questions](./how-it-works.md#questions), or your approval of its [plan](./how-it-works.md#plans), still waits, since that's read off the item): an item unchanged since the last run runs again, none is given up on, `awaywork skip` and `awaywork approve` on your machine don't reach it (`where: { approved: true }` never holds there), and a chain's first step starts without the last run's report. Nor does it keep the head a [`deliver: push`](./chains.md#push) left, so the PR doesn't wait for your review: the rule pushes again every run its `where` holds. A self-hosted runner keeps `~/.local/state/awaywork` of the user it runs as, so all of that carries over between runs as on your machine.

GitHub also ends a job on its hosted runners at 6 hours, whatever your window says. So there a run stops 5h40 after `awaywork run` starts, or at the window's end when that comes first, and the 20 minutes left go to publishing and the report; the workflow sets `timeout-minutes: 360` to match. A longer window, like `18:00-07:00`, effectively lasts about 6 hours there, and `plan` on the runner says so:

```
Warnings 1
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
- It spends daytime quota, next to your own sessions. The ceiling still holds, and since it starts outside every window, workers stop at `present_session_max` (40% of the 5-hour window by default).
- "Run it when Sentry escalates" needs a relay: Sentry's alert webhooks can't, as far as we know, send the auth header and body GitHub's dispatch API wants. awaywork ships none, and holds no credentials for one; a small function of yours that calls `gh workflow run` is enough.

### Reports from the runner

The runner's runs dir doesn't come back to your machine, so each run also uploads its `report.md`, `report.json` and `units.json` as an artifact named after the workflow and the run, like `awaywork-20261014-223527`. Inside the control repo, `awaywork report` and `report --list` fetch those through `gh` and mix them with your local runs, newest first. They find a workflow's runs by its file name, so keep its `name:` as `schedule install` wrote it:

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
| Cursor | `CURSOR_API_KEY` | A key from Cursor's dashboard |
| [Your own CLI](./configuration.md#bring-your-own-cli) | its `secrets` | Self-hosted runners only: nothing installs it on a GitHub-hosted one |

### Running Codex

Codex is experimental and doesn't run on GitHub-hosted runners: it uses the machine's own `codex login`, which Codex rotates in place, and a fresh runner has none to keep. With a GitHub-hosted runner, `schedule install` says so and leaves it out of the workflow, and a run there routes its units to your other providers:

```
codex won't run in this workflow: a GitHub-hosted runner has no Codex login, and one copied there goes stale since Codex rotates it in place; run Codex locally or on a self-hosted runner
```

So run it one of two ways:

- **Locally**, with launchd, systemd or cron, as in [On your machine](#on-your-machine).
- **On a self-hosted runner**: a machine of yours [added as the control repo's runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners), logged in with `codex login` as the user the runner runs as. On a headless box, `codex login --device-auth` does it without a browser ([Codex's docs](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)). Pick self-hosted at _Which runner?_: the workflow says `runs-on: self-hosted` and keeps Codex, with no secret for it. Every self-hosted runner the repo can use matches that, an organization's too, so a colleague's box could pick up your job: give your runner a [label of its own](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels) and add it, as in `runs-on: [self-hosted, alice-mac]`. Install says so while it's plain `self-hosted`, and keeps the labels on a re-run.

On a self-hosted runner the job runs on your machine, so the action keeps its hands off it: no freeing disk, no provider CLIs installed over yours, no git config written. It installs awaywork alone into the job's temp dir, which the runner empties every job, and runs the `codex`, `claude` and `agent` already on the runner's `PATH`, next to `git` and `gh`. A runner installed [as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application) doesn't read your shell profile: its `PATH` is the one `./config.sh` saved to `.path` in the runner's folder, which [`runsvc.sh`](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/runsvc.sh) exports, and other variables sit in `.env` next to it. So a `codex` or `claude` from nvm or Homebrew can be missing there: configure the runner from a shell where `codex --version` works, or add their folders to `.path` and restart the service (`./svc.sh stop`, then `./svc.sh start`). Claude still reads `CLAUDE_CODE_OAUTH_TOKEN` there. GitHub recommends self-hosted runners only for private repos, since a fork's pull request could otherwise run code on your machine: keep the control repo private.

### Running Cursor

Cursor's CLI has no npm package, so on a GitHub-hosted runner the action installs it with Cursor's own installer, as the runner's user rather than root: into `/opt/cursor`, which the worker user can read but not write, linked as `/usr/local/bin/agent`. `schedule install` puts that script in the workflow's `scripts` input, next to `packages`, and names `CURSOR_API_KEY` among the secrets:

```yaml
packages: "@anthropic-ai/claude-code"
scripts: |
  sudo install -d -o "$USER" /opt/cursor
  curl -fsS https://cursor.com/install | HOME=/opt/cursor bash
  sudo ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent
  agent --version
```

On a self-hosted runner it runs the `agent` already on the runner's `PATH` instead. Either way it gets the `CURSOR_API_KEY` secret the workflow passes, as it needs one everywhere: a login on the machine doesn't reach the fresh `HOME` it runs in.

## In a container

No machine of yours to leave on? Run `awaywork watch` in a container: on [Coolify](https://coolify.io), or with `docker compose` on any VPS. Setup, the agent and the checks run as a worker user inside it, as on a [GitHub-hosted runner](./safety.md#a-worker-user-in-awaywork-s-image). Compared with Actions, the state dir lives on a volume, so attempts, skips, approvals and a [`deliver: push`](./chains.md#push) head carry over; the daemon runs your [`run: soon`](#soon-runs) rules all day; there's no 6-hour cap; and Codex works, its login on a volume where it rotates in place.

It's a control repo of your own, private, as for Actions, and `schedule install` sets it up from inside it. Here with Claude Code, Codex and Linear in the config:

```
$ cd my-awaywork-repo
$ awaywork schedule install
☾ >_ awaywork  You're away, your agents work

│
◇  Where should it run on a schedule?
│  a container (Docker Compose, e.g. Coolify), from the repo in this directory
Wrote Dockerfile
Wrote compose.yml
Wrote entrypoint.sh
Copied ~/.config/awaywork/config.yml to .awaywork/config.yml
Before the first run:
  commit Dockerfile, compose.yml, entrypoint.sh and .awaywork/config.yml
  set these env vars in Coolify, or in .env beside compose.yml on a VPS: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, LINEAR_API_KEY
  GH_TOKEN is a classic personal access token of yours with the `repo`, `workflow` and `read:org` scopes (…)
  once it runs, log Codex in: docker exec -it <container> codex login --device-auth
```

Without a terminal, `schedule install --with docker` asks nothing. It writes the three files awaywork ships in `docker/` at the repo root, fit to your config, copies the config to `.awaywork/config.yml` and your [skills](./skills.md#where-skills-come-from), if any, to `.awaywork/skills/`. Commit and push, and that's all a deploy needs. Values are never printed: there's no secret store to offer them to, so you set them where the container runs.

| File | What it does |
| --- | --- |
| `Dockerfile` | Debian with Node 22, git, gh, sudo and tini; awaywork and your providers' CLIs, pinned to the awaywork that wrote it; `away`, the user awaywork runs as, and `awaywork`, the worker user, with the sudoers lines [`isolation: user`](./configuration.md#isolation) needs |
| `compose.yml` | `restart: unless-stopped`, `stop_grace_period: 2m`, `mem_limit: 4g`, volumes for the state dir and Codex's login, and each secret your config needs as an env var, with `TZ` defaulting to your timezone; `AWAYWORK_REMOTE_TOKEN` and port 7480, exposed to the proxy, for [your laptop](#from-your-laptop) |
| `entrypoint.sh` | Fails on an empty `GH_TOKEN`, commits as the token's user (env vars, as the action does), then `exec awaywork watch`, with its log on the container's output |

The image reads its config from `/home/away/.awaywork/config.yml`, copied in at build: a push is how a config change gets there. Only `.awaywork/` goes into the image, so anything your config names by path, a script say, lives in it too. It's GitHub only for now: the image has no twg, no SSH key for Bitbucket's pushes, and the entrypoint wants a `GH_TOKEN`, so install refuses a [Bitbucket](./configuration.md#bitbucket-and-jira) config, as for Actions. A config that [extends a base](./configuration.md#a-base-config) would get there without its base, so install refuses that too. For either, use launchd, systemd or cron.

Run `schedule install --with docker` again after changing your config or skills, or after upgrading awaywork. As for Actions, a file that matches is up to date, and one that differs shows the diff and is replaced only if you say yes, so a hand edit, a toolchain's `RUN` line say, never goes silently. Without a terminal it keeps the repo's copy, prints the diff and exits 1:

```
$ awaywork schedule install --with docker
diff --git a/…/my-awaywork-repo/Dockerfile b/…/awaywork-JnChDn/Dockerfile
index 994e7d1..10f7986 100644
--- a/…/my-awaywork-repo/Dockerfile
+++ b/…/awaywork-JnChDn/Dockerfile
@@ -18,7 +18,6 @@ ENV DISABLE_AUTOUPDATER=1
 RUN npm install -g "awaywork@$AWAYWORK_VERSION" $PACKAGES && npm cache clean --force

 # Your repos' toolchains go here, as RUN lines: setup runs as the worker user.
-RUN npm install -g pnpm@10

 # The developer's user runs awaywork; sudoers' chown names its uid and gid.
 RUN groupadd --gid 1001 away \
Kept Dockerfile; run this again in a terminal to replace it
compose.yml is up to date
entrypoint.sh is up to date
.awaywork/config.yml is up to date
```

In a terminal, say no to keep your line, or yes and add it back. `awaywork schedule remove` inside the repo deletes the three files, when the Dockerfile is awaywork's, and leaves `.awaywork/`. `doctor` inside it warns while the Dockerfile builds another awaywork than the one you run.

### On Coolify

Add a resource from your control repo with the **Docker Compose** build pack and the compose location `/compose.yml`. Coolify lists the variables `compose.yml` names, the ones install printed: `GH_TOKEN` is required, so it won't deploy until you fill it in (the same [classic token](#in-github-actions) as for Actions), `CLAUDE_CODE_OAUTH_TOKEN` is Claude's (`claude setup-token`), `CURSOR_API_KEY` Cursor's, and the rest your config's own. `TZ` is your windows' timezone and defaults to the one you ran install in; set it to change that. Deploy, and every push to the repo redeploys.

Compose, not the Dockerfile build pack: that one does [rolling updates](https://coolify.io/docs/applications/deployments/rolling-updates), starting the new container before it stops the old one, and awaywork's locks check their holder by pid and start time, which mean nothing across containers. So for a moment two daemons would share one state dir. Coolify doesn't roll compose apps: `docker compose up` replaces the container.

### On a VPS

Any box with Docker and the compose plugin. `.env` takes every env var install listed, here for a config with Claude alone:

```sh
git clone git@github.com:you/my-awaywork-repo.git && cd my-awaywork-repo
printf 'GH_TOKEN=%s\nCLAUDE_CODE_OAUTH_TOKEN=%s\nTZ=Europe/Rome\n' "$GH_TOKEN" "$CLAUDE_CODE_OAUTH_TOKEN" > .env && chmod 600 .env
docker compose up -d --build
```

Keep `.env` out of git. Without a `GH_TOKEN` compose refuses to start it:

```
$ docker compose up -d
error while interpolating services.awaywork.environment.GH_TOKEN: required variable GH_TOKEN is missing a value
```

After a `git pull`, `docker compose up -d --build` again.

### From your laptop

No ssh into the box, and none needed: give the daemon a token and your laptop's `awaywork report`, `plan`, `skip`, `approve` and `run --unit` run in the container, and so does [`/away`](./agents.md#claude-code), pane and skill, since they only call those. It's the CLI over HTTP, not an API: the daemon runs the same command, with its own config, and streams back what it prints as it prints it.

1. Make a token, `openssl rand -hex 32`, and set it as `AWAYWORK_REMOTE_TOKEN` in Coolify (or `.env` on a VPS), then redeploy. `compose.yml` already lists it. Without it the daemon opens no port; under 32 characters, it logs `remote: AWAYWORK_REMOTE_TOKEN is shorter than 32 characters, so no port is open` and keeps running without one.
2. Give the service a domain. In Coolify, the awaywork service's **Domains** field takes it with the container's port, `https://away.example.com:7480`: Coolify's proxy gets the Let's Encrypt certificate and forwards to port 7480, which `compose.yml` exposes to the proxy and never publishes on the host. On a VPS, publish it on localhost in a `compose.override.yml` beside `compose.yml` (compose merges it, and `schedule install` never touches it), and put Caddy in front:

   ```yaml
   services:
     awaywork:
       ports:
         - "127.0.0.1:7480:7480"
   ```

   ```
   away.example.com {
   	reverse_proxy 127.0.0.1:7480
   }
   ```

   In the image the daemon listens on every interface, since Coolify's proxy comes from another container. Anywhere else, `watch` under launchd, systemd or cron with the token in its env file, it listens on `127.0.0.1:7480` only and logs `remote: serving the CLI on port 7480, 127.0.0.1 only`, so the same Caddy on that machine is the way in.

3. On your laptop, add both to `~/.config/awaywork/env`:

   ```sh
   AWAYWORK_REMOTE=https://away.example.com
   AWAYWORK_REMOTE_TOKEN=<the same token>
   ```

That's it. Here against the image on Colima, Caddy standing in for Coolify's proxy, a stand-in agent and a `chores` command source; nothing of the run is on the laptop:

```
$ awaywork plan
Providers
  present run (outside the windows): present_session_max
  provider  window  used  ceiling  set by  resets in  session / stop at
  fake      week    10%   77.1%    pacing  1 run      10% / 40%
    other limits: reserve cap 90%

Units 1
     item  rule  skill            provider  deliver  title
  1  CH-1  #1    plan (built-in)  fake      report   Write a hello report
$ awaywork run --unit CH-1
Queued CH-1 as run 20261104-220657; awaywork report 20261104-220657 shows it once it ends
$ awaywork skip chores:CH-1 --until 2030-01-01
skipped with awaywork skip chores:CH-1 until 2030-01-01
$ awaywork unskip chores:CH-1
chores:CH-1 is no longer skipped
$ awaywork schedule status
No scheduled job installed
Daemon: running, pid 7, since 2026-11-04 23:06:35
Run in progress: unit run 20261104-220657
Next window: none, no windows set
Daemon log: /home/away/.local/state/awaywork/watch.log
$ awaywork report 20261104-220657 --unit CH-1
1  CH-1  Write a hello report
  skill   plan
  status  done
  result  report
  item    https://example.com/ch-1
  files   /home/away/.local/state/awaywork/runs/20261104-220657/units/ch-1/1-plan/worker.log
          /home/away/.local/state/awaywork/runs/20261104-220657/units/ch-1/1-plan/out/report.md
          /home/away/.local/state/awaywork/runs/20261104-220657/units/ch-1/out/report.md

Hello from the stand-in agent, as awaywork
```

The paths are the container's. Each request is a line in the container's log, with the command and how it went, never the token:

```
2026-11-04 23:06:56 remote: ["plan"]: exit 0
2026-11-04 23:06:57 unit run 20261104-220657 started for CH-1
2026-11-04 23:06:57 remote: ["run","--unit","CH-1"]: exit 0
2026-11-04 23:06:57 remote: ["skip","chores:CH-1","--until","2030-01-01"]: exit 0
```

What goes to the container: `report`, `plan`, `stats`, `sources`, `doctor`, `schedule status`, `config path`, `skip`, `unskip`, `approve` and `run --unit`, each with the flags it has here and nothing else. The rest runs on your laptop as before: `init`, `config schema` and `config edit`, `skills`, a full `run`, `schedule install`, and `--help`. One of those eleven with a flag the daemon doesn't take still goes there, and fails, so nothing you meant for the container lands on the laptop:

```
$ awaywork skip chores:CH-2 --reason "-- see thread"
AWAYWORK_REMOTE (http://127.0.0.1:7480): refused --reason -- see thread: write it --reason=-- see thread
$ awaywork run --unit CH-1 --dry-run
AWAYWORK_REMOTE (http://127.0.0.1:7480): refused --dry-run
```

Naming a config with `-c`/`--config` means this machine, so `awaywork plan --config other.yml` runs here. To run any other call here anyway, blank the variable for it: `AWAYWORK_REMOTE= awaywork report`.

`run --unit` starts no process on the box: the daemon takes it as a one-off run of that item, as the workflow's [`unit` input](#run-one-item-now) does. It reads the item from its source again, so it still has to match a rule; it runs even after a failed attempt; it's present outside a window and away until the window's end inside one; and it waits for the worker in progress, as a [soon run](#soon-runs) does. One that can't run says why and exits 1:

```
$ awaywork run --unit CH-9
no unit "CH-9" in the plan; awaywork plan --why CH-9 says why
$ awaywork run --unit CH-1
CH-1 is running in run 20261104-220137
```

The daemon runs two commands at a time and turns a third away. Each gets 2 minutes. While one prints nothing, as `plan` does while it reads your sources, the daemon still sends a `{}` line every 30 s so the proxy keeps the request open, and Ctrl-C on the laptop stops the command on the box. A `run --unit` still queues: it's the daemon's own by then. A box that's down, or a token that doesn't match, fails in one line too:

```
$ awaywork doctor
AWAYWORK_REMOTE (http://127.0.0.1:7480): 2 commands are running, try again
$ awaywork report
can't reach AWAYWORK_REMOTE (http://127.0.0.1:8480): read ECONNRESET
$ awaywork report
AWAYWORK_REMOTE (http://127.0.0.1:7480) refused AWAYWORK_REMOTE_TOKEN
```

To go back to your laptop's own runs, take the two lines out of the env file. A daemon of your own on the laptop opens no port while `AWAYWORK_REMOTE` is set: that machine forwards. What a leaked token gets, and how to rotate it, is in [Safety](./safety.md#the-remote-token).

### Living with it

- **Secrets are env vars.** There's no `~/.config/awaywork/env` in the image: awaywork reads the container's env. Coolify passes only the variables `compose.yml` names, so install lists every secret your config needs there, `ASANA_TOKEN`, a repo's `secrets` or `notify.secrets` included, as `NAME: ${NAME:-}`. Added one to the config? Run install again.
- **Codex** goes into the image when your config uses it: install adds `@openai/codex` to the Dockerfile's `PACKAGES`. Log in once into the volume, as install says: `docker exec -it <container> codex login --device-auth` (`docker ps` names the container). The login stays on the `codex` volume across redeploys, where Codex rotates it in place.
- **Your repos' toolchains** go in the Dockerfile as `RUN` lines, at the spot it marks: setup runs as the worker user, which can't enter `/home/away`, so install system-wide (`RUN npm install -g pnpm@10`, `RUN apt-get update && apt-get install -y …`), and a [CLI of your own](./configuration.md#bring-your-own-cli) the same way. Install shows them in its diff on the next run, as above.
- **Cursor** has no npm package, so `PACKAGES` can't add it: with Cursor in your config, install puts the installer from [Running Cursor](#running-cursor) at the toolchains spot as one `RUN`, without the `sudo`s or `-o "$USER"`, as the build runs as root:

  ```dockerfile
  RUN install -d /opt/cursor \
    && curl -fsS https://cursor.com/install | HOME=/opt/cursor bash \
    && ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent \
    && agent --version
  ```

  Built that way on arm64, the worker user ran `agent --version` (`2026.10.22-27dcf5f`) and couldn't write to `/opt/cursor`. Then set `CURSOR_API_KEY`, which `compose.yml` lists.

- **A [custom source](./custom-sources.md)'s `setup`** runs at build, as a `RUN` right after the config is copied in: in the config's folder, as root and without the secrets. What it builds there, awaywork can read and the worker user can't; it runs after the image's sweep for world-writable paths, so keep its output in that folder.
- **Upgrading** is a rebuild: upgrade awaywork, run `schedule install --with docker` again, commit and push. Claude Code's auto-updater is off, so it moves when you rebuild too.
- **A push stops a running unit.** The redeploy sends the daemon a SIGTERM: the unit stops, publishes nothing and doesn't count as an attempt, so the new container runs it again. Here `docker compose stop` hit a stand-in agent mid-unit, after the run's first unit had opened its draft PR, and `docker compose up -d` started the next container:

  ```
  2026-11-03 23:14:19   andreaprovenzale-awaywork-sandbox-197: implement on fake
  2026-11-03 23:14:20   andreaprovenzale-awaywork-sandbox-197: done
  2026-11-03 23:14:25   andreaprovenzale-awaywork-sandbox-196: implement on fake
  2026-11-03 23:14:39   andreaprovenzale-awaywork-sandbox-196: stopped: aborted
  2026-11-03 23:14:39 Run 20261103-231413: 1 draft PR, 0 reports, 2 units
       item                  skill      status                      result
    1  awaywork-sandbox#197  implement  done                        https://github.com/AndreaProvenzale/awaywork-sandbox/pull/198
       Ran as awaywork in the container image.
    2  awaywork-sandbox#196  implement  stopped: aborted (aborted)  interrupted
       Ran as awaywork in the container image.
  Report: /home/away/.local/state/awaywork/runs/20261103-231413/report.md
  2026-11-03 23:14:39 awaywork watch stopped
  2026-11-03 23:14:53 awaywork watch started, pid 7, config /home/away/.awaywork/config.yml
  2026-11-03 23:14:53 window run 20261103-231453 started, until 2026-11-04 04:00:00
  2026-11-03 23:14:58 Run 20261103-231453: 1 unit planned, state in /home/away/.local/state/awaywork/runs/20261103-231453
  2026-11-03 23:14:58   andreaprovenzale-awaywork-sandbox-196: implement on fake
  ```

  The stop took a second; `stop_grace_period: 2m` gives a slower one the 2 minutes `schedule install` gives the daemon on your machine, where Docker's default would kill it after 10 s.

- **Memory.** `compose.yml` caps the container at 4 GB, and the watchdog starts no unit under 1.5 GB free, counted against that cap: `process.availableMemory()` was 2.99 GB in a container with `-m 3g`, 7.19 GB without. A big repo's build next to the agent may want more: raise `mem_limit`.
- **Reaching it** is `docker exec`, or ssh to the host first; Coolify has a terminal for it too. The daemon's log, `watch.log` in the state dir, is also the container's output, so `docker logs -f <container>` follows it, as does Coolify's Logs tab:

  ```
  $ docker logs -f <container>
  2026-11-03 23:43:59 awaywork watch started, pid 7, config /home/away/.awaywork/config.yml
  2026-11-03 23:43:59 window run 20261103-234359 started, until 2026-11-04 05:00:00
  2026-11-03 23:44:04 Run 20261103-234359: 1 unit planned, state in /home/away/.local/state/awaywork/runs/20261103-234359
  2026-11-03 23:44:05   andreaprovenzale-awaywork-sandbox-199: implement on fake
  ```

  And `docker exec` runs awaywork's own commands in it:

  ```
  $ docker exec <container> awaywork schedule status
  No scheduled job installed
  Daemon: running, pid 7, since 2026-11-03 23:12:02
  Run in progress: window run 20261103-231202, until 2026-11-04 04:00:00
  Next window: 2026-11-04 22:00:00
  Daemon log: /home/away/.local/state/awaywork/watch.log
  $ docker exec <container> awaywork doctor
  ok    git: git version 2.39.5
  ok    gh: gh version 2.103.3 (2026-10-26)
  ok    gh login
  ok    /home/away/.awaywork/config.yml
  ok    isolation: user: setup, the agent and the checks run as awaywork
  warn  fake: unattended: grey
  warn  fake quota: fallback: 2 units (no quota reading), sits out runs outside the windows
  ok    github: 3 open items
  ```

  "No scheduled job" is right: the container is what keeps `watch` running. `docker exec <container> awaywork report` prints the morning report.
