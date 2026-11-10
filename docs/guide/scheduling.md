---
description: Run awaywork in its windows on your machine with launchd, systemd or cron, in GitHub Actions on GitHub's runners or your own, or in a container on Coolify or any Docker host.
---

# Scheduling

A scheduled run is one [window](./configuration.md#windows-limits-and-budget) opening: it starts when the window opens and starts no unit after it ends. A unit still running at the end stops with `stopped: window ended`, and what it left is published as for a quota stop.

## Pick where it runs

|  | [This machine](#on-your-machine) | [GitHub Actions](#in-github-actions) | [A container](#in-a-container) |
| --- | --- | --- | --- |
| What starts runs | `awaywork watch` under launchd, systemd or cron | A cron in your control repo's workflow runs `awaywork run --scheduled` | `awaywork watch` in Docker Compose, on Coolify or a VPS |
| [`run: soon`](#soon-runs) rules | Within minutes | In the windows: no daemon | Within minutes |
| Attempts, skips, a `push` head | Kept | Kept on a self-hosted runner; a GitHub-hosted one starts empty | Kept on a volume |
| Codex | Yes | Self-hosted runners only | Yes, its login on a volume |
| Run length | The window | About 6 hours on a GitHub-hosted runner | The window |
| Bitbucket, `extends` | Yes | No | No |
| Needs | The machine awake | A private control repo and its secrets | A Docker host and its env vars |

A daemon on a box of yours, the container or a machine you ssh into, also takes your laptop's commands, `/away` included: [From your laptop](#from-your-laptop).

In a terminal, `awaywork schedule install` asks where:

```
◆  Where should it run on a schedule?
│  ● this machine
│  ○ GitHub Actions, from the repo in this directory
│  ○ a container (Docker Compose, e.g. Coolify), from the repo in this directory
└
```

`--with` answers up front; without a terminal it takes this machine. Pick one per machine: with a local schedule and a runner on the same machine, both start at the window and work the same items on the same state dir. Moving to the runner, run `schedule remove` outside the control repo first; inside it, that deletes the workflow too.

## On your machine

```sh
awaywork schedule install                 # macOS: launchd
awaywork schedule install --with systemd  # Linux: a user service
awaywork schedule install --with cron
awaywork schedule status                  # the job, the daemon and its log
awaywork schedule remove
```

The job is `awaywork watch`, kept alive by the scheduler. It checks the clock every minute and starts a run when a window opens, even after the machine slept through the opening, and rereads the config each time, so window edits need no reinstall. It also runs [`run: soon`](#soon-runs) rules within minutes.

| Scheduler | Writes | Keeps it alive |
| --- | --- | --- |
| launchd | `~/Library/LaunchAgents/awaywork.plist` | Started at login, restarted after a crash (`KeepAlive`, `SuccessfulExit: false`) |
| systemd | `~/.config/systemd/user/awaywork.service` | Enabled at login, `Restart=on-failure` |
| cron | two tagged lines in your crontab | Started at boot (`@reboot`) and again every 5 minutes |

```
$ awaywork schedule status
Scheduled with launchd, keeping awaywork watch running
Config: ~/.config/awaywork/config.yml
Log: ~/.local/state/awaywork/schedule.log
Daemon: running, pid 67014, since 2026-10-25 17:26:00
Run in progress: soon run 20261025-162625
Next poll of flaky: 2026-10-25 17:30:00, backing off after 1 failed poll
Next window: none, no windows set
Daemon log: ~/.local/state/awaywork/watch.log
```

The daemon's log, `watch.log`, has events only: start and stop, runs and units starting and ending, and errors; past 5 MB it moves to `watch.log.1`. A run's full output goes to `run.log` in its run dir, and into `watch.log` too with `watch: { debug: true }`. `schedule.log` catches only a crashed daemon. The morning report is `awaywork report`. Both list what failed before any unit started:

```
warning: source chores: Command failed with exit code 1: ./chores.sh
  Error: CHORES_TOKEN is not set
```

Details:

- **One opening, one run.** A run that finishes early isn't restarted in the window; one started inside a window, after a reboot say, picks up there, skipping items already worked on.
- **One daemon at a time:** another copy exits with `awaywork watch is already running (pid 67014)`, which makes cron's restart line harmless.
- **Your run or the daemon's.** A manual `awaywork run` during a daemon run exits 1 (`awaywork watch holds the run lock (pid 67014); try again once its runs end, awaywork schedule status lists them`). A window opening during your manual run waits for it, checking every minute and logging it once; a soon run waits for the next poll. A dead process's lock is taken over; `--dry-run` takes none.
- **`PATH`:** the job keeps the installing shell's, so it finds the same `claude`, `codex`, `agent` and `gh`, but runs the binaries, not shell functions: [pin logins](./configuration.md#which-login) in the config instead.
- **Secrets** come from `~/.config/awaywork/env`. The daemon reads it and its own code once, at start: after editing it or upgrading, run `schedule install` again, which restarts it.
- **Restarting:** `install` and `remove` stop the running daemon first, whoever started it: a SIGTERM, then up to 2 minutes. A running unit stops, publishes nothing and isn't counted as an attempt. If it's still running after that, install changes nothing and says so. Run from inside the daemon (a hook, a worker), they refuse.
- launchd and systemd restart it only after a crash; a SIGTERM of yours keeps it down until your next login or `install`. Under cron it's back within 5 minutes.
- systemd user services run only while you're logged in (`loginctl enable-linger` lifts that). Without a user session (`sudo -iu`, `su -`) `--with systemd` fails and changes nothing, and `status` and `doctor` report no schedule; log in directly or use cron.
- `windows: []` is fine: the daemon idles and install sets no wake.
- A failed command gets two lines in the log: its error and the last error line of its stderr. Configured secrets show as `***`, so the report is safe for `notify`. Run ids are the start time in UTC.
- A job from an older awaywork (one trigger per window running `awaywork run --scheduled`) still works, but `status` and `doctor` flag it: run `schedule install` once.

### Soon runs

Every `watch.every` (5 minutes), the daemon polls the sources its [`run: soon`](./configuration.md#run-soon) rules read, plans just those rules and starts a run for the units due: new items, or ones changed since their last attempt, like a PR gone red or your reply to awaywork's [questions](./workflows.md#questions). Here a source's item came in, awaywork's questions on it didn't count, the reply did, and a second source was down for a while:

```
2026-10-25 16:17:51 awaywork watch started, pid 27290, config ~/.config/awaywork/config.yml
2026-10-25 16:17:51 source flaky: poll failed, next at 2026-10-25 16:21:51: Command failed with exit code 1: ./flaky.sh
2026-10-25 16:17:51 soon run 20261025-151751 started for ch-1
[...]
2026-10-25 16:21:00 soon run 20261025-152100 started for ch-1
[...]
2026-10-25 16:22:00 source flaky: polled fine again, every 2m
```

Details:

- awaywork's own questions comment isn't a change, nor is anything a run already took: a failed unit waits for the item to change, or the next window. One its run never attempted (no quota, sat out a present run, stopped) is due again an hour later, or at the first poll after a restart.
- A clock-driven job, Mondays at 09:00, is a [routine](./configuration.md#routines), which a soon rule starts at the first poll after.
- Each poll that finds units makes one run, with its own run dir, report and `per_run` share. One that finds nothing writes nothing (one line with `debug`).
- Outside a window a soon run is present: workers stop at `present_session_max` and providers without a quota reading sit out. Inside one it's away and ends with the window.
- A poll reads no quota and runs no model. A GitHub poll is 3 searches (your PRs, review requests, assigned issues), one per `search` entry and two more for [finished items](./configuration.md#finished-items): about 36 an hour at 5 minutes. A tracker poll is its list call plus a PR search per open task without a link. Give a slow or rate-limited tracker its own `every`.
- A failed poll backs off as long as `Retry-After` says (Jira and Asana, on a 429), else doubling per failure up to an hour, logging each backoff and recovery. GitHub, Linear and custom sources give no reset time, so they double.
- `notify` gets a soon run's `unit` events, not the run's end. A unit that sat out or was passed over by `when` fires none, so hourly retries stay quiet; a failed `setup` or a timed-out `when` still fires.
- Runs overlap, never on one item, and one worker runs at a time: a soon unit waits for the window run's current chain, not the whole run, routing on the quota it read when planning. A unit another run holds is skipped as `running in run 20261025-010000`. The daemon holds the run lock, and keeps the machine awake, while any run is in progress.
- An `isolation` edit applies to the next run that starts with none in progress, logged once while it waits. Restart `watch` or rerun `schedule install` to apply it now.

### Waking up for it

A sleeping machine runs nothing. While a run is in progress the daemon keeps the machine from idling to sleep (`caffeinate -i` on macOS, `systemd-inhibit --what=idle` on Linux where it works); the wake itself is a separate step `schedule install` offers in a terminal:

```
◆  Wake this Mac when the window opens (sudo pmset repeat wake MTWRFSU 01:00:00)?
│  ● Yes / ○ No
└
```

- macOS: `pmset` keeps one repeating wake, so every window must start at the same time, and it replaces your other repeating power events, scheduled sleeps and shutdowns too: the question lists them and defaults to No unless all it replaces is a wake. Keep a laptop on the charger; lid closed on battery, it may not wake fully.
- Linux: a root timer, `/etc/systemd/system/awaywork-wake.timer` with `WakeSystem=true`. A background job can block idle but not sleep, so turn off a desktop's own suspend timer on AC power.
- sudo needs a password, so without a terminal install only says how. `schedule remove` leaves the wake and prints how to remove it.
- Moving the windows' start needs `schedule install` again to move the wake; `config edit` and `doctor` warn until then.

## In GitHub Actions

Run it from a private repo of your own, on GitHub's runners or a machine of yours. On a team, each person keeps their own control repo, so nobody's token sits where a teammate can write; they can all point at the same repos, since each run sees its own token's `@me`. It's GitHub only and one file: install refuses a [Bitbucket](./configuration.md#bitbucket-and-jira) config or one that [extends a base](./configuration.md#a-base-config).

```
$ cd my-awaywork-repo
$ awaywork schedule install
[...]
◇  Which runner?
│  self-hosted
Wrote .github/workflows/awaywork.yml
Copied ~/.config/awaywork/config.yml to .awaywork/config.yml
Before the first run:
  commit .github/workflows/awaywork.yml and .awaywork/config.yml
  add these repository secrets: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
  GH_TOKEN is a classic personal access token of yours with the `repo`, `workflow` and `read:org` scopes (…)
```

It writes a workflow with a cron at each window's start (none with `windows: []`) plus `workflow_dispatch`, copies your config to `.awaywork/config.yml` and your [skills](./skills.md#where-skills-come-from) to `.awaywork/skills/`, and offers to set each needed secret it finds in your environment or env file with `gh secret set`, never printing values.

Then commit, add the secrets it lists as unset (`GH_TOKEN`, provider tokens, and any `secrets` of sources, repos, MCP servers and `notify`), and run it once from the Actions tab. `schedule remove` deletes the workflow.

`GH_TOKEN` is your classic personal access token: `repo` reads your PRs, issues, checks and logs and pushes branches and drafts; `workflow` lets it push branches that touch workflow files; `read:org` shows teammates with private org membership, whose text would otherwise be [hidden](./safety.md#public-repos).

Details:

- The runner is GitHub-hosted by default: a fresh VM, no Codex. Self-hosted: see [Running Codex](#running-codex). Without a terminal, `--with github-actions` keeps the workflow's runner (hosted for a new one) and offers no secrets.
- No daemon there, so [`run: soon`](#soon-runs) rules run in the windows; install says so once.
- `doctor` inside the repo fails naming secrets missing from the repo and its org, and fails a workflow that doesn't parse; when gh can't list secrets, it warns why. The action fails first thing on an empty `GH_TOKEN`, the sign secrets didn't reach the job.
- The cron is UTC: install converts each start from your timezone at standard time, and the job's `TZ` keeps ends, `days` and [routines](./configuration.md#routines) local. Runs never start early, but in summer time up to an hour late (a Rome `18:00` window fires at `17:00` UTC, 19:00 there March to October), so keep Actions windows over an hour. Changed timezone? Run install again.

### The action

The workflow calls awaywork's action at the release you generated it with, `AndreaProvenzale/awaywork@v0.3.1` say, which installs that version (`version` input). On a GitHub-hosted runner it frees about 20 GB of preinstalled SDKs (runners otherwise die quietly on large repos) and makes the [worker user](./safety.md#a-worker-user-on-github-hosted-runners).

It commits as the token's user through env, not git config, appends the morning report to the job summary and uploads the run as an [artifact](#reports-from-the-runner). A [custom source](./custom-sources.md)'s `setup` runs as its own step first, in the config's folder, without secrets.

- `GITHUB_TOKEN` is read-only (`permissions: contents: read`), checkout keeps no credential (`persist-credentials: false`), and only the action's step gets secrets.
- Every step inside the action sees them, hence the pin: new action code meets your secrets only when you rerun install. Pin `uses:` to the release's SHA for tighter.
- To upgrade, upgrade awaywork and rerun `schedule install --with github-actions`; by hand, change `uses:` and `version` together. A workflow from before the action runs its steps inline; `doctor` warns.
- Rerun install after config or skill changes. A matching file is up to date; one that differs shows the diff and is replaced only on your yes. Without a terminal it keeps the repo's copy, prints the diff and exits 1. The skills folder is replaced whole, dropping repo-only skills; with no skills of yours, the repo's stay.

### On the runner

- **No state on a hosted runner:** no attempts, skips or earlier reports, so unchanged items run again, none is given up on, your local `awaywork skip` doesn't reach it, and a chain starts without the last report. Waiting [questions](./workflows.md#questions) and [posts](./workflows.md#posts-that-wait) still wait, read off the item, and `awaywork approve` replies there.
- **No push hold:** without the head a [`deliver: push`](./chains.md#push) left, the rule pushes again every run its `where` holds.
- **A self-hosted runner** keeps its user's `~/.local/state/awaywork`, as on your machine.
- **MCP servers and toolchains:** a stdio [MCP server](./configuration.md#mcp-servers)'s `command` must exist on the runner (`npx` and `node` do). On a hosted runner it runs as the worker, who can't enter the runner's home, so a script in your checkout won't start; install packages, pnpm included, with the action's `packages`, not a setup action that installs into the home (`pnpm/action-setup` does). HTTP servers must be reachable from GitHub.
- **6 hours:** hosted jobs end at 6 hours, so a run stops 5h40 after it starts or at the window's end, leaving 20 minutes to publish; the workflow sets `timeout-minutes: 360`, and `plan` warns about longer windows (`GitHub-hosted runners end a job at 6 hours, so a run stops 5h40 after it starts, before 18:00-07:00 ends`). It stops like any window end, Actions-tab runs included. Self-hosted runs last the window, with `timeout-minutes: 1440`, added on your next install.

### Run one item now

The workflow takes a `unit` input, an item key:

```
$ gh workflow run awaywork -f unit=API-12
```

It runs only `API-12`, outside any window, retrying even after a failed attempt. The item is fetched again and must still match a rule, so "only your items", the ceiling and the prompt hold.

- `concurrency: awaywork` cancels nothing: a dispatch waits for the nightly run, and GitHub keeps only the newest pending run.
- It spends daytime quota; as a run outside the windows, workers stop at `present_session_max` (40% of the 5-hour window by default).
- "Run it when Sentry escalates" needs a relay: as far as we know Sentry's webhooks can't send what GitHub's dispatch API wants. awaywork ships none and holds no credentials for one; a small function calling `gh workflow run` does it.

### Reports from the runner

Each run uploads `report.md`, `report.json` and `units.json` as an artifact like `awaywork-20261014-223527`. Inside the control repo, `awaywork report` and `report --list` fetch those through `gh` and mix them with your local runs:

```
$ awaywork report --list
20261015-160012  9 units, 3 draft PRs, 2 reports  (github: awaywork)
20261012-203418  0 units, 0 draft PRs, 0 reports
```

They find runs by the workflow's file name, so keep its `name:` as written. A run downloads once, into `~/.local/state/awaywork/remote/<owner>/<repo>/<artifact>/`, never `runs/`, so `stats`, `replay` and attempts stay local. Artifacts expire with the repo's retention (90 days by default). Offline you get a `warning:` and your local runs; outside the control repo, local runs only.

### Credentials on a runner

| Provider | Secret | Notes |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; lasts a year |
| Codex | none | Self-hosted runners only, on the machine's own login |
| Cursor | `CURSOR_API_KEY` | A key from Cursor's dashboard |
| [Your own CLI](./configuration.md#bring-your-own-cli) | its `secrets` | Self-hosted runners only |

### Running Codex

Codex (experimental) uses the machine's `codex login`, which it rotates in place, so a fresh runner has none to keep. With a hosted runner, install leaves it out and runs route to your other providers:

```
codex won't run in this workflow: a GitHub-hosted runner has no Codex login, and one copied there goes stale since Codex rotates it in place; run Codex locally or on a self-hosted runner
```

Run it locally ([On your machine](#on-your-machine)), or on a machine of yours [added as the control repo's runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners), logged in with `codex login` as the runner's user (`codex login --device-auth` on a headless box, [Codex's docs](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)). Pick self-hosted at _Which runner?_: the workflow says `runs-on: self-hosted` and keeps Codex. Details:

- Every self-hosted runner the repo can use matches that label, an organization's too, so give yours a [label of its own](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels): `runs-on: [self-hosted, alice-mac]`. Install nags while it's plain `self-hosted` and keeps labels on a rerun.
- There the action keeps its hands off: no disk freeing, no CLIs installed over yours, no git config. It installs awaywork alone into the job's temp dir and runs the `codex`, `claude` and `agent` on the runner's `PATH`; Claude still reads `CLAUDE_CODE_OAUTH_TOKEN`.
- A runner [installed as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application) doesn't read your shell profile: its `PATH` is the `.path` file `./config.sh` saved, exported by [`runsvc.sh`](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/runsvc.sh), other variables in `.env`. nvm or Homebrew binaries may be missing: configure it where `codex --version` works, or edit `.path` and restart (`./svc.sh stop`, `./svc.sh start`).
- GitHub recommends self-hosted runners only for private repos, since a fork's PR could run code on them: keep the control repo private.

### Running Cursor

Cursor's CLI has no npm package, so on a hosted runner the action installs it with Cursor's installer, as the runner's user, into `/opt/cursor` (readable, not writable, by the worker), linked as `/usr/local/bin/agent`. Install puts it in the workflow's `scripts` input and names `CURSOR_API_KEY` among the secrets:

```yaml
packages: "@anthropic-ai/claude-code"
scripts: |
  sudo install -d -o "$USER" /opt/cursor
  curl -fsS https://cursor.com/install | HOME=/opt/cursor bash
  sudo ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent
  agent --version
```

Self-hosted runs the `agent` on the runner's `PATH`. Either way it needs the `CURSOR_API_KEY` secret: a machine login doesn't reach its fresh `HOME`.

## In a container

No machine to leave on? Run `awaywork watch` in a container, on [Coolify](https://coolify.io) or any VPS with `docker compose`. Setup, the agent and the checks run as a [worker user](./safety.md#a-worker-user-in-awaywork-s-image) inside. Unlike Actions, state lives on a volume (attempts, skips, a [`push`](./chains.md#push) head), soon rules run all day, there's no 6-hour cap, and Codex works, its login on a volume. From a private control repo:

```
$ cd my-awaywork-repo
$ awaywork schedule install
[...]
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

| File | What it does |
| --- | --- |
| `Dockerfile` | Debian with Node 22, git, gh, sudo and tini; awaywork and your providers' CLIs, pinned to the awaywork that wrote it; `away`, the user awaywork runs as, and `awaywork`, the worker user, with the sudoers lines [`isolation: user`](./configuration.md#isolation) needs |
| `compose.yml` | `restart: unless-stopped`, `stop_grace_period: 2m`, `mem_limit: 4g`, volumes for the state dir and Codex's login, each secret your config needs as an env var, `TZ` defaulting to your timezone; `AWAYWORK_REMOTE_TOKEN` and port 7480, exposed to the proxy, for [your laptop](#from-your-laptop) |
| `entrypoint.sh` | Fails on an empty `GH_TOKEN`, commits as the token's user (env vars, as the action does), then `exec awaywork watch`, its log on the container's output |

Commit and push: that's a deploy. Details:

- `--with docker` asks nothing; the files come from awaywork's `docker/`, fit to your config. Values are never printed: you set them where it runs.
- The config is copied into `/home/away/.awaywork/config.yml` at build, so a push is how a change gets there. Only `.awaywork/` goes in, so files the config names by path live there too.
- GitHub only for now (no twg, no SSH key for Bitbucket pushes), and no `extends` (the base wouldn't come along): install refuses both.
- Rerun install after config, skill or awaywork changes. As for Actions, a differing file shows its diff and is replaced only on your yes; without a terminal it keeps yours and exits 1:

  ```
  $ awaywork schedule install --with docker
  [...]
   # Your repos' toolchains go here, as RUN lines: setup runs as the worker user.
  -RUN npm install -g pnpm@10
  [...]
  Kept Dockerfile; run this again in a terminal to replace it
  compose.yml is up to date
  ```

- `schedule remove` in the repo deletes the three files if the Dockerfile is awaywork's, leaving `.awaywork/`. `doctor` warns while the Dockerfile builds another awaywork than yours.

### On Coolify

Add a resource from the control repo with the **Docker Compose** build pack, compose location `/compose.yml`. Coolify lists the variables it names: `GH_TOKEN` is required (the [classic token](#in-github-actions)), `CLAUDE_CODE_OAUTH_TOKEN` is Claude's (`claude setup-token`), `CURSOR_API_KEY` Cursor's, the rest your config's. `TZ` defaults to install's timezone. Deploy; every push redeploys.

Not the Dockerfile build pack: its [rolling updates](https://coolify.io/docs/applications/deployments/rolling-updates) start the new container before stopping the old, and awaywork's locks, checked by pid and start time, mean nothing across containers, so two daemons would share a state dir for a moment. Compose apps are replaced, not rolled.

### On a VPS

Any box with Docker and the compose plugin; `.env` takes the variables install listed:

```sh
git clone git@github.com:you/my-awaywork-repo.git && cd my-awaywork-repo
printf 'GH_TOKEN=%s\nCLAUDE_CODE_OAUTH_TOKEN=%s\nTZ=Europe/Rome\n' "$GH_TOKEN" "$CLAUDE_CODE_OAUTH_TOKEN" > .env && chmod 600 .env
docker compose up -d --build
```

Keep `.env` out of git. Without `GH_TOKEN`, compose refuses: `required variable GH_TOKEN is missing a value`. After a `git pull`, `docker compose up -d --build` again.

### Living with it

- **Secrets are env vars**, no env file: Coolify passes only what `compose.yml` names, so install lists every secret your config needs as `NAME: ${NAME:-}`. Added one? Run install again.
- **Codex:** install adds `@openai/codex` to the Dockerfile's `PACKAGES`. Log in once into the volume, `docker exec -it <container> codex login --device-auth`; it survives redeploys.
- **Toolchains** go in the Dockerfile as `RUN` lines at the marked spot, system-wide, since the worker can't enter `/home/away` (`RUN npm install -g pnpm@10`), [your own CLI](./configuration.md#bring-your-own-cli) too.
- **Cursor:** no npm package, so install puts [the installer](#running-cursor) at that spot as one `RUN`, without `sudo` (the build is root):

  ```dockerfile
  RUN install -d /opt/cursor \
    && curl -fsS https://cursor.com/install | HOME=/opt/cursor bash \
    && ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent \
    && agent --version
  ```

  On arm64 the worker ran `agent --version` (`2026.10.22-27dcf5f`) and couldn't write `/opt/cursor`. Set `CURSOR_API_KEY`.

- **A [custom source](./custom-sources.md)'s `setup`** runs at build, right after the config is copied, in its folder, as root, without secrets, after the sweep for world-writable paths: keep its output there, readable by awaywork, not the worker.
- **Upgrading** is a rebuild: upgrade, rerun install, push. Claude Code's auto-updater is off, so it moves with rebuilds.
- **A push stops a running unit:** the redeploy's SIGTERM stops it, unpublished and uncounted, and the new container runs it again. `stop_grace_period: 2m` matches the 2 minutes install gives the daemon on your machine, where Docker's default kills after 10 s. Here a stop hit a unit mid-run:

  ```
  2026-11-03 23:14:39   acme-api-196: stopped: aborted
  2026-11-03 23:14:39 awaywork watch stopped
  2026-11-03 23:14:53 awaywork watch started, pid 7, config /home/away/.awaywork/config.yml
  2026-11-03 23:14:58   acme-api-196: implement on fake
  ```

- **Memory:** capped at 4 GB, and the watchdog's 1.5 GB floor counts against the cap (`process.availableMemory()` was 2.99 GB under `-m 3g`, 7.19 GB without). Raise `mem_limit` for big builds.
- **Reaching it:** `docker exec`, ssh to the host, or Coolify's terminal. `watch.log` is the container's output (`docker logs -f <container>`, Coolify's Logs tab), and `docker exec <container> awaywork doctor`, `report` or `schedule status` work as usual; `status` says `No scheduled job installed`, which is right, since the container keeps `watch` running.

## From your laptop

Give the container's daemon a token and your laptop's `awaywork report`, `plan`, `skip`, `approve` and `run --unit` run there, [`/away`](./away.md) included. It's the CLI over HTTP, not an API: the daemon runs the same command with its own config and streams back its output. A box of your own without a container is simpler: [over ssh](#over-ssh).

1. Make a token (`openssl rand -hex 32`), set it as `AWAYWORK_REMOTE_TOKEN` in Coolify or `.env`, redeploy. Without it the daemon opens no port; under 32 characters it logs `remote: AWAYWORK_REMOTE_TOKEN is shorter than 32 characters, so no port is open`.
2. Give it a domain. In Coolify's **Domains** field, `https://away.example.com:7480`: the proxy gets the certificate and forwards to 7480, exposed to it, never published. On a VPS, publish it on localhost in a `compose.override.yml` (compose merges it; install never touches it) behind Caddy:

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

   In the image the daemon listens on every interface for Coolify's proxy; elsewhere, `watch` with the token in its env file listens on `127.0.0.1:7480` only (`remote: serving the CLI on port 7480, 127.0.0.1 only`).

3. On the laptop, in `~/.config/awaywork/env` (`AWAYWORK_REMOTE` takes `https://` or `http://` with the token, or [`ssh://`](#over-ssh) without):

   ```sh
   AWAYWORK_REMOTE=https://away.example.com
   AWAYWORK_REMOTE_TOKEN=<the same token>
   ```

Against the image on Colima, Caddy standing in for Coolify, a stand-in agent and a `chores` source:

```
$ awaywork run --unit CH-1
Queued CH-1 as run 20261104-220657; awaywork report 20261104-220657 shows it once it ends
$ awaywork skip chores:CH-1 --until 2030-01-01
skipped with awaywork skip chores:CH-1 until 2030-01-01
$ awaywork report 20261104-220657 --unit CH-1
1  CH-1  Write a hello report
  status  done
  files   /home/away/.local/state/awaywork/runs/20261104-220657/units/ch-1/1-plan/worker.log
          [...]

Hello from the stand-in agent, as awaywork
```

The paths are the container's. Each request is a line in its log, never the token: `remote: ["run","--unit","CH-1"]: exit 0`.

Details:

- What goes there: `report`, `plan`, `stats`, `sources`, `doctor`, `schedule status`, `config path`, `skills list`, `skip`, `unskip`, `approve` and `run --unit`, with their flags here. The rest stays local: `init`, `config schema` and `edit`, `skills eject`, a full `run`, `schedule install`, `--help`.
- One of the twelve with a flag the daemon refuses fails rather than running locally (`AWAYWORK_REMOTE (http://127.0.0.1:7480): refused --dry-run`); a value starting with `--` is written `--reason=-- see thread`.
- `-c`/`--config` means this machine. To run anything else here, blank it: `AWAYWORK_REMOTE= awaywork report`.
- `run --unit` starts no process on the box: the daemon queues a one-off run, like the workflow's [`unit` input](#run-one-item-now).
- The item must still match a rule unless `--skill` [picks one](./skills.md#run-one-on-an-item-no-rule-takes); it runs after a failed attempt, present outside a window, away inside one, and waits for the worker in progress like a [soon run](#soon-runs). `--detach` changes nothing. Failures say why and exit 1: `no unit "CH-9" in the plan; awaywork plan --why CH-9 says why`, `CH-1 is running in run 20261104-220137`.
- Two commands at a time, a third turned away (`2 commands are running, try again`), 2 minutes each. A silent command gets a `{}` line every 30 s to keep the proxy open; Ctrl-C stops it on the box. A queued `run --unit` is the daemon's by then.
- A box that's down or a wrong token fails in one line: `can't reach AWAYWORK_REMOTE (http://127.0.0.1:8480): read ECONNRESET`, `AWAYWORK_REMOTE (http://127.0.0.1:7480) refused AWAYWORK_REMOTE_TOKEN`.
- Remove the two lines to go back to local runs. A laptop daemon opens no port while `AWAYWORK_REMOTE` is set. A leaked token and rotation: [Safety](./safety.md#the-remote-token).

### Over ssh

awaywork on a box of its own, a VPS under systemd from [`schedule install`](#on-your-machine), a home server, a Mac mini: you can ssh in, so use that. No proxy, TLS or token on the laptop:

```sh
AWAYWORK_REMOTE=ssh://box   # or ssh://you@host:2222
```

The host is whatever `ssh` takes, aliases included. The same calls go through the box's daemon: the laptop runs `ssh -T -o BatchMode=yes box env AWAYWORK_REMOTE=http://127.0.0.1:7480 awaywork --from-ssh WyJzc2g6Ly9ib3giLCJwbGFuIl0`, the call (`["ssh://box","plan"]`) as one base64url word no login shell reads into, csh included, and the box forwards it to its daemon. The box needs:

- **The same awaywork or newer:** an older one says `error: unknown option '--from-ssh'`. Install the version `awaywork --version` prints on the laptop.
- **`watch` with a token:** `echo "AWAYWORK_REMOTE_TOKEN=$(openssl rand -hex 32)" >> ~/.config/awaywork/env`, then restart it. The token never leaves the box: ssh is the lock.
- **awaywork and node on ssh's command `PATH`**, not your login shell's (nvm's usually isn't). `ssh box env awaywork --version` checks it as the laptop's calls do; exit 127 (`env: 'awaywork': No such file or directory`, or `node`) means install them system-wide, or `sudo ln -s "$(command -v node)" "$(command -v awaywork)" /usr/local/bin/` from an interactive shell there.
- **Key auth:** `BatchMode` never asks for a password or a host key, either of which would hang the `/away` pane. ssh in once by hand to know the host key.

Exit codes are the box's and stdout and stderr stay apart, so `awaywork plan --json | jq` works. Shell characters in arguments arrive as text (`--reason "it's done; \$(rm -rf ~)"` is just a reason). There's no Ctrl-C without a terminal; the box's awaywork leaves when the laptop's ssh goes, and the daemon stops the command (`remote: ["plan"]: stopped, the client left`). Errors name the remote and the box's side:

```
$ awaywork report
can't reach AWAYWORK_REMOTE (ssh://dev@127.0.0.1:2222): Host key verification failed.
$ awaywork report
AWAYWORK_REMOTE (ssh://box): awaywork isn't on the box's PATH for non-interactive ssh; install it and node system-wide there, or link both into /usr/local/bin
$ awaywork run --unit CH-1
AWAYWORK_REMOTE (ssh://box): the box's daemon isn't serving, the box's /home/dev/.config/awaywork/env has no AWAYWORK_REMOTE_TOKEN; add one there and restart awaywork watch
$ awaywork report --list
AWAYWORK_REMOTE (ssh://box): the box's daemon runs with another AWAYWORK_REMOTE_TOKEN than its env file; restart awaywork watch there
```

A call over ssh never runs on the box outside its daemon, so a box without a token refuses rather than running `run --unit` itself. The container is the exception: its port goes to the proxy, not the host, so Coolify and compose use HTTP.
