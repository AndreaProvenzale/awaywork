---
description: Let your coding agent read your recent sessions and PRs, with your say-so every run, and suggest awaywork queue rules, routines and AGENTS.md lines for the work you already hand off by reflex, each checked on your real items.
---

# Suggested rules

CI goes red, you paste the failure into your agent. A review lands, you ask it to address the comments. Monday morning, you ask it to go through last week's errors. You've done each one so often you no longer notice, which is exactly why you'd never think to write a rule for it. `/awaywork:suggest` notices for you: it reads your recent agent sessions and your forge history, finds the work you keep doing right after the same kind of event or at the same time each week, and proposes it as queue rules, [routines](./configuration.md#routines) and fixes for the corrections you keep typing, each shown against the items it would take tonight.

## Run it

In Claude Code, with the [plugin](./agents.md#claude-code) installed:

```text
/awaywork:suggest
```

On a first setup, `/awaywork:queue` offers it once before asking what to offload. Codex and friends get the same skill from the npm package, at `plugin/skills/suggest/SKILL.md`, as in [Codex and friends](./agents.md#codex-and-friends).

## It asks first

Every run starts with three questions and a number, before it opens a single transcript:

- **Projects:** the repos in your config by default. Work and personal never mix: it reads only the folders you name, so your employer's sessions never feed your side project's queue, or the other way round.
- **Window:** the last 30 days by default.
- **Histories:** which agents' sessions. Your agent reading another vendor's sessions sends them to its vendor, and it says so: Codex sessions read by Claude go to Anthropic.
- **Size:** how many sessions and how many MB that is.

Nothing turns it on for good. Next time it asks again.

## What it reads

| Input | Where |
| --- | --- |
| Claude Code sessions | `~/.claude/projects/<folder>/*.jsonl`, and `$CLAUDE_CONFIG_DIR/projects/…` when that's set: both can hold sessions, counted once each |
| Codex sessions | `~/.codex/sessions/<yyyy>/<mm>/<dd>/*.jsonl` |
| Forge history | `gh`, read-only: your own PRs and issues, failed CI runs, reviews you gave. Not your replies on other people's threads: awaywork has nothing to do there that isn't commenting on someone's behalf |

It skips awaywork's own workers and every other headless session, subagent transcripts (they repeat their parent) and earlier suggest runs, or the counts would lie.

Months of transcripts are a lot of tokens, so it digests each session first, with a `jq` script that ships with the skill: the opening prompt, branch, folder and start time, the PR it worked on, and the correction signals that work in any language (a turn you interrupted, a tool call you rejected, you speaking up right after the agent edited files). Then it joins sessions to forge events (the session that started half an hour after CI failed on that PR's branch), clusters similar asks, and reads full sessions only for the clusters worth it, with subagents where your agent has them. It runs in your session, on your subscription, while you watch.

## What it turns into

| It found | It proposes |
| --- | --- |
| An event on your item, then the same ask | A queue rule: a `where` and a skill |
| The same ask at the same time each week | A routine and a rule on `source: routines`, with its cost in units a week |
| A correction every agent on the repo needs | A line in the repo's `AGENTS.md` (or `CLAUDE.md`), which helps your own sessions too |
| A correction only awaywork's workers need | A line in your awaywork `instructions` |
| A correction that's already written down and still made | A command instead of a second line: a [`verify`](./configuration.md#repos-and-instructions) like `pnpm lint` on the repo, or a command [gate](./configuration.md#gates) |

Anything your config or `AGENTS.md` already has shows as "already rule #1", not as a new idea. A pattern with no trigger awaywork can see ("when someone asks in Slack") is dropped. Then it drafts every rule and routine into a copy of your config and runs `awaywork plan --rules --json` and `awaywork doctor --json` on it, so each candidate comes with the real items it takes now, the near misses, and a routine's next occurrence.

## What you see

Pointed at awaywork's own repo, a month of its author's history, on a config with no `queue` yet, it went through 86 interactive Claude Code sessions (out of 163 files, the rest headless) and the repo's 143 PRs, 76 issues and 20 failed runs, then ended with, trimmed:

```text
Rules
  1  fix my red PRs                                  seen 5×   forge (+1 session)
     where: { type: pr, mine: true, checks: failing }   (already rule #1, default queue)
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
  Your prompts right after edits were "now do the next bit", not corrections.

Keep which? (e.g. 2, 3)
```

Plus a few lines under it: 2 patterns dropped because awaywork can't see what starts them, the draft keeps the 4 default rules as #1 to #4 since writing a `queue` replaces the default one, `doctor` passes on the draft, and neither new rule widens delivery. Its config, the repo and `AGENTS.md` were left alone. Not every month has a routine in it, and that's an answer too.

## You pick

Accept, tweak or decline each by number. Rules and routines you keep go through the queue skill's usual loop: drafted, checked on your items, written into your config keeping your comments, then `doctor`. An `AGENTS.md` line is a local edit you commit yourself. A rule that lets awaywork write more (`deliver: pending_review`, `pr`, `push`, `on_done`) gets its own yes, as in [the queue skill](./agents.md#claude-code). Nothing else is written.

What it won't do:

- quote your sessions: evidence is a count and a paraphrase, since sessions hold pasted tokens and secrets;
- touch the forge beyond reading;
- leave anything behind: its digests go in a temp dir it deletes;
- run in the background. The awaywork CLI never reads transcripts, and workers never see your history: only the session you started does.

## Running it again

There's no memory between runs, on purpose for now. What you accepted is in your config, so it comes back as "already rule #3". What you declined comes back as a fresh candidate next time. Nothing nudges you either: run `/awaywork:suggest` when your habits change, a new repo shows up, or you're curious what a month of your sessions says.
