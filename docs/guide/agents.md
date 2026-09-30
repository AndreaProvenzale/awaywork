---
description: How a coding agent can install and configure night-shift for its user, which commands are safe to run unattended, and the machine-readable docs to read.
---

# With an AI agent

night-shift is easy to set up from a coding agent: the config is one YAML
file with a JSON Schema, and every step has a non-interactive command.

## Prompt to paste

```text
Set up night-shift (https://andreaprovenzale.github.io/night-shift/llms.txt)
for me. Read the docs first. Find which of claude and codex I have
installed and logged in, and which GitHub repos I work on (gh). Ask me
which repos and which Asana workspace to include and how much quota a
night may use, then write the config, validate it and show me the plan.
Don't run a night or install a schedule until I say so.
```

## For agents

Machine-readable docs:

| URL | What |
|---|---|
| [`llms.txt`](https://andreaprovenzale.github.io/night-shift/llms.txt) | Index of every page, as Markdown links |
| [`llms-full.txt`](https://andreaprovenzale.github.io/night-shift/llms-full.txt) | All pages in one file |
| `<page>.md` | Any page as Markdown, e.g. [`guide/configuration.md`](https://andreaprovenzale.github.io/night-shift/guide/configuration.md) |
| [`config.schema.json`](https://andreaprovenzale.github.io/night-shift/config.schema.json) | The config's JSON Schema; `nightshift config schema` prints the installed version's |

Setting up:

1. `npm install -g nightshift-agent`; check `claude --version`,
   `codex --version`, `gh auth status`.
2. `nightshift init --yes` writes `~/.config/night-shift/config.yml`
   without a terminal: the installed providers, `github` when `gh` is
   logged in (repos `<login>/*`), the default queue and a 01:00-07:00
   night. Override with `--provider claude codex` (first takes units
   first), `--source github asana` and `--night 23:00-06:00`. Asana is
   skipped with a note unless `ASANA_TOKEN` is set; then it takes the
   first workspace and every project with the user's tasks. Linear is
   likewise skipped unless `LINEAR_API_KEY` is set. Jira is skipped:
   it needs a site and an email. It refuses
   to replace an existing config without `--force`. To go further, edit
   the file from [Configuration](./configuration.md) and the
   [reference](../reference/config.md). Asana gids come from
   `https://app.asana.com/api/1.0/workspaces` and `/projects` with the
   user's token.
3. Put secrets in `~/.config/night-shift/env` (`NAME=value` lines, mode
   600), never in the config. Ask the user for them; don't read them from
   other tools' files.
4. `nightshift config check` until it prints `ok`.
5. `nightshift plan`, and show the user the result.

What each command does:

| Command | Effect |
|---|---|
| `config check`, `config schema`, `skills list`, `report` | Read-only, local |
| `plan`, `doctor` | Read-only on sources and forge; probe each provider's quota (one tiny model call for Claude) |
| `skills eject <name>` | Copies a skill into the user's skills dir |
| `run --dry-run` | Clones repos and writes workspaces; no agent, nothing pushed |
| `run`, `run --unit <id>` | Runs agents on the user's quota; pushes branches and opens draft PRs. Ask first. |
| `schedule install` | Installs a nightly job, or writes a workflow with `--with github-actions`. Ask first. |
| `init --yes` | Writes the config from detected defaults; `--force` replaces one |
| `init`, `queue`, `config edit` | Interactive; need a terminal |

Machine-readable output:

- `nightshift plan --json` prints the plan as one object: `queue`,
  `defaultQueue`, `allowances` (per provider), `units`, `skipped` and
  `warnings`. Items leave out their raw source payload.
- `nightshift doctor --json` prints the checks as an array of
  `{ status, what, detail }`, `status` being `ok`, `warn` or `FAIL`. It
  exits 1 when any check is `FAIL`, as without `--json`.

`nightshift <command> --help` and the [CLI reference](../reference/cli.md)
list every option.
