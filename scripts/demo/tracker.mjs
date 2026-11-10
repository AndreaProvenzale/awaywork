// The demo's tracker, a custom source: lists the cards in tasks.json with the comments awaywork wrote, and writes them to comments.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { text } from 'node:stream/consumers'

const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])
const comments = read('comments.json')

if (process.argv[2] === 'write') {
  const write = JSON.parse(await text(process.stdin))
  if (write.op === 'comment')
    comments.push({ item: write.item, body: write.body, at: new Date().toISOString() })
  writeFileSync('comments.json', JSON.stringify(comments))
} else {
  const cards = read('tasks.json').map(({ key, title, column, repo }) => ({
    id: key.slice(2),
    key,
    title,
    url: `https://tracker.example/${key}`,
    comments: comments
      .filter((c) => c.item === key)
      .map(({ body, at }) => ({ author: 'dev', body, at, mine: true })),
    fields: { column, updated: '2026-01-02T10:00:00Z', ...(repo && { repo }) },
  }))
  console.log(JSON.stringify(cards))
}
