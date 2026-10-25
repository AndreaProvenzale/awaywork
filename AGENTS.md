# awaywork

Open-source CLI that schedules headless coding agents to spend idle subscription quota. Read `README.md`, then `docs/`: `guide/` and `extend/` for users and contributors, the rest is research.

## How we work

- **Simple beats clever.** The minimum that solves the problem. No option nobody asked for, no abstraction for single-use code.
- **Code speaks for itself.** Names carry the meaning; a comment is a one-liner explaining a why the code cannot.
- **Surgical diffs.** Every changed line traces to the task.
- **Vendor binaries only.** Never call a provider's backing API with a subscription credential; never store or proxy someone else's.
- **Guardrails are not negotiable.** Workers hold no write token and never pick where their work goes: awaywork does every write, where the config says. Nothing force-pushes, merges, approves, touches someone else's branch or item, or comments on someone's behalf: awaywork comments on and moves only items a rule matched as the developer's own, its comments marked as awaywork's, to where the config says. awaywork pushes only branches that did not exist (named `away/<key>` unless configured), unless a rule opts in to fast-forwarding the developer's own PR branch (`deliver: push`). A review it leaves (`deliver: pending_review`) stays the developer's pending one, which only they see until they submit it.
- **State what you checked, not what you believe.** A finding names its evidence; research tags claims [V]/[C]/[I] as in `docs/providers.md`.
- **Docs talk dev to dev.** Guides and the README are casual, a bit nerdy and generic ("Claude Code, Codex and friends"), and they show real output instead of describing it. Research docs stay dry and evidence-tagged.
- **Formatters own the layout.** Biome formats code, Prettier Markdown and YAML; Markdown prose is one line per paragraph. Run `pnpm format`; `pnpm lint` checks.
- **No dates in docs.** Git history owns time.
- **Docs follow the code.** A change to the CLI or the config schema runs `pnpm docs:gen` (from source, no build) and updates the guides it touches; CI fails on stale generated docs.
- **Branches only move forward.** Merge on green CI. Update a pushed branch by merging `main` into it; never rebase or force-push it.
