---
description: Run awaywork in its windows on your machine with launchd, systemd or cron, or in GitHub Actions on GitHub's runners or your own.
---

# Scheduling

A scheduled run is `awaywork run --scheduled`: it does nothing outside
the [`windows`](./configuration.md#windows-limits-and-budget) and starts
no unit after the one it is in ends. A unit still
running at the window's end stops there with status `stopped: window ended`,
and what it left is published as for a quota stop.

In a terminal, `awaywork schedule install` asks where it runs:

```
◆  Where should it run on a schedule?
│  ● this machine
│  ○ GitHub Actions, from the repo in this directory
│  ↑/↓ to navigate • Enter: confirm
└
```

`--with` answers that up front, and without a terminal (a script, a
coding agent) it asks nothing and takes this machine. `awaywork init`
ends with the same question, plus *later*.

## On your machine

```sh
awaywork schedule install                 # macOS: launchd
awaywork schedule install --with systemd  # Linux: a user timer
awaywork schedule install --with cron
awaywork schedule status                  # scheduler, time, config and log
awaywork schedule remove
```

| Scheduler | Writes | Missed while asleep or off |
|---|---|---|
| launchd | `~/Library/LaunchAgents/awaywork.plist` | Runs at the next wake |
| systemd | `~/.config/systemd/user/awaywork.{service,timer}` | Runs at the next boot (`Persistent=true`) |
| cron | a tagged line in your crontab | Skipped |

- The job keeps the `PATH` of the shell that installed it, so it finds the
  same `claude`, `codex` and `gh`. It runs the binary on that `PATH`, not
  a shell alias or function wrapping it.
- Secrets come from `~/.config/awaywork/env`, since a scheduled job
  starts without your login shell's variables.
- systemd user timers run only while you are logged in;
  `loginctl enable-linger` lifts that. Without a user session (after
  `sudo -iu` or `su -`, say) `--with systemd` fails and changes nothing;
  log in directly, or use `--with cron`, which needs no session. From
  such a shell `schedule status` and `doctor` can't reach the timer and
  report no schedule.
- Output goes to `~/.local/state/awaywork/schedule.log`, each run
  starting with a line dated in local time; the morning report is
  `awaywork report`. Both list what went wrong before any unit started,
  like a source command that failed:

  ```
  awaywork run at 2026-10-12 22:34:18
  warning: source chores: Command failed with exit code 1: ./chores.sh

  CHORES_TOKEN is not set
  Run 20261012-203418: 0 units planned, state in ~/.local/state/awaywork/runs/20261012-203418
  ```

  A secret the config names shows up as `***` there, so the report is
  safe to hand to `notify`. Run ids are the start time in UTC, so they sort the same across
  daylight saving and travel.
- The job bakes in the window starts, one trigger each. When you change them, `config edit` and
  `doctor` warn until `schedule install` runs again.

### Waking up for it

A sleeping machine runs nothing. Once a run starts it keeps the machine
from idling back to sleep (`caffeinate -i` on macOS, `systemd-inhibit
--what=idle` on Linux), so the missing piece is the wake itself. In a
terminal, `schedule install` offers one after the job:

```
◆  Wake this Mac when the window opens (sudo pmset repeat wake MTWRFSU 01:00:00)?
│  ● Yes / ○ No
└
```

- macOS: `pmset` keeps a single repeating wake, so this needs every
  window to start at the same time, and it replaces a repeating power
  event you already had (the question names it). Keep a laptop on the
  charger; with the lid closed on battery it may not wake fully.
- Linux: a root timer, `/etc/systemd/system/awaywork-wake.timer` with
  `WakeSystem=true`, resumes from suspend at each window start. A
  background job may block idle but not sleep, so a desktop that suspends
  on its own timer (GNOME's automatic suspend, say) can still put it
  down mid-run; turn that off on AC power.
- sudo wants a password, so without a terminal install only says how.
  `schedule remove` leaves the wake and prints the command that removes it.

## In GitHub Actions

Run it from a repo of your own instead (a private "awaywork" repo works
well), on GitHub's runners or on a machine of yours. On a team, each
person keeping their own control repo is the simple setup: it needs
nothing beyond this section, and nobody's token sits in a repo a
teammate can write to. Teammates can point theirs at the same repos,
since each run only sees its own token's `@me`. To share one repo
instead, see [Shared control repo](#shared-control-repo).

```
$ cd my-awaywork-repo
$ awaywork schedule install
│
◇  Where should it run on a schedule?
│  GitHub Actions, from the repo in this directory
│
◇  Whose control repo is this?
│  just mine
│
◇  Which runner?
│  self-hosted
Wrote .github/workflows/awaywork.yml
Copied ~/.config/awaywork/config.yml to .awaywork/config.yml
Before the first run:
  commit .github/workflows/awaywork.yml and .awaywork/config.yml
  add these repository secrets: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
  GH_TOKEN is a classic personal access token of yours with the `repo` and `workflow` scopes (…)
```

The runner is GitHub-hosted by default: a fresh VM each run, with no
Codex. Self-hosted is a machine of yours, see
[Running Codex](#running-codex). Without a terminal,
`awaywork schedule install --with github-actions` asks nothing: it keeps
the runner the workflow already has, GitHub-hosted for a new one, and
offers no secret.

This writes `.github/workflows/awaywork.yml`: a cron at each window's
start in your current timezone, plus `workflow_dispatch` for a
manual run; `awaywork schedule remove` deletes it. It also copies your
config to `.awaywork/config.yml` and your
[skills](./skills.md#where-skills-come-from), if any, to
`.awaywork/skills/` next to it, so your personal skills reach the
runner. It offers to set each repository secret the config needs whose
value is in your environment or `~/.config/awaywork/env`, with
`gh secret set`. Values are never printed. Then:

1. Commit the files it lists.
2. Add the repository secrets it lists as unset, e.g. `GH_TOKEN`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `ASANA_TOKEN`, your `notify.secrets`, your `after_unit.secrets`, your
   repos' `secrets`, your MCP servers' `secrets` and your custom sources' `secrets`.
3. Run it once by hand from the Actions tab.

`doctor`, run inside the repo, checks that every secret the workflow
names exists in the repo or its org, and fails naming the missing ones.

`GH_TOKEN` is your own token, since the work is yours: a classic personal
access token with the `repo` and `workflow` scopes. `repo` reads your PRs,
issues, checks and Actions logs, pushes new branches and opens draft PRs
in the configured repos; `workflow` lets it push branches that change
workflow files.

The workflow calls awaywork's action, `AndreaProvenzale/awaywork@v1`,
which installs the awaywork version you generated it with. On a
GitHub-hosted runner it first frees about 20 GB of preinstalled SDKs
(runners otherwise die quietly on large repos). It commits as the
token's user, through the job's env rather than git config, appends
the morning report to the job summary and uploads the run as an
[artifact](#reports-from-the-runner). Fixes to those steps reach you through
`v1`; to upgrade awaywork itself, raise `version` in the workflow, or
upgrade awaywork and run `schedule install --with github-actions`
again.
The job's `GITHUB_TOKEN` can only read (`permissions: contents: read`),
checkout keeps no credential (`persist-credentials: false`), and only the
action's step gets the secrets. Every step inside the action sees them:
if you'd rather not follow `v1`, pin it to a commit SHA of this repo
instead. A [custom source](./custom-sources.md)'s `setup` runs as a step
of its own before the action, in the config's folder, without the secrets.

The workflow works once awaywork has a stable release on npm, which
also creates the `v1` tag.

Run `schedule install --with github-actions` again after changing your
config or skills, or to refresh the workflow. Of the workflow, config and
skills, one that matches is up to date; one that differs shows the diff
and is replaced only if you say yes, so a hand edit never goes silently.
Without a terminal nobody can say yes: it keeps the repo's copy, prints
the diff and exits 1, so run it again in a terminal to replace it.
The skills folder is replaced as a whole: a skill only the repo has, say a
teammate's, goes with it. With no skills of your own, the repo's stay.

A workflow generated before the action existed runs its steps inline and
misses those fixes; `doctor`, run inside the repo, warns until you
run `schedule install --with github-actions` again.

A stdio [MCP server](./configuration.md#mcp-servers) runs on the runner,
so its `command` must be there: `npx` and `node` are, other binaries
need a setup step. An HTTP server must be reachable from GitHub's runners.

A GitHub-hosted runner starts with an empty state dir, so it keeps no
attempts or skips: an item unchanged since the last run runs again, none
is given up on, and `awaywork skip` on your machine doesn't reach it.
Nor does it keep the head a [`deliver: push`](./configuration.md#push)
left, so the PR doesn't wait for your review: the rule pushes again
every run its `where` holds. A self-hosted runner keeps
`~/.local/state/awaywork` of the user it runs as, so all of that
carries over between runs as on your machine.

GitHub also ends a job on its hosted runners at 6 hours, whatever your
window says. So there a run stops 5h40 after `awaywork run` starts,
or at the window's end when that comes first, and the 20 minutes
left go to publishing and the report; the workflow sets
`timeout-minutes: 360` to match. A longer window, like `18:00-07:00`,
effectively lasts about 6 hours there, and `plan` on the runner says so:

```
Warnings
  GitHub-hosted runners end a job at 6 hours, so a run stops 5h40 after it starts, before 18:00-07:00 ends
```

The stop works like any window end: a running unit stops with
`stopped: window ended` and publishes what it has. A run from the
Actions tab gets the same cap. On a self-hosted runner a run lasts the
whole window: GitHub's default of 360 minutes applies to self-hosted jobs
too, so that workflow sets `timeout-minutes: 1440`. One installed
without it gets the line on your next
`schedule install --with github-actions`.

Pick one per machine, though: a local schedule or a runner. Nothing
keeps two runs apart, so with both on one machine they start together
when a window opens and work the same items on the same state dir.
Moving to the runner, run `awaywork schedule remove` outside the control
repo first; inside it, that deletes the workflow too.

### Reports from the runner

The runner's runs dir doesn't come back to your machine, so each run
also uploads its `report.md` and `units.json` as an artifact named after
the workflow and the run, like `awaywork-20261014-223527`. Inside the
control repo, `awaywork report` and `report --list` fetch those through
`gh` and mix them with your local runs, newest first. They find a
workflow's runs by its file name, so keep its `name:` as
`schedule install` wrote it:

```
$ cd my-awaywork-repo
$ awaywork report --list
20261015-160012  9 units, 3 draft PRs, 2 reports  (github: awaywork)
20261014-223527  14 units, 2 draft PRs, 6 reports  (github: awaywork)
20261012-203418  0 units, 0 draft PRs, 0 reports
```

`awaywork report` prints the newest of either, `report <id>` any of
them. A run is downloaded once, into
`~/.local/state/awaywork/remote/<owner>/<repo>/<artifact>/`, and never
into `runs/`, so `stats`, `replay` and attempts stay about your own machine.
Artifacts expire with the repo's retention (90 days unless you changed
it), and an expired run drops off the list. If `gh` can't get to
GitHub, you get one `warning:` line and your local runs. Outside the
control repo, `report` only knows your local runs.

### Credentials on a runner

| Provider | Secret | Notes |
|---|---|---|
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; lasts a year |
| Codex | none | Self-hosted runners only, on the machine's own login |

### Running Codex

Codex is experimental and doesn't run on GitHub-hosted runners: it uses
the machine's own `codex login`, which Codex rotates in place, and a
fresh runner has none to keep. With a GitHub-hosted runner,
`schedule install` says so and leaves it out of the workflow, and a run
there routes its units to your other providers:

```
codex won't run in this workflow: a GitHub-hosted runner has no Codex login, and one copied there goes stale since Codex rotates it in place; run Codex locally or on a self-hosted runner
```

So run it one of two ways:

- **Locally**, with launchd, systemd or cron, as in
  [On your machine](#on-your-machine).
- **On a self-hosted runner**: a machine of yours
  [added as the control repo's runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners),
  logged in with `codex login` as the user the runner runs as. On a
  headless box, `codex login --device-auth` does it without a browser
  ([Codex's docs](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)).
  Pick self-hosted at *Which runner?*: the workflow says
  `runs-on: self-hosted` and keeps Codex, with no secret for it. Every
  self-hosted runner the repo can use matches that, an organization's
  too, so a colleague's box could pick up your job: give your runner a
  [label of its own](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels)
  and add it, as in `runs-on: [self-hosted, alice-mac]`. Install says
  so while it's plain `self-hosted`, and keeps the labels on a re-run.

On a self-hosted runner the job runs on your machine, so the action
keeps its hands off it: no freeing disk, no provider CLIs installed
over yours, no git config written. It installs awaywork alone into the
job's temp dir, which the runner empties every job, and runs the
`codex` and `claude` already on the runner's `PATH`, next to `git` and
`gh`. A runner installed
[as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)
doesn't read your shell profile: its `PATH` is the one `./config.sh`
saved to `.path` in the runner's folder, which
[`runsvc.sh`](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/runsvc.sh)
exports, and other variables sit in `.env` next to it. So a `codex` or
`claude` from nvm or Homebrew can be missing there: configure the runner
from a shell where `codex --version` works, or add their folders to
`.path` and restart the service (`./svc.sh stop`, then `./svc.sh start`).
Claude still reads `CLAUDE_CODE_OAUTH_TOKEN` there. GitHub
recommends self-hosted runners only for private repos, since a fork's
pull request could otherwise run code on your machine: keep the control
repo private.

## Shared control repo

Experimental: tested against a fake GitHub only, never run live yet.

One repo for a team, with a workflow and a GitHub Environment per
person. Each person runs `awaywork schedule install` inside it, picks
GitHub Actions, then *shared, with a workflow per person* at *Whose
control repo is this?*, and gives their name, which defaults to their
GitHub login. In a repo that already has your own `awaywork.yml`, that
question isn't asked: pass `--as <name>` to move it to shared. Or, from
a script:

```sh
awaywork schedule install --with github-actions --as alice
```

A person's workflow always runs on GitHub-hosted runners, so no Codex:
`runs-on: self-hosted` matches any runner the repo can use, and your job
could land on a teammate's machine, on their Codex login and state dir,
with your tokens in its env.

The name is lowercase letters, digits and `-`. Once the repo holds an
`awaywork-<person>.yml` or a `.awaywork/<person>/config.yml`, install
asks for your name right away; without a terminal it refuses without
`--as` and suggests it with your GitHub login. It writes:

| File | What |
|---|---|
| `.github/workflows/awaywork-alice.yml` | The same workflow, named `awaywork-alice`, with `concurrency: awaywork-alice` and `environment: { name: "alice", deployment: false }` |
| `.awaywork/alice/config.yml` | A copy of the config in use; `setup` steps run in this folder |
| `.awaywork/alice/skills/` | A copy of your [skills](./skills.md#where-skills-come-from), when you have any |

First it reads the environment `alice`. One that exists is kept as it
is, with a warning when any branch can deploy to it, or when its branch
policies don't name the default branch, so the job can't use it: fix
either in the repo's Settings > Environments. Otherwise install creates
it and lets only the default branch deploy to it. `deployment: false`
keeps the job out of the Deployments panel. The token still decides who
"me" is: the config names no one, and each job spends its own person's
subscription quota.

### Secrets come in layers

A job sees its environment's secrets, the repo's and the org secrets
shared with the repo. For the same name, the lowest wins: environment
over repository over organization.

| Layer | Holds | Install |
|---|---|---|
| Organization | Company-wide values, like a notify webhook | never sets it |
| Repository | What the team shares: the repos', MCP servers', `notify`'s and `after_unit`'s `secrets` | offers each, unless the repo or, in an org's repo, the org has it; when it can't list them, it says why and offers each |
| Environment `alice` | Alice's own: `GH_TOKEN`, the providers' and the sources' `secrets` | offers each |

Alice's own secrets are suffixed, `__` then the name upper-cased with
`-` as `_`, and the workflow maps each back:

```yaml
GH_TOKEN: ${{ secrets.GH_TOKEN__ALICE }}
```

So a repo or org `GH_TOKEN`, say yours from when the repo was your solo
control repo, never stands in for hers. A name in both groups counts as
personal. To keep a shared value to yourself, set it under its own name
in your environment: it wins. As for one repo per person, the values
come from your env and are never printed.

Once you have an environment, a fallback's suffixed repository secrets
(below) still reach any branch and fill in for any your environment
lacks: install warns about each and how to delete it.

### Without an environment

Creating an environment needs admin access to the repo, and GitHub's
docs reserve environment secrets on private repos for paid plans. In a
personal account's repo, a collaborator with write access can set
repository secrets, so the fallback works for them; in an
organization's repo GitHub's docs ask for admin access, so an admin may
have to set them. When GitHub refuses (HTTP 403, 404 or 422), install
says why and asks before falling back, defaulting to no: the workflow
loses its `environment:` line, and the same suffixed names become
repository secrets. Without a terminal it changes nothing and says to
run it in one. The API's answer decides, never a guess at
the plan. Any other error, like a network one, stops install, and so
does a refusal once `awaywork-alice.yml` uses the environment: it is
never downgraded.

The fallback has no branch limit: any branch's workflow can read every
teammate's token.

### Risks

- **Write access reads every secret.** Anyone who can push a branch can
  push a workflow that prints the repo's secrets. Each environment's
  default-branch limit is the guard, so protect the default branch:
  required reviews, no direct pushes. The fallback has no such guard.
- **The shared layers have no guard.** Repository and org secrets reach
  any branch, so keep there only what the whole team may see.
  Subscription tokens go in personal environments.
- **The repo holds teammates' credentials.** Each person sets their own,
  but keeping them together is the team's choice; one control repo per
  person avoids it.

### Sync, status and remove

Running the same command again is the sync, as for one repo per person:
`awaywork-alice.yml`, `.awaywork/alice/config.yml` and
`.awaywork/alice/skills/` are each replaced only after a diff and a
yes.

`schedule status` lists every `.github/workflows/awaywork*.yml`.
`schedule remove --as alice` deletes `awaywork-alice.yml` only: the
environment and its secrets stay until
`gh api -X DELETE repos/{owner}/{repo}/environments/alice`, and a
fallback's suffixed repository secrets, readable from any branch, until
`gh secret delete` for each, which it lists.

The action fails before anything else when `GH_TOKEN` is empty, which is
how a job whose secrets didn't reach it shows.

### Checking with doctor

`awaywork doctor`, run inside the repo, reads each
`awaywork*.yml`: its `environment` and every `secrets.X` its job's and
steps' `env:` name. Each must exist in that environment, the repo or the org: one
line per workflow says how many were found, or fails naming the missing
ones and where they go. With an environment, a name with the person's
suffix goes there and the rest to the repo; without one, all go to the
repo. Once the person has an environment, it warns about their suffixed
secrets still at repo level, as install does. A workflow that doesn't
parse fails, since it won't run either. When gh can't list the repo's or
the org's secrets (no access, no remote, not logged in), it warns why
instead of guessing what's missing.
