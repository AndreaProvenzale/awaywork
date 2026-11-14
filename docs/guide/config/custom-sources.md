---
description: Plug any task tracker into awaywork with a command that prints your open items as JSON, in any language, locally or on GitHub Actions.
---

# Custom sources

Your tracker isn't built in, an internal board say? Write a command, in any language, that prints your open items as JSON, and awaywork treats it like any other source.

## Config

```yaml
repos:
  acme/*:                               # an item in any other repo is skipped
sources:
  github: {}
  board:                                # any name; rules use it as `source: board`
    command: python3 sources/board.py   # runs in the config file's folder
    fields: [column, board]             # what `where` may match on; `any` is reserved
    secrets: [BOARD_TOKEN]              # env vars the command reads
    setup: pip install -r sources/requirements.txt   # GitHub Actions and awaywork's image only
    link: "Refs {key}"                  # optional: the line that links a PR, see below

queue:
  - skill: fix
    source: board
    where: { column: QA }
  - skill: implement
    source: board
    where: { column: In progress }
```

`init` writes no rules for custom sources: write yours.

## Output

The command prints a JSON array to stdout; its stderr shows when it fails.

```json
[
  {
    "id": "8812",
    "key": "AI-42",
    "title": "Export invoices as CSV",
    "url": "https://board.example/cards/AI-42",
    "description": "Users want a CSV export.",
    "comments": [{ "author": "qa", "body": "Header row missing", "at": "2026-01-02T10:00:00Z" }],
    "fields": { "column": "QA", "repo": "acme/api", "updated": "2026-01-02T10:00:00Z" }
  }
]
```

| Key |  |
| --- | --- |
| `id`, `key`, `title`, `url` | Required. `key` is the tracker's own reference; branch names use it, and your PRs are matched by it |
| `type` | `task` (default) or `issue` |
| `description`, `status`, `assignee`, `reviewers`, `labels`, `comments` | Optional. A comment may say `"mine": true` when your own account wrote it |
| `state`, `closed` | Optional: `open` (default) or `closed`, and the ISO time it closed; see [Finished items](#finished-items) |
| `fields` | Strings, numbers, booleans or lists of them. Every key must be listed in `fields` in the config, except `repo`, `created` and `updated` |
| `context` | Optional Markdown the worker reads instead of `description`: attachments, linked specs, whatever helps |

- **`fields.repo`** (`owner/name`) is where the code lives. Without it, a task is picked up only with a linked PR of yours, an issue never.
- **`link`**, in the config, is the line that [links a PR](./repos.md#linking-prs) in your tracker's words, from `{key}`, `{id}` and `{url}`, no default: awaywork writes it into its drafts and links your PRs whose body holds it, besides the key in branch or title.
- **`created` and `updated`** are ISO timestamps, which `order` sorts by.
- The command is killed after 10 minutes.

## Finished items

When a rule names [`state`](./queue-rules.md#finished-items), the command gets `AWAYWORK_CLOSED_SINCE`, the lookback's ISO start (`2026-10-11T09:30:00.000Z`), and may print items closed since, with `"state": "closed"` and `"closed"` set to when. Without it, print open items only, or all and the rules ignore the closed ones.

```js
// board.mjs: open cards, and those done since the lookback when a rule asks
const since = process.env.AWAYWORK_CLOSED_SINCE
const cards = await fetchCards() // your tracker's API
const items = cards
  .filter((c) => !c.doneAt || (since && c.doneAt >= since))
  .map((c) => ({
    id: c.id,
    key: c.ref,
    title: c.title,
    url: c.url,
    ...(c.doneAt && { state: 'closed', closed: c.doneAt }),
  }))
console.log(JSON.stringify(items))
```

`state` and `closed` are every item's own keys, so `fields` can't list them: print a tracker field called `state` under another name. A top-level `state` other than `open` or `closed`, or a non-ISO `closed`, is ignored with one warning naming the first such item, so an old command printing GitLab's `"state": "opened"` keeps working.

## House rules

As for [built-in sources](../../extend/sources.md#rules-for-a-source):

- `command` only reads; `write` writes, only when awaywork pipes it a write.
- Print only your items, assigned to you or awaiting your review: awaywork takes every printed item as yours, so `write` may move any of them.
- `write` refuses an item no longer yours since `command` printed it, which awaywork can't tell: exit non-zero and say so on stderr.
- Read tokens from env vars listed in `secrets`.

## Writing back

[`on_done`](./queue-rules.md#on-done) results and moves go through a `write` command of the source's; without one, its items stay put, with no result.

```yaml
sources:
  board:
    command: python3 sources/board.py
    write: node sources/board-write.mjs   # runs like `command`: config folder, `secrets` in its env
    fields: [column]
    secrets: [BOARD_TOKEN]                # a token that may write, for both

queue:
  - skill: implement
    source: board
    where: { column: Ready }
    on_done: { move: Review }
```

It runs once per write, the write as JSON on stdin: `op`, the item's `key` as `item`, its `id`, and `to` for a move or `body` for a comment.

```json
{ "op": "move", "item": "AI-42", "id": "8812", "to": "Review" }
{ "op": "comment", "item": "AI-42", "id": "8812", "body": "Which header row?\n\nReply here to answer: awaywork's next run takes this up again with your reply.\n\n— awaywork" }
```

- **A comment** is a step's [questions](../workflows/questions.md#questions), a rule's [plan](../workflows/plans.md) or your `awaywork approve` reply, ending in `— awaywork`: post it as is.
- **List it back** in `comments`, oldest first, `mine` set as below, and the item waits for an answer or approval until a later comment replies.
- **A non-zero exit** is a failed write: stderr goes to the run's output and report; the unit stays done.
- **Print the updated time** (ISO) before and after the write, `{"before": "…", "after": "…"}`. When `before` is what `command` printed, awaywork records `after`, so its own move doesn't look like a change next run and someone else's still does.

```js
// board-write.mjs: moves a card or comments on it, as you
import { text } from 'node:stream/consumers'

const write = JSON.parse(await text(process.stdin))
const card = `https://board.example/api/cards/${write.id}`
const headers = { Authorization: `Bearer ${process.env.BOARD_TOKEN}`, 'Content-Type': 'application/json' }
const before = (await (await fetch(card, { headers })).json()).card.updated_at
const res = await fetch(`${card}/${write.op === 'move' ? 'move' : 'comments'}`, {
  method: 'POST',
  headers,
  body: JSON.stringify(write.op === 'move' ? { column: write.to } : { text: write.body }),
})
if (!res.ok) throw new Error(`${write.op} ${write.item}: ${res.status} ${await res.text()}`)
console.log(JSON.stringify({ before, after: (await res.json()).card.updated_at }))
```

Set `"mine": true` on a printed comment your account wrote and, if the tracker says, nobody else edited last: awaywork counts a comment as its own only with its last line and `mine`, so a teammate pasting the line doesn't pass for awaywork.

## Thread hosts

Your tracker can't take awaywork's posts and `thread: github` doesn't fit (repos on Bitbucket, or plans kept out of the issue list)? A custom source with `thread: true` can host the [threads](../workflows/posts.md#threads), named in a rule's `thread`.

```yaml
sources:
  jira: { site: acme.atlassian.net, email: me@acme.dev } # a read-only token
  notes:
    command: node threads.mjs ~/vault/awaywork
    write: node threads.mjs ~/vault/awaywork write
    thread: true # its write opens threads

queue:
  - skill: story
    source: jira
    deliver: report
    wait: true
    thread: notes
```

The rule's first post for a card opens its thread, one more op for `write`:

```json
{ "op": "open", "item": "ENG-2101", "title": "ENG-2101: Export VAT report", "body": "awaywork posts here for [ENG-2101](https://acme.atlassian.net/browse/ENG-2101), Export VAT report: its plans, results and questions. Reply here to answer them; the card still decides whether it's yours.\n\n<!-- awaywork thread item=jira:ENG-2101 -->" }
```

It prints the thread's key and link, `{"key": "ENG-2101", "url": "file:///Users/me/vault/awaywork/ENG-2101.md"}`, plus an `id` when the host's own id isn't the key (a Notion page's). Each later post is a `comment` with that key as `item` and the `id` (else the key). Once the card's source says it's done comes a `close` with a last line, `The card is done, so awaywork closes its thread.`; a host may ignore it and get it again every run that still reads the card as done, a week by default.

- **Listed back as items:** `command` prints each thread like an item, the `body` it got as `description`, marker line included. The marker is how awaywork finds a card's thread every run, with nothing in the state dir. It's also why a thread is never an item of its own: a thread host's item carrying the marker is left out.
- **Its `comments` are the replies**, oldest first, `mine` on yours: only your reply answers a post, a teammate's is context in `item.md`. The rest works as on a GitHub thread: approving, feedback, held moves, `awaywork approve jira:ENG-2101` or the thread's key `notes:ENG-2101`.
- **One post, one comment:** part of a post is the model's text, so a host that splits it at anything shaped like a reply heading lets that text pass for your reply, `approve` included.
- **Nobody gets pinged:** unlike a GitHub issue, a file or page notifies nobody, so pair the host with a [notify](../results.md#notify) hook that tells you when something waits.

Example: [a folder of Markdown files](../../examples/markdown-threads.md) as a thread host.

## Examples

- [Chores](../../examples/chores.md): work with no tracker item, like tests for an untested module.
- [Sentry errors](../../examples/sentry.md): unresolved errors with their stack trace, for `fix`.

## On GitHub Actions

The runner has only the repo holding your config:

- **Commit the command next to `config.yml`.** A `~/` path works only on your laptop; `doctor` warns.
- **Build it in `setup`,** run in the config's folder before awaywork's action, without the source's secrets (`cargo build --release`, `go build -o board .`). A Mac binary won't run on the Linux runner; `ubuntu-latest` has Node, Python, Go and Rust.
- **Add the `secrets` as repository secrets:** `schedule install --with github-actions` names them in the workflow and offers to set those your environment has.

## Try it

```sh
awaywork doctor   # runs the command and checks its output
awaywork plan     # shows which rule each item hits
```
