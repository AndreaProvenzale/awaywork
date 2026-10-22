# Contributing

Read [AGENTS.md](AGENTS.md) first: it holds how we work, for people and coding agents alike. The config semantics every change keeps to are in the guides, [How it works](docs/guide/how-it-works.md) and [Configuration](docs/guide/configuration.md).

## Where things live

| Path | What |
| --- | --- |
| `src/core/` | The contracts between modules (`types.ts`) and the foreman: queue, units, budget, prompt, report |
| `src/sources/`, `src/providers/` | One adapter per file, plus the registry in `index.ts` |
| `src/forge/` | GitHub through `gh`: clone, find PRs, push, draft PRs |
| `src/worker/` | The workspace, the worker run, the watchdog and publishing |
| `src/config/`, `src/cli/`, `src/scheduler/` | Config schema and loading, one file per command, launchd/systemd/cron/Actions |
| `harness.md`, `skills/` | The fixed worker prompt and the built-in skills |
| `test/contracts/`, `test/fakes/` | Shared contract suites and the fakes they run against |

The `Provider` and `Source` contracts are spelled out in [docs/extend/providers.md](docs/extend/providers.md) and [sources.md](docs/extend/sources.md): a change to them updates those pages in the same PR.

## Setup

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm format      # Biome for code, Prettier for Markdown and YAML
pnpm docs:gen    # after a CLI or config schema change; CI fails on stale output
pnpm docs:dev    # the site at http://localhost:5173/awaywork/
```

Tests run against fakes and recorded fixtures. Tests against real accounts (`test/real-*.test.ts`) are skipped by default: provider tests unless `AWAYWORK_REAL=1`, source tests unless their env (token, test workspace or sandbox) is set; see below. `real-isolation.test.ts` needs `AWAYWORK_WORKER_TEST=1` and a Linux box with passwordless sudo where `scripts/worker-user.sh` made the worker user, as CI's `isolation` job does on a hosted runner. The script changes permissions all over the disk, so run it in a throwaway container or VM, not on your machine. `real-container.test.ts` needs `AWAYWORK_CONTAINER_TEST=<image>`, any image with a POSIX shell (`alpine` will do), and a Docker engine that sees your home, as CI's `container` job runs it.

## Live source tests

Sources only read (`items`, `prefetch`, `init`), so each one can be tested end to end without a provider: seed known items in a test account, read them back through the source, check exact fields and context files, then delete them. The seeding is the only code that writes to the tracker. Each `test/real-<id>.test.ts` skips unless its env is set; run one with `pnpm vitest run test/real-<id>.test.ts`.

| Source | Live test | Env |
| --- | --- | --- |
| GitHub | Seeds an assigned, labelled issue with a comment, and a PR closing it with a file, a failing Actions job and a review thread of mine; checks fields, `linkedPrs`, every prefetched file, the job's log in `checks.md` and `init`. With a second account, a PR of theirs requesting my review: `review_requested`, `author`, `trusted`, `reviewers` | `AWAYWORK_GITHUB_SANDBOX` (`owner/name`), `gh` as its owner, or an admin of an org repo that allows deleting issues, with the `workflow` scope and Actions on; `AWAYWORK_GITHUB_REVIEWER_TOKEN`, optional, a token of another account with write access |
| Asana | Seeds two tasks of mine in a new section of a test project, tagged and due, one commented and blocked by the other; checks fields, `repo_map`, `item.md` and `init` | `ASANA_TOKEN`, `AWAYWORK_ASANA_WORKSPACE`, `AWAYWORK_ASANA_PROJECT` (a project gid there) |
| Linear | Seeds two issues assigned to me in a started state, one labelled, prioritized and commented, blocking the other; checks fields, `repo_map`, the prefetched `item.md` and `init` | `LINEAR_API_KEY` with Read and Write (or full access), `AWAYWORK_LINEAR_TEAM`: the key of a team its user belongs to |
| Jira | Seeds two issues assigned to me in a test project, one labelled, with a priority and a comment, blocking the other; checks fields, `repo_map`, `blocked`, `item.md` and `init` offering the real project and status | `JIRA_API_TOKEN`, `JIRA_SITE` (host), `JIRA_EMAIL`, `AWAYWORK_JIRA_PROJECT` (a key whose project has a `Task` type); `JIRA_CLOUD_ID` for a scoped token |
| Command | None needed: local and deterministic, the contract test runs `test/fixtures/command/items.mjs` |  |

The GitHub test polls `items` until search indexes the seeded items and the seeded job has failed on a hosted runner. Its PR deletes the sandbox's own workflows and adds one that fails, so that job is the only check; the reviewer's PR says `[skip ci]`. Each run leaves one closed PR, two with a reviewer: GitHub cannot delete PRs. A cleanup that leaves anything else behind, including the workflow run, fails the run, naming what to delete by hand. Locally, the reviewer token is `gh auth token --user <second account>`.

The Asana test also creates a section, a tag and, on a paid plan, a custom field, then deletes them; deleted tasks stay in the token user's trash for 30 days [V]. Its token writes, and an Asana personal access token has no scopes: it acts with its user's full access [V], so use a test account that can create and delete tasks, sections and tags in the project. Dependencies (Starter and up) and custom fields are paid features [V]; a free plan refuses both with a 402 [V], so the test logs it and skips those checks.

Run the Linear test in a test workspace: `items` reads every open issue assigned to the key's user, and its config cannot narrow that, so the test checks only the seeded issues. It creates and deletes a team label of its own, which a workspace that keeps labels to admins refuses [I]. A deleted issue sits in the trash for 30 days [C]; trashed issues should not count against the free plan's 250 [I].

The Jira test runs twice, once per auth path: a classic token on the site URL, then a scoped token with `JIRA_CLOUD_ID` on the gateway, where `init` must find the same cloud id. Use a token made only for these tests: it writes. A scoped one needs `read:jira-work`, `write:jira-work` and `read:jira-user` (for `/myself`). In the project, its user needs Create, Assign, Link and Delete issues, Add comments and Assignable user, since the seeded issues are assigned to it; by default only project admins may delete. Jira's search is eventually consistent, so it polls like the GitHub test.

`real-pipeline.test.ts` needs the GitHub and Asana env and runs the CLI from source on a config of its own: an issue labelled for an `implement` rule and a task in a section it creates and deletes for `plan`. `plan --json` must give each its unit, skill and deliver on `claude`, and `run --dry-run --unit <key>` must leave its context file, prompt and skill in the run dir. A PR of mine whose body carries the task's `link` then links the task without skipping it; once the body also carries awaywork's footer, `plan` skips the task as waiting for review. A fake `claude` on `PATH` answers the quota probe with a recorded reading and a dry run starts no worker, so nothing spends quota; `HOME` is a temp dir, so state stays out of yours. Its PR commits with `[skip ci]` and leaves one closed PR.

## Adding things

- A provider: [docs/extend/providers.md](docs/extend/providers.md).
- A source: [docs/extend/sources.md](docs/extend/sources.md).
- A built-in skill: a folder in `skills/` with a `SKILL.md`; see [docs/guide/skills.md](docs/guide/skills.md).

A new provider or source claim tagged [C] or [I] needs a burn test before code depends on it.

## Releasing

Versions follow SemVer; while on 0.x a minor version may change the config. A tag `vX.Y.Z` publishes to npm as `latest`, `vX.Y.Z-rc.N` as `next`, and both create a GitHub release with generated notes (`.github/workflows/release.yml`). Generated workflows call the action (`action.yml`) at the tag of the version they install, so a fix to it reaches people when they run `schedule install` again: say so in the release notes.

`main` takes changes only through PRs, so a release starts as one that bumps the version:

```sh
npm version 0.1.0-rc.2 --no-git-tag-version
```

After it merges, tag the merge commit and push the tag:

```sh
git tag v0.1.0-rc.2 <merge-commit>
git push origin v0.1.0-rc.2
```

`release.yml` then tests, publishes to npm with provenance through trusted publishing (no token) and creates the GitHub release.
