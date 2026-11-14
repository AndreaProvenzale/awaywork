---
description: "Run awaywork in GitHub Actions on GitHub's runners or your own: the action, running one item now, reports, credentials, Codex and Cursor on a runner."
---

# In GitHub Actions

Run it from a private repo of your own, on GitHub's runners or a machine of yours. On a team, each person keeps their own control repo, so nobody's token sits where a teammate can write; they can all point at the same repos, since each run sees its own token's `@me`. It's GitHub only and one file: install refuses a [Bitbucket](../config/sources.md#bitbucket-and-jira) config or one that [extends a base](../config/index.md#a-base-config).

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

It writes a workflow with a cron at each window's start (none with `windows: []`) plus `workflow_dispatch`, copies your config to `.awaywork/config.yml` and your [skills](../skills.md#where-skills-come-from) to `.awaywork/skills/`, and offers to set each needed secret it finds in your environment or env file with `gh secret set`, never printing values.

Then commit, add the secrets it lists as unset (`GH_TOKEN`, provider tokens, and any `secrets` of sources, repos, MCP servers and `notify`), and run it once from the Actions tab. `schedule remove` deletes the workflow.

`GH_TOKEN` is your classic personal access token: `repo` reads your PRs, issues, checks and logs and pushes branches and drafts; `workflow` lets it push branches that touch workflow files; `read:org` shows teammates with private org membership, whose text would otherwise be [hidden](../safety/index.md#public-repos).

Details:

- The runner is GitHub-hosted by default: a fresh VM, no Codex. Self-hosted: see [Running Codex](#running-codex). Without a terminal, `--with github-actions` keeps the workflow's runner (hosted for a new one) and offers no secrets.
- No daemon there, so [`run: soon`](./machine.md#soon-runs) rules run in the windows; install says so once.
- `doctor` inside the repo fails naming secrets missing from the repo and its org, and fails a workflow that doesn't parse; when gh can't list secrets, it warns why. The action fails first thing on an empty `GH_TOKEN`, the sign secrets didn't reach the job.
- The cron is UTC: install converts each start from your timezone at standard time, and the job's `TZ` keeps ends, `days` and [routines](../config/sources.md#routines) local. Runs never start early, but in summer time up to an hour late (a Rome `18:00` window fires at `17:00` UTC, 19:00 there March to October), so keep Actions windows over an hour. Changed timezone? Run install again.

## The action

The workflow calls awaywork's action at the release you generated it with, `AndreaProvenzale/awaywork@v0.3.1` say, which installs that version (`version` input). On a GitHub-hosted runner it frees about 20 GB of preinstalled SDKs (runners otherwise die quietly on large repos) and makes the [worker user](../safety/isolation.md#a-worker-user-on-github-hosted-runners).

It commits as the token's user through env, not git config, appends the morning report to the job summary and uploads the run as an [artifact](#reports-from-the-runner). A [custom source](../config/custom-sources.md)'s `setup` runs as its own step first, in the config's folder, without secrets.

- `GITHUB_TOKEN` is read-only (`permissions: contents: read`), checkout keeps no credential (`persist-credentials: false`), and only the action's step gets secrets.
- Every step inside the action sees them, hence the pin: new action code meets your secrets only when you rerun install. Pin `uses:` to the release's SHA for tighter.
- To upgrade, upgrade awaywork and rerun `schedule install --with github-actions`; by hand, change `uses:` and `version` together. A workflow from before the action runs its steps inline; `doctor` warns.
- Rerun install after config or skill changes. A matching file is up to date; one that differs shows the diff and is replaced only on your yes. Without a terminal it keeps the repo's copy, prints the diff and exits 1. The skills folder is replaced whole, dropping repo-only skills; with no skills of yours, the repo's stay.

## On the runner

- **No state on a hosted runner:** no attempts, skips or earlier reports, so unchanged items run again, none is given up on, your local `awaywork skip` doesn't reach it, and a chain starts without the last report. Waiting [questions](../workflows/questions.md#questions) and [posts](../workflows/posts.md#posts-that-wait) still wait, read off the item, and `awaywork approve` replies there.
- **No push hold:** without the head a [`deliver: push`](../config/chains.md#push) left, the rule pushes again every run its `where` holds.
- **A self-hosted runner** keeps its user's `~/.local/state/awaywork`, as on your machine.
- **MCP servers and toolchains:** a stdio [MCP server](../config/mcp.md)'s `command` must exist on the runner (`npx` and `node` do). On a hosted runner it runs as the worker, who can't enter the runner's home, so a script in your checkout won't start; install packages, pnpm included, with the action's `packages`, not a setup action that installs into the home (`pnpm/action-setup` does). HTTP servers must be reachable from GitHub.
- **6 hours:** hosted jobs end at 6 hours, so a run stops 5h40 after it starts or at the window's end, leaving 20 minutes to publish; the workflow sets `timeout-minutes: 360`, and `plan` warns about longer windows (`GitHub-hosted runners end a job at 6 hours, so a run stops 5h40 after it starts, before 18:00-07:00 ends`). It stops like any window end, Actions-tab runs included. Self-hosted runs last the window, with `timeout-minutes: 1440`, added on your next install.

## Run one item now

The workflow takes a `unit` input, an item key:

```
$ gh workflow run awaywork -f unit=API-12
```

It runs only `API-12`, outside any window, retrying even after a failed attempt. The item is fetched again and must still match a rule, so "only your items", the ceiling and the prompt hold.

- `concurrency: awaywork` cancels nothing: a dispatch waits for the nightly run, and GitHub keeps only the newest pending run.
- It spends daytime quota; as a run outside the windows, workers stop at `present_session_max` (40% of the 5-hour window by default).
- "Run it when Sentry escalates" needs a relay: as far as we know Sentry's webhooks can't send what GitHub's dispatch API wants. awaywork ships none and holds no credentials for one; a small function calling `gh workflow run` does it.

## Reports from the runner

Each run uploads `report.md`, `report.json` and `units.json` as an artifact like `awaywork-20261014-223527`. Inside the control repo, `awaywork report` and `report --list` fetch those through `gh` and mix them with your local runs:

<!-- Generated by `pnpm docs:gen` from scripts/screens.ts. Do not edit. -->

```text schedule-report-list
$ awaywork report --list
20261015-160012  9 units, 3 draft PRs, 2 reports  (github: awaywork)
20261012-203418  0 units, 0 draft PRs, 0 reports
```

They find runs by the workflow's file name, so keep its `name:` as written. A run downloads once, into `~/.local/state/awaywork/remote/<owner>/<repo>/<artifact>/`, never `runs/`, so `stats`, `replay` and attempts stay local. Artifacts expire with the repo's retention (90 days by default). Offline you get a `warning:` and your local runs; outside the control repo, local runs only.

## Credentials on a runner

| Provider | Secret | Notes |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; lasts a year |
| Codex | none | Self-hosted runners only, on the machine's own login |
| Cursor | `CURSOR_API_KEY` | A key from Cursor's dashboard |
| [Your own CLI](../config/providers.md#bring-your-own-cli) | its `secrets` | Self-hosted runners only |

## Running Codex

Codex (experimental) uses the machine's `codex login`, which it rotates in place, so a fresh runner has none to keep. With a hosted runner, install leaves it out and runs route to your other providers:

<!-- Generated by `pnpm docs:gen` from scripts/screens.ts. Do not edit. -->

```text schedule-codex-hosted
codex won't run in this workflow: a GitHub-hosted runner has no Codex login, and one copied there goes stale since Codex rotates it in place; run Codex locally or on a self-hosted runner
```

Run it locally ([On your machine](./machine.md)), or on a machine of yours [added as the control repo's runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners), logged in with `codex login` as the runner's user (`codex login --device-auth` on a headless box, [Codex's docs](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)). Pick self-hosted at _Which runner?_: the workflow says `runs-on: self-hosted` and keeps Codex. Details:

- Every self-hosted runner the repo can use matches that label, an organization's too, so give yours a [label of its own](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels): `runs-on: [self-hosted, alice-mac]`. Install nags while it's plain `self-hosted` and keeps labels on a rerun.
- There the action keeps its hands off: no disk freeing, no CLIs installed over yours, no git config. It installs awaywork alone into the job's temp dir and runs the `codex`, `claude` and `agent` on the runner's `PATH`; Claude still reads `CLAUDE_CODE_OAUTH_TOKEN`.
- A runner [installed as a service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application) doesn't read your shell profile: its `PATH` is the `.path` file `./config.sh` saved, exported by [`runsvc.sh`](https://github.com/actions/runner/blob/main/src/Misc/layoutbin/runsvc.sh), other variables in `.env`. nvm or Homebrew binaries may be missing: configure it where `codex --version` works, or edit `.path` and restart (`./svc.sh stop`, `./svc.sh start`).
- GitHub recommends self-hosted runners only for private repos, since a fork's PR could run code on them: keep the control repo private.

## Running Cursor

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
