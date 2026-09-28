---
description: How to add a coding-agent provider to night-shift, with the research it needs first, the Provider contract, the registry line, tests against a fake binary, and a burn test.
---

# Adding a provider

A provider wraps one vendor's agent CLI. Adding one is a file in
`src/providers/`, a line in the registry and a passing contract suite.

## Research first

Before code, add the provider to [Providers](../providers.md) with each
claim tagged **[V]** (vendor docs), **[C]** (community) or **[I]**
(inference), and settle these with a real run:

- It runs **headless** with the user's own subscription login, through
  the vendor's **unmodified binary**. night-shift never calls a backing
  API with a subscription credential; a provider that only works that way
  is out.
- The terms allow unattended use, or at least don't forbid it.
- Where its quota can be read, and what one unit costs.
- Where it looks for skills and project instructions.

Every [C] or [I] claim the code depends on needs a burn test, recorded in
[Lessons](../lessons.md).

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
  detect(): Promise<{ installed: boolean; version?: string }>
  probe(ctx): Promise<Quota | null>         // null = fixed budget (fallback)
  run(job: Job, signal: AbortSignal): AsyncIterable<WorkerEvent>
  skillsDir: string                         // where skills go in the clone
  instructionsFile: string                  // CLAUDE.md, AGENTS.md, …
}
```

- `run` spawns the binary in `job.dir` with `job.prompt`, under
  `job.maxTurns`, with the environment from `workerEnv()` (forge tokens
  removed). It yields `log` lines, `quota` whenever the stream reports
  one, and exactly one `done`. It stops when `signal` aborts.
- `probe` reads the windows as shares from 0 to 1, `short` for the ~5 h
  session and `long` for the week or month. Return `null` when the quota
  can't be read; night-shift then applies `fallback`.
- A turn cap the CLI lacks is enforced by counting tool calls and
  aborting, as `codex.ts` does.

[`claude.ts`](https://github.com/AndreaProvenzale/night-shift/blob/main/src/providers/claude.ts)
is the shortest example; [`codex.ts`](https://github.com/AndreaProvenzale/night-shift/blob/main/src/providers/codex.ts)
shows a rotating credential and a per-machine lock.

## Register it

```ts
// src/providers/index.ts
export const providers: Record<string, Provider> = { claude, codex, mine }
```

The config schema, `init`, `doctor`, `plan` and `schedule install --with github-actions` pick it up from
the registry.

## Test it

- A fake binary in `test/fakes/<id>.mjs` that replays recorded output from
  `test/fixtures/<id>/`, and `providerContract(yourProvider(fakeBin), job)`
  from `test/contracts/provider.contract.ts`.
- Unit tests for the event parser against the recorded streams.
- A `test/real-<id>.test.ts` that spends a few turns of a real
  subscription, skipped unless `NIGHTSHIFT_REAL=1`.

Then a burn test: one real unit with `nightshift run --unit`, recorded in
`lessons.md` with what the quota did.
