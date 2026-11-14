---
description: Let your coding agent read your recent sessions and PRs, with your say-so every run, and suggest awaywork queue rules, routines and AGENTS.md lines for the work you already hand off by reflex, each checked on your real items.
---

# Suggested rules

CI goes red, you paste the failure into your agent. A review lands, you ask it to address the comments. Monday, you ask it to go through last week's errors. You do each so often you'd never think to write a rule for it.

`/away` notices for you, when you ask. It reads your recent agent sessions and forge history, finds the work you keep doing after the same kind of event or at the same time each week, and proposes queue rules, [routines](./config/sources.md#routines) and fixes for corrections you keep typing, each shown against the items it would take tonight.

## Run it

In Claude Code, with the [plugin](./away.md):

```text
/away what could you take off my plate?
```

With no config, `/away` sets awaywork up and asks whether your first rules should come from this, with the scope and size it would read; say yes and it doesn't ask again.

On a config with no queue, or only `init`'s default rules, it offers once before asking what to offload. It never needs a token: you add those with `awaywork secret <NAME>` ([/away in Claude Code](./away.md)). Codex and friends get the same skill from the npm package, in `plugin/skills/away/` ([Codex and friends](./agents.md#codex-and-friends)).

## It asks first

Every run starts with three questions and a number, before it opens a transcript:

- **Projects:** your config's repos by default. It reads only the folders you name, so work sessions never feed a side project's queue, or the reverse.
- **Window:** the last 30 days by default. Under 3 weeks it finds no routine, since a weekly habit needs 3 weeks, and says so.
- **Histories:** which agents' sessions and memories. Reading another vendor's sessions sends them to your agent's vendor, and it says so: Codex sessions read by Claude go to Anthropic.
- **Size:** how many sessions, MB and memory files that is.

Nothing turns it on for good: next time it asks again.

## What it reads

| Input | Where |
| --- | --- |
| Claude Code sessions | `~/.claude/projects/<folder>/*.jsonl`, and `$CLAUDE_CONFIG_DIR/projects/…` when set: both can hold sessions, counted once each |
| Codex sessions | `~/.codex/sessions/<yyyy>/<mm>/<dd>/*.jsonl`, or `$CODEX_HOME/sessions/…` when set |
| Agent memories | Claude Code's `~/.claude/projects/<folder>/memory/*.md` (and under `$CLAUDE_CONFIG_DIR`), your global `CLAUDE.md` and `rules/`; Codex's `~/.codex/AGENTS.md` and, with its memories feature on, probably `~/.codex/memories/` (named in the binary, checked on a real file first). A global file lends only lines that clearly apply to the repo |
| Forge history | `gh`, read-only: your PRs (who reviewed them, when), issues, failed CI runs, reviews you gave. Not your replies on others' threads: awaywork has nothing to do there that isn't commenting on someone's behalf |

It skips awaywork's workers and other headless sessions, subagent transcripts (they repeat their parent), Claude Code sessions Codex Desktop imported, and earlier suggest runs, or the counts would lie. Times become local before it looks for weekly habits, as a routine's `at` is local.

To spare tokens it first digests each session with a `jq` script shipped with the skill: opening prompt, branch, folder, start time, the PR, and language-independent correction signals (an interrupted turn, a rejected tool call, you speaking up right after an edit).

It joins sessions to forge events (a session half an hour after CI failed on that branch), clusters similar asks, and reads full sessions only for clusters worth it, with subagents where available. It runs in your session, on your subscription, while you watch.

## What it turns into

| It found | It proposes |
| --- | --- |
| An event on your item, then the same ask | A queue rule: a `where` and a skill |
| The same ask at the same time each week | A routine and a rule on `source: routines`, with its cost in units a week |
| A correction every agent on the repo needs | A line in the repo's `AGENTS.md` (or `CLAUDE.md`), which helps your own sessions too |
| A correction only awaywork's workers need | A line in your awaywork `instructions` |
| An ask to show a change works, after an agent's edits | Your repo's own [proving skill](./workflows/proving.md) and its gates, written with you |
| A correction already written down and still made | A command instead: a [`verify`](./config/repos.md#repos-and-instructions) like `pnpm lint`, or a command [gate](./workflows/gates.md) |

A saved memory can be a correction you already wrote down, which awaywork's Claude Code workers never see: they start with auto-memory off and none of your user-level config (Codex workers do read `~/.codex/AGENTS.md` under `isolation: none`). It reads the memory index, types and descriptions first, and opens only your feedback and notes stating a rule about the repo, not progress logs. One that holds for the repo becomes an `AGENTS.md` or `instructions` line; one about you doesn't.

With a rule that implements and no proving skill on it, it proposes one whether or not it saw the pattern, and asks how a change is proven in that repo before writing a line: it names no tool.

Anything your config or `AGENTS.md` already has shows as "already rule #1". A pattern with no trigger awaywork can see ("when someone asks in Slack") is dropped. Then it drafts the rules and routines into a copy of your config and runs `awaywork plan --rules --json` and `doctor --json` on it, so each comes with the items it takes now, the near misses, and a routine's next occurrence.

## What you see

On one developer's repo, a month of history, a config with the 4 rules `init` wrote: 86 interactive Claude Code sessions (of 163 files, the rest headless), 143 PRs, 76 issues and 20 failed runs, ending with, trimmed:

```text
Rules
  1  fix my red PRs                                  seen 5×   forge (+1 session)
     where: { type: pr, mine: true, checks: failing }   (already rule #1)
     takes now: nothing

  2  review my own green PRs before I merge them     seen 12×  sessions
     where: { type: pr, mine: true, ours: false, checks: passing }   skill: review   deliver: report
     → rule #5 in the draft. Merging stays with you; awaywork never merges.
     takes now: nothing. #355 and #356 match, but rule #2 (fix unresolved threads) takes them first.

  3  plan my issues before I pick them up            seen 8×   sessions
     where: { type: issue, label: { not: awaywork } }   skill: plan   deliver: report
     → rule #6 in the draft
     takes now: #216, #167, #155, #154, #131, #119, #64 (7 units, about 2 runs at the
     4-unit fallback; an issue isn't planned again unless it changes)

Routines
  None. No ask came back at the same weekday and hour in 3 or more weeks.

Corrections
  None repeated. Only one session had interrupted turns or rejected tool calls (2 each).

Keep which? (e.g. 2, 3)
```

Below it: 2 patterns dropped for having no visible trigger, the draft keeping the 4 rules `init` wrote as #1 to #4, `doctor` passing, neither rule widening delivery. Config, repo and `AGENTS.md` untouched. A month without a routine is an answer too.

## You pick

Accept, tweak or decline each by number. Kept rules and routines go through the skill's queue loop: drafted, checked on your items again, written into your config on your yes, comments kept, then `doctor`. An `AGENTS.md` line is a local edit you commit. A rule that lets awaywork write more (`pending_review`, `pr`, `push`, `on_done`) gets its own yes, as when [you write rules with it](./away.md). Nothing else is written. It won't:

- quote your sessions or memories: evidence is a count and a paraphrase, since sessions hold pasted secrets;
- touch the forge beyond reading;
- leave anything behind: digests go in a temp dir it deletes;
- run in the background. The CLI never reads transcripts and workers never see your history: only the session you started does.

## Running it again

There's no memory between runs, on purpose for now. What you accepted comes back as "already rule #3"; what you declined comes back as a fresh candidate. Nothing nudges you: ask again when habits change or a new repo shows up.
