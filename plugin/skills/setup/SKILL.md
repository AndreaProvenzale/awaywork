---
name: setup
description: "Sets awaywork up when it has no config: agents, the repos from the developer's recent sessions, trackers and a first queue checked on their real items. Reached through the away skill, which routes here."
user-invocable: false
---

# awaywork setup

There's no config yet: write one with the developer, asking as few times as you can, check it on their real items, and write it only on their yes. The ground rules in the [`away`](../away/SKILL.md#ground-rules) skill hold throughout (no credentials through you, real names only, widening shown on its own): invoke it first if it isn't loaded.

`<config>` is the path `awaywork config path` printed; `<draft>` is `config.draft.yml` in the same folder, made with `mkdir -p` on a first setup. Every command on the draft takes `--config <draft>`.

## 1. Look around

Nothing here needs the developer. Run these together:

- `awaywork doctor --json`: an array of `{ status, what, detail }`: `gh` and `gh login`, the config's `FAIL`, then each agent CLI, `ok` with its version or `warn` with why not (not installed; Cursor without `CURSOR_API_KEY`). No gh login: awaywork reads and writes GitHub through it, so it's the developer's `gh auth login`; wait.
- `awaywork sources github --json`: their `login` and `orgs`.
- `sh scripts/folders.sh 30`, the script beside this file: the folders their interactive Claude Code and Codex sessions ran in over the last 30 days, a header, then one tab-separated line per agent and folder: agent, sessions, MB, memories (Claude Code's memory files for that folder, `-` for Codex), folder, and its repo (`owner/repo` on github.com, else the remote's URL, `-` for none); then, under `user-level files`, the global `CLAUDE.md`, `rules/*.md` and Codex `AGENTS.md` that exist. It reads only each file's metadata (`cwd`, the remote) and file names, never what a session or a memory says: that waits for suggest's consent. Another agent's history: find where it keeps its sessions and take the folder from their metadata the same way.

Propose the GitHub repos those folders map to, grouped by owner, the owner with most sessions first, each repo with its count. Owners outside their login and orgs are in the list too, marked: this gh login may not reach them. Work and personal usually get a config each, as suggest keeps them apart: one config covers the owners they pick. `<login>/*` or `<org>/*` covers every repo of an owner, for when they work on most of them. A remote that isn't github.com is listed apart, never in a default, and you don't guess what it is: an ssh alias (`git@<alias>:owner/repo`) stays out until they name its repo; a Bitbucket Cloud repo is awaywork's `bitbucket` source, which this setup doesn't write (https://andreaprovenzale.github.io/awaywork/guide/configuration.md#bitbucket-and-jira).

## 2. Ask once

One message, each question with its default:

- **Providers:** the agent CLIs doctor found, the first taking units first and the next taking over when its quota runs out. Cursor also needs `CURSOR_API_KEY`: doctor says when it's missing.
- **Repos:** which owners this config is for, default the one with most sessions, then those owners' repos as listed, theirs to edit; `owner/*` only when they ask for it.
- **Trackers:** do tasks also come from Asana, Linear or Jira? For Jira, its Cloud site (`acme.atlassian.net`), their Atlassian email, and whether the API token is scoped (created "with scopes").
- **Window:** when runs may happen, default 01:00–07:00 their time.
- **First rules:** suggest them from their recent sessions and PRs, or start from awaywork's default rules? The default rules are the default: reading their sessions takes a yes. Give the scope as [`suggest`](../suggest/SKILL.md)'s step 1 asks it, from what you found: only the folders of the chosen owners' repos, the last 30 days, and which agents' sessions and memories, plus each user-level file by name. Say who reads them: everything you read goes to your vendor, another vendor's sessions too ("the sessions and memories I read go to Anthropic"); never say it stays on this machine. The size, summed from `folders.sh`'s lines for the default owner, in its units: "84 Claude Code sessions (31.4 MB) in 3 folders, 12 memory files and your global `CLAUDE.md`; no Codex sessions there". Their yes is suggest's consent for this run, for the owners they chose: it won't ask again.

## 3. Draft

Let the CLI render it, as `awaywork init` writes a config, comments and all:

```sh
awaywork --config <draft> init --yes --provider <theirs, first first> --source github --window <start>-<end>
```

It writes the providers, `github: {repos: [<login>/*]}`, the default GitHub rules and the window; ignore its `Next:` line. Then edit `sources.github.repos` in the draft to their list. A draft left by an earlier setup makes it refuse: ask whether to carry on from that draft or start over (`--force`).

## 4. Trackers

For each tracker they named, `awaywork --config <draft> sources <id> --json`. Jira's site and email are config, not flags: add `jira: {site: <site>, email: <email>}` under the draft's `sources` first, plus `cloud_id` for a scoped token (`curl -s https://<site>/_edge/tenant_info` prints its `cloudId`, no credentials needed).

A token it lacks fails naming its variable (`ASANA_TOKEN`, `LINEAR_API_KEY`, `JIRA_API_TOKEN`): for every missing one, in one message, give both ways to put it in: in their own terminal, `awaywork secret <NAME>`, which asks without echoing; here in Claude Code, copy the token, then `! pbpaste | awaywork secret <NAME>`. Say where each is made (Asana: Settings > Apps; Linear: Settings > Account > Security & access; Jira: id.atlassian.com > Security > API tokens, scoped to `read:jira-work`), wait, and rerun.

Then ask, in one message and from the real names, only this: Asana's workspace when there are several, and its projects to watch (none: every project with their tasks); Linear's teams and Jira's projects whose issues have code in a GitHub repo; and each one's repo (default: the only repo, when they kept one). Write them into the draft's `sources` in init's flow style:

```yaml
sources:
  github: {repos: [acme/api, acme/web]}
  asana: {workspace: "1201", projects: ["1202"], repo_map: {"1202": acme/api}}
  linear: {repo_map: {ENG: acme/api}}
  jira: {site: acme.atlassian.net, email: me@acme.com, repo_map: {SHOP: acme/web}}
```

## 5. First queue

A yes to suggestions: invoke the [`suggest`](../suggest/SKILL.md) skill, saying you come from setup with the scope they gave (the chosen owners' folders only) and the draft's path. It works on the draft and comes back with their picks in it.

For a tracker suggest proposed nothing for, or on a no, add its rules from the default queue (https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#the-queue), in that table's order among the GitHub rules the draft has, the section or status replaced by the real one from `sources` that means the same (`QA` may be `In QA`). None does: leave the rule out and say so.

`awaywork --config <draft> plan --rules --json` reads the sources and probes no provider; its output is in [`queue`](../queue/SKILL.md)'s step 5. Show, for each rule, the items it takes now (key and title), the ones an earlier rule takes first, and the unmatched ones that sound like work they'd hand over, with the reason. Nothing taken today isn't proof the rule is right: say so, and show the closest misses. A config error goes to stderr: fix the draft and rerun. Iterate until they agree.

## 6. Write

On their yes, move the draft to `<config>`, then `awaywork doctor --json` once: it probes each provider's quota, a tiny model call. A `FAIL` on the config is yours to fix; one on a binary, a login or a token is the developer's: say which and how.

End with a few lines: the providers, the sources and repos, each rule by number and what it takes now, doctor's result. Then the commands for them to run: `awaywork plan` previews the next run, `awaywork run --unit <id>` tries one unit, `awaywork schedule install` runs it in the window. Never run them yourself.
