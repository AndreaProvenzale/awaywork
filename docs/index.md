---
layout: home
description: awaywork is a harness that runs your coding agents (Claude Code, Codex, Cursor and friends) headless on your real tasks, under rules you set, and leaves draft PRs, reports and questions. It paces your quota and keeps you in control of what truly matters.
hero:
  name: awaywork
  text: You're away, your agents work
  tagline: A harness that runs your coding agents on your real tasks, under rules you set. It paces your quota and keeps you in control of what truly matters.
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
  - title: Your real tasks, picked by rules
    details: Red CI, review threads, QA feedback, requested reviews and sprint tasks from your forge and task tracker, matched by an ordered queue of rules you control.
  - title: Skills, chains and plans
    details: Skills are plain Markdown, built in or your own. Chain steps, loop review and fix, or split a feature into tasks that run as PRs, across repos too.
  - title: You decide what matters
    details: Plans and posts wait for your reply on your own item, questions come to you, and a gate puts a decision card on a change that wants a human.
  - title: Vendor binaries, your login
    details: Runs the stock agent CLIs (Claude Code, Codex, Cursor, more coming) headless with your own credentials. No API calls with a subscription token, no proxying.
  - title: Drafts, never merges
    details: Workers get no forge token. awaywork pushes only new branches and opens draft PRs, unless you opt in to ready ones or to fast-forward your own PR, and goes on with its own draft only from where it left it; it never force-pushes or merges, and comments only on your own items, marked as its own.
  - title: Paced quota
    details: Reads each agent's remaining quota before and during a run and stops at a ceiling that spreads it over the window, keeping a reserve for you.
---

```sh
npm install -g awaywork
awaywork init             # opens Claude Code on /away, which sets it up with you
awaywork plan             # a dry look at the next run; only a tiny quota probe
awaywork schedule install # runs in the windows you set
```

Setting it up with a coding agent? Point it at [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt) or [With an AI agent](./guide/agents.md).
