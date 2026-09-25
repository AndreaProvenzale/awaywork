# Lessons from the prototype

night-shift started as a private prototype: scheduled GitHub Actions running
headless Claude Code on one team's leftovers (red CI, review threads, QA
feedback, plans). Everything below was tested there, not read.

## Claude Code on a runner

- Headless Claude Code runs on a GitHub runner with a `claude setup-token`
  token, and the runs bill the subscription, not API credit.
- Differential test: 9 Fable turns (22k output, 227k cached input, $1.76
  list) moved the local `/usage` session window 9% → 13% and the weekly
  window 35% → 36% while the Mac was idle. The JSON result's
  `costBasis: list` says nothing about billing.
- A real fix unit (one PR, 18 bot threads, 7 commits, 49 tool calls,
  ~8 min on Opus) moved the session window 7% → 9%.

## Reading quota

| Where | `claude -p /usage` | `api.anthropic.com/api/oauth/usage` | `rate_limit_event` |
|---|---|---|---|
| Logged-in machine | Works, free, parseable | Not tested | Works |
| Runner with setup-token | Prints cost summary instead | 403, and rate-limited (429, 1 h) | Works |

One Haiku turn reads the plan state anywhere:

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

Identical to `/usage` on the Mac at the same moment. No per-model weekly
window in the event. Every worker's own stream carries it after each
response, so workers can stop themselves at a ceiling.

## Budgeting a night

- Weekly ceiling for tonight: `used + (1 - reserve - used) / nights to
  reset`, reserve 10%. Greedy before the reset, careful after.
- Kill a worker once the week passes the ceiling or the session passes 90%.
  No per-unit estimate needed.
- Fall back to a fixed budget (units per night, turns per unit) when the
  event is missing.
- Units are atomic and ordered; a run that hits the limit just stops.

## Guardrails that held

- The model gets no forge token. A script prefetches PR view, diff,
  threads and failed-check logs into files, clones with credentials
  stripped, and after the model finishes pushes `night/<branch>` and opens
  a draft PR. Never an existing branch, never force, merge or comment.
- Publish a branch only if the model wrote its PR body; write the body
  after the first commit so a killed run still leaves one.
- Commit trailer `Night-shift: <run id>`; a unit whose `night/<branch>`
  still exists is skipped.
- Service integrations need token-based paths: OAuth-only MCP servers
  (claude.ai connectors) do not work with a setup-token; REST with a
  personal token or an MCP with a bearer key does.

## Runners die quietly

Two fix units ended with "The hosted runner lost communication with the
server" after 75–85 min, no log, no artifact. Root cause, found by a
monitor plus an Opus diagnosis pass on the same runner: disk exhaustion
(6 GB yarn cache, 2 GB `node_modules`) plus a whole-repo type check larger
than the 7 GB runner, started as a background task.

- Claude Code background Bash tasks start their own session; a
  process-group kill misses them. Make the worker a child subreaper and
  kill every descendant.
- Watchdog: stop a unit below 1.5 GB memory or 2 GB disk.
- Free ~20 GB of preinstalled SDKs on hosted runners.
- The prompt forbids whole-repo type checks, builds, docker, dev servers
  and background commands; targeted tests on touched files only, and the
  draft PR's CI does the rest.

## What the worker had to discover

The prompt should state these per repo instead:
- Runtime version (`.nvmrc`), install command, CI commands verbatim.
- Bot review findings repeat per run: dedupe by title, answer every copy.
- A red AI-review check can mean the bot's turn cap, not findings.
- Device-only verification is flagged in the PR, never blocked on.
- The PR body states only what was checked; unverified rationale creeps in.
