---
description: How to add a work source such as a task tracker to awaywork, with the Source contract, fields for queue rules, prefetched context, init questions and contract tests.
---

# Adding a source

A source reads the developer's open work from a tracker. Adding one is a
file in `src/sources/`, a line in the registry and a passing contract
suite. [Sources](../sources.md) holds the research on which trackers can
be read headless and how.

For a private tracker, or one you don't want to maintain in here, a
[custom source](../guide/custom-sources.md) needs no code change: any
command that prints your items as JSON.

## Rules for a source

- **Read only.** A source never writes back to the tracker.
- **A personal token from an env var**, named in config (`token_env`),
  never stored in the config and never handed to the agent.
- **Only the user's items**: assigned to them, or awaiting their review.
- Plain REST or GraphQL with `fetch`; retry on 429 as `Retry-After` says.

## The contract

`src/core/types.ts`:

```ts
interface Source {
  id: string
  configSchema: ZodObject                  // strict; nested under sources.<id>
  fields: Record<string, ZodType>          // what `where` may match; `prefix.*` declares prefix.<any>
  secrets(cfg): string[]                   // env var names it reads
  items(cfg, ctx): Promise<Item[]>         // the user's open items
  prefetch(item, dir, ctx): Promise<void>  // write the context files the worker reads
  init?(ask: Ask, ctx): Promise<SourceSetup>   // its own `awaywork init` questions
}
```

- **`Item`**: an opaque `id` and a human `key` (the tracker's own, like
  `ENG-12`), `type` `issue` or `task`, title, description, url, comments,
  and `fields` holding only keys declared in `fields`. Keep the raw
  payload in `raw`.
- **Fields** are what users write rules against, in the tracker's own
  names: `section: QA`, not a mapped status. Set `repo` when the tracker
  can say which repo an item's code lives in (Asana's `project_repos`);
  without a linked PR or a `repo` the item is skipped. Set `created` and
  `updated` (ISO timestamps) so a rule's `order` can sort the items.
- **Linked PRs**: the forge finds the user's PRs that carry the item's
  key in their branch or title, or the source's `link` line in their
  body. Set `link` on the source when the tracker links PRs by a phrase
  in their description (Linear's `Part of {key}`, Asana's `{url}`).
- **`prefetch`** writes one Markdown file (`task.md`, `issue.md`) with
  the item and all its comments; it's all the worker will see.
- **`init`** asks for what the config needs and returns real values for
  `where` fields (e.g. section names), so the starting queue uses them.
  Tokens go through `ask.secret`, which saves them to the env file.

[`asana.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/sources/asana.ts)
is the example to copy.

## Register it

```ts
// src/sources/index.ts
export const sources: Record<string, Source<any>> = { github, asana, mine }
```

Rules may then use `source: mine` and its fields; `config check` rejects
unknown `where` keys with the list of fields each source declares.

## Test it

- Fixtures shaped from the tracker's documented responses in
  `test/fixtures/<id>/`, a recorded `fetch`, and
  `sourceContract(source, rawConfig, env, ask)` from
  `test/contracts/source.contract.ts`.
- A `test/real-<id>.test.ts` against a live account, skipped unless its
  env is set; best when it seeds the items it checks and deletes them,
  like `test/real-github.test.ts`.
- Document the token's scope, including when the tracker has no
  read-only token.
