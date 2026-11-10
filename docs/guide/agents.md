---
description: Ask a coding agent what awaywork did and why, and let it write your awaywork queue, with the skill awaywork ships for Codex and friends, plus which commands are safe to run unattended and the machine-readable docs to read.
---

# With an AI agent

You know what you want off your plate: red CI on your PRs, the bugs QA bounces back. Turning that into `where` clauses means learning every source's field names and your tracker's exact spelling of `In Progress`. Let your coding agent do it: the `away` skill asks what you want offloaded, tries its rules on your real PRs, issues and tasks, shows you what each would take tonight, and writes only what you say yes to.

In Claude Code, the plugin adds a pane beside the chat too: see [`/away` in Claude Code](./away.md).

## Codex and friends

The same skill ships in the npm package, in `plugin/skills/away/`, in the [Agent Skills](https://agentskills.io) format. Codex reads the Claude Code marketplace too:

```sh
codex plugin marketplace add AndreaProvenzale/awaywork
codex plugin add awaywork@awaywork
```

It shows up in Codex's skill list as `awaywork:away`; ask Codex to use it by name. Its longer routes, `setup.md`, `queue.md` and `suggest.md`, sit beside its `SKILL.md` and are read only when a route needs one.

Any agent that loads skills from a folder can take it from the installed package instead, e.g. `~/.agents/skills`, which Codex reads as well:

```sh
mkdir -p ~/.agents/skills
ln -s "$(npm root -g)/awaywork/plugin/skills/away" ~/.agents/skills/away
```

No skills support? Tell the agent to read `away/SKILL.md` and follow it.

## Prompt to paste

For a setup from scratch, before there's a config:

```text
Set up awaywork (https://andreaprovenzale.github.io/awaywork/llms.txt)
for me. Read the docs first. Find which of claude, codex and agent
(Cursor) I have installed and logged in, and which GitHub repos I work on (gh). Ask me
which repos and which Asana workspace to include and how much quota a
run may use, then write the config, validate it and show me the plan.
If a source needs a token, tell me to run awaywork secret <NAME>
instead of asking me for it. Don't start a run or install a schedule until I say so.
```

## For agents

Machine-readable docs:

| URL | What |
| --- | --- |
| [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt) | Index of every page, as Markdown links |
| [`llms-full.txt`](https://andreaprovenzale.github.io/awaywork/llms-full.txt) | All pages in one file |
| `<page>.md` | Any page as Markdown, e.g. [`guide/configuration.md`](https://andreaprovenzale.github.io/awaywork/guide/configuration.md) |
| [`config.schema.json`](https://andreaprovenzale.github.io/awaywork/config.schema.json) | The config's JSON Schema; `awaywork config schema` prints the installed version's |
| [`away`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/away/SKILL.md) | The `/away` skill: status, why an item did or didn't run, and which of the files below handles the rest |
| [`setup.md`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/away/setup.md) | A first config, when there's none: whose work and which logins, where it runs, repos from recent sessions, trackers, a checked first queue |
| [`queue.md`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/away/queue.md) | Writing and checking rules on real items |
| [`suggest.md`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/away/suggest.md) | Candidate rules from the user's own sessions and PRs, asked for every run |

Setting up:

1. `npm install -g awaywork`; check `claude --version`, `codex --version`, `agent --version` (Cursor, which also needs `CURSOR_API_KEY` in the env file), `gh auth status`.
2. `awaywork init --yes` writes `~/.config/awaywork/config.yml` without a terminal: the installed providers, `github` when `gh` is logged in (repos `<login>/*`), the default queue and a 01:00-07:00 window. Override with `--provider claude codex` (first takes units first), `--source github asana` and `--window 23:00-06:00`. Asana is skipped with a note unless `ASANA_TOKEN` is set; then it takes the first workspace and every project with the user's tasks. Linear is likewise skipped unless `LINEAR_API_KEY` is set. Cursor counts as installed only with `CURSOR_API_KEY` set, and `--provider cursor` takes it anyway: where it's the only agent, `--yes` without either stops, naming the missing key. Jira is skipped: it needs a site and an email. It refuses to replace an existing config without `--force`. To go further, edit the file from [Configuration](./configuration.md) and the [reference](../reference/config.md). `awaywork sources asana --json` gives the Asana workspace and project gids and the real section names for `where`; `sources linear`, `sources jira` (once the config has its `site` and `email`) and `sources github` do the same for theirs, without you ever seeing the token.
3. Secrets go in `~/.config/awaywork/env` (`NAME=value` lines, mode 600), never in the config. They're the user's to put there, with `awaywork secret ASANA_TOKEN` (a hidden prompt; in Claude Code, `! pbpaste | awaywork secret ASANA_TOKEN` after copying it): don't ask for them in the chat, and don't read them from that file or other tools' files.
4. `awaywork doctor` until the config's line isn't `FAIL`. Its `gh login` and `<provider> login` lines name the account each run uses; on a machine with several, the config pins them ([Which login](./configuration.md#which-login)). Without a config it still lists each agent CLI: `ok` with its version, `warn` when it's not installed or, for Cursor, `CURSOR_API_KEY` is unset. `awaywork config path` prints the config file in use and exits 1 while it doesn't exist.
5. For the queue, follow the [skill](#codex-and-friends). `awaywork plan`, and show the user the result. When stdin and stdout are both a terminal, `plan` and `report` open an interactive view; piped (`| cat`) or with `CI` set, they print text.

What each command does:

| Command | Effect |
| --- | --- |
| `config path`, `config schema`, `skills list`, `skills list --json`, `report`, `schedule status` | Read-only, local |
| `plan`, `doctor` | Read-only on sources and forge; probe each provider's quota (one tiny model call for Claude) |
| `plan --rules`, `plan --rules --json` | Read-only on sources and forge; probes no provider |
| `sources [id]` | Read-only on sources; prints no token |
| `skills eject <name>` | Copies a skill into the user's skills dir |
| `run --dry-run` | Clones repos and writes workspaces; no agent, nothing pushed |
| `run`, `run --unit <id>`, `run --unit <id> --detach`, `run --unit <id> --skill <name>` | Runs agents on the user's quota; pushes branches and opens draft PRs. `--detach` returns once the unit has started; `--skill` runs a skill on an item no rule takes. Ask first. |
| `schedule install` | Installs a scheduled job, or writes a workflow with `--with github-actions`, or a container's files with `--with docker`. Ask first. |
| `init --yes` | Writes the config from detected defaults; `--force` replaces one |
| `secret <NAME>` | Writes the env file from a hidden prompt or a pipe; prints no value. The user runs it, not you |
| `init`, `config edit` | Interactive; need a terminal. `init` opens Claude Code on `/away` |

Machine-readable output:

- `awaywork plan --json` prints the plan as one object: `queue`, `defaultQueue`, `allowances` (per provider), `units`, `skipped` and `warnings`. Items leave out their raw source payload. Each skipped entry is `{ item, kind, reason }`, plus `url` when it waits on an awaywork PR for review: the PR to open, which may not be the item, or on an answer or an approval: the item awaywork asked or posted its plan on. Its `kind` is `waiting_for_review`, `waiting_for_answer`, `waiting_for_approval`, `invalid_plan`, `store_failed`, `all_tasks_done`, `gave_up`, `no_repo`, `invalid_branch`, `refused_delivery`, `unstackable`, `draft_moved` or `continue_cap` when the user can act to make it run (review the awaywork PR, answer awaywork's questions on the item, approve or fix its plan, fix the store that couldn't read a post's files back, close the card whose tasks are all done, read the failed logs, give the item a repo, fix the rule, finish, mark ready or close awaywork's draft that moved or that said `continue` 3 times), and `no_rule`, `over_cap`, `unchanged`, `skipped_by_you`, `fanned_out` (a card whose plan became tasks), `waiting_for_task` (a task waiting for another's PR to merge, or to open, or for a check on it to pass), `task_merged`, `task_done` (a task that reports, whose `done` result is on its card), `continues_later` (a `continue` a soon run leaves to the next window run) or `running` (another of the daemon's runs is working on it) when it's the config doing its job. The first group also has `needsYou: true`, so you can pick those out without the list. A card's `taskPrs` holds its tasks' PRs by task id, with `checks`, the state of each check a task's `after` names (`passed`, `pending` or `failing`; missing when not reported). A plan's task has `item.task`: its card as `parent`, its `id` and `skill`, `plan`, the plan's tasks with each one's `after` (`opened`, `merged` or a check's name), `repo` and `ships`, `contract` when the plan has one, and `onto`, the task whose PR it stacks on; its `item.fields.repo` is its own repo. A unit that goes on from an earlier run has `continued`, the times it said `continue` so far, and, on awaywork's own draft, `resume`: its `url`, `number`, `status` (`continue` or `ask`), `head`, the commit awaywork left it at, and `from`, the commit the draft's commits start after. A unit stacked on a PR another unit of the run opens has `after`, that unit's id, and one waiting for tasks in other repos to open their PR earlier in the run has `waitsFor`, their task ids.
- `awaywork skills list --json` prints `skills`, each `{ name, deliver, pickable }`: `deliver` is the delivery it defaults to, `pickable` whether `run --unit --skill` can run it on one item.
- `awaywork plan --rules --json` prints the queue against the items the sources return now: `rules`, each rule's `rule` number, `skill`, `summary`, the items it takes (`taken`, with `plan: true` on a card its `deliver: plan` rule keeps though its `where` no longer matches) and the ones it matches that another rule takes (`takenBy`, by that rule's number), then `defaultQueue`, `unmatched`, the items no rule takes, each with a `reason` naming the closest rule and the conditions it failed, and `warnings`. Items are references: `source`, `key`, `title` and `url`. It reads no quota, attempts or caps, so `plan --why <key>` says what a run would really do with an item. On a sandbox repo with one review rule:

  ```json
  {
    "rules": [
      {
        "rule": 1,
        "skill": "review",
        "summary": "type=pr review_requested=true trusted=true",
        "taken": [],
        "takenBy": []
      }
    ],
    "defaultQueue": false,
    "unmatched": [
      {
        "source": "github",
        "key": "AndreaProvenzale/awaywork-sandbox#134",
        "title": "Review smoke: fix the typo in README",
        "url": "https://github.com/AndreaProvenzale/awaywork-sandbox/issues/134",
        "reason": "matched no rule; closest #1 review: type is issue, wants pr; review_requested is unset, wants true"
      }
    ],
    "warnings": []
  }
  ```

- `awaywork sources [id] --json` prints one object keyed by source id, of what each one's credentials can see. A source with nothing to list (`bitbucket`, a custom one) is left out without an id and an error with one. A source that can't tell, say with its token unset, goes to stderr as `<id>: <why>` (naming the variable and the env file for a token) and makes it exit 1; without an id, the others still print. Asana before it's configured, from the test fixtures, trimmed to one workspace:

  ```json
  {
    "asana": {
      "workspaces": [
        {
          "gid": "100",
          "name": "Acme",
          "projects": [
            { "gid": "300", "name": "Platform" },
            { "gid": "301", "name": "Mobile" }
          ],
          "sections": ["QA", "In progress", "Current sprint", "Q3"]
        }
      ]
    }
  }
  ```

  `github` has `login` and `orgs`; `linear` `teams`, each with `key`, `name` and `states`; `jira` `projects` (`key`, `name`) and `statuses`.

- `awaywork doctor --json` prints the checks as an array of `{ status, what, detail }`, `status` being `ok`, `warn` or `FAIL`. It exits 1 when any check is `FAIL`, as without `--json`.
- `awaywork report --json` prints the run's results (`runId`, `dryRun`, `startedAt`, `finishedAt`, `plan`, `results`, `quotas`, `warnings`) as one object, read from the run's `report.json`. With no id it's the last run that has one (`report --unit` and `--skipped` pick the same), so a run still going, or one that died, doesn't take its place; with none at all, or an id of a run that has none, it exits 1. Items are references only: `source`, `key`, `title` and `url`, plus `type` and, when it's yours, `mine` on a skipped one. Skipped entries have a `kind` and `needsYou` as in `plan --json`, except in a run from before skips had kinds. Each step that started has `files`, paths relative to the run dir: `log`, `report` and `diff` (its own commits) from the step's folder, and on a slice's first step, which publishes it, `sliceBody` and `sliceDiff` from `out/` (`out-2/` for a stacked slice and so on), the PR body or push summary (the joined report when the slice published reports) and the commits it published, or would have if the publish failed. A key is there only when its file was. A run [from the runner](./scheduling.md#reports-from-the-runner) comes with only `report.md`, `report.json` and `units.json`, so check a path exists before opening it. `summary` is the first paragraph of `sliceBody`, else of `report`. The PR it opened or pushed onto is `outcome.url`. A `fix` that found nothing to commit, trimmed:

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
