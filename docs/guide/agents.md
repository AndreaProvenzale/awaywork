---
description: How a coding agent can install and configure awaywork for its user, which commands are safe to run unattended, and the machine-readable docs to read.
---

# With an AI agent

awaywork is easy to set up from a coding agent: the config is one YAML file with a JSON Schema, and every step has a non-interactive command.

## Prompt to paste

```text
Set up awaywork (https://andreaprovenzale.github.io/awaywork/llms.txt)
for me. Read the docs first. Find which of claude and codex I have
installed and logged in, and which GitHub repos I work on (gh). Ask me
which repos and which Asana workspace to include and how much quota a
run may use, then write the config, validate it and show me the plan.
Don't start a run or install a schedule until I say so.
```

## For agents

Machine-readable docs:

| URL | What |
| --- | --- |
| [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt) | Index of every page, as Markdown links |
| [`llms-full.txt`](https://andreaprovenzale.github.io/awaywork/llms-full.txt) | All pages in one file |
| `<page>.md` | Any page as Markdown, e.g. [`guide/configuration.md`](https://andreaprovenzale.github.io/awaywork/guide/configuration.md) |
| [`config.schema.json`](https://andreaprovenzale.github.io/awaywork/config.schema.json) | The config's JSON Schema; `awaywork config schema` prints the installed version's |

Setting up:

1. `npm install -g awaywork`; check `claude --version`, `codex --version`, `gh auth status`.
2. `awaywork init --yes` writes `~/.config/awaywork/config.yml` without a terminal: the installed providers, `github` when `gh` is logged in (repos `<login>/*`), the default queue and a 01:00-07:00 window. Override with `--provider claude codex` (first takes units first), `--source github asana` and `--window 23:00-06:00`. Asana is skipped with a note unless `ASANA_TOKEN` is set; then it takes the first workspace and every project with the user's tasks. Linear is likewise skipped unless `LINEAR_API_KEY` is set. Jira is skipped: it needs a site and an email. It refuses to replace an existing config without `--force`. To go further, edit the file from [Configuration](./configuration.md) and the [reference](../reference/config.md). Asana gids come from `https://app.asana.com/api/1.0/workspaces` and `/projects` with the user's token.
3. Put secrets in `~/.config/awaywork/env` (`NAME=value` lines, mode 600), never in the config. Ask the user for them; don't read them from other tools' files.
4. `awaywork doctor` until the config's line isn't `FAIL`.
5. `awaywork plan`, and show the user the result. When stdin and stdout are both a terminal, `plan` and `report` open an interactive view; piped (`| cat`) or with `CI` set, they print text.

What each command does:

| Command | Effect |
| --- | --- |
| `config schema`, `skills list`, `report` | Read-only, local |
| `plan`, `doctor` | Read-only on sources and forge; probe each provider's quota (one tiny model call for Claude) |
| `plan --rules` | Read-only on sources and forge; probes no provider |
| `skills eject <name>` | Copies a skill into the user's skills dir |
| `run --dry-run` | Clones repos and writes workspaces; no agent, nothing pushed |
| `run`, `run --unit <id>` | Runs agents on the user's quota; pushes branches and opens draft PRs. Ask first. |
| `schedule install` | Installs a scheduled job, or writes a workflow with `--with github-actions`. Ask first. |
| `init --yes` | Writes the config from detected defaults; `--force` replaces one |
| `init`, `config edit` | Interactive; need a terminal |

Machine-readable output:

- `awaywork plan --json` prints the plan as one object: `queue`, `defaultQueue`, `allowances` (per provider), `units`, `skipped` and `warnings`. Items leave out their raw source payload. Each skipped entry is `{ item, kind, reason }`, plus `url` when it waits on an awaywork PR for review: the PR to open, which may not be the item, or on an answer or an approval: the item awaywork asked or posted its plan on. Its `kind` is `waiting_for_review`, `waiting_for_answer`, `waiting_for_approval`, `invalid_plan`, `all_tasks_done`, `gave_up`, `no_repo`, `invalid_branch`, `refused_delivery` or `unstackable` when the user can act to make it run (review the awaywork PR, answer awaywork's questions on the item, approve or fix its plan, close the card whose tasks are all done, read the failed logs, give the item a repo, fix the rule), and `no_rule`, `over_cap`, `unchanged`, `skipped_by_you`, `fanned_out` (a card whose plan became tasks), `waiting_for_task` (a task waiting for another's PR to merge, or to open, or for a check on it to pass), `task_merged`, `task_done` (a task that reports, whose `done` result is on its card) or `running` (another of the daemon's runs is working on it) when it's the config doing its job. A card's `taskPrs` holds its tasks' PRs by task id, with `checks`, the state of each check a task's `after` names (`passed`, `pending` or `failing`; missing when not reported). A plan's task has `item.task`: its card as `parent`, its `id` and `skill`, `plan`, the plan's tasks with each one's `after` (`opened`, `merged` or a check's name), `repo` and `ships`, `contract` when the plan has one, and `onto`, the task whose PR it stacks on; its `item.fields.repo` is its own repo. A unit stacked on a PR another unit of the run opens has `after`, that unit's id, and one waiting for tasks in other repos to open their PR earlier in the run has `waitsFor`, their task ids.
- `awaywork doctor --json` prints the checks as an array of `{ status, what, detail }`, `status` being `ok`, `warn` or `FAIL`. It exits 1 when any check is `FAIL`, as without `--json`.
- `awaywork report --json` prints the run's results (`runId`, `dryRun`, `startedAt`, `finishedAt`, `plan`, `results`, `quotas`, `warnings`) as one object, read from the run's `report.json`. Items are references only: `source`, `key`, `title` and `url`. Skipped entries have a `kind`, as in `plan --json`, except in a run from before skips had kinds. Each step that started has `files`, paths relative to the run dir: `log`, `report` and `diff` (its own commits) from the step's folder, and on a slice's first step, which publishes it, `sliceBody` and `sliceDiff` from `out/` (`out-2/` for a stacked slice and so on), the PR body or push summary (the joined report when the slice published reports) and the commits it published, or would have if the publish failed. A key is there only when its file was. A run [from the runner](./scheduling.md#reports-from-the-runner) comes with only `report.md`, `report.json` and `units.json`, so check a path exists before opening it. `summary` is the first paragraph of `sliceBody`, else of `report`. The PR it opened or pushed onto is `outcome.url`. A `fix` that found nothing to commit, trimmed:

  ```json
  {
    "status": "done",
    "outcome": { "kind": "none", "reason": "nothing" },
    "summary": "No code changes: both red checks are unrelated to this diff.",
    "files": {
      "log": "units/acme-api-5/1-fix/worker.log",
      "sliceBody": "units/acme-api-5/out/pr.md"
    }
  }
  ```

`awaywork <command> --help` and the [CLI reference](../reference/cli.md) list every option.
