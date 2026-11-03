---
name: away
description: "Use when the developer asks about awaywork, the CLI that runs coding agents on their items while they're away: its status, what ran or needs them, why an item did or didn't run, taking on or stopping some work, what it could take off their plate, or carrying on a unit it worked on. Covers its queue rules and suggesting them."
---

# awaywork

awaywork runs coding agents headless on the developer's items, picked by the `queue` rules in its config, and leaves draft PRs and reports. Docs: https://andreaprovenzale.github.io/awaywork/llms.txt

If your instructions start with `# awaywork worker`, you're one of awaywork's own workers: don't use this skill. No command tells, so don't run one to check.

## Ground rules

- **No credentials through you.** Never ask for, print, read or write a token, nor open `~/.config/awaywork/env`. A source that isn't configured or can't authenticate is the developer's to fix: tell them to run `awaywork init`, or to set the variable the error names in that env file, and wait.
- **Read freely, ask before acting, never run.** `report`, `plan` (`--why`, `--rules`, `--json`), `sources`, `doctor`, `skills list` and `config schema` only read. Ask first, saying what it does, before `skip <source:key>` (leaves the item alone in the coming runs, until `unskip` or `--until <date>`), `unskip <source:key>` (lets awaywork pick it up again) and `approve <source:key>` (replies approve on the plan the item waits on, or marks it approved for `approved: true` rules). Never `run`, `watch` or `schedule`: give the command.
- **Real names only.** Projects, sections and statuses come from `awaywork sources`, labels and repos from the items or the developer, never from a guess.
- **Check before writing.** The config changes only after `plan --rules --json` shows each rule takes what the developer described. Show them and wait for their yes; when they can't answer, write only the rules they asked for whose check holds no surprise, and say what you left out.
- **Widening is shown on its own,** as the [`queue`](../queue/SKILL.md#widening) skill says. awaywork's guardrails are not config: it never merges a PR, force-pushes, approves or touches someone else's branch, and writes only on the developer's own items. Don't look for a way around them.

Pass `--config <path>` to every command when the developer uses one; otherwise awaywork reads `$AWAYWORK_CONFIG`, then `~/.config/awaywork/config.yml`. `awaywork` not on PATH: tell them `npm i -g awaywork`. `--json` an unknown option: it's too old, `npm i -g awaywork@latest`.

## Route

`queue` and `suggest` are this plugin's other skills, hidden from the `/` menu: invoke them as skills, and read their `SKILL.md` only where there's no skill tool.

- **No request** (bare `/away`): `awaywork report --json`, then a few lines: when the last run finished, each unit's item (`results[].planned.unit.items`) with its PR (`outcome.url`) or `summary`, and the `plan.skipped` entries with `needsYou: true` (absent means not flagged), each with what unblocks it. Nothing else: no other skips, no warnings, unless they ask. No runs yet: say so. Only when they ask what's next, `awaywork plan --json` (it probes quota, so it's slower).
- **One item** ("why didn't X run", a key or URL): `awaywork plan --why <key>`. Not the rules' doing: say what unblocks it. The rules': invoke [`queue`](../queue/SKILL.md), from its Tweak section.
- **Offload, stop or tweak work**: invoke [`queue`](../queue/SKILL.md).
- **"What could you take off my plate?"**, or a yes to `queue`'s first-setup offer: invoke [`suggest`](../suggest/SKILL.md).
- **Continue a unit here**: `awaywork report --unit <n|key>` (`awaywork report <run-id> --unit …` for an older run, `report --list` names them) prints its links, steps, files and PR body or report. Check out its branch and carry on from what it left.
