---
layout: home
description: awaywork spends idle AI coding-subscription quota while you sleep, running Claude Code, Codex and friends headless on red CI, review threads, QA feedback and plans, and leaves draft PRs and a morning report.
hero:
  name: awaywork
  text: You're away, your agents work
  tagline: Your AI coding quota resets every week, used or not. Clock out, and your agents clock in on your leftovers. Draft PRs and a report by morning.
  image:
    light: /brand/mark.svg
    dark: /brand/mark-dark.svg
    alt: awaywork
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /guide/how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/AndreaProvenzale/awaywork
features:
  - title: Your leftovers, ranked
    details: Red CI, unresolved review threads, QA feedback, requested reviews and sprint tasks from your forge and task tracker, ordered by a queue of rules you control.
  - title: Won't eat your morning
    details: Reads each agent's remaining quota before and during each run and stops at a ceiling you set, so the morning still has room.
  - title: Vendor binaries, your login
    details: Runs the stock agent CLIs (Claude Code, Codex, more coming) headless with your own credentials. No API calls with a subscription token, no proxying.
  - title: Drafts, never merges
    details: Workers get no forge token. awaywork pushes only new branches and opens draft PRs, unless you opt in to ready ones or to fast-forward your own PR; it never force-pushes, merges or comments.
---

```sh
npm install -g awaywork
awaywork init             # finds your agents and forge login, asks the rest
awaywork plan             # a dry look at the next run; only a tiny quota probe
awaywork schedule install # runs when you clock out
```

Setting it up with a coding agent? Point it at [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt) or [With an AI agent](./guide/agents.md).
