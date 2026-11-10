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

A comment is a step's [questions](./workflows.md#questions), a rule's [plan](./workflows.md#plans) or your `awaywork approve` reply to one: the body ends with awaywork's `— awaywork` line, and the command posts it as is. List it back in `comments`, oldest comment first and `mine` set as below, and the item waits for an answer or an approval until a later comment replies. A non-zero exit is a failed write: its stderr goes in the run's output and the morning report, and the unit stays done. Print the item's updated time (ISO) right before and after the write as `{"before": "…", "after": "…"}`: when `before` is still what `command` printed, awaywork records `after`, so its own move doesn't make the item look changed next run, while someone else's change during the run still does.

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

## Thread hosts

Your tracker can't take awaywork's posts, and `thread: github` doesn't fit: your repos are on Bitbucket, or you'd rather keep plans out of the issue list. A custom source can host the [threads](./workflows.md#threads) instead: say `thread: true` on it and name it in a rule's `thread`.

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

It prints the new thread's key and link, `{"key": "ENG-2101", "url": "file:///Users/me/vault/awaywork/ENG-2101.md"}`. It may print an `id` too, when the host's own id for the thread isn't the key: a Notion page's, say. Every post awaywork makes for the card is then a `comment` with that key as `item` and the `id` (the key when there's none), and once the card's source says it's done, a `close` with a last line to post, `The card is done, so awaywork closes its thread.` A host may ignore `close`: it then gets it again on every run that still reads the card as done, a week by default.

- **Listed back as items.** `command` prints each thread it opened like any item, with the `body` it got as `description`, the marker line included. That marker is how awaywork finds a card's thread on every run, so nothing goes in the state dir, and why a thread is never an item of its own: a thread host's item carrying it is left out.
- **Its `comments` are the replies**, oldest first, `mine` on yours, as on any item: only your reply answers a post, a teammate's is context in `item.md`. Everything else works as on a GitHub thread: approving, feedback, held moves, `awaywork approve jira:ENG-2101` or the thread's own key, `notes:ENG-2101`. Keep each of awaywork's posts one comment: part of it is the model's text, so a host that splits a post into several at anything shaped like its reply heading lets that text pass for your reply, an `approve` included.
- **Nobody gets pinged.** A GitHub issue notifies its assignee; a file or a page in your notes doesn't, so a post waits there unseen. Pair the host with a [notify](./configuration.md#notify) hook that tells you when a run left something waiting.

### A folder of Markdown files

One file per card, in a folder only you write to: a corner of your Obsidian vault, say. A `### <who> · <time>` line heads each reply. A file can't tell who wrote a line, so `mine` is whoever the heading names, and that makes it a thread only while you're the folder's only writer: a personal vault yes, a team's shared drive no. awaywork writes there too, so the script escapes a heading line in what it appends (`\### `), and the step's own text can't start a reply.

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

A real one, after a waiting `story`, a teammate's `approve` (context), yours, and the `prototype` it let through:

```md
# CARD-1: Export VAT report

awaywork posts here for [CARD-1](https://tracker.example/CARD-1), Export VAT report: its plans, results and questions. Reply here to answer them; the card still decides whether it's yours.

<!-- awaywork thread item=tracker:CARD-1 -->

### andreaprovenzale · 2026-11-07T20:55:22.292Z

Result of story

Report of story: a story for the VAT export.

Status: done

To approve, reply with approve as the first line. Any other reply is feedback: awaywork runs this step again with it.

— awaywork · waits

### bob · 2026-11-07T20:55:33Z

approve

### andreaprovenzale · 2026-11-07T20:56:02Z

approve

### andreaprovenzale · 2026-11-07T20:56:13.464Z

Result of prototype

Report of prototype: a story for the VAT export.

Status: done

— awaywork
```

Reply from your editor with a heading of your own, or from the shell:

```sh
printf '\n### %s · %s\n\napprove\n' "$(id -un)" "$(date -u +%FT%TZ)" >> ~/vault/awaywork/CARD-1.md
```

Once the card is done, `close` posts its last line and moves the file to `closed/`, which the listing doesn't read.

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
