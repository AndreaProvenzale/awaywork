# Contributing

Read [AGENTS.md](AGENTS.md) first: it holds how we work, for people and
coding agents alike. The config semantics every change keeps to are in
the guides, [How it works](docs/guide/how-it-works.md) and
[Configuration](docs/guide/configuration.md).

## Where things live

| Path | What |
|---|---|
| `src/core/` | The contracts between modules (`types.ts`) and the foreman: queue, units, budget, prompt, report |
| `src/sources/`, `src/providers/` | One adapter per file, plus the registry in `index.ts` |
| `src/forge/` | GitHub through `gh`: clone, find PRs, push, draft PRs |
| `src/worker/` | The workspace, the worker run, the watchdog and publishing |
| `src/config/`, `src/cli/`, `src/scheduler/` | Config schema and loading, one file per command, launchd/systemd/cron/Actions |
| `harness.md`, `skills/` | The fixed worker prompt and the built-in skills |
| `test/contracts/`, `test/fakes/` | Shared contract suites and the fakes they run against |

The `Provider` and `Source` contracts are spelled out in
[docs/extend/providers.md](docs/extend/providers.md) and
[sources.md](docs/extend/sources.md): a change to them updates those
pages in the same PR.

## Setup

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm docs:gen    # after a CLI or config schema change; CI fails on stale output
pnpm docs:dev    # the site at http://localhost:5173/awaywork/
```

Tests run against fakes and recorded fixtures. Tests against real
accounts (`test/real-*.test.ts`) are skipped by default: provider tests
unless `AWAYWORK_REAL=1`, source tests unless their env (token, test
workspace or sandbox) is set; see
[docs/e2e.md](docs/e2e.md#live-source-tests).

## Adding things

- A provider: [docs/extend/providers.md](docs/extend/providers.md).
- A source: [docs/extend/sources.md](docs/extend/sources.md).
- A built-in skill: a folder in `skills/` with a `SKILL.md`; see
  [docs/guide/skills.md](docs/guide/skills.md).

A new provider or source claim tagged [C] or [I] needs a burn test before
code depends on it.

## Releasing

Versions follow SemVer; while on 0.x a minor version may change the
config. A tag `vX.Y.Z` publishes to npm as `latest`, `vX.Y.Z-rc.N` as
`next`, and both create a GitHub release with generated notes
(`.github/workflows/release.yml`). Generated workflows call the action
(`action.yml`) at the tag of the version they install, so a fix to it
reaches people when they run `schedule install` again: say so in the
release notes.

```sh
npm version 0.1.0-rc.1    # bumps package.json, commits, tags
git push --follow-tags
```

npm publishes through trusted publishing, without a token. It can only be
configured for a package that exists, so the very first version goes out
by hand: `npm version` as above, `pnpm build && npm publish --tag next`,
then still `git push --follow-tags`, since workflows find the action by
that tag (`release.yml` failing to republish it is fine). Then on
npmjs.com add the trusted publisher (this repo, workflow `release.yml`).
