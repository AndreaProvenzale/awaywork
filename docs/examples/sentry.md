---
description: A custom source for your unresolved Sentry issues with their latest stack trace, and a rule for fix.
---

# Sentry errors

A [custom source](../guide/config/custom-sources.md) to adapt.

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
