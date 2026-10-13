---
description: What unit and burn tests have not run for real yet, and the end-to-end pass before the first release.
---

# End-to-end pass before the first release

What the unit tests and burn tests have not yet run for real, and the
pass that runs it before the first release. Results go to
[Real runs](./providers.md#real-runs), with tags as in `providers.md`.

## Already run for real

From [Real runs](./providers.md#real-runs):

- Claude: `implement` to draft PR, `review` to a report, and skipping an
  item that links an open awaywork PR.
- Codex: `review` to a report, stopped at its ceiling between units,
  the next unit re-routed to Claude.

## Only run against fakes or fixtures

| Area | Gap |
|---|---|
| Asana | Custom fields and dependencies (paid) never read live: `real-asana.test.ts` ran on a free plan only. |
| Jira | A scoped token never ran: one token passed on both the site and the gateway, so it is classic [I]. |
| Skills | `fix-ci`, `address-review`, `qa-feedback`, `continue`, `plan` never ran. |
| Codex, `draft_pr` | Codex has only written reports, never pushed or opened a PR. |
| Claude ceiling | Never stopped mid-run: no real Claude unit reached its ceiling. |
| Scheduling | `schedule install` never fired a run; the `github-actions` workflow never ran on a runner (`timezone` is [C]). |
| Codex remote | Not on GitHub-hosted runners; a self-hosted runner is untested. |
| Setup UX | `init`, `queue` and `config edit` never ran against real accounts. |
| Packaging | Never installed from a packed tarball; `harness.md` and `skills/` resolve from the package root (`src/config/paths.ts`). |

## Live source tests

Sources only read (`items`, `prefetch`, `init`), so each one can be
tested end to end without a provider: seed known items in a test
account, read them back through the source, check exact fields and
context files, then delete them. The seeding is the only code that
writes to the tracker. Each `test/real-<id>.test.ts` skips unless its
env is set; run one with `pnpm vitest run test/real-<id>.test.ts`.

| Source | Live test | Env |
|---|---|---|
| GitHub | Seeds an assigned, labelled issue with a comment, and a PR closing it with a file, a failing Actions job and a review thread of mine; checks fields, `linkedPrs`, every prefetched file, the job's log in `checks.md` and `init`. With a second account, a PR of theirs requesting my review: `review_requested`, `author`, `trusted`, `reviewers` | `AWAYWORK_GITHUB_SANDBOX` (`owner/name`), `gh` as its owner, or an admin of an org repo that allows deleting issues, with the `workflow` scope and Actions on; `AWAYWORK_GITHUB_REVIEWER_TOKEN`, optional, a token of another account with write access |
| Asana | Seeds two tasks of mine in a new section of a test project, tagged and due, one commented and blocked by the other; checks fields, `repo_map`, `item.md` and `init` | `ASANA_TOKEN`, `AWAYWORK_ASANA_WORKSPACE`, `AWAYWORK_ASANA_PROJECT` (a project gid there) |
| Linear | Seeds two issues assigned to me in a started state, one labelled, prioritized and commented, blocking the other; checks fields, `repo_map`, the prefetched `item.md` and `init` | `LINEAR_API_KEY` with Read and Write (or full access), `AWAYWORK_LINEAR_TEAM`: the key of a team its user belongs to |
| Jira | Seeds two issues assigned to me in a test project, one labelled, with a priority and a comment, blocking the other; checks fields, `repo_map`, `blocked`, `item.md` and `init` offering the real project and status | `JIRA_API_TOKEN`, `JIRA_SITE` (host), `JIRA_EMAIL`, `AWAYWORK_JIRA_PROJECT` (a key whose project has a `Task` type); `JIRA_CLOUD_ID` for a scoped token |
| Command | None needed: local and deterministic, the contract test runs `test/fixtures/command/items.mjs` | |

The GitHub test polls `items` until search indexes the seeded items and
the seeded job has failed on a hosted runner. Its PR deletes the
sandbox's own workflows and adds one that fails, so that job is the only
check; the reviewer's PR says `[skip ci]`. Each run leaves one closed
PR, two with a reviewer: GitHub cannot delete PRs. A cleanup that leaves
anything else behind, including the workflow run, fails the run, naming
what to delete by hand. Locally, the reviewer token is
`gh auth token --user <second account>`.

The Asana test also creates a section, a tag and, on a paid plan, a
custom field, then deletes them; deleted tasks stay in the token user's
trash for 30 days [V]. Its token writes, and an Asana personal access
token has no scopes: it acts with its user's full access [V], so use a
test account that can create and delete tasks, sections and tags in the
project. Dependencies (Starter and up) and custom fields are paid
features [V]; a free plan refuses both with a 402 [V], so the test logs
it and skips those checks.

Run the Linear test in a test workspace: `items` reads every open issue
assigned to the key's user, and its config cannot narrow that, so the
test checks only the seeded issues. It creates and deletes a team label
of its own, which a workspace that keeps labels to admins refuses [I].
A deleted issue sits in the trash for 30 days [C]; trashed issues
should not count against the free plan's 250 [I].

The Jira test runs twice, once per auth path: a classic token on the
site URL, then a scoped token with `JIRA_CLOUD_ID` on the gateway, where
`init` must find the same cloud id. Use a token made only for these
tests: it writes. A scoped one needs `read:jira-work`, `write:jira-work`
and `read:jira-user` (for `/myself`). In the project, its user needs
Create, Assign, Link and Delete issues, Add comments and Assignable
user, since the seeded issues are assigned to it; by default only
project admins may delete. Jira's search is eventually consistent, so it
polls like the GitHub test.

`real-pipeline.test.ts` needs the GitHub and Asana env and runs the CLI
from source on a config of its own: an issue labelled for an `implement`
rule and a task in a section it creates and deletes for `plan`. `plan
--json` must give each its unit, skill and deliver on `claude`, and `run
--dry-run --unit <key>` must leave its context file, prompt and skill in
the run dir. A PR of mine whose body carries the task's `link` then
links the task without skipping it; once the body also carries
awaywork's footer, `plan` skips the task as waiting for review. A
fake `claude` on `PATH` answers the quota probe with a recorded reading
and a dry run starts no worker, so nothing spends quota; `HOME` is a
temp dir, so state stays out of yours. Its PR commits with `[skip ci]`
and leaves one closed PR.

## Before starting

- `review_requested` needs a second GitHub account: nobody can request
  their own review. `address-review` can use review comments left on
  one's own PR.
- The workflow from `schedule install --with github-actions` calls
  `AndreaProvenzale/awaywork@v1` with the CLI's own version, and only a
  stable release moves `v1`: publish a release candidate first, and point
  `uses:` at its tag and `version` at its number in the test repo.
- A scheduled job runs the `claude` binary on `PATH`, with whichever
  login is active then, not a shell function or alias wrapping it.
- Back up `~/.codex/auth.json`.

## Setup

- A private sandbox repo, `AndreaProvenzale/awaywork-sandbox`: a
  small TypeScript project with a CI job that can be turned red, a PR
  template and agent instructions.
- An Asana project with sections `QA`, `In progress`, `Current sprint`,
  mapped to the sandbox in `repo_map`, and a token made only for
  these tests.
- A dedicated config passed with `--config`.

## Pass

### 1. Install and set up

- `pnpm build && npm pack`, install the tarball globally, then
  `awaywork --help`, `skills list` and `doctor` from outside this repo.
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
| `plan` | Asana task in `Current sprint`, no PR, repo from `repo_map` | Claude | report |
| `implement` | assigned GitHub issue, no PR | Claude | draft PR |

For each unit, check:

- the context files in the run dir;
- the footer and the `Awaywork:` trailer;
- the PR body's claims, rerun on the branch;
- the next `plan` skipping the item as waiting for review.

### 3. Guardrails

- A branch that already exists on the remote is never pushed: the unit
  takes a `-2` suffix, or is skipped when an awaywork PR there names
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
  run (`providers.md`): raise its `per_run` for the pass only.
- A provider without a quota reading: `fallback` caps units and turns.

### 5. Unattended

- `schedule install` with a window a few minutes ahead: it
  fires, and `awaywork report` shows the run. A scheduled run outside
  the window does nothing.
- systemd and cron on a Linux VM or container, or ship them marked
  untested.
- `schedule install --with github-actions` in the sandbox,
  `workflow_dispatch`, then one scheduled run: `timezone`, disk cleanup, commit identity, the report in the
  step summary.
- Codex on a self-hosted runner twice, recording what the refreshed
  `auth.json` does to the second run.

### 6. A whole run

One `awaywork run --scheduled` with both providers, GitHub and Asana.
Record it in [Real runs](./providers.md#real-runs) like the earlier
burn tests, and retag the [C]/[I] claims it settles in `providers.md`
and `sources.md`.

## Then

Publish a release candidate first (`CONTRIBUTING.md`, "Releasing") so
step 5 installs from npm, and check the docs site against what the pass
found: every guide claim it settled or contradicted.
