---
description: Survey of open-source projects, vendor features and commercial products that overlap with awaywork, and where people ask for a tool like it.
---

# Landscape

Who else spends idle agent quota overnight, and who is asking for it.
Tags: **[V]** read the project's README or the vendor's docs, **[C]** seen only in
a search snippet, star listing or press, **[I]** inference. Reddit and most
vendor blogs were unreachable from the research sandbox, so community demand
here leans on GitHub issues.

## Summary

Nobody found combines all of awaywork: a queue harvested from forges and
trackers (red CI, review threads, assigned issues, GitHub and GitLab), pacing
against the subscription's own session and weekly windows with a morning
reserve, several vendor CLIs, and draft PRs only. Each piece exists somewhere:

- **Quota pacing:** rohanprichard/claude-overnight, EthanMcDonnell/claude-nightshift,
  cooco119/claude-quota-tracker. All Claude only, all hand-queued prompts.
- **Forge-harvested work:** ComposioHQ/agent-orchestrator (CI failures and
  review comments routed back to the owning agent), ulmentflam/nightly
  (issues plus "PR rescue"). Neither paces quota.
- **Draft PRs with guardrails:** igdutra/claude-overnight,
  ableinc/coding-agent-loop, openslop/nightshift.
- **Scheduled cloud agents on a subscription:** Claude Code Routines. Claude
  and GitHub only, no quota pacing, no work harvesting.

The biggest risk is vendors, not projects: Routines, Codex automations,
Copilot Automations, Jules and Cursor all ship scheduled agents that open PRs.
The old name was crowded: at least ten GitHub repos are called some variant of
nightshift, hence awaywork.

## Direct competitors: overnight, quota-aware

| Project | Overlap | Differs |
|---|---|---|
| [rohanprichard/claude-overnight](https://github.com/rohanprichard/claude-overnight) [V] | Night window from launchd/systemd; skips if the 5 h window is above 20%, stops at 60%, skips the batch above 80% weekly; worktree branches; morning digest | Claude only, hand-queued jobs, no PRs; reads the undocumented `api/oauth/usage` endpoint [C] |
| [EthanMcDonnell/claude-nightshift](https://github.com/EthanMcDonnell/claude-nightshift) [V] | Markdown task files, usage check before each launch, launchd at 2am, per-repo worktree, digest | No push, no forge source |
| [cooco119/claude-quota-tracker](https://github.com/cooco119/claude-quota-tracker) [V] | Forecasts both windows, nudges on unused quota, night queue guarded at 80%, plugin lets the agent defer work to night | macOS app, no forge, no PRs |
| [dujunyi416/claude-nightshift](https://github.com/dujunyi416/claude-nightshift) [V] | Pre-warms the 5 h window before waking, bedtime prompt queue, auto-resume, Telegram | Windows only; calls the internal OAuth usage endpoint |
| [vasiliyk/claude-queue](https://github.com/vasiliyk/claude-queue) [V] | Priority and dependency queue, pauses at 95%, resumes after reset | Reads quota by scraping the claude.ai session cookie; its README warns this may breach the ToS |
| [igdutra/claude-overnight](https://github.com/igdutra/claude-overnight) [V] | Specs implemented overnight with QA and review, opens PRs with `gh`, never merges, unsets `ANTHROPIC_API_KEY`, hook blocks force-push, budget reserve for the report | Hand-written specs, Claude only |
| [ulmentflam/nightly](https://github.com/ulmentflam/nightly) [V] | Claude, Codex, opencode, pi and more; ranked issues, RFCs, "PR rescue"; draft PRs; `briefing.html`; refusal policy; cron or CI | Concurrency caps per tier, no subscription pacing |
| [openslop/nightshift](https://github.com/openslop/nightshift) [V] | Any yes-to-everything CLI on a timer; ten job types including issues; PRs only; skips files touched by open PRs | No quota pacing |
| [jonit-dev/night-watch-cli](https://github.com/jonit-dev/night-watch-cli) [V] | PRDs or issue-board items to PRs, Claude or Codex, cron, dry run | No pacing, no CI or review sources |
| [paulocorcino/ralphy](https://github.com/paulocorcino/ralphy) [V] | Rust daemon on issues labelled `AFK`, drives installed CLIs on the subscription | Never pushes; local `afk/run-<ts>` branches only |
| [Shaurya-Sethi/nightshift](https://github.com/Shaurya-Sethi/nightshift) [V] | PRD child issues in dependency order, seven CLIs | Merges its own PRs, no scheduler, no pacing |
| [q1zhen/nightshift](https://github.com/q1zhen/nightshift) [V] | Codex overnight on `TODO.md`, daily digest | Codex only, local TODOs |
| [jshchnz/claude-code-scheduler](https://github.com/jshchnz/claude-code-scheduler) [V] | Plugin registers `claude -p` with launchd, cron or Task Scheduler; worktree; pushes a branch | Skips permissions, no pacing, no queue |
| [Ark0N/Codeman](https://github.com/Ark0N/Codeman) [C] | Runs Claude, Codex, Gemini and more 24/7 in tmux, resumes after limits, scheduled jobs | No forge queue |
| [mixpeek/amux](https://github.com/mixpeek/amux) [C] | Parallel workers, cron-style schedules, self-pacing overnight loops, morning briefing | Board, not forge-driven |

Smaller overnight runners [C]: ppuliu/night-shift, GodModeAI2025/NightShift,
thebasedcapital/nightcrawler, Bitmia-ai/RedEye, benikigai/nightshift,
yail259/overnight, ElectricJack/agent-queue, rezsekmv/ccq, M16Ali/claude-guard,
danielmaier42/claudeq, maxaiquota.com.

## Issue and CI to PR agents

- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
  [V]: `@claude` and automation mode on any event, including `schedule`;
  accepts `CLAUDE_CODE_OAUTH_TOKEN`. One workflow per repo, no harvesting,
  no pacing.
- [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)
  [C]: nightly triage, review, fixes; API key, not subscription.
- [OpenHands](https://github.com/OpenHands/OpenHands) resolver [C]:
  `fix-me` label to PR, API keys.
- [SWE-agent](https://github.com/SWE-agent/SWE-agent) and mini-swe-agent [C]:
  research-grade issue fixers, no scheduling.
- [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents)
  [V]: cloud-sandbox agents from GitHub, Linear, Slack or cron; accepts
  Claude or ChatGPT subscription OAuth. No pacing.
- [AnandChowdhary/continuous-claude](https://github.com/AnandChowdhary/continuous-claude)
  [V]: loop that opens a PR, waits for checks and auto-merges; budgets by
  runs, cost and duration.
- [ableinc/coding-agent-loop](https://github.com/ableinc/coding-agent-loop)
  [C]: labelled issues to draft PRs from a worktree. Closest PR model, no quota.
- [sweepai/sweep](https://github.com/sweepai/sweep) [C]: the original
  issue-to-PR bot, now a JetBrains assistant.

## Orchestrators and task sources

Interactive or board-driven, none paces quota: ComposioHQ/agent-orchestrator
[V], smtg-ai/claude-squad, BloopAI/vibe-kanban, stablyai/orca,
frankbria/ralph-claude-code, Yeachan-Heo/oh-my-claudecode, manaflow-ai/cmux
[C]. eyaltoledano/claude-task-master, MrLesk/Backlog.md and gastownhall/beads
[C] are task stores awaywork could read as sources.

## Quota monitors and auto-resume

Monitors: ccusage (local JSONL logs), Claude-Code-Usage-Monitor, CodexBar
(Claude and Codex windows, has a CLI), ClaudeBar, token-monitor [C].
Resume-after-limit scripts: terryso/claude-auto-resume and a dozen smaller
ones; window pre-warmers such as macalinao/claude-code-schedule [C].

## Vendor features

| Feature | Overlap | Gap awaywork fills |
|---|---|---|
| [Claude Code Routines](https://code.claude.com/docs/en/routines) [V] | Schedule, API or GitHub PR/release triggers; draws subscription usage; `claude/` branches; refuses protected branches and others' commits | Claude and GitHub only; daily run cap, no pacing against remaining quota; the prompt must find the work |
| [Auto-fix, desktop scheduled tasks](https://code.claude.com/docs/en/claude-code-on-the-web) [V] | Auto-fix pushes fixes for CI and review comments on one watched PR | Per PR, opt-in; desktop tasks need the app open |
| `autoContinueAtUsageLimit` in Claude Code [C] | Resumes at session reset, on by default | Session window only; one report of it spending 66% of an overnight window unasked (anthropics/claude-code#92319 [V]) |
| [Codex automations](https://developers.openai.com/codex/app/automations) [C] | Scheduled local runs on plan limits | Codex only; cloud scheduling still requested (openai/codex#47660 [V]) |
| Codex GitHub integration, codex-action [C] | `@codex` fixes CI or issues | Per mention |
| GitHub Copilot Automations and Agent HQ [C] | Nightly failing tests to draft PRs; Claude and Codex as assignable agents | Billed as Copilot credits, not the user's own subscription |
| [GitHub Agentic Workflows](https://github.com/github/gh-aw) [V] | Markdown workflows on Actions; Copilot, Claude, Codex, Gemini engines; safe outputs | Subscription OAuth support unknown |
| Jules scheduled tasks, [jules-action](https://github.com/google-labs-code/jules-action) [V] | Nightly tasks, CI fixer | Gemini only, API key |

## Commercial products

All [C]. Hosted, and bill their own credits or API tokens rather than the
user's subscription, except where noted.

- **Tembo:** runs Claude Code, Codex, Cursor or Amp on Sentry, Linear or cron
  triggers across repos; offers ChatGPT-subscription Codex. Closest commercial
  analog.
- **Charlie Labs Daemons:** standing agents defined in markdown, on events
  and schedules, returning PRs.
- **Cursor Automations and Bugbot Autofix:** cron or event cloud agents,
  API-rate billing.
- **Devin Automations**, **Factory Droids** (`droid-action` on cron), **Warp
  Oz scheduled agents**, **Augment cloud agents**, **Ona Automations**,
  **Continue Mission Control**, **Cosine Genie**.
- **CodeRabbit** fix-CI and **Graphite** (now Cursor): review-centric fixes.
- **Renovate** `nonOfficeHours`: the deterministic precedent for bot PRs
  landing overnight.

## Demand

GitHub issues, reaction counts from the API [V]:

| Issue | Ask | 👍 |
|---|---|---|
| anthropics/claude-code#13354 | Continue when the session limit is reached | 208 |
| anthropics/claude-code#35744 | Auto-continue after the rate limit resets | 100 |
| anthropics/claude-code#4785 | Cron-like scheduled headless tasks, closed as not planned | |
| anthropics/claude-code#47276 | Quota visibility and pausing at 95% | |
| anthropics/claude-code#79127 | Suspend instead of ending; lost 24 of 70 tasks on resume | |
| openai/codex#34035 | Keep the 5-hour limit removed | 166 |
| openai/codex#21073 | Auto-resume when the limit resets | 65 |
| openai/codex#2992 | Fall back to an API key when the plan runs out | 45 |
| openai/codex#28931 | Auto-resume `/goal` after the limit | 38 |

Posts [C]: dev.to "I was maxing my Claude 5-hour limit daily and still
wasting weekly quota every night" (rohanprichard); jeangalea.com
"claude-code-overnight"; dev.to "I ran Claude Code unattended, all night";
wmedia.es "Claude Code can work while you sleep"; Ask HN "What do you do when
you hit Claude subscription limits?" (item 48506908).

What people want: resume at reset, a pacing threshold that keeps a daytime
reserve, visible quota and reset time, a prioritised queue, cron, isolated
branches, a morning digest. What worries them: tools that read OAuth tokens
or cookies, silent overnight spend, prompt injection from PR content,
unattended permission prompts that hang (anthropics/claude-code#86915).

## Terms

- Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance)
  [V] bars third parties from routing or storing subscription credentials,
  and does not "prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription". Usage limits "assume
  ordinary, individual usage". awaywork sits inside the carve-out; tools
  that read the OAuth token to call usage endpoints sit closer to the line [I].
- Anthropic justified weekly limits by users "running Claude Code
  continuously in the background, 24/7" [C]. It announced moving `claude -p`,
  the Agent SDK and GitHub Actions to a separate credit billed at API prices,
  then paused the change and promised notice [C]. If it returns, headless
  runs stop drawing on the subscription; that is the largest risk to
  awaywork's premise.
- OpenAI documents persisting ChatGPT auth in CI [C]; no explicit statement
  on unattended use found.
