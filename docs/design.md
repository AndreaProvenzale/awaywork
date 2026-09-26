---
description: "The shape of night-shift: foreman, workers and publisher, the provider adapter, work units, guardrails and the watchdog findings."
---

# Design

The shape carried over from the prototype (`lessons.md`) and the
provider research (`providers.md`); `plan.md` has the details.

## Shape

1. **Foreman**, no model call. Collects work units from sources, ranks
   them, reads each provider's quota and plans the night.
2. **Workers**, one per unit. Each runs a provider's stock CLI headless in
   a fresh clone, under a turn cap and the night's ceiling.
3. **Publisher**, no model call. Pushes a new branch and opens draft PRs;
   writes the morning report.

Runs the same locally (launchd, systemd, cron) and remotely (GitHub
Actions, a VPS, a container).

## Provider adapter

Each provider declares:

| Field | Values |
|---|---|
| `run` | how to invoke the stock binary headless |
| `credential` | `static` (secret) or `rotating` (file written back after each run) |
| `quota` | `window` (expires unused) or `credits` (monthly) |
| `probe` | how to read remaining quota, or none (fixed budget) |
| `unattended` | allowed, grey, forbidden (per ToS) |

The adapter never touches the backing API with a subscription credential
and never stores anyone else's.

## Work units

Sources state facts about each item (a PR with failing checks, an issue
with a label, a task in a section); an ordered queue of rules matches
those facts and names the skill that does the work. Built-in skills cover
the prototype's kinds (`ci_red`, `qa_feedback`, `review_comments`,
`review_requested`, `in_progress`, `plan`) and users can replace them.
One unit per feature, highest rule wins. Sources are pluggable: GitHub first, then
issue trackers through thin read-only adapters (`sources.md`).

## Guardrails

- The model gets no forge token; context is prefetched into files.
- Output defaults to a draft PR from a new branch into the developer's
  branch. Safety comes from pushing only branches that don't exist yet,
  never from the branch name, so the name can follow team conventions. Pushing onto the developer's own branch is a per-rule opt-in
  (after v1). Never someone else's branch, never force, merge or comment.
- Resource watchdog and descendant kill on every worker.

## Watchdog

Tags as in `providers.md`.

- Node cannot become a child subreaper: `prctl(PR_SET_CHILD_SUBREAPER)`
  needs a native addon [I]. A cgroup needs a delegated subtree or root,
  which a laptop run doesn't have [I]. So both platforms poll instead.
- Every 2 s the watchdog lists `ps -A -o pid=,ppid=,lstart=` and records
  each descendant of night-shift by pid and start time; at the end it
  kills those still alive with the same start time. A detached
  grandchild whose parent exited is killed this way [V, tested on macOS;
  the same test runs on Linux in CI]. A process born and orphaned
  between two polls escapes [I].
- Claude Code's background tasks stay children of `claude` while it
  runs, in their own session (`lessons.md`), so a poll sees them before
  they are orphaned [I].
- Memory is `process.availableMemory()`. On macOS it matched `vm_stat`
  free + inactive + speculative (45 GB against 44 GB), while
  `os.freemem()` counted free pages only (24 GB) [V, tested]. On Linux
  libuv reads `MemAvailable`, capped by the cgroup limit [C].
- Disk is `statfs` on the clone's filesystem [V].

## Decided

- TypeScript on Node, `commander` plus `@clack/prompts`; YAML config
  with an ordered queue of rules. Details and milestones in `plan.md`.
- Routing: a rule's provider list, else the configured provider order;
  the first under its ceiling takes the unit.
- Quota allocation is config: a reserve, a cap per night, and a session
  ceiling, per provider.
- v1 runs locally and in CI only; vendor cloud schedulers are out.
- Team conventions: night-shift fixes only what code must decide before
  the model runs, the branch name (a template, default `night/{key}`).
  PR title, body and commit style are the model's, taken from the repo
  (PR template, recent history) and the instructions. A footer on the PR
  body marks night-shift's own PRs.

## Open decisions

See `plan.md`, "Open decisions".
