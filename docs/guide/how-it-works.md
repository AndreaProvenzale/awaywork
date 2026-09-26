---
description: How a night runs, from items to units, the queue of rules, deduplication, quota ceilings and routing, the worker's workspace, and delivery as a draft PR or a report.
---

# How it works

```
collect ──> match ──> dedupe ──> budget ──> dispatch ──> publish ──> report
(sources)   (queue    (one unit  (quota     (workers,    (forge,     (morning
             rules ->  per        probes,    one per      no model)   report)
             skills)   feature)   caps)      unit)
└──────────────── foreman, no model call ────────────────┘
```

Only the workers call a model. Everything else is plain code you can
inspect with `nightshift plan` before a night.

## Items

A source returns your open items with facts about each: a `type` (`pr`,
`issue`, `task`) and source fields.

| Source | Items | Fields a rule can match |
|---|---|---|
| GitHub | PRs you authored, PRs awaiting your review, issues assigned to you, in the configured repos | `repo`, `label`, `author`, `mine`, `draft`, `checks` (`failing`, `pending`, `passing`), `unresolved_threads`, `review_requested` |
| Asana | Tasks assigned to you in a workspace, optionally some projects | `project`, `section`, `tags`, `repo` (from `project_repos`), `fields.<custom field>` |

## The queue

The queue is an ordered list of rules. Each item takes the **first** rule
it matches; an item that matches none is skipped. A rule names the
`skill` that does the work.

```yaml
queue:
  - skill: fix-ci
    where: { type: pr, mine: true, checks: failing }
  - skill: implement
    where: { type: issue, label: night-shift }
```

With no `queue` in the config, the default one applies, keeping only the
rules whose source is configured:

| # | Skill | Source | Where |
|---|---|---|---|
| 1 | `fix-ci` | GitHub | my PR, checks failing |
| 2 | `qa-feedback` | Asana | section `QA` |
| 3 | `address-review` | GitHub | my PR, unresolved threads |
| 4 | `review` | GitHub | my review requested |
| 5 | `continue` | Asana | section `In progress` |
| 6 | `plan` | Asana | section `Current sprint` |

`nightshift init` writes the queue out, with your real Asana section
names, so you can edit it.

## Units

Items that share a key or a linked PR (repo and branch) are one unit, one
piece of work on one feature, ranked at its best item's rule. An Asana
task linked to your PR becomes one unit with that PR.

- The unit works in its linked PR's repo, else the item's `repo` field;
  with neither it is skipped.
- A unit that links an open night-shift PR is skipped as **waiting for
  review**: night-shift doesn't stack work on work you haven't read.
- Units run one at a time, in queue order.

## Budget

Each provider gets a ceiling for tonight on its long window (the week for
Claude, the week or month for Codex). The ceiling is the lowest of:

- `used + per_night`, when `per_night` is set;
- `1 - reserve` (default reserve 10%);
- pacing: `used + (1 - reserve - used) / nights to reset`, so a night
  just before the reset may spend more than one just after.

A worker stops once the provider reports its long window past the ceiling
or its short (5 h) window past `session_max` (default 90%). Claude reports
quota during the run, so it stops mid-run; Codex is read after each run,
so it stops between units. A provider whose quota can't be read gets a
fixed `fallback` of units and turns per night.

## Routing

A rule's `provider` list, else the global `providers` order. The first
provider under its ceiling takes the unit. When a window fills, the next
unit goes to the next provider.

## The worker

Each unit runs in a fresh clone on a new branch cut from its base (your
PR's branch when it has one, else the default branch).

- `.nightshift/context/` holds the prefetched item: PR view, diff,
  unresolved threads and failed-check logs, or the issue or task with
  its comments.
- The skills go where the agent looks for them (`.claude/skills/`,
  `.agents/skills/`).
- The prompt is, in order: the fixed [harness](https://github.com/AndreaProvenzale/night-shift/blob/main/harness.md),
  the skill, then your instructions (global, per repo, in-repo
  `.night-shift/instructions.md`, per rule).
- The agent has no forge token and a `gh` config without a login.
- A turn cap bounds the run (200, or `fallback.turns` without a quota
  reading) and a watchdog stops it below 1.5 GB of free memory or 2 GB of
  disk, then kills every process it left behind.

## Delivery

| `deliver` | What happens |
|---|---|
| `draft_pr` | The worker commits and writes `.nightshift/out/pr.md` (first line the title). night-shift adds a `Night-shift: <run id>` trailer, pushes the new branch and opens a draft PR into your PR's branch, else the default branch. No `pr.md`, no publish. |
| `report` | The worker writes `.nightshift/out/report.md`; nothing is pushed. It goes into the morning report. |

`review` and `plan` default to `report`, every other skill to `draft_pr`;
a rule can override either. Every PR body ends with a footer naming
night-shift and the run, which is how the next plan recognises it.

## The morning report

`nightshift report` prints the last run: units done and skipped with the
reason, each provider's windows before and after against the ceiling, and
the report-only outputs. In GitHub Actions it lands in the job summary.
`nightshift report --list` lists recent runs with their units, draft PRs
and reports; `nightshift report <id>` prints one of them.
