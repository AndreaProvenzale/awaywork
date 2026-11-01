---
description: Ask a coding agent what awaywork did and why, and let it write your awaywork queue, with the Claude Code plugin or the skill it ships for Codex and friends, plus which commands are safe to run unattended and the machine-readable docs to read.
---

# With an AI agent

You know what you want off your plate: red CI on your PRs, the bugs QA bounces back. Turning that into `where` clauses means learning every source's field names and your tracker's exact spelling of `In Progress`. Let your coding agent do it: the `away` skill asks what you want offloaded, tries its rules on your real PRs, issues and tasks, shows you what each would take tonight, and writes only what you say yes to.

## Claude Code

```text
/plugin marketplace add AndreaProvenzale/awaywork
/plugin install awaywork@awaywork
/away
```

On Claude Code 2.1.275 or later, `/plugin install awaywork --marketplace AndreaProvenzale/awaywork` does the first two in one go. Third-party marketplaces don't auto-update by default: `/plugin marketplace update awaywork` pulls the latest skill, or turn auto-update on under `/plugin` > Marketplaces.

Bare `/away` opens a pane beside the chat, straight from `awaywork report --json`:

```text
awaywork · last run 06:10 · 1 PR · 5 need you  r: refresh p: plan

1: Needs you (5)  2: Last run (1)  3: Next run  4: Skipped (2)

acme/sandbox
  ▾ #169  Add codex model flag to the provider config      review PR
    waiting for review: awaywork PR is open
    o: open PR  s: skip
  #168  Round cart discounts to the cent                   review PR
  #167  Add toMinutes and toHours                          review PR
  #166  Split the checkout service                      approve plan
jira SHOP
  SHOP-12  Migrate billing webhooks                  answer question
```

It lands on the first tab with something in it. Next run stays empty until you press `p`: `awaywork plan` probes your quota (one Haiku call) and reads your forge, so it waits to be asked; `r` reads the last run again, and nothing else.

Items sit under their repo, or their tracker and project key, a line each: the ref, the title, and what the item asks of you (`review PR`, `answer question`, `approve plan`, `add repo`, ...) or why it waits (`no rule`, `over cap`, `skipped by you`, ...). Needs you lists a repo's items by that word, so the PRs to review sit together. A second line shows up only when the reason says more than the word, like the cap that's full.

One row is open at a time, with its whole reason and only the buttons it has. Click a row to open it: that's all the desktop app needs, where the prompt keeps the keyboard. In the terminal, Tab and the arrows go row to row, opening the one they land on, and its keys work right away:

- `o` opens its PR, issue or tracker item;
- `s` skips the item in the coming runs, or unskips one you skipped;
- `a` approves the plan the item waits on (`approve plan`), or, when one of your rules has `approved: true`, marks a last-run unit or a skipped item approved (`mark approved`);
- `h` (`ask Claude here`) hands a unit of the last run to this chat, which carries on from `awaywork report <run> --unit <id>`;
- `⏎` on an open unit of the last run, or its `read report`, reads `awaywork report <run> --unit <id>`. `/away why didn't <key> run?` gets the full `plan --why`, quota probe and all.

`s` and `a` ask `yes`/`no` under the row first (`y` or `n`), saying what they'll do, then mark the row `skipped`, `unskipped` or `approved` in place of its word: the rows are what the last run or `p` saw, so the next `p` is what shows the change. The pane never runs or schedules anything. No `awaywork` on your `PATH`, or one too old for `--json`, and it says so, with `npm i -g awaywork@latest`. Under `claude -p`, where nothing draws a pane, bare `/away` goes to the skill instead.

`/away` with anything after it goes to the skill; `/awaywork:away` works the same, for when another command already has the name. Say what you want in your own words, or ask about an item: `/away fix my PRs when CI goes red`, `/away why didn't acme/api#12 run last night?`. The skill:

- reads your config and learns real names with `awaywork sources --json`, so a section is spelled the way Asana spells it;
- drafts rules on a copy beside your config and runs `awaywork plan --rules --json` on it, showing you the items each rule takes now, the ones another rule takes first, and the near misses with the condition they failed;
- writes the rules you accept into your config, keeping your comments and layout, then runs `awaywork doctor --json`;
- starts a tweak from the item, with `awaywork plan --why <key>`, and shows the before and after.

What it won't do: see a token (credentials are `awaywork init`'s job, and `~/.config/awaywork/env` is off limits), start a run or install a schedule (it gives you the commands), skip, unskip or approve an item without asking, or turn on anything that lets awaywork write more, like `deliver: push`, `deliver: pr`, `on_done` or dropping `trusted`, without showing you the rule before and after. One you asked for by name it then writes; one you didn't waits for your yes.

Not sure what to hand over? `/away what could you take off my plate?` reads your recent agent sessions and PRs, with your say-so every time, and proposes the rules, routines and `AGENTS.md` lines for the work you already do by reflex, each checked on your real items: [Suggested rules](./suggest.md). The skill offers it once, on a first setup.

Asked to "fix my PRs when CI goes red, and implement my issues labelled skill-smoke" on a sandbox repo, it ran `sources`, tried the rules on a draft, hit `labels` (that's Linear's and Jira's field; GitHub's is `label`), fixed it from the config error, wrote the two rules under the existing one and ended with, trimmed:

```text
I added two rules to your queue and kept your existing review rule as rule 1. The config
passes `awaywork doctor`, and `plan --rules` on the real config takes the same items the
draft did.

| # | Rule                                                   | Takes now                               |
|---|--------------------------------------------------------|-----------------------------------------|
| 1 | review: PRs where your review is requested (unchanged) | nothing                                 |
| 2 | fix: your PRs with failing checks                      | nothing                                 |
| 3 | implement: your issues labelled `skill-smoke`          | `AndreaProvenzale/awaywork-sandbox#133` |

- Rule 2 is unproven. None of your PRs has red CI right now, so the rule takes nothing
  today. It will start taking PRs the next time CI goes red on one.
- Both new rules only open draft PRs. I left `deliver` unset. If you'd rather it push onto
  the branch, add `deliver: push` to rule 2, but that lets awaywork write more, so it needs
  your explicit yes.

To try it:
- `awaywork plan` previews the next run.
- `awaywork run --unit <id>` runs one unit, for example #133.
- `awaywork schedule install` sets up the schedule, if nothing is scheduled yet.
```

## Codex and friends

The same skills ship in the npm package, in `plugin/skills/`, in the [Agent Skills](https://agentskills.io) format. Codex reads the Claude Code marketplace too:

```sh
codex plugin marketplace add AndreaProvenzale/awaywork
codex plugin add awaywork@awaywork
```

It shows up in Codex's skill list as `awaywork:away`, next to `awaywork:queue` and `awaywork:suggest`, which it routes to; ask Codex to use it by name.

Any agent that loads skills from a folder can take it from the installed package instead, e.g. `~/.agents/skills`, which Codex reads as well:

```sh
mkdir -p ~/.agents/skills
for s in away queue suggest; do ln -s "$(npm root -g)/awaywork/plugin/skills/$s" ~/.agents/skills/$s; done
```

No skills support? Tell the agent to read `away/SKILL.md` and follow it.

## Prompt to paste

For a setup from scratch, before there's a config:

```text
Set up awaywork (https://andreaprovenzale.github.io/awaywork/llms.txt)
for me. Read the docs first. Find which of claude and codex I have
installed and logged in, and which GitHub repos I work on (gh). Ask me
which repos and which Asana workspace to include and how much quota a
run may use, then write the config, validate it and show me the plan.
If a source needs a token, tell me to run awaywork init instead of
asking me for it. Don't start a run or install a schedule until I say so.
```

## For agents

Machine-readable docs:

| URL | What |
| --- | --- |
| [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt) | Index of every page, as Markdown links |
| [`llms-full.txt`](https://andreaprovenzale.github.io/awaywork/llms-full.txt) | All pages in one file |
| `<page>.md` | Any page as Markdown, e.g. [`guide/configuration.md`](https://andreaprovenzale.github.io/awaywork/guide/configuration.md) |
| [`config.schema.json`](https://andreaprovenzale.github.io/awaywork/config.schema.json) | The config's JSON Schema; `awaywork config schema` prints the installed version's |
| [`away`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/away/SKILL.md) | The `/away` skill: status, why an item did or didn't run, and which skill handles the rest |
| [`queue`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/queue/SKILL.md) | Writing and checking rules on real items |
| [`suggest`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/suggest/SKILL.md) | Candidate rules from the user's own sessions and PRs, asked for every run |

Setting up:

1. `npm install -g awaywork`; check `claude --version`, `codex --version`, `gh auth status`.
2. `awaywork init --yes` writes `~/.config/awaywork/config.yml` without a terminal: the installed providers, `github` when `gh` is logged in (repos `<login>/*`), the default queue and a 01:00-07:00 window. Override with `--provider claude codex` (first takes units first), `--source github asana` and `--window 23:00-06:00`. Asana is skipped with a note unless `ASANA_TOKEN` is set; then it takes the first workspace and every project with the user's tasks. Linear is likewise skipped unless `LINEAR_API_KEY` is set. Jira is skipped: it needs a site and an email. It refuses to replace an existing config without `--force`. To go further, edit the file from [Configuration](./configuration.md) and the [reference](../reference/config.md). `awaywork sources asana --json` gives the Asana workspace and project gids and the real section names for `where`; `sources linear`, `sources jira` (once the config has its `site` and `email`) and `sources github` do the same for theirs, without you ever seeing the token.
3. Secrets go in `~/.config/awaywork/env` (`NAME=value` lines, mode 600), never in the config. They're the user's to put there, or to type into `awaywork init`: don't ask for them in the chat, and don't read them from that file or other tools' files.
4. `awaywork doctor` until the config's line isn't `FAIL`.
5. For the queue, follow the [skill](#codex-and-friends). `awaywork plan`, and show the user the result. When stdin and stdout are both a terminal, `plan` and `report` open an interactive view; piped (`| cat`) or with `CI` set, they print text.

What each command does:

| Command | Effect |
| --- | --- |
| `config schema`, `skills list`, `report` | Read-only, local |
| `plan`, `doctor` | Read-only on sources and forge; probe each provider's quota (one tiny model call for Claude) |
| `plan --rules`, `plan --rules --json` | Read-only on sources and forge; probes no provider |
| `sources [id]` | Read-only on sources; prints no token |
| `skills eject <name>` | Copies a skill into the user's skills dir |
| `run --dry-run` | Clones repos and writes workspaces; no agent, nothing pushed |
| `run`, `run --unit <id>` | Runs agents on the user's quota; pushes branches and opens draft PRs. Ask first. |
| `schedule install` | Installs a scheduled job, or writes a workflow with `--with github-actions`. Ask first. |
| `init --yes` | Writes the config from detected defaults; `--force` replaces one |
| `init`, `config edit` | Interactive; need a terminal |

Machine-readable output:

- `awaywork plan --json` prints the plan as one object: `queue`, `defaultQueue`, `allowances` (per provider), `units`, `skipped` and `warnings`. Items leave out their raw source payload. Each skipped entry is `{ item, kind, reason }`, plus `url` when it waits on an awaywork PR for review: the PR to open, which may not be the item, or on an answer or an approval: the item awaywork asked or posted its plan on. Its `kind` is `waiting_for_review`, `waiting_for_answer`, `waiting_for_approval`, `invalid_plan`, `all_tasks_done`, `gave_up`, `no_repo`, `invalid_branch`, `refused_delivery`, `unstackable`, `draft_moved` or `continue_cap` when the user can act to make it run (review the awaywork PR, answer awaywork's questions on the item, approve or fix its plan, close the card whose tasks are all done, read the failed logs, give the item a repo, fix the rule, finish, mark ready or close awaywork's draft that moved or that said `continue` 3 times), and `no_rule`, `over_cap`, `unchanged`, `skipped_by_you`, `fanned_out` (a card whose plan became tasks), `waiting_for_task` (a task waiting for another's PR to merge, or to open, or for a check on it to pass), `task_merged`, `task_done` (a task that reports, whose `done` result is on its card), `continues_later` (a `continue` a soon run leaves to the next window run) or `running` (another of the daemon's runs is working on it) when it's the config doing its job. The first group also has `needsYou: true`, so you can pick those out without the list. A card's `taskPrs` holds its tasks' PRs by task id, with `checks`, the state of each check a task's `after` names (`passed`, `pending` or `failing`; missing when not reported). A plan's task has `item.task`: its card as `parent`, its `id` and `skill`, `plan`, the plan's tasks with each one's `after` (`opened`, `merged` or a check's name), `repo` and `ships`, `contract` when the plan has one, and `onto`, the task whose PR it stacks on; its `item.fields.repo` is its own repo. A unit that goes on from an earlier run has `continued`, the times it said `continue` so far, and, on awaywork's own draft, `resume`: its `url`, `number`, `status` (`continue` or `ask`), `head`, the commit awaywork left it at, and `from`, the commit the draft's commits start after. A unit stacked on a PR another unit of the run opens has `after`, that unit's id, and one waiting for tasks in other repos to open their PR earlier in the run has `waitsFor`, their task ids.
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
- `awaywork report --json` prints the run's results (`runId`, `dryRun`, `startedAt`, `finishedAt`, `plan`, `results`, `quotas`, `warnings`) as one object, read from the run's `report.json`. Items are references only: `source`, `key`, `title` and `url`. Skipped entries have a `kind` and `needsYou` as in `plan --json`, except in a run from before skips had kinds. Each step that started has `files`, paths relative to the run dir: `log`, `report` and `diff` (its own commits) from the step's folder, and on a slice's first step, which publishes it, `sliceBody` and `sliceDiff` from `out/` (`out-2/` for a stacked slice and so on), the PR body or push summary (the joined report when the slice published reports) and the commits it published, or would have if the publish failed. A key is there only when its file was. A run [from the runner](./scheduling.md#reports-from-the-runner) comes with only `report.md`, `report.json` and `units.json`, so check a path exists before opening it. `summary` is the first paragraph of `sliceBody`, else of `report`. The PR it opened or pushed onto is `outcome.url`. A `fix` that found nothing to commit, trimmed:

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
