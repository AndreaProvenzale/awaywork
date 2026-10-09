---
description: Run night-shift every night on your machine with launchd, systemd or cron, or in GitHub Actions with repository secrets.
---

# Scheduling

A scheduled run is `nightshift run --scheduled`: it does nothing outside
the `night` window (or, with [`windows`](./configuration.md#night-and-budget),
every window) and starts no unit after it ends. A unit still
running at the window's end stops there with status `stopped: night ended`,
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
- The job bakes in the window starts (`night.start`, or each of `windows`), one trigger each. When you change it, `config edit` and
  `doctor` warn until `schedule install` runs again.

The machine must be awake at each window's start (or `night.start`). On a laptop, a sleep schedule
that wakes it (macOS: `pmset repeat wakeorpoweron`) or a machine that
stays on does that.

## In GitHub Actions

Run it on a hosted runner instead, from a repo of your own (a private
"night-shift" repo works well). On a team, each person keeping their own
control repo is the simple setup: it needs nothing beyond this section,
and nobody's token sits in a repo a teammate can write to. Teammates can
point theirs at the same repos, since each run only sees its own
token's `@me`. To share one repo instead, see
[Shared control repo](#shared-control-repo).

```sh
cd my-night-shift-repo
nightshift schedule install --with github-actions
```

This writes `.github/workflows/night-shift.yml`: a nightly cron at
`night.start` in your current timezone, plus `workflow_dispatch` for a
manual run; `nightshift schedule remove` deletes it. It also copies your
config to `.night-shift/config.yml` and your
[skills](./skills.md#where-skills-come-from), if any, to
`.night-shift/skills/` next to it, so your personal skills reach the
runner. It offers to set each repository secret the config needs whose
value is in your environment or `~/.config/night-shift/env`, with
`gh secret set`. Values are never printed. Then:

1. Commit the files it lists.
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
`v1`; to upgrade night-shift itself, raise `version` in the workflow, or
upgrade nightshift-agent and run `schedule install --with github-actions`
again.
The action gets the job's env, secrets included: if you'd rather not
follow `v1`, pin it to a commit SHA of this repo instead. A
[custom source](./custom-sources.md)'s `setup` runs as a step of its own
before the action, in the config's folder.

The workflow works once night-shift has a stable release on npm, which
also creates the `v1` tag.

Run `schedule install --with github-actions` again after changing your
config or skills, or to refresh the workflow. Of the workflow, config and
skills, one that matches is up to date; one that differs shows the diff
and is replaced only if you say yes, so a hand edit never goes silently.
The skills folder is replaced as a whole: a skill only the repo has, say a
teammate's, goes with it. With no skills of your own, the repo's stay.

A workflow generated before the action existed runs its steps inline and
misses those fixes; `doctor`, run inside the repo, warns until you
run `schedule install --with github-actions` again.

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

## Shared control repo

One repo for a team, with a workflow and a GitHub Environment per
person. Each person runs, inside it:

```sh
nightshift schedule install --with github-actions --as alice
```

The name is lowercase letters, digits and `-`. Once the repo holds a
`night-shift-<person>.yml` or a `.night-shift/<person>/config.yml`,
install without `--as` refuses and suggests `--as` with your GitHub
login. It writes:

| File | What |
|---|---|
| `.github/workflows/night-shift-alice.yml` | The same workflow, named `night-shift-alice`, with `concurrency: night-shift-alice` and `environment: { name: "alice", deployment: false }` |
| `.night-shift/alice/config.yml` | A copy of the config in use; `setup` steps run in this folder |
| `.night-shift/alice/skills/` | A copy of your [skills](./skills.md#where-skills-come-from), when you have any |

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
docs reserve environment secrets on private repos for paid plans. Setting
repository secrets needs only write access, so the fallback works for
anyone who can push. When GitHub refuses (HTTP 403, 404 or 422),
install says why and asks before falling back, defaulting to no: the
workflow loses its `environment:` line, and the same suffixed names
become repository secrets. The API's answer decides, never a guess at
the plan. Any other error, like a network one, stops install, and so
does a refusal once `night-shift-alice.yml` uses the environment: it is
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
`night-shift-alice.yml`, `.night-shift/alice/config.yml` and
`.night-shift/alice/skills/` are each replaced only after a diff and a
yes.

`schedule status` lists every `.github/workflows/night-shift*.yml`.
`schedule remove --as alice` deletes `night-shift-alice.yml` only: the
environment and its secrets stay until
`gh api -X DELETE repos/{owner}/{repo}/environments/alice`, and a
fallback's suffixed repository secrets, readable from any branch, until
`gh secret delete` for each, which it lists.

The action fails before anything else when `GH_TOKEN` is empty, which is
how a job whose secrets didn't reach it shows.
