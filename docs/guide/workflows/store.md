---
description: Big plans, contracts and screenshots live in a store outside the post and come back to the next step, where an edit is feedback.
---

# Store

A card's thread suits a decision, not a 400-line plan, a contract or three screenshots, and a fresh runner loses whatever stayed in the run dir. `store` is one command awaywork hands each file a post pins: it puts the file anywhere (Notion, a bucket, a folder) and prints a link.

```yaml
store:
  command: node store.mjs # runs in the config file's folder, like a custom source's command
  secrets: [STORE_TOKEN] # withheld from workers, listed in Actions
  read: { max_mb: 10, files: ["*.md", "*.yml", "*.png"] } # what comes back; default 10 MB of everything
```

The post gets a short summary and a link per file; the next unit reading the thread gets the files back, on any machine: [Files that come back](#files-that-come-back).

The model never sees a URL before awaywork writes it, nor picks where a file goes. A tiny store keeping files in a folder beside it, at `file://` URLs, enough for one machine:

```js
// store.mjs: keeps each file awaywork puts in a folder next to it, at a file:// URL.
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const op = JSON.parse(readFileSync(0, 'utf8'))
if (op.op === 'put') {
  const to = join(dirname(fileURLToPath(import.meta.url)), 'files', randomUUID(), basename(op.path))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(op.path, to)
  console.log(JSON.stringify({ url: pathToFileURL(to).href }))
} else {
  const path = fileURLToPath(op.url)
  // A pin line anyone could write names this URL: read only this store's files.
  if (!path.startsWith(join(dirname(fileURLToPath(import.meta.url)), 'files', '/')))
    throw new Error(`not in this store: ${op.url}`)
  process.stdout.write(readFileSync(path))
}
```

It gets one JSON op on stdin per call, with your environment, like a [custom source](../config/custom-sources.md):

- `{"op": "put", "item": "ENG-2101", "unit": "eng-2101", "path": "/…/units/eng-2101/out/plan.yml", "kind": "plan"}` prints `{"url": "…"}`. `path` is awaywork's copy out of the clone, readable during the put. `kind` is `plan`, `contract`, `report`, or the file's name under `.away/out/`, so one script can send recordings to a bucket and plans to Notion.
  - It may print `{"skip": true}` instead, to keep a file out of the store (a 200 MB trace): the file stays in the run dir, the post goes out without a link to it, and nothing is reported. Any other output is a failed put.
  - A skip decides what goes to the store, never what is posted. A lean report or plan whose `report.md` is skipped still posts the step's `summary.md`, or with none the report's first five lines, with no link to the report. So a skip keeps no secret off the item.
  - A lean plan can't be approved or fanned out without its `plan.yml` and contract. Skip either and the plan isn't posted: `plan not posted: plan.yml isn't in the store`.
- `{"op": "get", "url": "…"}` prints the bytes exactly as put. A put-only store sets `get: false`, and awaywork reads back with a plain HTTP GET, within the command's 10 minutes.

After each put awaywork gets the file back and compares its sha256, which the pin carries. A store that returns other bytes (a CMS adding a newline, Notion round-tripping markdown) would make every post look edited, so that file isn't pinned: `report.md not stored: the store gave back different bytes than awaywork put`. Keep such a page for people, the bytes somewhere that keeps them.

The script's job, not awaywork's:

- **A URL that lasts.** It's read back days later. An S3 presigned link expires within a week: re-sign in `get` from a key in the URL, or pick a host whose links don't expire.
- **Secrets in what leaves.** A log or recording can hold a token the agent saw: redact it before the script stores the file. A skip doesn't keep it off the item, and what `summary.md` says is the skill's job.
- **Only its own URLs.** awaywork reads pins only off its own posts and the PRs it opened for you, and on GitHub and Jira skips any someone else edited last. Asana, Linear and custom sources don't say who edited a comment, so a teammate who can edit yours can edit a pin line; a `get` that refuses URLs it didn't print, as above, stops the store fetching what they name.
  - With `get: false` nothing refuses. A file changed in the store no longer matches its pin and is left out of the step, but a rewritten pin line (a new URL with its own hash) passes, and awaywork fetches it at every `plan`. On those sources it trusts whoever can edit the post.
  - A file edited after its pin never reaches a step: the edit reruns the step without it.

When the store fails:

- A failed put leaves the file in the run dir, pins nothing and adds a morning report line (`fail.bin not stored: Command failed with exit code 1: …`, or `printed 11 characters that aren't JSON, not {"url": "…"}`, never quoting the output); post and PR still go out.
- A lean report whose own `report.md` failed posts the whole report in place of the summary, other pins kept, and says so; over 30 KB it fails like any result.
- A failed get on a post the unit depends on (the one an approval covers, its own when it runs again, a PR's footer) skips the unit as `fix store`, with why, counting no attempt. One on a task's result that waits or went ahead skips every task of its card the same way, a done task's result too: the card's tasks stay held until the store gives the file back.
- On any other post (an older plan, a newer report) it costs only that post's files and a morning report line, so an expired `plan.yml` on an old plan stops nothing.

## Files that come back

With a [store](./store.md), a plan or report rule's post is lean: the step writes `.away/out/summary.md`, a few lines for the thread (its prompt asks for it), and awaywork posts that, its own facts and a pin per file the step left, the rest in the store:

<!-- Generated by `pnpm docs:gen` from scripts/screens.ts. Do not edit. -->

```text workflows-lean-post
Result of story

A story in one line.

Status: done

To approve, reply with approve as the first line. Any other reply is feedback: awaywork runs this step again with it.

Pinned mock.png: file:///…/cfg/files/71e96381-7e32-4ee7-9aab-5f803b4de816/mock.png (7 bytes, sha256 2d4566582844690f8634a8b2534ea5221560038c6c0650c99140759bad603ae2)
Pinned report.md: file:///…/cfg/files/a63b0dec-63e2-4701-968e-8350ad439bae/report.md (22 bytes, sha256 8ce3d4416e83b1da658e0404e2cf700108a3ed2e43b077fadad9eb5ccaa95c8e)

— awaywork · waits
```

A lean plan lists its tasks (`Tasks:`, `- api: VAT export endpoint`, ...) in place of `plan.yml`, which is pinned with its contract and report, so only summary and task list count toward the 30 KB limit.

- `post: full` keeps the whole comment, report inline, and pins only the other files.
- A step with no `summary.md` gets its report's first five lines, and a morning report line.
- Pins sit below everything the model wrote, right above the mark, so a `Pinned` line in a report pins nothing.
- A PR step's files, screenshots say, are pinned in the PR body's footer the same way.
- Without a store, posts are full and files stay in the run dir, for the [notify](../results.md#notify) hook.

### What comes back

Before a unit's worker starts, awaywork gets its items' pinned files into `.away/context/<item>/files/<post>/`, a folder per post named by its place in the thread (`2-story/`):

- the post an approval covers (a task's plan, the result `approved: story` names);
- its own newest post when it runs again on feedback or a `continue`, and every newer post;
- on a PR awaywork opened for you, its footer's.

Also:

- A footer file changed since its pin is left out, with a morning report line: nothing reruns on a PR body. A stranger's PR carrying awaywork's marker gets nothing read back.
- The worker still holds no token, and its prompt calls those files data, like `item.md`: someone else wrote them.
- A lean plan's tasks read its `plan.yml` and contract through `get`; what a task `ships` still comes from its PR's head.
- `read.max_mb` caps what one unit reads back, 10 by default; the rest stay links, named in the morning report, and a pin's size means one over the cap isn't fetched. `read.files` narrows by name, `*.md` matching `notes/a.md` too.

### An edit is feedback

Every `plan`, run and watch poll reads back, within the cap, the files of the posts that decide a rule (a plan's, a waiting or approved report's, a task's result that waits or went ahead) and checks their hash. A mismatch makes the post stale, which counts as your feedback, whoever edited it: the step runs again, though the card didn't change, with the edited file in context and its path in `files/EDITED` (one per line), which its prompt calls feedback, and posts again. A rule that waits needs a fresh `approve`, so you only approve what awaywork has seen:

<!-- Generated by `pnpm docs:gen` from scripts/screens.ts. Do not edit. -->

```text workflows-edited-post
  1  api#206  story  done    report
     Full report of story.
     report.md of awaywork's post of 2026-11-07T19:31:26Z changed in the store since awaywork pinned it
     result posted on https://github.com/acme/api/issues/206#issuecomment-6712036203; it waits for your approve
```

So edit the plan in Notion freely, then approve what comes back. A full post keeps the card's rule: your edit of the plan comment counts, someone else's voids it.
