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

- `awaywork doctor --json`: an array of `{ status, what, detail }`. With no config it still lists the agent CLIs it found, and `gh` with its login, before the config's `FAIL`. No gh login: awaywork reads and writes GitHub through it, so it's the developer's `gh auth login`; wait.
- `awaywork sources github --json`: their `login` and `orgs`.
- `sh scripts/folders.sh 30`, the script beside this file: the folders their interactive Claude Code and Codex sessions ran in over the last 30 days, one tab-separated line per agent and folder: agent, sessions, KB, folder, and its repo (`owner/repo` on github.com, else the remote's URL, `-` for none). It reads only each file's metadata (`cwd`, the remote), never what a session says: that waits for suggest's consent. Another agent's history: find where it keeps its sessions and take the folder from their metadata the same way.

Propose the GitHub repos those folders map to, most sessions first. `<login>/*` or `<org>/*` covers every repo of an owner, for when they work on most of them. A folder whose remote isn't github.com (a Bitbucket one, an ssh alias) is listed apart: ask what it is rather than guess.

## 2. Ask once

One message, each question with its default:

- **Providers:** the agent CLIs doctor found, the first taking units first and the next taking over when its quota runs out. Cursor also needs `CURSOR_API_KEY`: doctor says when it's missing.
- **Repos:** the proposed list, theirs to edit; `owner/*` works.
- **Trackers:** do tasks also come from Asana, Linear or Jira? For Jira, its Cloud site (`acme.atlassian.net`), their Atlassian email, and whether the API token is scoped (created "with scopes").
- **Window:** when runs may happen, default 01:00–07:00 their time.
- **First rules:** suggest them from their recent sessions and PRs, or start from awaywork's default rules? Give the scope as [`suggest`](../suggest/SKILL.md)'s step 1 asks it, from what you found: the folders of the repos above, the last 30 days, which agents' histories (another vendor's sessions go to yours: say so by name), and the size, from `folders.sh`'s counts.

## 3. Draft

Let the CLI render it, as `awaywork init` writes a config, comments and all:

```sh
awaywork --config <draft> init --yes --provider <theirs, first first> --source github --window <start>-<end>
```

It writes the providers, `github: {repos: [<login>/*]}`, the default GitHub rules and the window; ignore its `Next:` line. Then edit `sources.github.repos` in the draft to their list. A draft left by an earlier setup makes it refuse: ask whether to carry on from that draft or start over (`--force`).

## 4. Trackers

For each tracker they named, `awaywork --config <draft> sources <id> --json`. Jira's site and email are config, not flags: add `jira: {site: <site>, email: <email>}` under the draft's `sources` first, plus `cloud_id` for a scoped token (`curl -s https://<site>/_edge/tenant_info` prints its `cloudId`, no credentials needed).

A token it lacks fails naming its variable (`ASANA_TOKEN`, `LINEAR_API_KEY`, `JIRA_API_TOKEN`): give the router's `awaywork secret` instruction for every missing one in one message, with where each is made (Asana: Settings > Apps; Linear: Settings > Account > Security & access; Jira: id.atlassian.com > Security > API tokens, scoped to `read:jira-work`), wait, and rerun.

Then ask, in one message and from the real names, only what `awaywork init` asks: Asana's workspace when there are several, and its projects to watch (none: every project with their tasks); Linear's teams and Jira's projects whose issues have code in a GitHub repo; and each one's repo (default: the only repo, when they kept one). Write them into the draft's `sources` as init does:

```yaml
sources:
  github: {repos: [acme/api, acme/web]}
  asana: {workspace: "1201", projects: ["1202"], repo_map: {"1202": acme/api}}
  linear: {repo_map: {ENG: acme/api}}
  jira: {site: acme.atlassian.net, email: me@acme.com, repo_map: {SHOP: acme/web}}
```

## 5. First queue

A yes to suggestions: invoke the [`suggest`](../suggest/SKILL.md) skill, saying you come from setup with the scope they gave and the draft's path. It works on the draft and comes back with their picks in it.

For a tracker suggest proposed nothing for, or on a no, add its rules from the default queue (https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#the-queue), in that table's order among the GitHub rules the draft has, the section or status replaced by the real one from `sources` that means the same (`QA` may be `In QA`). None does: leave the rule out and say so.

`awaywork --config <draft> plan --rules --json` reads the sources and probes no provider; its output is in [`queue`](../queue/SKILL.md)'s step 5. Show, for each rule, the items it takes now (key and title), the ones an earlier rule takes first, and the unmatched ones that sound like work they'd hand over, with the reason. Nothing taken today isn't proof the rule is right: say so, and show the closest misses. A config error goes to stderr: fix the draft and rerun. Iterate until they agree.

## 6. Write

On their yes, move the draft to `<config>`, then `awaywork doctor --json` once: it probes each provider's quota, a tiny model call. A `FAIL` on the config is yours to fix; one on a binary, a login or a token is the developer's: say which and how.

End with a few lines: the providers, the sources and repos, each rule by number and what it takes now, doctor's result. Then the commands for them to run: `awaywork plan` previews the next run, `awaywork run --unit <id>` tries one unit, `awaywork schedule install` runs it in the window. Never run them yourself.
