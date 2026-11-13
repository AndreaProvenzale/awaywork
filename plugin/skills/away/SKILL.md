---
name: away
description: "Use when the developer asks about awaywork, the CLI that runs coding agents on their items while they're away: setting it up, its status, what ran or needs them, why an item did or didn't run, taking on or stopping some work, what it could take off their plate, or carrying on a unit it worked on. Covers its queue rules and suggesting them."
---

# awaywork

awaywork runs coding agents headless on the developer's items, picked by the `queue` rules in its config, and leaves draft PRs and reports. Docs: https://andreaprovenzale.github.io/awaywork/llms.txt

If your instructions start with `# awaywork worker`, you're one of awaywork's own workers: don't use this skill. No command tells, so don't run one to check.

## Ground rules

- **No credentials through you.** Never ask for, print, read or write a token, nor open `~/.config/awaywork/env`, and never ask them to paste one into the chat. A token a source lacks is the developer's to put in: `awaywork secret <NAME>`, with the variable the error names, saves it there. They run it in their own terminal, where it asks without echoing, or pipe it in from where they copied it: in Claude Code, `! pbpaste | awaywork secret <NAME>` once the token is on the clipboard. Wait, then retry what failed.
- **Read freely, ask before acting, never run.** `report`, `plan` (`--why`, `--rules`, `--json`), `sources`, `doctor`, `skills list`, `config path`, `config schema` and `schedule status` only read. Ask first, saying what it does, before `skip <source:key>` (leaves the item alone in the coming runs, until `unskip` or `--until <date>`), `unskip <source:key>` (lets awaywork pick it up again) and `approve <source:key>` (replies approve on the plan or result the item waits on). Never `run`, `watch`, `schedule install` or `schedule remove`: give the command.
- **Real names only.** Projects, sections and statuses come from `awaywork sources`, labels and repos from the items or the developer, never from a guess.
- **Check before writing.** The config changes only after `plan --rules --json` shows each rule takes what the developer described. Show them, then ask; a write waits for their yes in this session, however small or narrowing the change.
- **Widening is shown on its own,** as [`queue.md`](queue.md#widening) says. awaywork's guardrails are not config: it never merges a PR, force-pushes, approves or touches someone else's branch, and writes only on the developer's own items. Don't look for a way around them.

Pass `--config <path>` to every command when the developer uses one. `awaywork config path` prints the config it reads, exiting 1 when there's none: that answer is final, so never look for a config another way (`ls`, `cat`, the environment). `awaywork` not on PATH: tell them `npm i -g awaywork`. `--json` an unknown option, or `config path` an unknown command: it's too old, `npm i -g awaywork@latest`.

## Route

[`setup.md`](setup.md), [`queue.md`](queue.md), [`suggest.md`](suggest.md) and [`prove.md`](prove.md), beside this file, hold the longer routes: read the one a route names, whole, and follow it.

Every route starts with `awaywork config path`. Exit 1 with the line `<path> not found; awaywork init writes one`, whatever the request: read `setup.md`, which writes the config with them. Any other failure (`can't reach AWAYWORK_REMOTE`, say): show its line and stop. A path that isn't on this machine is the server's that `AWAYWORK_REMOTE` forwards to (https://andreaprovenzale.github.io/awaywork/guide/scheduling.md#from-your-laptop): the commands work as here, but the config isn't here to read: a rule change goes in the control repo's `.awaywork/config.yml` and a push, so say that rather than following `queue.md` or `suggest.md` for one.

- **No request** (bare `/away`): `awaywork report --json`, then a few lines: when the last run finished, each unit's item (`results[].planned.unit.items`) with its PR (`outcome.url`) or `summary`, and the `plan.skipped` entries with `needsYou: true` (absent means not flagged), each with what unblocks it. Nothing else: no other skips, no warnings, unless they ask. No runs yet: say so. Only when they ask what's next, `awaywork plan --json` (it probes quota, so it's slower).
- **One item** ("why didn't X run", a key or URL): `awaywork plan --why <key>`. Not the rules' doing: say what unblocks it. The rules': `queue.md`, from its Tweak section.
- **A post waiting for their decision** (`waiting_for_approval` in a report or plan, "waiting for your approval" in a why): a plan or result awaywork posted on the item or its thread. They answer with a reply there from their own account: first line `approve` goes on, anything else is feedback and the step runs again.
- **Offload, stop or tweak work**: `queue.md`.
- **Proof, evidence or QA of what awaywork ships** ("show me it works before I review"): `prove.md`, which writes the repo's own proving skill and its gates with them.
- **"What could you take off my plate?"**, or a yes to `queue.md`'s first-setup offer: `suggest.md`.
- **Continue a unit here**: `awaywork report --unit <n|key>` (`awaywork report <run-id> --unit …` for an older run, `report --list` names them) prints its links, steps, files and PR body or report. Check out its branch and carry on from what it left.
