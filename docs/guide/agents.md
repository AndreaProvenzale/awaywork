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

On Claude Code 2.1.275 or later, `/plugin install awaywork --marketplace AndreaProvenzale/awaywork` does the first two in one go. Third-party marketplaces don't auto-update by default: `/plugin marketplace update awaywork` pulls the latest skill, or turn auto-update on under `/plugin` > Marketplaces. `awaywork init` does all three from your shell: it offers the install (or loads the package's plugin for that one session on a no) and opens Claude Code on `/away set up awaywork`.

No config yet? `/away`, bare or with anything after it, sets awaywork up. It asks `awaywork config path` where the config goes, and the CLI's answer is the only place it looks: with [`AWAYWORK_REMOTE`](./scheduling.md#from-your-laptop) set, that's the server's config, so there's nothing to set up. A pane opens beside the chat on its [Config tab](#the-config-tab), empty until the draft exists. Then it looks around without asking: `awaywork doctor --json` for your agent CLIs, every gh account and the orgs it reaches, the login in each Claude Code folder (a shell function that switches `CLAUDE_CONFIG_DIR` counts), whether a job is already scheduled here, and the folders your Claude Code and Codex sessions ran in over the last 30 days, with the MCP servers set up for each, from metadata and config alone, mapped to repos by their git remotes. The rest comes in rounds of up to four multiple-choice questions, its pick first, every option built from what it found. The first round, renamed:

```text
←  ☐ Work  ☐ Claude login  ☐ Runs on  ✔ Submit  →

Whose GitHub work should this awaywork config take care of?

❯ 1. octocat (Recommended)
     Reaches octocat, widgets; ~215 sessions in these repos, mostly api (124) and site (41).
  2. octocat-acme
     Reaches acme; ~125 sessions across acme/app, acme/backend, acme/web and others.
  3. octocat-labs
     Reaches acme-labs; no sessions seen in those owners' repos.
  4. Type something.
```

The login tab offers each Claude Code folder with its account and plan (`$CLAUDE_CONFIG_DIR, Max 5x (Recommended)`, the one holding that work's sessions), and the next rounds ask for the repos, a tracker (an MCP server pointing at one is a hint), the window, the rules and whether to [suggest](./suggest.md) more from those sessions, with what it would read:

```text
←  ☐ My PRs  ☐ Reviews  ☐ Cards  ☐ Learn  ✔ Submit  →

Which work on your own PRs should awaywork take?

❯ 1. [ ] Fix red checks
         Pushes a draft PR stacked on your PR with the fix.
  2. [ ] Fix review threads
         Draft PR stacked on yours addressing open review comments, awaywork's own drafts included.
  3. [ ] Keep them up to date with main (widening)
         Pushes a merge of main onto your PR; a conflict gets resolved by a model and waits for your review.
```

Review requests are one pick (a report only you read, or your pending GitHub review, which widens what it writes), and if you hand over the sprint's cards, the round with your tracker's names asks how: plan then implement across repos, waiting for you only when a judge finds a product decision the card leaves open, or on every plan, or just a plan report.

The suggestions option says what it would read before it reads it: `Reads 124 Claude Code sessions (233.7 MB) in the api folder plus memories and your global CLAUDE.md; it goes to Anthropic.`

A tracker needs a token, and it never goes through the chat. The skill tells you to run `awaywork secret LINEAR_API_KEY`, which saves it in `~/.config/awaywork/env` (mode 600) and prints only that it did: in your own terminal it asks at a hidden prompt; in Claude Code, copy the token and type `! pbpaste | awaywork secret LINEAR_API_KEY`. Say done, and it reads your teams and statuses with `awaywork sources linear --json` and asks only which repo each team's code lives in.

The draft is `config.draft.yml` beside the config, rendered by `awaywork init --yes` right after the round that picks repos and a window, so you watch it fill in on the Config tab, and then edited: your repos, the gh account and Claude login it runs on, pinned as `sources.github.user` and `config_dir` wherever a scheduled job wouldn't find them on its own ([Which login](./configuration.md#which-login)), your tracker, and the rules you picked with your tracker's real status names. `awaywork plan --rules --json` shows what each rule takes now, and on your yes it becomes the config and `doctor` runs once:

```text
Rules (none takes anything today)
1. fix: your PRs with failing checks.
2. fix: your PRs with unresolved threads.
3. fix: your awaywork PRs with threads you started.
4. review: PRs where your review is requested, trusted authors.
5. implement: Linear NIG issues in In Progress.
6. plan: Linear NIG issues in Todo.

Commands for you to run (I never run these):
- awaywork plan previews the next run.
- awaywork run --unit <id> tries one unit.
- awaywork schedule install runs it in the window.
```

It left out the default `QA` rule, saying so: that team has no `QA` status.

With a config, bare `/away` opens a pane beside the chat, straight from `awaywork report --json`:

```text
☾ awaywork · last run 01:00 · 9 PRs · 14 need you
r: refresh p: plan
1: Needs you (14)  2: Last run (12)  3: Next run
4: Skipped (30)
──────────────────────────────────────────────────────────────
acme/shop  1/14                                      h: ‹ l: ›
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ ╭────────────────────────────╮
┃ #101             review PR ┃ │ #109               approve │
┃ Coupon codes with          ┃ │ Split the checkout service │
┃ per-customer limits        ┃ │                            │
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ╰────────────────────────────╯
o: open PR  s: skip

──────────────────────────────────────────────────────────────
Coupon codes with per-customer limits
waiting for review: awaywork PR is open
https://github.com/acme/shop/pull/401
```

It lands on the first tab with something in it, or on [Config](#the-config-tab) while a draft is waiting. Next run stays empty until you press `p`: `awaywork plan` probes your quota (one Haiku call) and reads your forge, so it waits to be asked; `r` reads the last run again, and nothing else.

A tab is a strip of cards, a page at a time: items under their repo, or their tracker and project key, and Needs you lists a repo's by what they ask of you, so the PRs to review sit together. A card has the ref and that word (`review PR`, `answer question`, `approve`, `add repo`, ...) or why the item waits (`no rule`, `over cap`, `skipped by you`, ...), then the title. The line above it says whose card you're on and where (`acme/shop  1/14`). Under the strip sit the card's buttons, and under the rule its detail: the title, the whole reason and the link. Every part keeps its height, so nothing jumps while you browse. The wheel over the cards steps through them; anywhere else it scrolls the detail. A pane too short for all that (a small window, or the pane above the prompt outside fullscreen) drops the fixed heights and scrolls as a whole.

`h` and `l` step card to card while the pane has the keyboard, as it does when it opens. Click a card and the strip takes every key: ←/→ (or Tab) move at once, ↑/↓ scroll the detail and the letters still press their buttons, until Esc hands the keyboard back to the prompt. That's how the desktop app gets keys too, where the prompt keeps them otherwise. In VS Code, click a card's ref to pick it; `h` and `l` work there too. The buttons are the card's own:

- `o` opens its PR, issue or tracker item;
- `s` skips the item in the coming runs, or unskips one you skipped;
- `a` (`approve`) approves the plan or result the item waits on, replying `approve` on it;
- `g` (`run now`) starts the item right away, in the background, with `awaywork run --unit <source:key> --detach`. It's on Next run's cards and on the skips that only the schedule was holding: `unchanged`, `skipped by you`, `over cap`, `gave up`. On a card no rule takes (`no rule`) it asks which skill first, one press from the row, `fix` preselected on a PR and `implement` on anything else, `b` to go back, then starts it with [`--skill`](./skills.md#run-one-on-an-item-no-rule-takes);
- `v` (`view report`) shows a last-run unit's `awaywork report <run> --unit <id>` in the detail, and `b` goes back. `/away why didn't <key> run?` gets the full `plan --why`, quota probe and all;
- `c` (`ask Claude here`) hands a unit of the last run to this chat, which carries on from `awaywork report <run> --unit <id>`.

`s`, `a` and `g` ask `yes`/`no` in place of the buttons first (`y` or `n`), saying what they'll do and whether there's an undo (`skip #101 in the coming runs? awaywork unskip undoes it`, `Run #109 now with fix? Draft PR, uses your quota.`), then mark the card `skipped`, `unskipped`, `approved` or `started` in place of its word: the cards are what the last run or `p` saw, so the next `p` is what shows the change. A `g` that can't start, the run lock taken or no provider for it, says why in the status line and leaves the card as it was. `g` is the only thing here that starts a run, and only on your press; the pane schedules nothing. Picking a skill goes through the same confirm (`Run #409 now with fix? Draft PR, uses your quota.`), and the skills it lists are `awaywork skills list --json`'s, so one only a repo carries isn't among them. No `awaywork` on your `PATH`, or one too old for `--json` or `config explain`, and it says so, with `npm i -g awaywork@latest`. Under `claude -p`, where nothing draws a pane, bare `/away` goes to the skill instead.

### The Config tab

Tab 5 is your config the way it reads to a human: the draft while there is one, else the file. No config yet, or a `config.draft.yml` waiting, and the pane lands here, with this as its only tab until the config exists. A config that lives behind [`AWAYWORK_REMOTE`](./scheduling.md#from-your-laptop) isn't on this machine, so there's no tab for it, just the run tabs.

```text
☾ awaywork · last run 01:00 · 9 PRs · 14 need you
r: refresh p: plan
1: Needs you (14)  2: Last run (12)  3: Next run
4: Skipped (30)  5: Config
──────────────────────────────────────────────────────────────
config.yml  ✓ valid                           f: flow  y: YAML
01:00–07:00 · claude · github · keeps 10% in reserve

    TAKES                                DOES
 1  my PRs, checks failing · 2           fix ▶ draft PR
 2  my PRs, your open threads            fix ▶ draft PR
 3  PRs, review requested, from tru… · 1 review ▶ report
▸4  issues, label sprint · 1             plan ▶ ◆ plan
 5  planned tasks                        implement ▶ draft PR

4. issues, label sprint
plan ▶ ◆ plan ▶ rule 5

Takes now
acme/shop#42  Coupon codes with per-customer limits

↑↓ rule  c: ask Claude  o: open config.yml:11
```

Each rule is one row: what it takes, in words, and what it does, `· 2` being what it takes right now, from a `plan --rules` in the background (it reads your sources and no quota). `◆` means the rule can stop for you: a plan that waits, `wait: true`, or a gate. Every skill keeps one color, the same on the cards of Last run and Next run (a card too narrow for the skill and a readable ref just drops the skill).

↑↓ moves between rules and redraws the flow under the table, loops included, with `f`, `y` and `d` flipping that to the YAML or the last write's diff. A pane too short for all of it lets the wheel and the page keys scroll it, and the arrows still step and bring the rule back into view. `c` asks Claude about the rule; `o` opens it at its line in VS Code, or the file if `code` isn't around. A draft that doesn't validate keeps the last good drawing, its problems on top.

No polling: the plugin watches the config's folder, and the chat's own writes to the draft land right away. That's why it runs `awaywork config path` at session start, with `mkdir -p` on that folder only when there's no config yet, so a first setup's files have somewhere to appear. A control folder picked during setup gets followed the moment Claude writes the draft there.

`/away` with anything after it goes to the skill; `/awaywork:away` works the same, for when another command already has the name. Say what you want in your own words, or ask about an item: `/away fix my PRs when CI goes red`, `/away why didn't acme/api#12 run last night?`. The skill:

- reads your config and learns real names with `awaywork sources --json`, so a section is spelled the way Asana spells it;
- drafts rules on a copy beside your config and runs `awaywork plan --rules --json` on it, showing you the items each rule takes now, the ones another rule takes first, and the near misses with the condition they failed;
- asks before writing, and on your yes writes the rules into your config, keeping your comments and layout, then runs `awaywork doctor --json`;
- starts a tweak from the item, with `awaywork plan --why <key>`, and shows the before and after.

What it won't do: see a token (you put one in with `awaywork secret <NAME>`, and `~/.config/awaywork/env` is off limits), start a run or install a schedule (it gives you the commands), skip, unskip or approve an item without asking, or turn on anything that lets awaywork write more, like `deliver: push`, `deliver: pr`, `on_done` or dropping `trusted`, without showing you the rule before and after. Nothing reaches your config without your yes in that session, a change you asked for by name included; a widening you didn't ask for gets its own question.

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
