---
layout: home
description: night-shift spends idle coding-subscription quota overnight, running Claude Code and Codex headless on red CI, review threads, QA feedback and plans, and leaves draft PRs and a morning report.
hero:
  name: night-shift
  text: Your agents work the night shift
  tagline: Spend the coding-agent quota you didn't use today on your leftovers. Draft PRs and a report by morning.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /guide/how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/AndreaProvenzale/night-shift
features:
  - title: Your leftovers, ranked
    details: Red CI, unresolved review threads, QA feedback, requested reviews and sprint tasks from GitHub and Asana, ordered by a queue of rules you control.
  - title: Paced to your quota
    details: Reads each agent's remaining quota before and during the night and stops at a ceiling you set, so the morning still has room.
  - title: Vendor binaries, your login
    details: Runs the stock Claude Code and Codex CLIs headless with your own credentials. No API calls with a subscription token, no proxying.
  - title: Nothing lands without you
    details: Workers get no forge token. night-shift pushes only new branches and opens draft PRs; it never force-pushes, merges or comments.
---

```sh
npm install -g nightshift-agent
nightshift init             # pick agents, sources and a queue
nightshift plan             # what tonight would do, no agent runs
nightshift schedule install # every night at night.start
```

Setting it up with a coding agent? Point it at
[`llms.txt`](https://andreaprovenzale.github.io/night-shift/llms.txt) or [With an AI agent](./guide/agents.md).
