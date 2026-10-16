---
description: Research on which coding subscriptions can run headless and remotely, how their quota can be read, and what their terms allow, with claims tagged by evidence.
---

# Providers

Can each coding subscription's quota be spent headlessly, on a machine other than the developer's? Researched from vendor docs, ToS and changelogs. Tags: **[V]** vendor docs, **[C]** community or press, **[I]** inference. Anything [C] or [I] that the design depends on needs a burn test, recorded under [Real runs](#real-runs).

## Summary

| Provider | Headless credential | Remote | Bills | Quota model | Quota readable | Automation ToS |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude setup-token`, 1 year, static | Yes, documented for CI [V] | Subscription [V, burn-tested] | 5 h + weekly windows | `rate_limit_event` in stream-json [V, tested] | Stock binary only [V] |
| Codex (ChatGPT plan) | `~/.codex/auth.json`, rotates at every refresh [V, tested] | Yes, "advanced" [V] | Subscription | 5 h + weekly windows; free plan one 30-day window [V, tested] | App-server `account/rateLimits/read` [V, tested] | Own login, no sharing [I] |
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

Z.ai, Kimi, MiniMax and Alibaba expose Anthropic-compatible endpoints, so the stock `claude` binary runs on them with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` [V].

## Groups

1. **Static token, remote-ready.** Claude Code, Copilot, Cursor, Kiro, Factory, Amp, Warp, Augment, Devin, Mistral. Create once, store as a secret.
2. **Rotating login file, remote with care.** Codex, and Gemini on a personal plan. One file per machine, serialized runs, write the refreshed file back after every run.
3. **ToS-limited.** Alibaba forbids unattended runs; Z.ai and Kimi allow only official tools with their real identity.
4. **Local only.** Junie's subscription.

## What matters for awaywork

- **Idle quota only expires on rolling windows.** Claude, Codex, Factory, Z.ai, Alibaba, OpenCode Go (hours to a week) and Gemini, Jules (daily) lose what a night leaves unused. Monthly credit plans (Copilot, Cursor, Amp, Warp, Augment, Mistral) lose it only at month end; scheduling them nightly is about capacity, not waste.
- **Always the vendor's unmodified binary with the user's own credential.** Never call the backing API with a subscription token, never store, pool or proxy other users' credentials, never spoof the client identity. Anthropic (enforced since April 2026), Google (bans in February 2026) and Z.ai punish exactly that.
- **Vendors ship their own schedulers**: Claude routines, Codex scheduled tasks, Cursor Automations, Copilot coding agent via Agentic Workflows, Jules scheduled tasks, Warp, Devin Cloud, Factory Missions, Amp Orbs. None paces work against remaining quota across providers.

## Per provider

### Claude Code

- `claude setup-token` prints a one-year OAuth token; set `CLAUDE_CODE_OAUTH_TOKEN`. Inference only: no Remote Control, no claude.ai connectors. `ANTHROPIC_API_KEY` or `apiKeyHelper` outrank it; `--bare` ignores it. [V] https://code.claude.com/docs/en/authentication
- `claude-code-action` takes `claude_code_oauth_token`; docs show cron and say runs use the subscription. Do not share one token across an org. [V] https://code.claude.com/docs/en/github-actions
- Copying `~/.claude/.credentials.json` instead gives a refreshing login that eventually needs `/login`. [V]
- ToS: OAuth is for "ordinary use of Claude Code and other native Anthropic applications"; third parties may not route requests through Pro/Max credentials or "collect, store, or intermediate" them; signing in to the unmodified binary with your own subscription is allowed. Limits "assume ordinary, individual usage". [V] https://code.claude.com/docs/en/legal-and-compliance
- Agent SDK with subscription OAuth is not permitted; enforcement against third-party harnesses from 4 April 2026. [C] https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546
- Anthropic announced moving `claude -p`, the Agent SDK and GitHub Actions to a separate credit billed at API prices, then paused the change and promised notice. If it returns, headless runs stop drawing on the subscription. [C]
- Quota: status-line JSON `rate_limits.five_hour` / `seven_day` [V] https://code.claude.com/docs/en/statusline; `rate_limit_event` in `claude -p --output-format stream-json --verbose` (tested, [Real runs](#real-runs)).
- `--max-turns` ends the run itself: with 2, the stream stops after two model messages with a `result` of subtype `error_max_turns` and exit 1 (2.1.282). `num_turns` in the result counts more than model messages (3 there). [V, tested]
- Skills: a `SKILL.md` folder under `.claude/skills/` in the working directory is listed in the `init` event's `skills` and callable by a headless run that allows the `Skill` tool (2.1.282). [V, tested]
- What `claude -p` loads, checked offline with a fake `HOME` and a stub API (2.1.284). With no flag: user and project `CLAUDE.md`, user and project skills, `SessionStart` hooks from `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`, MCP servers from `~/.claude.json` and an unapproved `.mcp.json` (both started), and auto-memory under `~/.claude/projects/`. `--setting-sources project,local` drops every user-scope item but auto-memory; `--setting-sources ''` drops the project ones too except `.mcp.json`, which only `--strict-mcp-config` drops; `--settings '{"autoMemoryEnabled":false}'` drops auto-memory. `--add-dir` loads no skills under `--setting-sources ''`. [V, tested] User plugins are enabled from user settings, so they go with them. [I] Workers run `project,local` on the developer's own branches and `''` with `--strict-mcp-config` on someone else's PR and in the probe, all without auto-memory.
- Under `--setting-sources ''`, checked the same way (2.1.284): a `--plugin-dir` folder with `.claude-plugin/plugin.json` named `nightshift` and `skills/<name>/SKILL.md` lists `nightshift:<name>` in the `init` event's `skills`, while the clone's `.claude/skills/` stays out; a `SessionStart` hook in the `--settings` JSON runs. [V, tested] Named `awaywork` since the rename. [I] So workers get their skills as that plugin, outside the clone, and the developer's `settings` file merged into the `--settings` JSON.
- Headless runs refuse writes under `.claude/` without a grant, even with `Write` allowed (`permission_denied`, `safetyCheck`). [V, tested]
- An empty `GH_CONFIG_DIR` hides a keyring `gh` login. [V, tested]
- Sandbox, checked on macOS with a stub API (2.1.284): `claude -p --settings '{"sandbox":{"enabled":true}}'` runs Bash with network denied (`deny network-outbound` in the tool result) and writes limited to the working directory; `git commit` there works. A Bash call with `dangerouslyDisableSandbox` is refused headless, and with `allowUnsandboxedCommands: false` runs sandboxed anyway. Sandboxed Bash can't write `.claude/settings.json` or `.claude/settings.local.json`. Project settings merge in: their `sandbox.enabled: false` loses to the flag, but their `sandbox.network.allowedDomains` or a `WebFetch(domain:…)` allow rule opens those domains. [V, tested] The binary says a missing sandbox backend runs the shell unconfined unless `sandbox.failIfUnavailable` is true [V, binary strings]; the Linux backend (bubblewrap) is not tested.
- The sandbox covers Bash, PowerShell and Monitor only; Read, Edit and Write are held by permission rules. Hooks and MCP servers run outside it. On Linux it needs bubblewrap and socat, and Ubuntu 24.04+ AppArmor stops bubblewrap creating user namespaces without a profile for it. [V] https://code.claude.com/docs/en/sandboxing Whether GitHub's `ubuntu-latest` runner has them is not checked, so offline there may fail to start [I].
- MCP servers, checked on macOS with a stub API, a stdio echo server and a streamable-HTTP one (2.1.289): `--mcp-config` takes the `{"mcpServers":…}` JSON as a string. Its servers load under `--setting-sources project,local`, and under `--setting-sources '' --strict-mcp-config`, which still drops the clone's `.mcp.json`. `${VAR}` expands from the binary's env in `env` and in `headers` (`Bearer ${VAR}` reached the server). A stdio server inherits the binary's whole env, so a secret meant for one server reaches every server and the worker's Bash. `--allowedTools mcp__<server>` allows all of a server's tools; `mcp__<server>__<tool>` allows just that one. A tool outside the list is denied. In three of the first runs `permissionMode` read `auto` in the `init` event, where a classifier rules on unlisted tools, and `default` in every later one, with identical flags. `--permission-mode dontAsk` denies unlisted tools in every run and still runs the listed ones, so workers pin it. With the offline sandbox, the stdio server fetched a local port and the HTTP server was reached: neither is sandboxed. [V, tested]
- Routines: cloud, cron (1 h minimum), API `/fire`, GitHub events; plan usage plus a daily run cap. [V] https://code.claude.com/docs/en/routines

### Codex

- `codex login --device-auth`, copy `~/.codex/auth.json`, or forward port 1455. [V] https://developers.openai.com/codex/auth
- CI with account auth is "advanced"; API keys recommended. Tokens refresh about every 8 days and rewrite `auth.json`; "Do not share the same file across concurrent jobs or multiple machines". Persist the refreshed file; seed only when missing. [V] https://developers.openai.com/codex/auth/ci-cd-auth
- `openai/codex-action` takes API keys only. [V] https://github.com/openai/codex-action
- Quota: `codex app-server` (stdio JSON-RPC: `initialize`, `initialized`, then `account/rateLimits/read`) returns `rateLimits.primary` and `.secondary`, each `usedPercent` (0–100), `windowDurationMins`, `resetsAt` (unix s), plus `planType`. The server does not exit on its own. [V, tested 0.149.1] The request names its client: the user agent reads `night-shift/<codex version>`. [V, tested] Now `awaywork/<codex version>`. [I]
- On the free plan the only window is `primary`, 43200 min (30 days), `secondary` null. Before any use `resetsAt` was now + 30 days; the window started at the first run. [V, tested] Plus/Pro show a 5 h primary and a weekly secondary. [C]
- Free-plan cost: one trivial `exec` (two shell calls, one edit) moved the month 0% → 2%; a small `implement` unit (a typo, a commit, the PR body) 4% → 9%; ten tool calls of a `review` that read a 1,000-line diff 9% → 20%. So the paced ceiling (~3% a run on a 30-day window, with one run a day) is below one unit. [V, tested]
- The access token lasts 10 days (`exp - iat` of the JWT) and `auth.json` says when it was last refreshed. [V, tested]
- The first probe refreshed a 12-day-old `auth.json` in place (`last_refresh` moved, login still valid). So probes rotate the file too and share the per-machine lock with runs. [V, tested]
- A refresh fires when the access token expires, not when `last_refresh` is 8 days old as the CI guide says, and every refresh rotates the refresh token. [V, tested 0.162.1]
- A replaced refresh token still refreshed 8 s, ~6 min and ~30 min later, and the live login kept working beside it. After ~27 h it failed with "refresh token was already used", and the live login still refreshed. So a secret seeded on an ephemeral runner fails the night after its first refresh. [V, tested 0.162.1]
- Several `codex login --device-auth` on one account coexist: a new login revokes none, and `codex logout` of one leaves the others working. On macOS the default credential store writes `auth.json`. [V, tested 0.162.1]
- `codex exec --json` prints JSONL: `thread.started`, `turn.started`, `item.started` / `item.completed` (`agent_message`, `command_execution` with `exit_code`, `file_change`, `error`), then `turn.completed` with token usage, or `error` and `turn.failed` with exit 1. No quota and no turn count in the stream. [V, tested 0.149.1]
- `exec` has no turn cap flag [V, `codex exec --help`]; awaywork counts tool calls (commands, edits, MCP calls, web searches) as turns and kills the binary past the cap. The quota is read after the run, once `exec` has exited: an app server started beside a running `exec` would share `auth.json` and could race a token refresh [I]. So a Codex worker stops at its ceiling only between units, never mid-run.
- The `workspace-write` sandbox refuses `.git/index.lock`, so the model cannot commit; workers run `--sandbox danger-full-access`, like Claude's unsandboxed Bash. [V, tested]
- Network off with `.git` writable (0.149.1, macOS, `codex sandbox` and `codex exec` on a stub Responses API): `workspace-write` blocks the network, and `sandbox_workspace_write.writable_roots` doesn't reopen `.git`. A permission profile passed with `-c` does: `default_permissions="night"`, `permissions.night.filesystem` with `":root"="read"`, the clone and `<clone>/.git` as `"write"`, and `permissions.night.network.enabled=false` commits, blocks `curl` and blocks writes outside the clone. Without the explicit `.git` entry `.git` stays read-only. `--sandbox` overrides the profile, so it must be left out. `-c web_search="disabled"` drops the hosted `web_search` tool from the request. [V, tested] Linux (Landlock) not tested.
- `-c sandbox_mode="danger-full-access"`, before or after the profile, doesn't reopen the network or writes outside the clone; alone it does. Neither does an earlier `permissions.night.network.enabled=true`, and a `profile` key is refused (0.149.1, macOS, `codex exec` on a stub). [V, tested]
- `--ignore-user-config` skips `config.toml` (MCP servers, notify hooks, plugins) while auth still comes from `CODEX_HOME` [V, `--help`; tested]; `--ephemeral` saves no session. A prompt argument plus piped stdin appends stdin, so the prompt goes in on stdin as `-`. [V, `--help`]
- MCP servers (0.160.0, macOS, `codex exec` on a stub Responses API, isolated `CODEX_HOME`, `env -i`):
  - `-c mcp_servers.<name>.command|args|env|env_vars|url|bearer_token_env_var|http_headers|env_http_headers|enabled_tools` registers a server under `--ignore-user-config`, and TOML arrays and inline tables work through `-c`. A server gets only the variables `env_vars` forwards, plus `HOME` and `PATH`. `shell_environment_policy.exclude` hides those variables from the model's shell while the server still gets them.
  - `enabled_tools` drops the other tools from the request; a forced call to one is refused.
  - `exec` never prompts: a call that needs approval fails at once with "MCP tool call requires approval, but approval policy is never". Under `--sandbox danger-full-access` every tool runs. Under the offline permission profile only tools annotated `readOnlyHint` run, unless the server sets `default_tools_approval_mode="approve"`.
  - Under the offline profile the stdio server still fetched the network and wrote outside the clone, and the HTTP server was reached.
  - A server that fails to start or times out (default about 10 s) is dropped silently, with exit 0, so workers set `startup_timeout_sec` to 60.
  - An `item.completed` of type `mcp_tool_call` carries `server`, `tool`, `arguments`, `result`, `error` and `status`. [V, tested]
- Skills: `.agents/skills` in every directory from the working directory up to the repo root [V] https://learn.chatgpt.com/docs/build-skills; a `SKILL.md` there was found and followed by a headless `exec`. [V, tested] Whether `exec` reads skills from anywhere outside the clone under `--ignore-user-config` is unchecked [I], so workers still get theirs copied into the clone. `-c key=value` overrides a config value, parsed as TOML [V, `codex exec --help`]; that it applies under `--ignore-user-config` is [I]. Instructions: `AGENTS.md`, root down to the working directory [V] https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Scheduled tasks run in the cloud from web or mobile; desktop tasks on local projects need the app running. [V] https://learn.chatgpt.com/docs/automations

### GitHub Copilot

- CLI reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`; fine-grained user PAT with "Copilot Requests"; classic PATs fail. [V] https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli
- In Actions, `permissions: copilot-requests: write` replaces the PAT; in an org repo it bills the org. [V] https://github.blog/changelog/2026-07-02-copilot-cli-no-longer-needs-a-personal-access-token-in-github-actions/
- Premium requests became token-metered AI Credits in June 2026. [V] https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- Quota: billing usage REST API and per-user `ai_credits_used`. [V] https://docs.github.com/en/billing/tutorials/automate-usage-reporting
- Coding agent can be assigned an issue via API, so cron can drive it; Agentic Workflows (gh-aw) support schedules. [V] https://github.github.com/gh-aw/reference/auth/

### Cursor

- `CURSOR_API_KEY` or `--api-key`; recommended for CI. [V] https://cursor.com/docs/cli/reference/authentication, https://cursor.com/docs/cli/github-actions
- Plan-pool billing for CLI keys is not stated in docs. [C]
- Automations: cron or events, billed as cloud-agent usage. [V] https://cursor.com/docs/cloud-agent/automations

### Gemini

- Headless reuses cached OAuth; otherwise `GEMINI_API_KEY` or Vertex. [V] https://geminicli.com/docs/get-started/authentication/
- AI Pro 1,500 and Ultra 2,000 requests/day via OAuth; an unpaid API key gets 250 and not the subscription. [V] https://geminicli.com/docs/resources/quota-and-pricing/
- ToS: using the services behind Gemini CLI from third-party software is a violation. [V] https://geminicli.com/docs/resources/tos-privacy/ Mass bans in February 2026. [C] https://github.com/google-gemini/gemini-cli/discussions/20632
- `run-gemini-cli` supports Code Assist, Vertex, WIF, API key; not AI Pro OAuth. [V] https://github.com/google-github-actions/run-gemini-cli
- Jules: API with keys, 15/100/300 tasks per day, scheduled tasks in the UI only. [V] https://developers.google.com/jules/api, https://jules.google/docs/usage-limits/

### Others

- Kiro: https://kiro.dev/docs/cli/headless/ (Amazon Q CLI end of support 30 April 2027)
- Factory: https://docs.factory.ai/cli/droid-exec/overview, https://docs.factory.ai/pricing
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

## Real runs

What real runs showed. The prototype was a private set of scheduled GitHub Actions running headless Claude Code on one team's leftovers.

### Claude Code on a hosted runner

- A `claude setup-token` token runs headless Claude Code on a GitHub runner, billed to the subscription: 9 Fable turns (22k output, 227k cached input, $1.76 list) moved the session window 9% → 13% and the weekly window 35% → 36% while the developer's machine was idle. The result's `costBasis: list` says nothing about billing. [V, prototype]
- A real fix unit (one PR, 18 bot threads, 7 commits, 49 tool calls, ~8 min on Opus) moved the session window 7% → 9%. [V, prototype]
- Reading quota: [V, prototype]

  | Where | `claude -p /usage` | `api.anthropic.com/api/oauth/usage` | `rate_limit_event` |
  | --- | --- | --- | --- |
  | Logged-in machine | Works | Not tested | Works |
  | Runner with setup-token | Prints a cost summary instead | 403, then 429 for 1 h | Works |

  One Haiku turn reads it anywhere:

  ```sh
  claude -p "reply ok" --model claude-haiku-4-5-20251001 --max-turns 1 \
    --output-format stream-json --verbose \
    | jq -c 'select(.type == "rate_limit_event") | .rate_limit_info' | tail -1
  ```

  ```json
  {"status":"allowed","rateLimitType":"five_hour","unifiedWindows":{
   "five_hour":{"utilization":0.02,"resetsAt":1790254200},
   "seven_day":{"utilization":0.36,"resetsAt":1790391600}}}
  ```

  Identical to `/usage` on the same machine at the same moment, with no per-model weekly window. A worker's own stream carries it after each response.

- OAuth-only MCP servers (claude.ai connectors) don't work with a setup-token; REST with a personal token, or an MCP server with a bearer key, does. [V, prototype]

### Runners die quietly

Two fix units ended with "The hosted runner lost communication with the server" after 75–85 min, with no log and no artifact. A monitor and a diagnosis pass on the same runner found disk exhaustion (6 GB yarn cache, 2 GB `node_modules`) plus a whole-repo type check larger than the 7 GB runner, started as a background task. [V, prototype] What came out of it: the action frees about 20 GB of preinstalled SDKs (`action.yml`), a watchdog stops a unit below 1.5 GB of memory or 2 GB of disk, and the harness forbids whole-repo checks, builds and background commands.

- Claude Code's background Bash tasks start their own session, so a process-group kill misses them. [V, prototype] They stay children of `claude` while it runs. [I]
- Node can't become a child subreaper without a native addon, and a cgroup needs a delegated subtree or root, which a laptop run doesn't have. [I] So the watchdog polls `ps` every 2 s and at the end kills each recorded descendant still alive with the same start time: a detached grandchild whose parent exited is killed [V, tested on macOS; the same test runs on Linux in CI]. One born and orphaned between two polls escapes. [I]
- Memory is `process.availableMemory()`: on macOS it matched `vm_stat` free + inactive + speculative (45 GB against 44 GB), where `os.freemem()` counted free pages only (24 GB). [V, tested] On Linux libuv reads `MemAvailable`, capped by the cgroup limit. [C]
- Disk is `statfs` on the clone's filesystem. [V]

### awaywork's burn tests

- One Claude unit (Claude Code 2.1.282, the developer's login, `implement` on an issue of this repo, a 3% cap per run): 57 s, 6 turns, one commit and a PR body. The publisher pushed a new branch and opened a draft PR with the footer and the trailer, and the next `plan` skipped the issue as waiting for review. Neither window moved at 1% resolution, so stopping at the ceiling wasn't exercised. A new issue took a few seconds to show up in GitHub search. [V, tested]
- Two providers (`providers: [codex, claude]`, Codex 0.149.1 on a free ChatGPT plan, Claude Code 2.1.283, a 3% cap per run, `review` with `deliver: report` on two PRs): Codex took the first unit, read its month at 20% against an 11.7% ceiling and was stopped after 1 min 30 s, keeping the report it had written. The second unit was re-routed to Claude, which finished in 28 turns (session 9% → 11%, week unmoved). The first probe refreshed a 12-day-old `auth.json`, and the login stayed valid. That build read Codex's quota mid-run, outside the lock; it now reads it after the run. [V, tested]

## Unverified, burn-test before relying on it

- Cursor: API-key usage draws on the plan pool.
- Kiro: API-key runs draw plan credits.
- Factory: `droid exec` shares the interactive pool.
- Devin: personal-plan CLI billing.
- Codex: Plus/Pro window shape; whether an app server beside a running `exec` can share one `auth.json` safely, which a mid-run quota read needs. Two refreshes minutes apart both succeed [V, tested], but two processes writing one file at once was not tested.
- Offline workers on Linux: Claude's bubblewrap sandbox and Codex's Landlock profile were only tested on macOS.
- Codex remote: how an ephemeral runner saves the refreshed `auth.json` back to its secret; the workflow's `GITHUB_TOKEN` cannot write secrets.
