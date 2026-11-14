---
description: A thread host script keeping one Markdown file per card, in a folder only you write to.
---

# A folder of Markdown files as threads

A [thread host](../guide/config/custom-sources.md#thread-hosts) script.

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
