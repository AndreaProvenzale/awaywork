# Design (draft)

Nothing is built yet. This is the shape carried over from the prototype
(`lessons.md`) and the provider research (`providers.md`).

## Shape

1. **Foreman**, no model call. Collects work units from sources, ranks
   them, reads each provider's quota and plans the night.
2. **Workers**, one per unit. Each runs a provider's stock CLI headless in
   a fresh clone, under a turn cap and the night's ceiling.
3. **Publisher**, no model call. Pushes `night/<branch>` and opens draft
   PRs; writes the morning report.

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
- Output defaults to a `night/<branch>` draft PR into the developer's
  branch. Pushing onto the developer's own branch is a per-rule opt-in
  (after v1). Never someone else's branch, never force, merge or comment.
- Resource watchdog and descendant kill on every worker.

## Decided

- TypeScript on Node, `commander` plus `ink`; YAML config with an ordered
  queue of rules. Details and milestones in `plan.md`.
- Routing: a rule's provider list, else the configured provider order;
  the first under its ceiling takes the unit.
- Quota allocation is config: a reserve, a cap per night, and a session
  ceiling, per provider.
- v1 runs locally and in CI only; vendor cloud schedulers are out.

## Open decisions

See `plan.md`, "Open decisions".
