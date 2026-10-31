---
name: queue
description: "Set up or tweak the developer's awaywork queue: the rules that pick which of their PRs, issues and tracker tasks coding agents work on while they're away. Use when they want awaywork to take on or stop some kind of work, or ask why it did or didn't run on an item."
---

# awaywork queue

awaywork runs coding agents headless on the developer's items, picked by the `queue` rules in its config. Turn what the developer wants offloaded into rules, check them on their real items, and write only what they accept. Docs: https://andreaprovenzale.github.io/awaywork/llms.txt

## Ground rules

- **No credentials through you.** Never ask for, print, read or write a token, nor open `~/.config/awaywork/env`. A source that isn't configured or can't authenticate is the developer's to fix: tell them to run `awaywork init`, or to set the variable the error names in that env file, and wait.
- **No runs.** Never run `awaywork run`, `watch`, `schedule`, `approve`, `skip` or `unskip`; say the command instead.
- **Real names only.** Projects, sections and statuses come from `awaywork sources`, labels and repos from the items or the developer, never from a guess.
- **Check before writing.** The config changes only after the developer has seen what each rule takes and said yes.
- **Widening needs its own yes** (below). awaywork's guardrails are not config: it never merges, force-pushes, approves or touches someone else's branch, and writes only on the developer's own items. Don't look for a way around them.

Pass `--config <path>` to every command when the developer uses one; otherwise awaywork reads `$AWAYWORK_CONFIG`, then `~/.config/awaywork/config.yml`.

## Set up

1. **Find the config.** `awaywork` not on PATH: tell them `npm i -g awaywork`. No config: tell them to run `awaywork init` and come back. Read it, and the schema for the keys: its `$schema` line, or `awaywork config schema`. Queue rules are in https://andreaprovenzale.github.io/awaywork/guide/configuration.md#queue-rules.
2. **Ask what to offload,** in their words: "my PRs with red CI", "bugs in QA", "review requests from my team". Don't make them speak YAML.
   <!-- Hook: a "suggest rules from my history" step will be offered here. -->
3. **Learn the names.** `awaywork sources --json`, or `awaywork sources <id> --json`, prints one object keyed by source id: `github` `login` and `orgs`; `asana` `workspaces` with `gid`, `name`, `projects` (`gid`, `name`) and `sections`; `linear` `teams` with `key`, `name`, `states`; `jira` `projects` (`key`, `name`) and `statuses`. A source it can't read goes to stderr as `<id>: <why>` and exits 1; a missing token is the first ground rule. The fields a `where` takes differ per source (`label` on GitHub, `labels` on Linear and Jira): https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#items, and an unknown key's config error lists them.
4. **Draft on a copy.** Copy the config to `config.draft.yml` in the same folder (relative paths in it resolve from there) and edit the queue there. The first rule an item matches takes it, so order matters. With no `queue` key the default queue applies; a `queue` you write replaces it whole, so carry over the default rules the developer keeps. A rule looks like:

   ```yaml
   queue:
     - skill: fix # awaywork skills list
       source: github
       where: { type: pr, mine: true, checks: failing }
     - skill: implement
       source: jira
       where: { status: Ready, labels: awaywork }
   ```

5. **Check on real items.** `awaywork --config <draft> plan --rules --json` reads the sources and probes no provider. It prints:

   ```json
   {
     "queue": [{ "rule": 1, "skill": "fix", "summary": "source=github type=pr mine=true checks=failing", "taken": [{ "source": "github", "key": "acme/api#12", "title": "…", "url": "…" }], "takenBy": [{ "rule": 2, "items": [] }] }],
     "defaultQueue": false,
     "unmatched": [{ "source": "github", "key": "acme/api#9", "title": "…", "url": "…", "reason": "matched no rule; closest #1 fix: checks is passing, wants failing" }],
     "warnings": []
   }
   ```

   `taken` is what the rule runs on now, `takenBy` what it matches but another rule takes, `unmatched` what no rule takes, with the closest rule's failed conditions. A config error goes to stderr with exit 1: fix the draft and rerun. Show the developer, for each new or changed rule, the items it takes (key and title), the ones another rule takes, and the unmatched ones that sound like what they asked for, with the reason. Iterate until they agree. Nothing taken today isn't proof the rule is right: say so, and show the closest misses.

6. **Write.** Apply the accepted rules to the real config by editing only the lines that change: keep comments, order and style as you found them, and don't round-trip the file through a YAML library. Delete the draft.
7. **Validate.** `awaywork doctor --json` prints an array of `{ status, what, detail }`, `status` being `ok`, `warn` or `FAIL`, and exits 1 on any `FAIL`. A `FAIL` on the config (its `what` is the config's path) is yours to fix; one on a binary or a login is the developer's: say which and how. It probes each provider's quota, a tiny model call, so run it once here, not in the loop. Then rerun `plan --rules --json` on the real config and check it takes what the draft did.

## Tweak

Start from the item: "why did or didn't X run", "stop doing Y on Z".

1. `awaywork plan --why <key>`, with the key as `plan` shows it (`acme/api#12`, `ENG-12`, or `source:key`), says which rule plans it, or why it's skipped: `no_rule` with the closest rule and the condition that failed, or a kind such as `unchanged`, `over_cap`, `waiting_for_review`, `skipped_by_you`. It probes quota like `plan`. For a past run, `awaywork report --json`.
2. Not the rules' doing (skipped by them, waiting on their review or answer, a cap): say what unblocks it, e.g. `awaywork unskip <source:key>`, and stop.
3. Otherwise change the rule in a draft as above and show the before and after of `plan --rules --json`: the items each changed rule gains and loses. Then write and validate.

## Widening

A change that lets awaywork write more, or exposes the agent to more, is shown on its own as the rule before and after, with what it means, and is written only on a yes the developer gives after seeing that. Asking for the change is not the yes; when you can't ask, leave it out and say so. Widening is:

- `deliver: pr` (opens ready for review, pinging reviewers and code owners), `push` (pushes onto the developer's own PR branch), `pending_review` (leaves their pending review on the PR), `plan` (posts a plan on the item and waits for approval).
- `on_done`, or a wider one: posts the result on the item, moves it in the tracker.
- Dropping `trusted: true`, or `trusted: false`, on a rule over other people's PRs: the agent then reads untrusted authors' text.
- `mcp` servers, `secrets` or `isolation` changes.

New rules leave `deliver` unset (draft PRs) or use `report`, unless the developer asks.

## End

Summarize in a few lines: each rule added, changed or removed, by number and what it takes now; the widening changes they approved; doctor's result. Then the commands for them to run: `awaywork plan` to preview the next run, `awaywork run --unit <id>` to try one unit, `awaywork schedule install` if nothing is scheduled yet.
