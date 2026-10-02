---
description: What unit and burn tests have not run for real yet, and the end-to-end pass before the first release.
---

# End-to-end pass before v1

What the unit tests and burn tests have not yet run for real, and the
pass that runs it before the first release. Results go to `lessons.md`,
with tags as in `providers.md`.

## Already run for real

From `lessons.md`:

- Claude: `implement` to draft PR, `review` to a report, and skipping an
  item that links an open night-shift PR.
- Codex: `review` to a report, stopped at its ceiling between units,
  the next unit re-routed to Claude.

## Only run against fakes or fixtures

| Area | Gap |
|---|---|
| Asana | Never read a live workspace (`real-asana.test.ts`), nor `project_repos`. |
| Linear | Never read a live workspace (`real-linear.test.ts`), nor `team_repos`; queries shaped from the documented schema, not replayed from real responses. |
| Jira | Never read a live site (`real-jira.test.ts`), nor `project_repos`, a scoped token or the gateway; fixtures shaped from the documented responses. |
| Skills | `fix-ci`, `address-review`, `qa-feedback`, `continue`, `plan` never ran. |
| Codex, `draft_pr` | Codex has only written reports, never pushed or opened a PR. |
| Claude ceiling | Never stopped mid-run: real units stayed below 1% of either window. |
| Scheduling | `schedule install` never fired a night; the `github-actions` workflow never ran on a runner (`timezone` is [C]). |
| Codex remote | Best effort by design (rotating `auth.json`). |
| Setup UX | `init`, `queue` and `config edit` never ran against real accounts. |
| Packaging | Never installed from a packed tarball; `harness.md` and `skills/` resolve from the package root (`src/config/paths.ts`). |

## Before starting

- `review_requested` needs a second GitHub account: nobody can request
  their own review. `address-review` can use review comments left on
  one's own PR.
- The workflow from `schedule install --with github-actions` calls
  `AndreaProvenzale/night-shift@v1` with the CLI's own version, and only a
  stable release moves `v1`: publish a release candidate first, and point
  `uses:` at its tag and `version` at its number in the test repo.
- A scheduled job runs the `claude` binary on `PATH`, with whichever
  login is active then, not a shell function or alias wrapping it.
- Back up `~/.codex/auth.json`.

## Setup

- A private sandbox repo, `AndreaProvenzale/night-shift-sandbox`: a
  small TypeScript project with a CI job that can be turned red, a PR
  template and agent instructions.
- An Asana project with sections `QA`, `In progress`, `Current sprint`,
  mapped to the sandbox in `project_repos`, and a token made only for
  these tests.
- A dedicated config passed with `--config`.

## Pass

### 1. Install and set up

- `pnpm build && npm pack`, install the tarball globally, then
  `nightshift --help`, `skills list` and `doctor` from outside this repo.
- `init` with real accounts (Claude and Codex, GitHub and Asana),
  `config check`, `queue` (reorder, save, comments kept), and
  `config edit` with a broken draft, which must be refused.

### 2. One unit per skill

Set up the item, read `plan`, then `run --unit <id>`.

| Skill | Item | Provider | Deliver |
|---|---|---|---|
| `fix-ci` | my PR, checks failing | Claude | draft PR |
| `address-review` | my PR, threads left on it | Codex | draft PR |
| `review` | PR with my review requested by a second account | Codex | report |
| `qa-feedback` | Asana task in `QA`, linked PR | Claude | draft PR |
| `continue` | Asana task in `In progress`, linked PR | Codex | draft PR |
| `plan` | Asana task in `Current sprint`, no PR, repo from `project_repos` | Claude | report |
| `implement` | assigned GitHub issue, no PR | Claude | draft PR |

For each unit, check:

- the context files in the run dir;
- the footer and the `Night-shift:` trailer;
- the PR body's claims, rerun on the branch;
- the next `plan` skipping the item as waiting for review.

### 3. Guardrails

- A branch that already exists on the remote is never pushed: the unit
  takes a `-2` suffix, or is skipped when a night-shift PR there names
  its item, and the push refuses it again.
- `deliver: report` pushes nothing.
- An extra skill telling the model to run `gh auth status` and push:
  both fail, nothing reaches the remote.
- A run killed before `pr.md` publishes nothing.

### 4. Budget and routing

- Claude's `session_max` set about 1% above the current session use and
  a long unit: killed mid-run, output kept, the next unit re-routed to
  Codex.
- Codex free costs 5–11% of the month per unit against a paced ~3% a
  night (`providers.md`): raise its `per_night` for the pass only.
- A provider without a quota reading: `fallback` caps units and turns.

### 5. Unattended

- `schedule install` with the night window a few minutes ahead: it
  fires, and `nightshift report` shows the night. A scheduled run outside
  the window does nothing.
- systemd and cron on a Linux VM or container, or ship them marked
  untested.
- `schedule install --with github-actions` in the sandbox,
  `workflow_dispatch`, then one scheduled night: `timezone`, disk cleanup, commit identity, the report in the
  step summary.
- Codex in Actions twice, recording what the rotated `auth.json` does
  to the second run.

### 6. A whole night

One `nightshift run --scheduled` with both providers and both sources.
Record it in `lessons.md` like the earlier burn tests, and retag the
[C]/[I] claims it settles in `providers.md` and `sources.md`.

## Then

Publish a release candidate first (`CONTRIBUTING.md`, "Releasing") so
step 5 installs from npm, and check the docs site against what the pass
found: every guide claim it settled or contradicted.
