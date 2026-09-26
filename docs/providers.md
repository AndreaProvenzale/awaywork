# Providers

Can each coding subscription's quota be spent headlessly, on a machine
other than the developer's? Researched from vendor docs, ToS and changelogs.
Tags: **[V]** vendor docs, **[C]** community or press, **[I]** inference.
Anything [C] or [I] that the design depends on needs a burn test like the
Claude one in `lessons.md`.

## Summary

| Provider | Headless credential | Remote | Bills | Quota model | Quota readable | Automation ToS |
|---|---|---|---|---|---|---|
| Claude Code | `claude setup-token`, 1 year, static | Yes, documented for CI [V] | Subscription [V, burn-tested] | 5 h + weekly windows | `rate_limit_event` in stream-json [V, tested] | Stock binary only [V] |
| Codex (ChatGPT plan) | `~/.codex/auth.json`, rotates ~8 days | Yes, "advanced" [V] | Subscription | 5 h + weekly windows; free plan one 30-day window [V, tested] | App-server `account/rateLimits/read` [V, tested] | Own login, no sharing [I] |
| GitHub Copilot CLI | Fine-grained PAT or Actions `GITHUB_TOKEN` | Yes, documented [V] | AI Credits, monthly allowance [V] | Monthly credits | Billing and usage APIs [V] | Low [I] |
| Cursor CLI | `CURSOR_API_KEY` | Yes, documented [V] | Plan pool, then on-demand [C] | Monthly usage | Admin API, Teams only [V] | Low [I] |
| Gemini CLI (AI Pro/Ultra) | Cached OAuth `~/.gemini/oauth_creds.json` | Works, not sanctioned [C] | Subscription only via OAuth [V] | Daily requests | `/stats`, interactive only [V] | **High** [V] |
| Gemini Code Assist | Workload Identity / Vertex | Yes, `run-gemini-cli` [V] | License [V] | Daily requests | No [I] | Low [I] |
| Jules | API key (alpha) | Yes [V] | Plan tasks [I] | Daily tasks | No [I] | Low [I] |
| Kiro (ex Amazon Q CLI) | `KIRO_API_KEY`, Pro plans | Yes, headless mode [V] | Plan credits [I] | Monthly credits | ? | None found |
| Factory Droid | `FACTORY_API_KEY`, `droid exec` | Yes, `droid-action` [V] | Plan pool [I] | 5 h / 7 d / 30 d | ? | None found |
| Amp | `AMP_API_KEY`, `amp -x` | Yes [V] | Credits [V] | Credits | ? | None found |
| Warp (Oz) | `WARP_API_KEY` | Yes, `oz-agent-action` [V] | Credits [V] | Monthly credits | ? | None found |
| Augment (Auggie) | `AUGMENT_SESSION_AUTH` | Yes [V] | Plan credits [V] | Monthly credits | `--show-credits` [V] | One user per token [V] |
| Devin (ex Windsurf) | `DEVIN_API_TOKEN`, `devin -p` | Yes [V] | ACUs; personal plans unclear | Credits | ? | None found |
| Mistral Vibe | `MISTRAL_API_KEY` | Yes [V] | Shared monthly allowance [V] | Monthly | ? | None found |
| JetBrains Junie | Subscription via OAuth only | **Local only** [I] | API key is usage-billed [V] | — | ? | — |
| Z.ai GLM Coding Plan | Plan API key | Technically yes | Subscription [V] | Rolling + weekly | ? | Official tools only, no raw API [V] |
| Kimi Code | Plan API key | Technically yes | Membership [V] | Rate-limited | ? | No User-Agent changes [V] |
| Alibaba Coding Plan (Qwen) | `sk-sp-` key | **Forbidden** | Subscription [V] | 5 h / week / month | ? | No non-interactive use [V] |
| MiniMax Token Plan | `sk-cp-` key | Technically yes | Subscription [V] | Plan | ? | Full ToS not read |
| OpenCode Go | `OPENCODE_API_KEY` | Technically yes | $ caps per 5 h / week / month [C] | Rolling | ? | Not found |

Z.ai, Kimi, MiniMax and Alibaba expose Anthropic-compatible endpoints, so
the stock `claude` binary runs on them with `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN` [V].

## Groups

1. **Static token, remote-ready.** Claude Code, Copilot, Cursor, Kiro,
   Factory, Amp, Warp, Augment, Devin, Mistral. Create once, store as a
   secret.
2. **Rotating login file, remote with care.** Codex, and Gemini on a
   personal plan. One file per machine, serialized runs, write the
   refreshed file back after every run.
3. **ToS-limited.** Alibaba forbids unattended runs; Z.ai and Kimi allow
   only official tools with their real identity.
4. **Local only.** Junie's subscription.

## What matters for night-shift

- **Idle quota only expires on rolling windows.** Claude, Codex, Factory,
  Z.ai, Alibaba, OpenCode Go (hours to a week) and Gemini, Jules (daily)
  lose what a night leaves unused. Monthly credit plans (Copilot, Cursor,
  Amp, Warp, Augment, Mistral) lose it only at month end; scheduling them
  nightly is about capacity, not waste.
- **Always the vendor's unmodified binary with the user's own
  credential.** Never call the backing API with a subscription token,
  never store, pool or proxy other users' credentials, never spoof the
  client identity. Anthropic (enforced since April 2026), Google (bans in
  February 2026) and Z.ai punish exactly that.
- **Vendors ship their own schedulers**: Claude routines, Codex scheduled
  tasks, Cursor Automations, Copilot coding agent via Agentic Workflows,
  Jules scheduled tasks, Warp, Devin Cloud, Factory Missions, Amp Orbs.
  None paces work against remaining quota across providers.

## Per provider

### Claude Code
- `claude setup-token` prints a one-year OAuth token; set
  `CLAUDE_CODE_OAUTH_TOKEN`. Inference only: no Remote Control, no
  claude.ai connectors. `ANTHROPIC_API_KEY` or `apiKeyHelper` outrank it;
  `--bare` ignores it. [V] https://code.claude.com/docs/en/authentication
- `claude-code-action` takes `claude_code_oauth_token`; docs show cron and
  say runs use the subscription. Do not share one token across an org.
  [V] https://code.claude.com/docs/en/github-actions
- Copying `~/.claude/.credentials.json` instead gives a refreshing login
  that eventually needs `/login`. [V]
- ToS: OAuth is for "ordinary use of Claude Code and other native
  Anthropic applications"; third parties may not route requests through
  Pro/Max credentials or "collect, store, or intermediate" them; signing in
  to the unmodified binary with your own subscription is allowed. Limits
  "assume ordinary, individual usage". [V]
  https://code.claude.com/docs/en/legal-and-compliance
- Agent SDK with subscription OAuth is not permitted; enforcement against
  third-party harnesses from 4 April 2026. [C]
  https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546
- Quota: status-line JSON `rate_limits.five_hour` / `seven_day` [V]
  https://code.claude.com/docs/en/statusline; `rate_limit_event` in
  `claude -p --output-format stream-json --verbose` (tested, `lessons.md`).
- `--max-turns` ends the run itself: with 2, the stream stops after two
  model messages with a `result` of subtype `error_max_turns` and exit 1
  (2.1.282). `num_turns` in the result counts more than model messages
  (3 there). [V, tested]
- Skills: a `SKILL.md` folder under `.claude/skills/` in the working
  directory is listed in the `init` event's `skills` and callable by a
  headless run that allows the `Skill` tool (2.1.282). [V, tested]
- Headless runs refuse writes under `.claude/` without a grant, even with
  `Write` allowed (`permission_denied`, `safetyCheck`). [V, tested]
- An empty `GH_CONFIG_DIR` hides a keyring `gh` login. [V, tested]
- Routines: cloud, cron (1 h minimum), API `/fire`, GitHub events; plan
  usage plus a daily run cap. [V] https://code.claude.com/docs/en/routines

### Codex
- `codex login --device-auth`, copy `~/.codex/auth.json`, or forward port
  1455. [V] https://developers.openai.com/codex/auth
- CI with account auth is "advanced"; API keys recommended. Tokens refresh
  about every 8 days and rewrite `auth.json`; "Do not share the same file
  across concurrent jobs or multiple machines". Persist the refreshed file;
  seed only when missing. [V] https://developers.openai.com/codex/auth/ci-cd-auth
- `openai/codex-action` takes API keys only. [V] https://github.com/openai/codex-action
- Quota: `codex app-server` (stdio JSON-RPC: `initialize`, `initialized`,
  then `account/rateLimits/read`) returns `rateLimits.primary` and
  `.secondary`, each `usedPercent` (0–100), `windowDurationMins`,
  `resetsAt` (unix s), plus `planType`. The server does not exit on its
  own. [V, tested 0.149.1] The request names its client: the user agent
  reads `night-shift/<codex version>`. [V, tested]
- On the free plan the only window is `primary`, 43200 min (30 days),
  `secondary` null. Before any use `resetsAt` was now + 30 days; the
  window started at the first run. [V, tested] Plus/Pro show a 5 h
  primary and a weekly secondary. [C]
- Free-plan cost: one trivial `exec` (two shell calls, one edit) moved the
  month 0% → 2%; a small `implement` unit (a typo, a commit, the PR body)
  4% → 9%. So the paced ceiling (~3% a night on a 30-day window) is below
  one unit. [V, tested]
- The first probe refreshed a 12-day-old `auth.json` in place
  (`last_refresh` moved, login still valid). So probes rotate the file
  too and share the per-machine lock with runs. [V, tested]
- `codex exec --json` prints JSONL: `thread.started`, `turn.started`,
  `item.started` / `item.completed` (`agent_message`,
  `command_execution` with `exit_code`, `file_change`, `error`), then
  `turn.completed` with token usage, or `error` and `turn.failed` with
  exit 1. No quota and no turn count in the stream. [V, tested 0.149.1]
- `exec` has no turn cap flag [V, `codex exec --help`]; night-shift
  counts tool calls (commands, edits, MCP calls, web searches) as turns
  and kills the binary past the cap, and re-reads the quota every 10
  tool calls and after the run so a worker stops at its ceiling.
- The `workspace-write` sandbox refuses `.git/index.lock`, so the model
  cannot commit; workers run `--sandbox danger-full-access`, like Claude's
  unsandboxed Bash. [V, tested]
- `--ignore-user-config` skips `config.toml` (MCP servers, notify hooks,
  plugins) while auth still comes from `CODEX_HOME` [V, `--help`; tested];
  `--ephemeral` saves no session. A prompt argument plus piped stdin
  appends stdin, so the prompt goes in on stdin as `-`. [V, `--help`]
- Skills: `.agents/skills` in every directory from the working directory
  up to the repo root [V] https://learn.chatgpt.com/docs/build-skills; a
  `SKILL.md` there was found and followed by a headless `exec`. [V, tested]
  Instructions: `AGENTS.md`, root down to the working directory [V]
  https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Scheduled tasks run in the cloud from web or mobile; desktop tasks on
  local projects need the app running. [V] https://learn.chatgpt.com/docs/automations

### GitHub Copilot
- CLI reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`;
  fine-grained user PAT with "Copilot Requests"; classic PATs fail. [V]
  https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- In Actions, `permissions: copilot-requests: write` replaces the PAT; in
  an org repo it bills the org. [V]
  https://github.blog/changelog/2026-07-02-copilot-cli-no-longer-needs-a-personal-access-token-in-github-actions/
- Premium requests became token-metered AI Credits in June 2026. [V]
  https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- Quota: billing usage REST API and per-user `ai_credits_used`. [V]
  https://docs.github.com/en/billing/tutorials/automate-usage-reporting
- Coding agent can be assigned an issue via API, so cron can drive it;
  Agentic Workflows (gh-aw) support schedules. [V]
  https://github.github.com/gh-aw/reference/auth/

### Cursor
- `CURSOR_API_KEY` or `--api-key`; recommended for CI. [V]
  https://cursor.com/docs/cli/reference/authentication,
  https://cursor.com/docs/cli/github-actions
- Plan-pool billing for CLI keys is not stated in docs. [C]
- Automations: cron or events, billed as cloud-agent usage. [V]
  https://cursor.com/docs/cloud-agent/automations

### Gemini
- Headless reuses cached OAuth; otherwise `GEMINI_API_KEY` or Vertex. [V]
  https://geminicli.com/docs/get-started/authentication/
- AI Pro 1,500 and Ultra 2,000 requests/day via OAuth; an unpaid API key
  gets 250 and not the subscription. [V]
  https://geminicli.com/docs/resources/quota-and-pricing/
- ToS: using the services behind Gemini CLI from third-party software is a
  violation. [V] https://geminicli.com/docs/resources/tos-privacy/ Mass
  bans in February 2026. [C]
  https://github.com/google-gemini/gemini-cli/discussions/20632
- `run-gemini-cli` supports Code Assist, Vertex, WIF, API key; not
  AI Pro OAuth. [V] https://github.com/google-github-actions/run-gemini-cli
- Jules: API with keys, 15/100/300 tasks per day, scheduled tasks in the
  UI only. [V] https://developers.google.com/jules/api,
  https://jules.google/docs/usage-limits/

### Others
- Kiro: https://kiro.dev/docs/cli/headless/ (Amazon Q CLI end of support
  30 April 2027)
- Factory: https://docs.factory.ai/cli/droid-exec/overview,
  https://docs.factory.ai/pricing
- Amp: https://ampcode.com/manual, https://ampcode.com/docs/pricing
- Warp: https://docs.warp.dev/reference/cli/
- Augment: https://docs.augmentcode.com/cli/automation/overview
- Devin: https://docs.devin.ai/cli/reference/commands
- Mistral Vibe: https://docs.mistral.ai/vibe/code/cli/api-keys-profiles
- Junie: https://junie.jetbrains.com/docs/junie-cli.html
- Z.ai: https://docs.z.ai/devpack/usage-policy
- Kimi: https://www.kimi.com/code/docs/en/
- Alibaba: https://www.alibabacloud.com/help/en/model-studio/coding-plan
- MiniMax: https://platform.minimax.io/docs/token-plan/quickstart
- OpenCode Go: https://opencode.ai/docs/go/

## Unverified, burn-test before relying on it

- Cursor: API-key usage draws on the plan pool.
- Kiro: API-key runs draw plan credits.
- Factory: `droid exec` shares the interactive pool.
- Devin: personal-plan CLI billing.
- Codex: Plus/Pro window shape; an app server running beside `exec`
  (the mid-run probe) sharing one `auth.json` safely during a refresh.
- Codex remote: an ephemeral runner seeds `auth.json` from the secret
  every run, so after a refresh the secret's refresh token goes stale.
