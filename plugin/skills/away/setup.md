# awaywork setup

There's no config yet: write one with the developer, check it on their real items, and write it only on their yes. The [ground rules](SKILL.md#ground-rules) hold throughout (no credentials through you, real names only, widening shown on its own).

`<config>` is the path `awaywork config path` printed; `<draft>` is `config.draft.yml` in the same folder, made with `mkdir -p` on a first setup. Every command on the draft takes `--config <draft>`.

## How to ask

Ask in rounds, each one question tool call (`AskUserQuestion` in Claude Code): at most 4 questions, 2–4 options each. The tool adds a free-text option itself: never add an "Other". The option you'd pick goes first, its label ending `(Recommended)`; each description is one line on what picking it does. Build every option from what you found, never a placeholder. A question with one possible answer isn't asked: say what you took in the round's lead-in. Before each call, at most 3 lines on what you found that the round relies on: no tables, no lists of everything you saw. Without a question tool, ask each round as one numbered message, each question with its default.

## 1. Look around

Nothing here needs the developer. Run these together, from where you are (don't `cd` into this skill's folder), and wait for every one before the first round; one that failed or timed out is named in the lead-in:

- `awaywork doctor --json`: `gh` and `gh login`, the config's `FAIL`, then each agent CLI, `ok` with its version or `warn` with why not. No gh login: it's the developer's `gh auth login`; wait.
- `gh auth status --json hosts`: every gh account on github.com, and the active one. For each, `GH_TOKEN=$(gh auth token --user <login>) awaywork sources github --json` gives its orgs: the token goes from gh to awaywork and is never printed.
- The agent logins. Claude Code: `~/.claude`, `$CLAUDE_CONFIG_DIR`, and what `$SHELL -ic 'type claude'` shows: a function or alias that picks `CLAUDE_CONFIG_DIR` is how they switch subscriptions, so read it for its folders. `claude auth status --json` names a folder's account and plan: `env -u CLAUDE_CONFIG_DIR` for `~/.claude` (set to it, Claude Code finds no login), `CLAUDE_CONFIG_DIR=<dir>` for any other, and only on a folder that exists, since it creates a missing one. Codex: `codex login status`, with `CODEX_HOME=<dir>` for a folder other than `~/.codex`.
- `sh <this file's folder>/scripts/folders.sh 30 <each Claude folder>`: the folders their interactive sessions ran in over the last 30 days, a header, then one tab-separated line per agent, Claude folder and folder: agent, sessions, MB, memories, the Claude folder they're under (`-` for Codex), the MCP servers set up for that folder, enabled or not (`-` for none), folder, and its repo (`owner/repo` on github.com, else the remote's URL, `-` for none). Then, under `mcp servers`, each server's name, scope (`user`, `local` or `project`), type and URL host; under `user-level files`, the files suggest would read. It reads metadata and config only, never what a session or memory says: that waits for suggest's consent.
- `cd ~ && awaywork schedule status`: a job already scheduled here (inside a repo it also counts that repo's workflow).
- `uname`, and whether `docker info` answers.

Tracker hints: an MCP server named after a tracker, or one pointing at an in-house host (`tasks` at `tasks.acme.com`), and the skills and instructions already in your own context. A hint is a guess: in the question, say where it came from ("your MCP servers and the `acme-cards` skill mention Acme Tasks").

## 2. Whose work, where it runs

- **Work:** one option per gh account whose owners have sessions, most sessions first: the owners it reaches, with their session counts. One config is one account's work; the other gets its own setup later.
- **Subscription,** with more than one Claude login: one option per login, its account and plan; recommended is the one whose folder holds most of that work's sessions. The same for Codex logins.
- **Runs on:** this machine (launchd or systemd; on macOS awaywork runs as them, or in a container with Docker), GitHub Actions (a fresh VM each run, from a control repo, with a token secret), a box with Docker (Coolify or a VPS: the worker user is forced, and the CLI reaches it from the laptop over `AWAYWORK_REMOTE`). One machine runs one awaywork daemon: when one is already scheduled here, this machine isn't the default, and its description says why.

Pin what they chose in the draft (step 5): the gh account as `sources.github.user`, a login whose folder isn't `~/.claude` or `~/.codex` as that provider's `config_dir` (`providers: [{claude: {config_dir: ~/.claude-work}}, codex]`). Off this machine the token in the environment wins and the pin changes nothing; in a container here (`isolation: container`) Claude's `config_dir` is refused, and its login is `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, put in with `awaywork secret`.

## 3. What it works on

- **Repos:** the chosen owners' repos from `folders.sh`, multi-select. Up to 4, one option each; more, group them (all listed; the ones with most sessions; `owner/*`, every repo of the owner). Edits go in the free text. A remote that isn't github.com stays out of every option and you don't guess what it is: an ssh alias (`git@<alias>:owner/repo`) waits until they name its repo; a Bitbucket Cloud repo is awaywork's `bitbucket` source, which this setup doesn't write (https://andreaprovenzale.github.io/awaywork/guide/configuration.md#bitbucket-and-jira).
- **Tracker:** a hint first; then Asana, Linear, Jira; none. One that isn't built in becomes a custom source (step 5).
- **Window:** default 01:00–07:00 their time.
- **Providers,** only with more than one ready: the order, the first taking units and the next taking over when its quota runs out. Cursor also needs `CURSOR_API_KEY`.

## 4. What to take off their plate

- **Rules,** multi-select, from the default queue (https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#the-queue), only what their sources can feed: fix my PRs' red checks; fix review threads on my PRs; review requests; tracker cards (QA notes fixed, in-progress implemented, the sprint planned). Each description says what the default rule leaves: a fix is a draft PR stacked on their PR, a review or a plan a report, an implementation a draft PR. A review left as their pending review, which only they see, is `deliver: pending_review`, a widening: its own option, saying so.
- **Learn from my sessions:** yes or no, default no. The yes carries the scope as [`suggest.md`](suggest.md)'s step 1 asks it, numbers included, summed from `folders.sh` for the chosen owners only: "84 Claude Code sessions (31.4 MB) in 3 folders, 12 memory files, your global `CLAUDE.md`; it goes to Anthropic". Never say it stays on this machine. Their yes is suggest's consent for this run: it won't ask again.

## 5. Draft

Where it goes: a single file at `<config>`, unless the config needs files beside it (a custom source, instructions, skills) or runs off this machine: then a control folder, a git repo they own. Propose one next to their clones (`~/projects/acme/awaywork`), say why, and once they agree, `git init` it with a `.gitignore` for `.env`, and make `<config>` its `.awaywork/config.yml`, where `schedule install --with github-actions` or `--with docker` keeps the config, with what it names by path beside it in `.awaywork/`. Pass `--config <config>` from then on, and print the `AWAYWORK_CONFIG` line for their shell profile.

```sh
awaywork --config <draft> init --yes --provider <theirs, first first> --source github --window <start>-<end>
```

It writes the providers, `github: {repos: [<login>/*]}`, the default GitHub rules and the window; ignore its `Next:` line. Then edit the draft: `sources.github.repos` to their list, the pins from step 2, and one `repos` entry per repo with `setup`, `test` and `verify` from its clone (the lockfile says the package manager: `bun.lock` is `bun install --frozen-lockfile`, not yarn; the scripts in `package.json`, `pyproject.toml` or the `Makefile` say the rest; `{files}` where the test runner takes paths). A clone you can't find: leave its entry out and say so. A draft left by an earlier setup makes init refuse: ask whether to carry on from it or start over (`--force`).

**Built-in trackers:** for each, `awaywork --config <draft> sources <id> --json`. Jira's site and email are config: add `jira: {site, email}` first, plus `cloud_id` for a scoped token (`curl -s https://<site>/_edge/tenant_info`). A missing token fails naming its variable: in one message, `awaywork secret <NAME>` in their terminal, or `! pbpaste | awaywork secret <NAME>` here once copied, and where each is made (Asana: Settings > Apps; Linear: Settings > Account > Security & access; Jira: id.atlassian.com > Security > API tokens, scoped to `read:jira-work`); wait and rerun. Then one round from the real names: Asana's workspace and projects, Linear's teams, Jira's projects, and each one's repo. Write them in init's flow style:

```yaml
sources:
  github: {repos: [acme/api, acme/web], user: octocat-acme}
  asana: {workspace: "1201", projects: ["1202"], repo_map: {"1202": acme/api}}
  linear: {repo_map: {ENG: acme/api}}
  jira: {site: acme.atlassian.net, email: me@acme.com, repo_map: {SHOP: acme/web}}
```

**A custom tracker:** a script in the control folder, as https://andreaprovenzale.github.io/awaywork/guide/custom-sources.md says, read-only, its token from the env var it declares under `secrets`. A source is a script, not an MCP client, so it needs the API behind the server: the MCP server's host is a start, not the endpoint. Ask them where its API docs are, or to let you read the skill that uses it, before writing a line. Keep it to what the rules need: the items assigned to them, the fields a rule matches on, the repo each item belongs to. Check it with `sources <id> --json` and show three real items.

## 6. First queue

A yes to suggestions: follow [`suggest.md`](suggest.md) from its step 2, with the scope they gave and the Claude folders you found, on the draft; it comes back here with their picks in the draft. Otherwise, or for a family suggest proposed nothing for, write the families they picked from the default queue, in that table's order, each section or status replaced by the real one from `sources` that means the same (`QA` may be `In QA`); none does: leave the rule out and say so.

`awaywork --config <draft> plan --rules --json` reads the sources and probes no provider; its output is in [`queue.md`](queue.md)'s step 5. Show, for each rule, the items it takes now (key and title), the ones an earlier rule takes first, and the unmatched ones that sound like work they'd hand over, with the reason. Nothing taken today isn't proof the rule is right: show the closest misses. A config error, or a pin that can't be made, goes to stderr: fix the draft and rerun. Then one question: write it, change a rule (free text), or start over.

## 7. Write

On their yes, move the draft to `<config>`, then `awaywork doctor --json` once: it probes each provider's quota, a tiny model call, and its `gh login` and `<provider> login` rows name the account each run uses. A `FAIL` on the config is yours to fix; one on a binary, a login or a token is the developer's: say which and how.

End with a few lines: whose work and which logins, where it runs, the sources and repos, each rule by number and what it takes now, doctor's result. Then the commands for where it runs: `awaywork plan` previews the next run, `awaywork run --unit <id>` tries one unit, and `awaywork schedule install` (this machine), `awaywork schedule install --with github-actions` or `--with docker` (from the control folder) schedules it. Never run them yourself.
