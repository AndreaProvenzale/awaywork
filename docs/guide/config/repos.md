---
description: Per-repo settings and instructions, what runs in the clone, the branch names units push to, and how a PR is linked to its item.
---

# Repos and branches

## Repos and instructions

`repos` lists the repos awaywork works in, and holds each one's commands and instructions:

```yaml
repos:
  acme/web:                              # a bare key: listed, no settings
  acme/*: { setup: pnpm install --frozen-lockfile }   # a glob: every repo it names
  acme/api:
    secrets: [NPM_TOKEN]                 # only setup sees these
    verify: pnpm lint && pnpm test
    test: pnpm vitest run {files}
    instructions: notes/acme-api.md
```

- **It's the allowlist.** The `github` source reads these repos, and an item from any source, a custom one too, that names a repo no key matches, as its `repo` or its linked PR's, is skipped; `awaywork plan --skipped unlisted_repo` shows them. A repo the config names itself, a routine's `repo` or a `repo_map` value, has to be listed, or the config is refused.
- **A key** is `owner/name` or a `*` glob, which stays within the owner or the name (`acme/*`, `acme/api-*`).
- **Settings merge.** A repo takes the settings of every key that names it: globs first, in the order written, then its own key, a later one winning per setting. `secrets` add up and `gates` merge by name. Above, `acme/api` gets the glob's `setup` and its own `verify`.

- **`setup`** runs once per unit in the fresh clone, before any agent, outside the model; the agent is told it ran.
- **`verify`** runs once the chain ends, before publishing. A failure still publishes, its tail in the PR body or push summary, and a `deliver: pr` PR opens as a draft; the tail also lands in `verify.log` in the unit's `out/` in the run dir.
- **`test`** is a line in the agent's prompt.
- **`image`** is what the repo's units run in under [`isolation: container`](../safety/isolation.md#in-a-container).
- **`instructions`** (top level, per repo, per rule) are file paths relative to the config they're in. A repo can also carry `.awaywork/instructions.md`, read unless the unit is on someone else's PR.

Top-level `skills` adds [skills](../skills.md#where-skills-come-from) to every unit. PR titles, bodies and commit messages have no config: the agent follows the repo's template, its commit style and your instructions.

Details on `setup` and its `secrets`:

- Later chain steps share the clone and don't rerun it, so a `when` or `until` command needing a step's new dependencies installs them itself (`pnpm i --frozen-lockfile && pnpm test`). Whatever setup leaves running is stopped.
- Its `secrets` reach setup only, masked in its output, passed from repository secrets in Actions. Read them from the repo's config (`${NPM_TOKEN}` in `.npmrc`), not your home, which the agent shares.
- It gets `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` as `none`, so `gh` and git over https through gh's helper fail with a 401, even on a public repo. List `GH_TOKEN` in `secrets` to give it yours.
- On someone else's PR it runs the author's install scripts, so it gets no secrets, and runs only for an author with write access or org membership. No secrets either on an awaywork PR's branch a rule took up, which a worker wrote.
- A plan's task may name any repo `repos` lists, and runs with that repo's settings ([Across repos](../workflows/tasks.md#across-repos)).

### What runs in the clone

Every config command that touches a clone. All run in a shell outside the model, in the clone, except `context`, which runs in the config's folder. None gets a forge token.

| Command | When | Secrets | A failure |
| --- | --- | --- | --- |
| `repos.<repo>.setup` | Once per unit, before the first agent; not for later steps, nor on an untrusted author's PR | Its repo's `secrets`; none on someone else's PR or an awaywork branch a rule took up | Non-zero, over 15 minutes or the window's end skips the unit, the tail in the report |
| `sources.<id>.context.command` | Per item, before setup; not on a dry run | Its own `secrets` | Logged; the unit runs without `extra/`. Over two minutes, the window's end, over 1 MB, or a symlink or non-file in its output count as failures |
| `repos.<repo>.test` | Never by awaywork: the agent runs it if it wants | The agent's: its provider's and its rule's MCP servers' | Up to the agent |
| `repos.<repo>.verify` | Once per chain that ends with commits, before publishing; not for `report` | None | Its tail in the PR body or push summary; a `pr` PR opens as a draft; still published |
| `when.command` | Before a step's agent; not on an untrusted author's PR | None | The step is passed over; over 15 minutes or the window's end ends the chain, which publishes |
| `until.command` | After every loop step; not on an untrusted author's PR, where the loop ends | None | The loop goes on; uncommitted changes fail it too; the window's end ends the chain; a loop ending on a failure puts the tail in the PR body |
| `gates.<name>.command` | Once per chain with commits, after `verify`; not for `report` or `pending_review`, nor a dry run. A plan or report rule's own gate after its step. Each with `$AWAYWORK_OUT_DIR` | None | The gate fires: stdout in the decision card, a `pr` PR opens as a draft, a plan or report waits. So does a command that can't run, times out, hits the window's end or isn't run on an untrusted PR ([Gates](../workflows/gates.md)) |

`verify`, `when` and `until` share results: one command on one commit runs once; a gate always runs afresh. All four get the chain's start commit as `$AWAYWORK_FROM`, and their git ignores replace refs; a gate also gets `$AWAYWORK_OUT_DIR`, a read-only copy of the steps' `.away/out/`. Only a gate's git reads attributes from the start commit; the others keep the worktree's, so an eol or LFS rule the chain adds doesn't trip your `verify`. More in [Loops](./chains.md#loops).

## Branch names

`branch` is a template, set globally, per repo or per rule; the most specific wins:

```yaml
queue:
  - { skill: fix, where: { type: pr, mine: true, checks: failing }, branch: "fix/{title}" }
```

It needs `{key}` or `{title}` (a slug of at most 40 characters), else every unit would share it. Optional `{type}` is the conventional-commit type of the chain's first committing skill ([`metadata.type`](../skills.md#write-your-own)).

| Item                               | `{key}`       |
| ---------------------------------- | ------------- |
| GitHub PR or issue `acme/api#12`   | `acme-api-12` |
| Asana task with custom ID `ENG-12` | `ENG-12`      |
| Linear or Jira issue `ENG-12`      | `ENG-12`      |
| Task `api` of a plan on `ENG-12`   | `ENG-12-api`  |

The name is cosmetic, since awaywork finds its PRs by their footer, except for Jira, which links a PR only by the key in its branch or title: keep `{key}` in one of them.

awaywork pushes only branches that don't exist yet, but for a [`push`](./chains.md#push) rule and its own draft it [continues](../workflows/questions.md#continue). When the name is taken:

- The unit takes the first free `<branch>-2` to `<branch>-10`, for every step of its chain.
- Unless awaywork tried there: a PR on that branch, open or closed unmerged, whose footer names one of the unit's items skips it as `awaywork tried this in <PR>; delete <branch> to run it again` (that record is on GitHub, so it holds on a runner without [attempts](../how-it-works.md#units)), unless it's the draft the unit [goes on](../workflows/questions.md#continue) with. A merged one starts a new round with a suffix.
- A branch with no PR whose tip has the `Awaywork:` trailer is a push whose PR failed: skipped until you delete it. Without the trailer it's your work, passed over for a suffix.
- A [plan's task](../workflows/tasks.md) takes no suffix, since its PR is found by its branch: skipped until you delete it. So a `planned` rule's template renders from `{key}` alone (`{title}` or `{type}` is a config error, as a re-plan may retitle), and every `planned` rule of a source sets the same `branch`, or none does.

## Linking PRs

Trackers don't say which PR is a task's, so awaywork looks through your open PRs:

- Its own PR is linked by the items its footer names, never by names, so its PR for ENG-13 mentioning ENG-12 isn't ENG-12's. A footer naming no items counts as none.
- Yours is linked when its branch or title holds the key as a whole word, any case, or its body holds the source's `link` line. A bare key in the body doesn't count.

`link` is a line in the tracker's words, from the item's `{key}`, `{id}` and `{url}`, which awaywork also writes into its drafts:

| Source | Default `link` | Why |
| --- | --- | --- |
| `linear` | `Part of {key}` | Non-closing: merging leaves the issue to your workflow |
| `asana` | `{url}` | Asana links a PR whose description holds the task URL |
| `jira` | none | Jira links on the branch or title only |
| custom | none | Whatever your tracker reads, e.g. `Refs {key}` |

```yaml
sources:
  linear: { link: "Closes {key}" }   # merging closes the issue
```
