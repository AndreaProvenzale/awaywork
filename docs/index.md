---
layout: home
description: awaywork is a harness that runs your coding agents (Claude Code, Codex, Cursor and friends) headless on your real tasks, under rules you set, and leaves draft PRs, reports and questions. It paces your quota and brings you only the decisions that matter.
hero:
  name: awaywork
  text: You're away, your agents work
  tagline: Run your coding agents on your real tasks, under rules you set. awaywork paces your quota and brings you only the decisions that matter.
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
    details: No forge token for workers. New branches and draft PRs by default, with opt-in for ready PRs or fast-forwarding your own PR's branch; awaywork continues its own draft only while it's where it left it, never force-pushes, merges or approves, and comments only on your items, marked as its own.
  - title: Paced quota
    details: Stops each agent at a ceiling that spreads its quota over the window and keeps a reserve for you. Agents whose quota can't be read get fixed caps.
---

```sh
npm install -g awaywork
awaywork init             # opens Claude Code on /away, which sets it up with you
awaywork plan             # a dry look at the next run; only a tiny quota probe
awaywork schedule install # runs in the windows you set
```

Setting it up with a coding agent? Point it at [`llms.txt`](https://andreaprovenzale.github.io/awaywork/llms.txt) or [With an AI agent](./guide/agents.md).
