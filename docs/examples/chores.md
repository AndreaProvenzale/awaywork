---
description: A custom source that hands out work with no tracker item, one item per chore and repo.
---

# Chores

A [custom source](../guide/config/custom-sources.md) to adapt.

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

- **Attempts** skip a unit whose items haven't changed since a worker finished it ([how it works](../guide/how-it-works.md)). `updated` is the week's Monday, so a chore runs at most weekly, and not while its last draft is open; print the day's date for daily.
- **Weekdays** are the script's: print nothing on days off.
- **A fixed time**, Mondays at 09:00, needs no script: that's a [routine](../guide/config/sources.md#routines), each occurrence a new item and branch, so every week opens its own PR.
- **`quota`** is rechecked at unit start: `plan` shows the gate and notes missing headroom, and the run skips the chore without it.
- **No `link`**: a chore has no tracker page, so its drafts carry no link line.
