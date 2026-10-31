---
description: Plug any task tracker into awaywork with a command that prints your open items as JSON, in any language, locally or on GitHub Actions.
---

# Custom sources

Your tracker isn't built in? Maybe it's an internal board, or a Jira nobody will ever let you share a token for. Write a command that prints your open items as JSON, and awaywork treats it like any other source. Use any language: Python, Go, Rust, bash, or an `npx` package.

## Config

```yaml
sources:
  github: { repos: [acme/*] }
  board:                                # any name; rules use it as `source: board`
    command: python3 sources/board.py   # runs in the config file's folder
    fields: [column, board]             # what `where` may match on; `any` is reserved
    secrets: [BOARD_TOKEN]              # env vars the command reads
    setup: pip install -r sources/requirements.txt   # GitHub Actions only
    link: "Refs {key}"                  # optional: the line that links a PR, see below

queue:
  - skill: fix
    source: board
    where: { column: QA }
  - skill: implement
    source: board
    where: { column: In progress }
```

The built-in queue only has rules for built-in sources, so a custom source needs rules of its own.

## Output

The command prints a JSON array to stdout. Anything it writes to stderr shows up when it fails.

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

- **`fields.repo`** (`owner/name`) says where the code lives. Without it, a task is picked up only when you already have a PR linked to it, and an issue not at all.
- **`link`** in the config is the line, in your tracker's own words, that links a PR to an item: awaywork writes it into its draft PRs, and links a PR of yours whose body holds it, on top of the key in its branch or title. `{key}`, `{id}` and `{url}` are the item's; there's no default. See [Linking PRs](./configuration.md#linking-prs).
- **`created` and `updated`** are ISO timestamps, and a rule's `order` sorts by them.
- The command gets 10 minutes before it is killed.

## Finished items

A rule that names [`state`](./configuration.md#finished-items) can match items you closed lately. When one does, the command gets `AWAYWORK_CLOSED_SINCE`, the ISO time its lookback starts (`2026-10-11T09:30:00.000Z`), and may print the items closed since then next to the open ones, with `"state": "closed"` and `"closed"` set to when. Without the variable, no rule wants them: print open items only, or print them anyway and the rules leave them alone.

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

`state` and `closed` are every item's own keys, so `fields` in the config can't list them: if your tracker has a field called `state`, print it under another name. A top-level `state` other than `open` or `closed`, or a `closed` that isn't an ISO time, is ignored, with one warning naming the first such item, so a command that printed GitLab's `"state": "opened"` before keeps working.

## House rules

The same rules as for [built-in sources](../extend/sources.md#rules-for-a-source):

- `command` only reads. Writing is `write`'s, and only when awaywork pipes it a write.
- Print only your items: assigned to you, or waiting on your review. awaywork takes every item you print as yours, so `write` may move any of them.
- `write` refuses an item that's no longer yours, reassigned or unassigned since `command` printed it: awaywork can't tell, so exit non-zero and say so on stderr.
- Read tokens from env vars and list them in `secrets`.

## Writing back

A rule's [`on_done`](./configuration.md#on-done) posts its result on your item and moves it once its work is published. A custom source does that through a `write` command of its own; without one, its items stay where they are, with no result.

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

awaywork runs it once per write with the write as JSON on stdin: `op`, the item's `key` as `item` and its `id`, then `to` for a move or `body` for a comment.

```json
{ "op": "move", "item": "AI-42", "id": "8812", "to": "Review" }
{ "op": "comment", "item": "AI-42", "id": "8812", "body": "Which header row?\n\nReply here to answer: awaywork's next run takes this up again with your reply.\n\n— awaywork" }
```

A comment is a step's [questions](./how-it-works.md#questions), a rule's [plan](./how-it-works.md#plans) or your `awaywork approve` reply to one: the body ends with awaywork's `— awaywork` line, and the command posts it as is. List it back in `comments`, oldest comment first and `mine` set as below, and the item waits for an answer or an approval until a later comment replies. A non-zero exit is a failed write: its stderr goes in the run's output and the morning report, and the unit stays done. Print the item's updated time (ISO) right before and after the write as `{"before": "…", "after": "…"}`: when `before` is still what `command` printed, awaywork records `after`, so its own move doesn't make the item look changed next run, while someone else's change during the run still does.

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

On a comment your `command` prints back, set `"mine": true` when your own account wrote it and, if the tracker says, nobody else edited it last: awaywork counts a comment as its own only with its last line and `mine`, so a teammate pasting the line doesn't pass for awaywork.

## Recipe: chores

When the queue is done and quota is left, a source can hand out work that needs no tracker item: tests for an untested module, a TODO to clear. Print one item per chore and repo, and put its rule last so it only gets what the rest leaves:

```yaml
sources:
  chores:
    command: node chores.mjs
    fields: [chore]

queue:
  # ...your other rules first
  - skill: implement
    source: chores
    where: { chore: tests }
    when: { headroom: 20% }   # only on spare quota
```

```js
// chores.mjs: the `description` is the brief the worker reads
const chores = [{ name: 'tests', task: 'Add tests for the least tested module.' }]
const repos = ['acme/api', 'acme/web']
const monday = new Date()
monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
const updated = `${monday.toISOString().slice(0, 10)}T00:00:00Z`

console.log(JSON.stringify(repos.flatMap((repo) => chores.map(({ name, task }) => ({
  id: `${name}:${repo}`,
  key: `chore-${name}-${repo.replace('/', '-')}`,
  title: `Chore: ${name} in ${repo}`,
  url: `https://example.com/chores/${name}`,
  description: task,
  fields: { chore: name, repo, updated },
})))))
```

- **Attempts** keep a chore from redoing the same work: a unit whose items haven't changed since a worker finished it is skipped, see [how it works](./how-it-works.md). `updated` is the Monday of the week, so a chore runs at most once a week, and not while its last draft PR is still open; print the day's date to run it every day.
- **Weekdays** are the script's call: print nothing on the days a chore shouldn't run.
- **A fixed time**, like every Monday at 09:00, needs no script: that's a built-in [routine](./configuration.md#routines). Each occurrence is a new item with its own branch, so with `deliver: draft_pr` or `pr` every week opens its own PR instead of waiting on last week's.
- **`when`** is checked again when the unit starts: `plan` lists the chore with its gate and notes when the probe has no headroom for it, and the run skips it without the headroom.

- **No `link`** is set: a chore has no tracker page, so its draft PRs carry no link line.

## Recipe: Sentry errors

An error with a stack trace is a problem listed on an item, so `fix` takes it like a red check. This one is a recipe to adapt, and it hasn't run against a real Sentry yet: point it at your org and projects, print your unresolved issues with their latest stack trace, and let a rule pick the loud ones.

```yaml
sources:
  sentry:
    command: node sentry.mjs
    fields: [level, count]
    secrets: [SENTRY_TOKEN]   # a personal auth token, read access to events

queue:
  - skill: fix
    source: sentry
    where: { level: [error, fatal], count: { gte: 10 } }
```

```js
// sentry.mjs: your unresolved Sentry issues, one item each
const org = 'acme'
const repos = { api: 'acme/api', web: 'acme/web' } // Sentry project: GitHub repo
const query = encodeURIComponent('is:unresolved assigned:me')

async function get(path) {
  const res = await fetch(`https://sentry.io/api/0/${path}`, {
    headers: { Authorization: `Bearer ${process.env.SENTRY_TOKEN}` },
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

function stackTrace(event) {
  const exceptions = event.entries.find((e) => e.type === 'exception')?.data.values ?? []
  return exceptions.map((ex) => [
    `${ex.type}: ${ex.value}`,
    ...(ex.stacktrace?.frames ?? []).toReversed()
      .map((f) => `  at ${f.function ?? '?'} (${f.filename}:${f.lineNo})`),
  ].join('\n')).join('\n\n')
}

const items = []
for (const [project, repo] of Object.entries(repos)) {
  for (const issue of await get(`projects/${org}/${project}/issues/?query=${query}`)) {
    const event = await get(`organizations/${org}/issues/${issue.id}/events/latest/`)
    items.push({
      id: issue.id,
      key: issue.shortId,
      title: issue.title,
      url: issue.permalink,
      context: `Culprit: ${issue.culprit}\n\n\`\`\`\n${stackTrace(event)}\n\`\`\``,
      fields: { repo, level: issue.level, count: Number(issue.count), updated: issue.lastSeen },
    })
  }
}
console.log(JSON.stringify(items))
```

- **`assigned:me`** keeps it to your errors, like any source. Drop it if the whole project is yours.
- **One request per issue** for the latest event: fine for a handful of errors; cap the list or skip `context` if your project is noisier.
- **No `type`**: items default to `task`, and only tasks get linked to your open PRs, awaywork's included. So an error whose draft PR is still open waits for you instead of getting a second one.
- **`updated`** is `lastSeen`: an error that fires again after you closed its draft PR is fair game again. One `fix` couldn't turn into a PR gets 3 tries however often it fires, then one a week ("gave up after 3 attempts"). A GitHub-hosted runner keeps no attempts, so there it's tried every run: cap the rule with `units:` if that's a lot.
- **Frames come oldest first** from Sentry; the script flips them so the throwing line is on top.
- **EU-region org?** Swap `sentry.io` for `de.sentry.io`.

## On GitHub Actions

The runner has only what's in the repo holding your config, so:

- **Commit the command next to `config.yml`.** A path under `~/` works on your laptop and nowhere else, and `awaywork doctor` warns about it.
- **Build it in `setup`.** It runs in the config's folder before awaywork's action, e.g. `cargo build --release` or `go build -o board .`. It runs without the source's secrets: only the command gets them. A binary built on your Mac won't run on the Linux runner. `ubuntu-latest` ships Node, Python, Go and Rust.
- **Add the `secrets` as repository secrets.** `awaywork schedule install --with github-actions` writes them into the workflow by name, and offers to set the ones your environment has.

## Try it

```sh
awaywork doctor   # runs the command and checks its output
awaywork plan     # shows which rule each item hits
```
