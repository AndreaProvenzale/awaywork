# night-shift

Open-source CLI that schedules headless coding agents to spend idle
subscription quota. Read `README.md`, then `docs/`: `guide/` and
`extend/` for users and contributors, the rest is research and design.

## How we work

- **Simple beats clever.** The minimum that solves the problem. No option
  nobody asked for, no abstraction for single-use code.
- **Code speaks for itself.** Names carry the meaning; a comment is a
  one-liner explaining a why the code cannot.
- **Surgical diffs.** Every changed line traces to the task.
- **Vendor binaries only.** Never call a provider's backing API with a
  subscription credential; never store or proxy someone else's.
- **Guardrails are not negotiable.** Workers never force-push, merge,
  touch someone else's branch, or comment on someone's behalf. By default
  they push only branches that did not exist (named `night/<key>` unless
  configured); pushing to the developer's own branch is an explicit
  per-rule opt-in.
- **State what you checked, not what you believe.** A finding names its
  evidence; research tags claims [V]/[C]/[I] as in `docs/providers.md`.
- **No dates in docs.** Git history owns time.
- **Docs follow the code.** A change to the CLI or the config schema runs
  `pnpm build && pnpm docs:gen` and updates the guides it touches; CI
  fails on stale generated docs.
