---
description: Plug any task tracker into awaywork with a command that prints your open items as JSON, in any language, locally or on GitHub Actions.
---

# Custom sources

Your tracker isn't built in? Maybe it's an internal board, or a Jira
nobody will ever let you share a token for. Write a command that prints
your open items as JSON, and awaywork treats it like any other
source. Use any language: Python, Go, Rust, bash, or an `npx` package.

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
  - skill: qa-feedback
    source: board
    where: { column: QA }
  - skill: continue
    source: board
    where: { column: In progress }
```

The built-in queue only has rules for built-in sources, so a custom
source needs rules of its own.

## Output

The command prints a JSON array to stdout. Anything it writes to stderr
shows up when it fails.

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

| Key | |
|---|---|
| `id`, `key`, `title`, `url` | Required. `key` is the tracker's own reference; branch names use it, and your PRs are matched by it |
| `type` | `task` (default) or `issue` |
| `description`, `status`, `assignee`, `reviewers`, `labels`, `comments` | Optional |
| `fields` | Strings, numbers, booleans or lists of them. Every key must be listed in `fields` in the config, except `repo`, `created` and `updated` |
| `context` | Optional Markdown the worker reads instead of `description`: attachments, linked specs, whatever helps |

- **`fields.repo`** (`owner/name`) says where the code lives. Without it,
  a task is picked up only when you already have a PR linked to it, and
  an issue not at all.
- **`link`** in the config is the line, in your tracker's own words, that
  links a PR to an item: awaywork writes it into its draft PRs, and
  links a PR of yours whose body holds it, on top of the key in its
  branch or title. `{key}`, `{id}` and `{url}` are the item's; there's no
  default. See [Linking PRs](./configuration.md#linking-prs).
- **`created` and `updated`** are ISO timestamps, and a rule's `order`
  sorts by them.
- The command gets 10 minutes before it is killed.

## House rules

The same rules as for [built-in sources](../extend/sources.md#rules-for-a-source):

- Only read. Never write to the tracker.
- Print only your items: assigned to you, or waiting on your review.
- Read tokens from env vars and list them in `secrets`.

## Recipe: chores

When the queue is done and quota is left, a source can hand out work that
needs no tracker item: tests for an untested module, a TODO to clear. Print
one item per chore and repo, and put its rule last so it only gets what
the rest leaves:

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

- **Attempts** keep a chore from redoing the same work: a unit whose items
  haven't changed since a worker finished it is skipped, see
  [how it works](./how-it-works.md). `updated` is the Monday of the week,
  so a chore runs at most once a week, and not while its last draft PR is
  still open; print the day's date to run it every day.
- **Weekdays** are the script's call: print nothing on the days a chore
  shouldn't run.
- **`when`** is checked again when the unit starts: `plan` lists the chore
  with its gate and notes when the probe has no headroom for it, and the
  run skips it without the headroom.
- **No `link`** is set: a chore has no tracker page, so its draft PRs carry
  no link line.

## On GitHub Actions

The runner has only what's in the repo holding your config, so:

- **Commit the command next to `config.yml`.** A path under `~/` works on
  your laptop and nowhere else, and `awaywork doctor` warns about it.
- **Build it in `setup`.** It runs in the config's folder before
  awaywork's action, e.g. `cargo build --release` or `go build -o board .`.
  It runs without the source's secrets: only the command gets them.
  A binary built on your Mac won't run on the Linux runner. `ubuntu-latest`
  ships Node, Python, Go and Rust.
- **Add the `secrets` as repository secrets.**
  `awaywork schedule install --with github-actions` writes them into the
  workflow by name, and offers to set the ones your environment has.

## Try it

```sh
awaywork doctor   # runs the command and checks its output
awaywork plan     # shows which rule each item hits
```
