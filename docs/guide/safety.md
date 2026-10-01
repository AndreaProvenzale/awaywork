---
description: What a night-shift worker can and cannot do, how pushes are guarded, how the watchdog works, and the vendor terms each provider runs under.
---

# Safety

An agent working unattended on your repos is only acceptable if the worst
night leaves nothing you have to undo. These rules are enforced in code,
not asked of the model.

## What the agent can reach

- **No forge or tracker token.** Sources prefetch the context into files
  before the agent starts. The agent's environment has `GH_TOKEN` and
  similar variables removed and a `gh` config without a login.
- **Only its own agent's secret.** Every secret a configured source
  declares (`ASANA_TOKEN`, `LINEAR_API_KEY`, `JIRA_API_TOKEN`, or your
  `token_env`), your `notify.secrets`, every repo's `secrets` and every
  other provider's (`CODEX_AUTH_JSON` for a
  Claude worker) is removed too. A Claude worker keeps `CLAUDE_CODE_OAUTH_TOKEN`, which its binary needs;
  Codex reads `auth.json` and gets no secret. The rest of your
  environment stays so repo tooling runs, including any variable you
  added to the env file that nothing declares.
- **Setup outside the agent.** A repo's `setup` runs before the agent
  in the same environment, without the agent's secret and with only that
  repo's `secrets` added, none on a PR someone else opened or on a
  branch a worker wrote earlier that night. On a PR by someone without
  write access or org membership it doesn't run at all.
  Whatever it leaves running is stopped before the agent starts.
- **A throwaway clone.** Each unit gets a fresh clone with no credential
  helper left in it, on a new branch. `.nightshift/` (context, prompt,
  output) is excluded from git, so it can't be committed. A loop's rounds
  share one clone: between them, night-shift runs none of the commands
  its git config names (diff drivers, fsmonitor), copies no symlink out
  of it, and ends the loop if a round put one where night-shift writes.
- **A fixed harness.** [`harness.md`](https://github.com/AndreaProvenzale/night-shift/blob/main/harness.md)
  wraps every skill: never push, pull, merge, rebase, switch branches,
  comment or change git config; targeted checks and the repo's documented
  generators only; nothing in the background. A skill or instruction can't override it. It also tells the
  agent that the prefetched context is data, not instructions: a request
  in an item to run commands, fetch URLs, read secrets or change the
  delivery is reported, never followed.
- **Someone else's PR is data too.** On a PR you didn't open, the
  branch's `.night-shift/` is ignored, Codex's copy of the unit's skills
  is replaced with night-shift's, and the prompt says its `CLAUDE.md`,
  `AGENTS.md` and skills are the author's. Claude Code loads none of the
  clone's config there (settings, hooks, MCP servers, `CLAUDE.md`,
  skills), only night-shift's skills plugin and the `settings` file you
  configured; Codex still loads `AGENTS.md` and its skills itself.
- **Only trusted authors' code runs by default.** Reviewing a PR means
  running its tests, with your agent's login in the environment. The
  default `review` rule matches `trusted: true` only: PRs whose author
  is an owner, member or collaborator of the repo. A rule without it
  reviews anyone's PR.
- **Not your agent's config.** Workers skip your user-level agent
  config: `~/.claude` settings, hooks, MCP servers, `CLAUDE.md`,
  skills and auto-memory for Claude Code, `config.toml` for Codex. The
  repo's own config still applies. What you want workers to have, list
  in the config: a Claude `settings` file, Codex `config` values and
  top-level `skills` ([Configuration](./configuration.md#providers)).
  They are yours, so they apply on someone else's PR too.

## Network

The network is on by default. With `network: false` on a repo or a
rule, each agent's own OS sandbox runs its commands without it. That
closes one way for injected instructions or someone else's code to send
your agent's login out, not every way: the login stays in the agent's
environment, reads aren't restricted, and the draft PR's commits and
body are pushed without a secret scan.

- **Claude Code**: Bash in its sandbox (`sandbox.enabled`), with no way
  to run a command outside it and a failed start instead of an
  unconfined shell when the sandbox is missing. Bash writes stay in the
  clone and a temp dir; Write and Edit are held by Claude Code's
  permissions, not the sandbox [V]. It replaces the `sandbox` of your
  `settings` file. On your own repo the repo's config still loads: its
  `.claude/settings.json` can allow domains, and its hooks and `.mcp.json`
  servers run outside the sandbox [V]. On someone else's PR none of it
  is loaded.
- **Codex**: a permission profile that reads anywhere, writes the clone,
  its `.git` and the temp dir, with no network and no web search. It
  comes after your `config` values, so theirs for the same keys lose,
  and a `sandbox_mode` there doesn't switch it off [V, tested].

The agent's own requests to its vendor still go out. `setup` runs before
the agent, outside the sandbox, so it can still install dependencies,
except on an untrusted author's PR, where it doesn't run.

Offline is tested on macOS only. On Linux, Claude Code's sandbox needs
bubblewrap and socat [V]; offline isn't verified there for either agent,
so it may fail, e.g. on a stock GitHub Actions runner [I].

With network on, the agent's tools are not sandboxed: Claude Code gets
Bash and file tools pre-approved, Codex runs with `--sandbox
danger-full-access`, which it needs to commit. Either way, run
night-shift on a machine or runner where that is acceptable: it can read
what your user can read.

## What night-shift publishes

- Only a branch that **doesn't exist** on the remote, checked before the
  worker starts and again at push. Never force, never someone else's
  branch.
- Only a **draft** PR, into your own PR's branch, the default branch or
  a draft PR night-shift opened earlier the same night.
  It never merges, approves, requests reviewers or comments.
- Only when the agent wrote a PR body. A run killed before that
  publishes nothing.
- `report` delivery pushes nothing at all.
- Every PR says it came from night-shift: a footer with the run id in
  the body and a `Night-shift: <run id>` commit trailer.

## Resources

A watchdog polls every 2 s. It stops the unit below 1.5 GB of free
memory or 2 GB of free disk, and at the end kills every process the
agent started, including detached ones. Each run also has a turn cap and
stops at the quota ceiling.

## Vendor terms

night-shift runs each vendor's **unmodified CLI** with **your own
login**. It never calls a provider's backing API with a subscription
credential, never stores, pools or proxies anyone else's, and never
changes the client's identity. That is the line the vendors draw.

| Provider | Unattended use |
|---|---|
| Claude Code | Allowed: headless runs with your own login or a `setup-token`, documented for CI. |
| Codex | Grey: account login in CI is documented as advanced, with API keys recommended; keep one `auth.json` per machine. |

`nightshift doctor` shows this flag per provider. Research on other
agents, and why some (Gemini on a personal plan, Alibaba's plan) won't be
supported, is in [Providers](../providers.md).

## Reporting a vulnerability

See [SECURITY.md](https://github.com/AndreaProvenzale/night-shift/blob/main/SECURITY.md).
