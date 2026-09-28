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
  declares (`ASANA_TOKEN`, or your `token_env`) and every other
  provider's (`CODEX_AUTH_JSON` for a Claude worker) is removed too. A
  Claude worker keeps `CLAUDE_CODE_OAUTH_TOKEN`, which its binary needs;
  Codex reads `auth.json` and gets no secret. The rest of your
  environment stays so repo tooling runs, including any variable you
  added to the env file that nothing declares.
- **A throwaway clone.** Each unit gets a fresh clone with no credential
  helper left in it, on a new branch. `.nightshift/` (context, prompt,
  output) is excluded from git, so it can't be committed.
- **A fixed harness.** [`harness.md`](https://github.com/AndreaProvenzale/night-shift/blob/main/harness.md)
  wraps every skill: never push, pull, merge, rebase, switch branches,
  comment or change git config; targeted checks only; nothing in the
  background. A skill or instruction can't override it.

The agent's own tools are not sandboxed: Claude Code gets Bash and file
tools pre-approved, Codex runs with `--sandbox danger-full-access`, which
it needs to commit. Run night-shift on a machine or runner where that is
acceptable: it can read what your user can read.

## What night-shift publishes

- Only a branch that **doesn't exist** on the remote, checked before the
  worker starts and again at push. Never force, never someone else's
  branch.
- Only a **draft** PR, into your own PR's branch or the default branch.
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
