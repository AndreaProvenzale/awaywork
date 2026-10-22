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
  package: string                           // npm package with the binary, for runners
  secrets: string[]                         // env var names it reads unattended
  unavailable?(env): string | undefined     // why it can't run here, if it can't
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx): Promise<Quota | null>         // null = fixed budget (fallback)
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  skillsDir?: string                        // where skills go in the clone; unset: job.plugin
  instructionsFile: string                  // CLAUDE.md, AGENTS.md, …
}
```

- `run` spawns the binary in `job.dir` with `job.prompt`, under `job.maxTurns`, with `job.env` as its whole environment (`extendEnv: false`): awaywork has already removed the forge tokens and the other providers' and sources' secrets. It yields `log` lines, `quota` whenever the stream reports one, and exactly one `done`. It stops when `signal` aborts. `job.config` is the provider's entry in the config, its paths relative to `job.configDir`; without a `skillsDir`, the unit's skills come as a plugin folder in `job.plugin`. Spawn the binary with `launch` (`src/core/launch.ts`), not `execa`: every process that runs repo code starts through it, so it gets the isolation the run is under. On a GitHub-hosted runner that's another user with its own `HOME`, which reaches `job.env`, the clone and `job.plugin`, not the runner's home; under `isolation: container` it's a container of the repo's image, which mounts only the clone and `job.plugin` and gets only the unit's secrets and the env names in `AWAYWORK_ENV` (`src/core/launch.ts`), so a variable your provider sets for its binary goes on that list. Pass what the binary needs through those.
- `probe` reads the windows as shares from 0 to 1, `short` for the ~5 h session and `long` for the week or month. Return `null` when the quota can't be read; awaywork then applies `fallback`.
- A turn cap the CLI lacks is enforced by counting tool calls and aborting, as `codex.ts` does.
- `unavailable` returns a one-line reason where the provider can't run, as Codex on a GitHub-hosted runner: `plan` and `run` route around it, `doctor` says why, and `schedule install --with github-actions` leaves it out of the workflow.

[`claude.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/providers/claude.ts) is the shortest example; [`codex.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/providers/codex.ts) shows a rotating credential and a per-machine lock.

## Register it

```ts
// src/providers/index.ts
export const providers: Record<string, Provider> = { claude, codex, mine }
```

The config schema, `init`, `doctor`, `plan` and `schedule install --with github-actions` pick it up from the registry.

## Test it

- A fake binary in `test/fakes/<id>.mjs` that replays recorded output from `test/fixtures/<id>/`, and `providerContract(yourProvider(fakeBin), job)` from `test/contracts/provider.contract.ts`. A check that can't apply goes in its third argument, `exempt` (the command provider has no npm `package`, for one).
- Unit tests for the event parser against the recorded streams.
- A `test/real-<id>.test.ts` that spends a few turns of a real subscription, skipped unless `AWAYWORK_REAL=1`.

Then a burn test: one real unit with `awaywork run --unit`, recorded in [Real runs](../providers.md#real-runs) with what the quota did.
