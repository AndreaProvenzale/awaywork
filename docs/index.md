---
layout: home
description: night-shift spends idle AI coding-subscription quota while you sleep, running Claude Code, Codex and friends headless on red CI, review threads, QA feedback and plans, and leaves draft PRs and a morning report.
hero:
  name: night-shift
  text: Your agents work the night shift
  tagline: Your AI coding quota resets every week, used or not. Clock out, and your agents clock in on your leftovers. Draft PRs and a report by morning.
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
    details: Red CI, unresolved review threads, QA feedback, requested reviews and sprint tasks from your forge and task tracker, ordered by a queue of rules you control.
  - title: Won't eat your morning
    details: Reads each agent's remaining quota before and during the night and stops at a ceiling you set, so the morning still has room.
  - title: Vendor binaries, your login
    details: Runs the stock agent CLIs (Claude Code, Codex, more coming) headless with your own credentials. No API calls with a subscription token, no proxying.
  - title: Drafts, never merges
    details: Workers get no forge token. night-shift pushes only new branches and opens draft PRs, unless you opt in to fast-forward your own PR; it never force-pushes, merges or comments.
---

```sh
npm install -g nightshift-agent
nightshift init             # finds your agents and forge login, asks the rest
nightshift plan             # a dry look at tonight, zero tokens spent
nightshift schedule install # every night when you clock out
```

Setting it up with a coding agent? Point it at
[`llms.txt`](https://andreaprovenzale.github.io/night-shift/llms.txt) or [With an AI agent](./guide/agents.md).
