---
description: How to add a coding-agent provider to awaywork, with the research it needs first, the Provider contract, the registry line, tests against a fake binary, and a burn test.
---

# Adding a provider

A provider wraps one vendor's agent CLI. Adding one is a file in `src/providers/`, a line in the registry and a passing contract suite.

Just want your own CLI in the rotation? A [command provider](../guide/configuration.md#bring-your-own-cli) needs no code, only a few lines of config. The rest of this page is for shipping a built-in.

## Research first

Before code, add the provider to [Providers](../providers.md) with each claim tagged **[V]** (vendor docs), **[C]** (community) or **[I]** (inference), and settle these with a real run:

- It runs **headless** with the user's own subscription login, through the vendor's **unmodified binary**. awaywork never calls a backing API with a subscription credential; a provider that only works that way is out.
- The terms allow unattended use, or at least don't forbid it.
- Where its quota can be read, and what one unit costs.
- Where it looks for skills and project instructions.

Every [C] or [I] claim the code depends on needs a burn test, recorded in [Real runs](../providers.md#real-runs).

## The contract

`src/core/types.ts`:

```ts
interface Provider {
  id: string
  configSchema: ZodObject                   // strict; `budget` is added to it
  credential: 'static' | 'rotating'         // a token, or a login file the CLI rewrites
  quota: 'window' | 'credits'               // expires unused, or monthly credits
  unattended: 'allowed' | 'grey' | 'forbidden'
  install?: { npm: string } | { script: string }  // how a GitHub-hosted runner gets the binary
  secrets: string[]                         // env var names it reads unattended
  unavailable?(env): string | undefined     // why it can't run here, if it can't
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx): Promise<Quota | null>         // null = fixed budget (fallback)
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  prepare?(job: Job): Promise<void>         // writes what run reads in the clone, first
  skillsDir?: string                        // where skills go in the clone; unset: job.plugin
  instructionsFile: string                  // CLAUDE.md, AGENTS.md, …
  bin?: string                              // the binary's name, when it isn't the id
  repoConfig?: string[]                     // clone files hidden on someone else's PR
}
```

- `run` spawns the binary in `job.dir` with `job.prompt`, under `job.maxTurns`, with `job.env` as its whole environment (`extendEnv: false`), forge tokens and other providers' and sources' secrets already removed. It yields `log` lines, `quota` whenever the stream has one, and exactly one `done`.
  - Spawn with `launch` (`src/core/launch.ts`), not `execa`: every process running repo code goes through it, so it gets the run's isolation. Pass `signal` as `cancelSignal`; `launch` closes the binary's output a second after it stopped, so a process that left its group can't keep your loop reading.
  - The binary reaches only `job.env`, the clone and `job.plugin`: on a GitHub-hosted runner it's another user with its own `HOME`, without the runner's home; under `isolation: container` a container of the repo's image mounting only the clone and `job.plugin`, with only the unit's secrets and the env names in `AWAYWORK_ENV`, so put a variable your provider sets on that list.
  - `job.config` is the provider's config entry, paths relative to `job.configDir`. Without a `skillsDir`, skills come as a plugin folder in `job.plugin`.
- `prepare` runs before each `run`, while the clone is still yours under every isolation (under `user` and `container` it's the worker's once `run` starts), so write files the binary reads here, like Cursor's `HOME` in `.away/agent-home`. `launch`'s `home` option then gives the binary that `HOME` whatever the isolation.
- `repoConfig` names clone files that make the binary run commands or allow it more, like `.cursor/hooks.json`: awaywork removes them on someone else's PR, git keeping the committed version, and for a gate's judge, since an agent wrote its clone, restoring them after the judge on your own PR.
- `probe` reads windows as shares from 0 to 1, `short` for the ~5 h session, `long` for the week or month; `null` when unreadable, and awaywork applies `fallback`.
- A turn cap the CLI lacks is enforced by counting tool calls and aborting, as `codex.ts` does.
- `install` is how the action puts the binary on a GitHub-hosted runner: an npm package joins its one `npm install -g`; a bash `script` runs as the runner's user, with sudo, before the worker user exists, as Cursor's does. Install outside the runner's home and nowhere the worker can write. Without `install`, a provider is `unavailable` there.
- `unavailable` returns a one-line reason where it can't run, as Codex and command providers on a hosted runner: `plan` and `run` route around it, `doctor` says why, and `schedule install --with github-actions` leaves it out.

[`claude.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/providers/claude.ts) is the shortest example; [`codex.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/providers/codex.ts) shows a rotating credential and a per-machine lock; [`cursor.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/providers/cursor.ts) a `HOME` of its own, written by `prepare`.

## Register it

```ts
// src/providers/index.ts
export const providers: Record<string, Provider> = { claude, codex, cursor, mine }
```

The config schema, `init`, `doctor`, `plan` and `schedule install --with github-actions` pick it up from the registry.

## Test it

- A fake binary in `test/fakes/<id>.mjs` that replays recorded output from `test/fixtures/<id>/`, and `providerContract(yourProvider(fakeBin), job)` from `test/contracts/provider.contract.ts`. A check that can't apply goes in its third argument, `exempt` (the command provider's config can't be empty, for one).
- Unit tests for the event parser against the recorded streams.
- A `test/real-<id>.test.ts` that spends a few turns of a real subscription, skipped unless `AWAYWORK_REAL=1`.

Then a burn test: one real unit with `awaywork run --unit`, recorded in [Real runs](../providers.md#real-runs) with what the quota did.
