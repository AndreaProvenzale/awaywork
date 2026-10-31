---
name: suggest
description: "Suggest awaywork queue rules, routines and instruction fixes from what the developer already does: with their consent each run, read their recent coding-agent sessions and forge history for work they keep doing after the same kind of event or at the same time each week, and check each candidate on their real items. Use when they ask what awaywork could take off their plate, or say yes to the offer on first setup."
---

# awaywork suggest

Find the work the developer hands to an agent by reflex, right after something happens on one of their items (CI goes red on their PR, a review lands) or at the same time each week, plus the corrections they keep repeating. Propose each as awaywork config, checked on their real items, and write only what they pick, through the queue skill. Docs: https://andreaprovenzale.github.io/awaywork/guide/suggest.md

## Ground rules

- **Ask first, every run.** Read no session before the developer has said which projects, how far back and which agents' histories (step 1). Nothing turns this on for good.
- **One scope.** Use only the projects they named. Work and personal never mix: a session from another project never feeds a candidate, even when it sits next to one in scope.
- **Paraphrase only.** Sessions hold pasted tokens, customer data and secrets. Evidence is a count and a paraphrase in your words, never a quote, a path or output from inside a session, and nothing from one goes verbatim into a rule, a line or the chat. Keep digests out of the chat too: they carry prompt text.
- **Read-only.** Read sessions where they are, never copy them; put digests in a temp dir and delete it at the end. Forge CLIs only read.
- **Nothing written but what they pick,** through the queue skill's loop. Its ground rules hold here: no credentials, no runs, real names only, widening needs its own yes.

## 1. Ask

Read the config as the queue skill's step 1 does. Then count what's in scope from file names and dates, plus, for Codex, each file's first line (`cwd`, `originator`) and whether it has a `turn_context` line (step 2 says where), and ask in one message:

- **Projects:** default the repos in the config, as the local folders their sessions ran in. Ask for the folder when you can't tell.
- **Window:** default the last 30 days. Under 3 weeks finds no routines (step 4 wants 3 different weeks): say so.
- **Histories:** which agents' sessions, of those you found. Reading another vendor's sessions sends them to yours: say so by name, e.g. "Codex sessions I read go to Anthropic".
- **Size:** what that is, e.g. "84 Claude Code sessions (31 MB) in 1 folder; no Codex sessions there".

Wait for a yes or their changes.

## 2. Find the sessions

Formats are the vendors' and change: check one real file before trusting the notes below, and adjust.

**Claude Code** keeps one `<session-id>.jsonl` per session in `~/.claude/projects/<slug>/`, and in `$CLAUDE_CONFIG_DIR/projects/<slug>/` when that's set: both can hold sessions, so count a `sessionId` once. The slug is the folder the session started in with every character but letters and digits as `-` (`/Users/me/src/api` is `-Users-me-src-api`). Take the slugs that start with the slug of the project or of one of its worktrees (`git worktree list` in the project names them, sibling folders too), then keep the sessions whose `cwd` is one of those folders or under it, since `-Users-me-src-api-docs` starts with it too. Skip:

- awaywork's own workers: slugs with `-local-state-awaywork-runs-` in them, and any session whose `entrypoint` is `sdk-cli` (headless `claude -p`: awaywork's workers, scripts, CI);
- subagent transcripts, `<session-id>/subagents/*.jsonl`, and lines with `isSidechain: true`: they repeat their parent;
- this session and earlier suggest runs, by their `first`: `/awaywork:suggest …`, or the `/awaywork:queue …` prompt that opened this session when it came through the queue skill's offer, or one asking in words for awaywork suggestions; and this session by its id when you know it. Not by "the newest file": other sessions may be open in the same project.

User and assistant lines carry `sessionId`, `timestamp`, `cwd`, `gitBranch` and `entrypoint`. A typed prompt is a `user` line whose `message.content` is a string, or text and pasted image blocks (newer versions add `origin.kind: human`); tool results are `user` lines too, holding `tool_result` blocks, and a slash command is `<command-name>` and `<command-args>` tags. A `pr-link` line (`prUrl`, `prRepository`, `prNumber`) names a PR the session worked on, which beats `gitBranch` when the developer works from subagents' worktrees and stays on the default branch. An interrupted turn is a user text block starting `[Request interrupted by user` (`… for tool use]` when it stopped a tool call); a tool call they rejected is a `tool_result` with `is_error: true` starting `The user doesn't want to proceed with this tool use`. A rejection with `permissionDecision.source: config` came from a permission rule or classifier, not from them.

`jq -nc -f scripts/claude-sessions.jq <file>`, the script beside this file, run once per file, prints one line per interactive session: `session`, `start`, `cwd`, `branch`, `prs`, `first` (the opening prompt, cut at 200 characters), `turns` (typed prompts), `interrupted`, `rejected` and `after_edit` (typed prompts right after the agent edited files).

**Codex** keeps `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (`$CODEX_HOME/sessions` when set). The first line is `session_meta`, whose `payload` has `id`, `timestamp`, `cwd`, `git.branch`, `git.repository_url` and `originator`; skip `codex_exec`, headless `codex exec`, where awaywork's workers run. Skip a file with no `turn_context` line too: that's a Claude Code session Codex Desktop imported, every line stamped in the minute the import ran, so it would count twice and form a fake same-hour cluster. A typed prompt is an `event_msg` line with `payload.type: user_message`, its text in `payload.message`; newer files (`history_mode: paginated`) have none and hold it as a `response_item` `message` with `role: user`, in `input_text` blocks mixed with injected ones starting `<` or `# AGENTS.md`. An interrupted turn is a `turn_aborted` event, unconfirmed in real files: treat a count of 0 as unknown. `jq -nc -f scripts/codex-sessions.jq <file>`, once per file, skips the files above and prints `session`, `start`, `cwd`, `branch`, `first`, `turns` and `aborted`.

**Another agent:** find its history folder, check one file and pull the same fields.

## 3. Prefilter

Digest every session in scope; open none in full yet. Correction signals that work in any language come first: an interrupted turn, a rejected tool call, a typed prompt right after the agent edited files. That last one is as often "now do the next bit" as a correction, so it says which sessions to read, not what was corrected. Keywords ("no,", "don't", "always", "instead", in the developer's language) only add weight.

Then the forge, per repo in scope, read-only. On GitHub, with `<since>` the window's first day:

```sh
gh pr list -R <repo> --author @me --state all --search "created:>=<since>" --limit 300 --json number,title,headRefName,createdAt,mergedAt,state,reviews --jq '.[] | .reviews |= map({author: .author.login, state, submittedAt})'
gh issue list -R <repo> --author @me --state all --search "created:>=<since>" --limit 300 --json number,title,createdAt,closedAt,labels
gh run list -R <repo> --status failure --created ">=<since>" --limit 300 --json headBranch,createdAt,workflowName,event
gh pr list -R <repo> --state all --search "reviewed-by:@me -author:@me updated:>=<since>" --limit 300 --json number,title,author,headRefName,createdAt,updatedAt
```

Their own PRs with the reviews on them (trimmed: a review's body is someone else's text) and issues (`--assignee @me` too), the failed runs, and the reviews they gave, which map to `review` with `deliver: pending_review`. Not their replies on other people's threads: awaywork has no action there that isn't commenting on someone's behalf. Elsewhere, the forge CLI's equivalent (`glab` on GitLab).

## 4. Join and cluster

- **Session to item:** its `pr-link`, else the repo of its `cwd` and its `gitBranch` as a PR's `headRefName`. **Session to event:** the last forge event on that PR or branch before the session started, within a day: a failed run, a review on their PR, a PR they reviewed (joined by its `headRefName`, its `createdAt` as the time), a merge.
- **Time candidates:** a session on the default branch with no PR or event near it. Same weekday and hour, give or take one, in at least 3 different weeks. Timestamps are UTC and a routine's `at` and `days` local: convert first.
- **Cluster** similar asks under the same trigger: the same kind of action on the same kind of item. One is worth reading at 3 sessions, or 3 weeks for a time pattern.
- **Read** two or three full sessions per worthwhile cluster, no more, to learn the action and what got corrected. Where your agent has subagents, give each cluster to one and ask for a paraphrase back (what was asked, after what, what was corrected, how often), never quotes.
- **Forge alone counts:** a commit they pushed onto their own PR soon after its CI went red is the pattern even with no session behind it.
- **No trigger, no candidate:** a pattern awaywork can't see the start of ("when someone asks in chat") is dropped. Say how many you dropped, not what they were.

## 5. Map

| Pattern | Becomes |
| --- | --- |
| Event on an item, then an action | A queue rule: a `where` on a configured source, with real names from `awaywork sources --json` as in the queue skill's step 3 (fields per source: https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#items), and a skill |
| Same time each week, then an action | A routine, `sources.routines.<name>: { days, at, repo, title, description }`, and a rule with `source: routines`, `where: { name: <name> }` and `deliver: report`; `run: soon` when it shouldn't wait for a window (https://andreaprovenzale.github.io/awaywork/guide/configuration.md#routines) |
| The action | A skill from `awaywork skills list`: built-in, ejected, or the repo's own |
| A correction every agent on the repo needs | A line in the repo's `AGENTS.md`, or `CLAUDE.md` when that's what it has |
| A correction only awaywork's workers need | A line in an awaywork `instructions` file, global or per repo |
| A correction already written down, still made | A command instead of a second line: `repos.<repo>.verify` for a check every slice should pass, like `pnpm lint`, or a command gate when a human should look |

Compare every candidate with what's there: the queue (or the default queue, when `plan --rules --json` says `defaultQueue: true`), the routines, the instructions files, the repo's `AGENTS.md` and `CLAUDE.md`. A match is shown as "already rule #2" or "already in AGENTS.md", not proposed again.

A routine spends quota on every occurrence, work or not: show its units per week (days times times of day), and end its `description` with "stop with a one-line report when there's nothing new". A candidate that widens delivery or exposure, as the queue skill's Widening section lists, is flagged as such.

## 6. Verify

Copy the config to a draft as the queue skill's step 4 does and add every rule and routine candidate. `awaywork --config <draft> plan --rules --json` gives, per rule, what it takes now (`taken`), what an earlier rule takes first (`takenBy`), and the `unmatched` items that fit the pattern, with the reason. A new routine's latest occurrence shows up as taken: it runs at the next window, or within minutes with `run: soon`. A config error goes to stderr: fix the candidate or drop it. Then, once for the whole draft, `awaywork --config <draft> doctor --json` and `awaywork --config <draft> plan --json`, whose `routines` holds each routine's next occurrence by name; both probe quota, so not per candidate.

For a correction, check the target file for the line, or one meaning the same.

## 7. Show and pick

Numbered candidates in three groups, each with its evidence as a count and where it came from, the config it becomes, and what it takes now:

```text
Looked at 30 days: 84 Claude Code sessions in 1 repo, 143 PRs and 20 failed runs on GitHub.

Rules
  1  fix my red PRs                      seen 6×   sessions + forge
     where: { type: pr, mine: true, checks: failing }   (already rule #1)
  2  review PRs that ask for me          seen 4×   forge
     where: { type: pr, review_requested: true }   deliver: pending_review (widens: leaves your pending review)
     takes now: acme/web#19

Routines
  3  triage Sentry for acme/api          4 Mondays, ~09:00   sessions
     routines.sentry-triage: { days: [mon], at: "09:00", repo: acme/api }
     skill: triage   deliver: report   1 unit a week
     takes now: sentry-triage-20261026-0900   next: Mon 2 Nov 09:00

Corrections
  4  run the formatter before committing  corrected in 5 sessions
     already in AGENTS.md, still corrected → repos.acme/api.verify: pnpm lint

Keep which? (e.g. 2, 3, 4)
```

Nothing found in a group: say so in one line, and under 3 weeks just "no routines: window too short", without what fell short. The developer accepts, tweaks or declines each. Accepted rules and routines go through the queue skill's steps 4 to 7 (draft, check, write, validate), starting from the draft above with the declined ones taken out; widening still needs its own yes. A correction: show the file and the exact line, and edit only on a yes; it's a local change they commit themselves. Nothing declined is written, and nothing is remembered: a declined candidate comes back next run.

## End

Delete the temp digests. Summarize in a few lines what was added where, and say they can run `/awaywork:suggest` (or ask for awaywork suggestions) again whenever their habits change; nothing reminds them.

Report only changes you actually made, naming each file; don't describe a file you didn't touch.
