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

The built-in queue has no rules for custom sources: write yours.

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
- **`link`**, in the config, is the line that [links a PR](./configuration.md#linking-prs) in your tracker's words, from `{key}`, `{id}` and `{url}`, no default: awaywork writes it into its drafts and links your PRs whose body holds it, besides the key in branch or title.
- **`created` and `updated`** are ISO timestamps, which `order` sorts by.
- The command is killed after 10 minutes.

## Finished items

When a rule names [`state`](./configuration.md#finished-items), the command gets `AWAYWORK_CLOSED_SINCE`, the lookback's ISO start (`2026-10-11T09:30:00.000Z`), and may print items closed since, with `"state": "closed"` and `"closed"` set to when. Without it, print open items only, or all and the rules ignore the closed ones.

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

As for [built-in sources](../extend/sources.md#rules-for-a-source):

- `command` only reads; `write` writes, only when awaywork pipes it a write.
- Print only your items, assigned to you or awaiting your review: awaywork takes every printed item as yours, so `write` may move any of them.
- `write` refuses an item no longer yours since `command` printed it, which awaywork can't tell: exit non-zero and say so on stderr.
- Read tokens from env vars listed in `secrets`.

## Writing back

[`on_done`](./configuration.md#on-done) results and moves go through a `write` command of the source's; without one, its items stay put, with no result.

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

- **A comment** is a step's [questions](./workflows.md#questions), a rule's [plan](./workflows.md#plans) or your `awaywork approve` reply, ending in `— awaywork`: post it as is.
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

Your tracker can't take awaywork's posts and `thread: github` doesn't fit (repos on Bitbucket, or plans kept out of the issue list)? A custom source with `thread: true` can host the [threads](./workflows.md#threads), named in a rule's `thread`.

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
- **Nobody gets pinged:** unlike a GitHub issue, a file or page notifies nobody, so pair the host with a [notify](./configuration.md#notify) hook that tells you when something waits.

### A folder of Markdown files

One file per card, in a folder only you write to, like a corner of your Obsidian vault. A `### <who> · <time>` line heads each reply, and since a file can't tell who wrote a line, `mine` is whoever the heading names: a thread only while you're the sole writer (a personal vault, not a shared drive). awaywork writes there too, so the script escapes heading lines it appends (`\### `) and the step's text can't start a reply.

```js
// threads.mjs: awaywork's threads as Markdown files in a folder only you write to
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { text } from 'node:stream/consumers'

const [folder, mode] = process.argv.slice(2)
const dir = resolve(folder)
const me = userInfo().username
const reply = /^### (\S+) · (\S+)$/m // `### <who> · <ISO time>`, then the reply
const file = (key) => join(dir, `${key}.md`)
const escaped = (text) => text.replace(/^### /gm, '\\### ') // what awaywork posts never reads as a reply

await mkdir(dir, { recursive: true })
if (mode !== 'write') {
  const threads = []
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.md'))) {
    const [head, ...replies] = (await readFile(join(dir, name), 'utf8')).split(/^(?=### \S+ · \S+$)/m)
    if (!head.includes('<!-- awaywork thread ')) continue
    const key = name.slice(0, -3)
    threads.push({
      id: key,
      key,
      title: head.match(/^# (.*)$/m)?.[1] ?? key,
      url: `file://${file(key)}`,
      description: head.replace(/^# .*\n+/, ''),
      comments: replies.map((r) => {
        const [, author, at] = r.match(reply)
        return { author, at, body: r.replace(reply, '').trim(), mine: author === me }
      }),
    })
  }
  console.log(JSON.stringify(threads))
} else {
  const write = JSON.parse(await text(process.stdin))
  if (write.op === 'open') {
    const key = write.item.replace(/[^\w.-]+/g, '-')
    await writeFile(file(key), escaped(`# ${write.title}\n\n${write.body}\n`), { flag: 'wx' })
    console.log(JSON.stringify({ key, url: `file://${file(key)}` }))
  } else if (write.op === 'comment' || write.op === 'close') {
    const thread = await readFile(file(write.item), 'utf8') // no thread, no comment
    await writeFile(file(write.item), `${thread}\n### ${me} · ${new Date().toISOString()}\n\n${escaped(write.body)}\n`)
    if (write.op === 'close') {
      await mkdir(join(dir, 'closed'), { recursive: true })
      await rename(file(write.item), join(dir, 'closed', `${write.item}.md`))
    }
  } else throw new Error(`${write.op}: this folder only holds threads`)
}
```

A real one, after a waiting `story`, a teammate's `approve` (context only), yours, and the `prototype` it let through:

```md
# CARD-1: Export VAT report

[...]
<!-- awaywork thread item=tracker:CARD-1 -->

### me · 2026-11-07T20:55:22.292Z

Result of story
[...]
— awaywork · waits

### bob · 2026-11-07T20:55:33Z

approve

### me · 2026-11-07T20:56:02Z

approve

### me · 2026-11-07T20:56:13.464Z

Result of prototype
[...]
```

Reply from your editor with a heading of your own, or the shell:

```sh
printf '\n### %s · %s\n\napprove\n' "$(id -un)" "$(date -u +%FT%TZ)" >> ~/vault/awaywork/CARD-1.md
```

Once the card is done, `close` posts its last line and moves the file to `closed/`, which the listing doesn't read.

## Recipe: chores

Quota left when the queue is done? A source can hand out work with no tracker item, like tests for an untested module. Print one item per chore and repo, with its rule last:

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
    quota: { headroom: 20% }  # only on spare quota
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

- **Attempts** skip a unit whose items haven't changed since a worker finished it ([how it works](./how-it-works.md)). `updated` is the week's Monday, so a chore runs at most weekly, and not while its last draft is open; print the day's date for daily.
- **Weekdays** are the script's: print nothing on days off.
- **A fixed time**, Mondays at 09:00, needs no script: that's a [routine](./configuration.md#routines), each occurrence a new item and branch, so every week opens its own PR.
- **`quota`** is rechecked at unit start: `plan` shows the gate and notes missing headroom, and the run skips the chore without it.
- **No `link`**: a chore has no tracker page, so its drafts carry no link line.

## Recipe: Sentry errors

An error with a stack trace is a problem listed on an item, so `fix` takes it like a red check. A recipe to adapt, not yet run against a real Sentry: your unresolved issues with their latest stack trace, and a rule picking the loud ones.

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

- **`assigned:me`** keeps it to your errors; drop it if the project is all yours.
- **One request per issue** for the latest event: fine for a handful; cap the list or skip `context` if noisier.
- **No `type`:** items are `task`s, and only tasks link to your open PRs, awaywork's included, so an error with an open draft waits for you rather than getting a second.
- **`updated` is `lastSeen`:** an error firing again after you closed its draft is fair game. One `fix` can't turn into a PR gets 3 tries however often it fires, then one a week ("gave up after 3 attempts"). A hosted runner keeps no attempts, so there it's tried every run: cap it with `units:`.
- **Frames** come oldest first; the script flips them so the throwing line is on top.
- **EU-region org?** Use `de.sentry.io`.

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
