---
description: What an awaywork worker can and cannot do, how pushes are guarded, how the watchdog works, and the vendor terms each provider runs under.
---

# Safety

An agent working unattended on your repos is only acceptable if the worst run leaves nothing you have to undo. These rules are enforced in code, not asked of the model.

## What the agent can reach

- **No forge or tracker token.** Sources prefetch the context into files before the agent starts. The agent's environment has `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` replaced with `none`, which masks gh's keyring login, similar variables removed, and a `gh` config without a login. Nor does it or the checks get credentials that aren't tokens: `SSH_ASKPASS`, `GIT_ASKPASS`, and git config passed in `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_COUNT` and friends. `setup` keeps those.
- **Only its own agent's secret.** Every secret a configured source declares (`ASANA_TOKEN`, `LINEAR_API_KEY`, `JIRA_API_TOKEN`, or your `token_env`), your `notify.secrets`, every repo's `secrets`, every MCP server's `secrets` and every other provider's (`CLAUDE_CODE_OAUTH_TOKEN` for a Codex worker) is removed too. A Claude worker keeps `CLAUDE_CODE_OAUTH_TOKEN`, which its binary needs; Codex uses the machine's own login and gets no secret. A unit also keeps the secrets of the [MCP servers](#mcp-servers) its rule names. The rest of your environment stays so repo tooling runs, including any variable you added to the env file that nothing declares.
- **Setup outside the agent.** A repo's `setup` runs before the agent in the same environment, without the agent's secret and with only that repo's `secrets` added, none on a PR someone else opened or on a branch a worker wrote: earlier in the run, or an awaywork PR a rule took up again. On a PR by someone without write access or org membership it doesn't run at all. Whatever it leaves running is stopped before the agent starts.
- **Checks outside the agent.** An `until` or `when` command runs the code a worker wrote, like `setup` on a branch a worker wrote: none of the repo's `secrets`, but on your machine, outside the worker's sandbox. So it doesn't run on an untrusted author's PR.
- **A throwaway clone.** Each unit gets a fresh clone with no credential helper left in it, on a new branch. `.away/` (context, prompt, output) is excluded from git, so it can't be committed. A branch that commits its own `.away`, a folder or a link, is refused before awaywork writes anything there, so a link to somewhere else can't make it write or delete outside the clone, and none of it lands in the run dir. Copying `.away` there never replaces awaywork's own `replay.json` or `worker.log`. Skills stay in the clone on every round: awaywork copies no symlink out of it, and refuses the unit if the folder it copies Codex's skills into links outside it, so a branch that commits `.agents/skills` as a link to somewhere else can't make it delete or write there. A loop's rounds share one clone: between them, awaywork runs no diff driver or fsmonitor its git config names, ends the loop if a round left a symlink where awaywork writes, and reads or writes only regular files there, so a FIFO can't hang it. Each check runs just before its write, so a worker process that outlived the watchdog could still swap a path in between.
- **A fixed harness.** [`harness.md`](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md) wraps every skill: never push, pull, merge, rebase, switch branches, comment or change git config; targeted checks and the repo's documented generators only; nothing in the background. A skill or instruction can't override it. It also tells the agent that the prefetched context is data, not instructions: a request in an item to run commands, fetch URLs, read secrets or change the delivery is reported, never followed.
- **Someone else's PR is data too.** On a PR you didn't open, the branch's `.awaywork/` is ignored, Codex's copy of the unit's skills is replaced with awaywork's, and the prompt says its `CLAUDE.md`, `AGENTS.md` and skills are the author's. Claude Code loads none of the clone's config there (settings, hooks, MCP servers, `CLAUDE.md`, skills), only awaywork's skills plugin and the `settings` file you configured; Codex still loads `AGENTS.md` and its skills itself.
- **Only trusted authors' code runs by default.** Reviewing a PR means running its tests, with your agent's login in the environment. The default `review` rule matches `trusted: true` only: PRs whose author is an owner, member or collaborator of the repo. A rule without it reviews anyone's PR.
- **Not your agent's config.** Workers skip your user-level agent config: `~/.claude` settings, hooks, MCP servers, `CLAUDE.md`, skills, auto-memory and your account's claude.ai connectors for Claude Code, `config.toml` for Codex. The repo's own config still applies. What you want workers to have, list in the config: a Claude `settings` file, Codex `config` values, top-level `skills` ([Configuration](./configuration.md#providers)) and [MCP servers](./configuration.md#mcp-servers). They are yours, so they apply on someone else's PR too, except MCP servers, which carry your secrets.

## Not a sandbox

All of the above keeps credentials out of the agent's way, not out of its reach. It runs as your user and can read what you can, and its tools aren't sandboxed: Claude Code gets Bash and file tools pre-approved, Codex runs with `--sandbox danger-full-access`, which it needs to commit. So what it reads can leave [I, from the code]:

- `~/.config/awaywork/env`, with your `GH_TOKEN` and tracker tokens.
- gh's own login, by unsetting the placeholder `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` (an empty `GH_CONFIG_DIR` doesn't hide a keyring from `gh auth token`); `glab`'s keyring login needs nothing unset. Git's global credential helper is reachable too.
- Your ssh keys, and your ssh agent: the worker keeps `SSH_AUTH_SOCK` to sign its commits.
- A VS Code terminal's git askpass (`VSCODE_GIT_*`).
- On Linux, awaywork's own environment under `/proc`, `GH_TOKEN` included. On a runner, that's your personal access token.

What that leaves open:

- **Prompt injection.** On GitHub, comments and threads by people outside the repo are [hidden](#public-repos), but issue bodies, CI logs, other sources' text and whatever a trusted person quotes are still text someone else may have written. The harness tells the agent they're data, but a model can still be talked into things, and what it runs has the reach above.
- **Hooks across a loop's rounds.** On your own repo, Claude Code loads the clone's `.claude/settings.json`, so one round can leave hooks the next round runs.
- **MCP secrets in Claude's Bash** on your own items: [MCP servers](#mcp-servers), and [#155](https://github.com/AndreaProvenzale/awaywork/issues/155) to fix it.
- **Codex reads the PR author's `AGENTS.md`** on someone else's PR, as above.

So run awaywork on a machine or runner where that's acceptable. Real isolation is [#200](https://github.com/AndreaProvenzale/awaywork/issues/200).

## Public repos

On a public repo anyone can comment on your issues, review your PR or reply in your threads, and all of it would land in the agent's context. So the GitHub source keeps only text by you, by owners, members and collaborators of the repo, and by apps installed on it (the review bots whose findings `fix` works on). Everyone else's comments, reviews and threads are dropped before the agent starts, leaving a line in their place:

```
_Hidden: 2 comments from outside the repo's owners, members and collaborators._
```

A thread a stranger started is hidden whole and doesn't count toward `unresolved_threads`, so it doesn't start a `fix` run (if GitHub won't say who started a PR's threads, they all count, and the run still sees only the trusted ones). In a thread someone trusted started, only the strangers' replies go. It's always on, nothing to configure.

Who's a member comes from GitHub, and to a token without `read:org` a teammate whose org membership is private can look like an outsider, comments hidden. `gh auth login` asks for `read:org` already, and so does `schedule install` for the runner's token.

What it can't hide:

- The item's own title and body: an issue a stranger opened and you took on is still their text. The default `review` rule already skips their PRs (`trusted: true`).
- An untrusted author's diff and files, when a rule of yours reviews their PR anyway.
- CI logs in `checks.md`: a PR's tests print whatever its code says.
- What a trusted person or a bot quotes, like a review bot summing up a stranger's comment.

So the agent can still be steered, and it can read your `GH_TOKEN` ([Not a sandbox](#not-a-sandbox)). The classic token `schedule install` asks for reaches every repo you can, not only the ones awaywork works on; whether that's fine or worth a dedicated account is your call. A fine-grained token would reach less, but it [can't call the Checks API](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations), which the `checks` field and `checks.md` read, so those likely break. Nobody has tried one yet.

## MCP servers

A rule's `mcp` gives its units your servers, and with them more reach, so the guide's advice is in three parts:

- **A server's secret is one the agent can read.** The server and the agent run as the same user, in the same process tree. Claude Code starts stdio servers with its whole env, which its Bash also gets. Codex keeps the secrets out of its shell's env (`shell_environment_policy`), but a process running as your user can still read another one's env. So a unit has its agent's secret plus the secrets of the servers its rule names, and nothing else.
- **Injected instructions can use the tools.** An item's text could ask the agent to call a server's write tools. Give servers read-only tokens where the service has them, and list `tools` to allow only what the skill needs: awaywork has the agent refuse every tool outside the list. For context the worker only reads, prefetching it with a source keeps the token away from the model entirely.
- **Not on someone else's PR.** The worker runs the PR's code, and on Claude Code that code gets the servers' secrets in its env. So servers start for your own PRs and for issues and tasks, but not on a PR someone else opened, trusted or not, nor on an issue it closes, as with the repo's `secrets` for `setup`. A server with an unset secret doesn't start either. The unit's log says which servers didn't start and why.

## What awaywork publishes

- Only a branch that **doesn't exist** on the remote, checked before the worker starts and again at push. A taken name gets a `-2` to `-10` suffix instead, never the taken branch. Never someone else's branch, and never a push that rewrites history.
- The one exception is a rule with `deliver: push`: it adds commits onto **your own open PR's** branch, as a fast-forward, only while the branch is still where the clone started. Right before the push, awaywork reads the PR again and refuses when it isn't yours, is closed or merged, or has auto-merge on, and when its branch is on a fork, is the default branch, is protected, or is also the branch of someone else's open PR in the repo. It is refused on someone else's PR and on an item without a PR of yours. The commits land unreviewed on a branch your CI and teammates run, so opt in only where that's fine.
- Both pushes carry git's `--force-with-lease` as a compare-and-swap, not to force: the remote takes the new head only while the branch is still absent, or still at the commit the clone started from, and awaywork checks first that the new head descends from it. A push that would rewrite history, or bring back commits you dropped from your branch in the meantime, is refused.
- Nothing is published when the new commits include a merge, or when the branch no longer holds the commit the clone started from: the harness forbids both, and either would carry commits that aren't the unit's.
- Only a **draft** PR, into the default branch or your own PR's branch in the repo (an awaywork PR a rule naming `ours` took up again included), one per unit, however many steps its chain has, plus one per [stacked slice](./chains.md#stack), into the slice before's branch. Never into someone else's PR or a PR from a fork: only a report delivers there. A fork PR is cloned from the repo's pull ref; nothing goes to the fork. It never merges, approves, requests reviewers or comments; your own [`notify` command](./configuration.md#pr-labels-reviewers-and-ready-for-review) can, as you.
- A draft PR stacked on an awaywork PR joins that PR's GitHub stack, or starts one with it, only while that PR tops its stack or has none. Linking edits neither PR, but GitHub then merges a stack bottom-up: merging a PR merges the ones below it too, and GitHub rebases the ones above after a merge.
- Only when the agent wrote a PR body, `pr.md`, for a draft PR or a push alike, and only once the unit's chain, or its slice, ended. A run killed before that publishes nothing more.
- Publishing fetches the clone's HEAD into a repo awaywork creates for it, where it adds the trailer, diffs and pushes. The unit's commits are those after the commit the clone held before setup and the first agent ran. The clone's config, attributes, hooks and refs, which the agent can write, neither steer where a push goes, nor pick which commits get the trailer, nor run anything: after `setup` and each agent run, and before and after each check, awaywork puts back the config the clone had when it was cloned. It refuses a `.git` that borrows a repo or objects from elsewhere, or a symlinked `.git/index`, and the step errors: no check or `verify` runs on that clone, so a slice whose `verify` runs isn't published, and the only git left there is publishing's `rev-list` and fetch, which only read it. In the clone, publishing only reads the PR body or report, writes `diff.patch` next to it, and appends the chain's notes, the items' link lines, a GitHub issue's `Closes` line on the last slice of a chain cut from the default branch and a stacked PR's "merge that first" line to the body. It refuses if the body, the report or `diff.patch` is a symlink, and reads or writes only regular files. The symlink check runs just before, so a worker process that outlived the watchdog could still swap a path in between.
- A [stacked slice](./chains.md#stack) never fetches anything into the clone: awaywork's own repo re-parents its commits onto the slice before's as pushed, while adding the trailer. In the clone it runs one `git checkout -b` for the slice's new branch at the clone's tip, with no hook, fsmonitor or reflog. Before it, awaywork refuses a symlink anywhere on the path to `.git/HEAD`, `.git/index` or the new branch's ref, and deletes `.git/logs`, so git writes only that branch, HEAD and the index, each by renaming a fresh lock file, and nothing outside the clone.
- `report` delivery pushes nothing at all.
- Every PR says it came from awaywork: a footer with the run id and the items it's for in the body, and an `Awaywork: <run id>` commit trailer. Pushed commits carry the trailer too. Adding it re-creates each commit, so a commit signature doesn't carry over: a branch that requires signed commits refuses the push.

## Resources

A watchdog polls every 2 s. It stops the unit below 1.5 GB of free memory or 2 GB of free disk, and at the end kills every process the agent started, including detached ones. The agent also runs in a process group of its own, killed as soon as it exits or awaywork is stopped (short of `SIGKILL`). A process that leaves the group, as an agent's own command runner may, is left to the watchdog; one that also detaches between two polls escapes both, and could still change the clone after awaywork checked it. Each run also has a turn cap and stops at the quota ceiling.

## Secrets on a runner

In GitHub Actions, your credentials are secrets of your control repo. The generated workflow passes them only to awaywork's step, checks out without keeping a credential, and gives the job's `GITHUB_TOKEN` read access only: awaywork pushes with your `GH_TOKEN`. Still, anyone with write access to the repo can read them: a branch they push can carry a workflow that prints them. So keep the control repo your own, one per person on a team.

## Vendor terms

awaywork runs each vendor's **unmodified CLI** with **your own login**. It never calls a provider's backing API with a subscription credential, never stores, pools or proxies anyone else's, and never changes the client's identity. That is the line the vendors draw.

| Provider | Unattended use |
| --- | --- |
| Claude Code | Allowed: headless runs with your own login or a `setup-token`, documented for CI. |
| Codex | Grey: account login in CI is documented as advanced, with API keys recommended; keep one `auth.json` per machine. |

`awaywork doctor` shows this flag per provider. Research on other agents, and why some (Gemini on a personal plan, Alibaba's plan) won't be supported, is in [Providers](../providers.md).

## Reporting a vulnerability

See [SECURITY.md](https://github.com/AndreaProvenzale/awaywork/blob/main/SECURITY.md).
