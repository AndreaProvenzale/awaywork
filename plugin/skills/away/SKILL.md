---
name: away
description: "awaywork, the CLI that runs coding agents on the developer's PRs, issues and tasks while they're away: its status (the last run, its PRs, what needs them), why an item did or didn't run, setting up or tweaking the queue rules that pick its work, and suggesting rules from what they already do. Use when they mention awaywork, ask what ran or what needs them, why something did or didn't run, want it to take on or stop some work, ask what it could take off their plate, or want to carry on a unit it worked on."
---

# awaywork

awaywork runs coding agents headless on the developer's items, picked by the `queue` rules in its config, and leaves draft PRs and reports. Docs: https://andreaprovenzale.github.io/awaywork/llms.txt

Inside one of awaywork's own workers (your instructions start `# awaywork worker`, or `AWAYWORK_ITEM_KEY` is set): don't use this skill.

## Ground rules

- **No credentials through you.** Never ask for, print, read or write a token, nor open `~/.config/awaywork/env`. A source that isn't configured or can't authenticate is the developer's to fix: tell them to run `awaywork init`, or to set the variable the error names in that env file, and wait.
- **Read freely, ask before acting, never run.** `report`, `plan` (`--why`, `--rules`, `--json`), `sources`, `doctor`, `skills list` and `config schema` only read. Ask first, saying what it does, before `skip <source:key>` (leaves the item alone in the coming runs, until `unskip` or `--until <date>`), `unskip <source:key>` (lets awaywork pick it up again) and `approve <source:key>` (replies approve on the plan the item waits on, or marks it approved for `approved: true` rules). Never `run`, `watch` or `schedule`: give the command.
- **Real names only.** Projects, sections and statuses come from `awaywork sources`, labels and repos from the items or the developer, never from a guess.
- **Check before writing.** The config changes only after `plan --rules --json` shows each rule takes what the developer described. Show them and wait for their yes; when they can't answer, write only the rules they asked for whose check holds no surprise, and say what you left out.
- **Widening is shown on its own,** as [queue.md](queue.md#widening) says. awaywork's guardrails are not config: it never merges, force-pushes, approves or touches someone else's branch, and writes only on the developer's own items. Don't look for a way around them.

Pass `--config <path>` to every command when the developer uses one; otherwise awaywork reads `$AWAYWORK_CONFIG`, then `~/.config/awaywork/config.yml`. `awaywork` not on PATH: tell them `npm i -g awaywork`.

## Route

- **No request** (bare `/away`): `awaywork report --json`, then a few lines: when the last run finished, each unit's item (`results[].planned.unit.items`) with its PR (`outcome.url`) or `summary`, and the `plan.skipped` entries with `needsYou: true`, each with what unblocks it. Nothing else: no other skips, no warnings, unless they ask. No runs yet: say so. Only when they ask what's next, `awaywork plan --json` (it probes quota, so it's slower).
- **One item** ("why didn't X run", a key or URL): `awaywork plan --why <key>`. Not the rules' doing: say what unblocks it. The rules': follow [queue.md](queue.md#tweak).
- **Offload, stop or tweak work**: follow [queue.md](queue.md).
- **"What could you take off my plate?"**, or a yes to queue.md's first-setup offer: follow [suggest.md](suggest.md).
- **Continue a unit here**: `awaywork report --unit <n|key>` (`awaywork report <run-id> --unit …` for an older run, `report --list` names them) prints its links, steps, files and PR body or report. Check out its branch and carry on from what it left.
