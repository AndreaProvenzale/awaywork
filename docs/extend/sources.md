---
description: How to add a work source such as a task tracker to awaywork, with the Source contract, fields for queue rules, prefetched context, init questions, discovery and contract tests.
---

# Adding a source

A source reads the developer's open work from a tracker, and what they finished lately when a rule asks. Adding one is a file in `src/sources/`, a line in the registry and a passing contract suite. [Sources](../sources.md) holds the research on which trackers can be read headless and how.

For a private tracker, or one you don't want to maintain in here, a [custom source](../guide/custom-sources.md) needs no code change: any command that prints your items as JSON.

## Rules for a source

- **It writes only when awaywork asks**, never on its own: `write` comments on or moves one of the user's own items, at a destination the config names, and awaywork has already checked the item is theirs and put its mark on a comment.
- **A personal token from an env var**, named in config (`token_env`), never stored in the config and never handed to the agent.
- **Only the user's items**: assigned to them, or awaiting their review. Set `mine: true` on the ones that are theirs, assigned to them or theirs by authorship; awaywork writes to no other.
- Plain REST or GraphQL with `fetch`; retry on 429 as `Retry-After` says.

## The contract

`src/core/types.ts`:

```ts
interface Source {
  id: string
  configSchema: ZodObject                  // strict; nested under sources.<id>
  fields: Record<string, ZodType>          // what `where` may match; `prefix.*` declares prefix.<any>
  link?: string | false                    // default PR link line, e.g. `Part of {key}`; false: none to configure
  secrets(cfg): string[]                   // env var names it reads
  items(cfg, ctx, since?): Promise<Item[]> // the user's open items, plus those finished since `since`
  prefetch(item, dir, ctx): Promise<void>  // write the context files the worker reads
  init?(ask: Ask, ctx): Promise<SourceSetup>   // its own `awaywork init` questions
  discover?(cfg, ctx): Promise<Discovery>      // read-only: what its credentials can see
  write?(cfg, item, write, ctx): Promise<{ before?, after? }>  // comment or move; the item's updated times around it
}
```

- **`Item`**: an opaque `id` and a human `key` (the tracker's own, like `ENG-12`), `type` `issue` or `task`, title, description, url, comments, and `fields` holding only keys declared in `fields`. Keep the raw payload in `raw`.
- **`state` and `closed`** go in `fields` on every item, without being declared: `state` is `open`, `merged` (PRs only) or `closed` (closed unmerged, done, canceled), and `closed` is the ISO time a finished item merged or closed. `since` is a `Date`, set only when some rule for the source can match a finished item: its lookback, the widest `closed: { newer_than }` among those rules or 7 days. Read finished items only then, with the tracker's own date filter (Jira `resolved >= -Nm`, Linear `completedAt`, Asana `completed_since`), never by paging through history. Without `since`, return open items only.
- **Fields** are what users write rules against, in the tracker's own names: `section: QA`, not a mapped status. Set `repo` when the tracker can say which repo an item's code lives in (Asana, Jira and Linear all read a `repo_map` option; reuse it); without a linked PR or a `repo` the item is skipped. Set `created` and `updated` (ISO timestamps) so a rule's `order` can sort the items.
- **Linked PRs**: the forge finds the user's PRs that carry the item's key in their branch or title, or the source's `link` line in their body. Set `link` on the source when the tracker links PRs by a phrase in their description (Linear's `Part of {key}`, Asana's `{url}`).
- **`prefetch`** writes `item.md` with the item and all its comments; it's all the worker will see.
- **`write`** gets `{ op: 'comment', body }` or `{ op: 'move', to }`. A move goes to the status, state, section or label named `to` in the tracker's words, ignoring case, and throws naming the ones there are when none matches. In that read right before the write, read the assignee too and throw `<key> is no longer yours` when the item isn't the user's any more: `mine` is from plan time. Return the item's `updated` as the tracker has it right before the write and right after, read back when the calls don't return it: awaywork records `after` only while `before` is the one it read, so its own change doesn't look new next run and nobody else's gets lost. Set `mine: true` on each comment the user wrote, unless the tracker says someone else edited it last: `isAwayworkComment` counts a comment as awaywork's only with its mark and `mine`. Tell the user's comments by the item's own assignee when items are read as assigned to them, rather than with one more call. Leave `write` out when the tracker can't be written to.
- **`init`** asks for what the config needs and returns real values for `where` fields (e.g. section names), so the starting queue uses them. Tokens go through `ask.secret`, which saves them to the env file.
- **`discover`** returns, read only, the names a config and `where` need: workspaces, projects, teams, statuses, as plain data (strings, lists of them, lists of records like it). `awaywork sources <id>` prints it, and calls it for an unconfigured source too, with only the schema's defaults in `cfg`: throw saying what to configure when the source can't do without it. Share its listing calls with `init`. Throw `unsetSecret(name)` from `core/poll.ts` for a missing token, so the command can say where to put it.

[`asana.ts`](https://github.com/AndreaProvenzale/awaywork/blob/main/src/sources/asana.ts) is the example to copy.

## Register it

```ts
// src/sources/index.ts
export const sources: Record<string, Source<any>> = { github, asana, mine }
```

Rules may then use `source: mine` and its fields; `doctor` rejects unknown `where` keys with the list of fields each source declares.

## Test it

- Fixtures shaped from the tracker's documented responses in `test/fixtures/<id>/`, a recorded `fetch`, and `sourceContract(source, rawConfig, env, ask, move)` from `test/contracts/source.contract.ts`, where `move` is where a source with `write` moves its first item.
- A `test/real-<id>.test.ts` against a live account, skipped unless its env is set; best when it seeds the items it checks and deletes them, like `test/real-github.test.ts`.
- Document the token's scope, including when the tracker has no read-only token, and the scope `write` needs.
