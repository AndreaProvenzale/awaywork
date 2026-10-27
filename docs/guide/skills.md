---
description: The built-in awaywork skills, how skills are resolved, ejecting one to tweak it, and writing your own as an Agent Skills folder.
---

# Skills

A skill tells the worker what to do with a unit. Every skill is an [Agent Skills](https://agentskills.io) folder with a `SKILL.md`, so the same folder works for Claude Code and Codex.

## Built-in skills

| Skill | For | Delivers |
| --- | --- | --- |
| `fix` | Problems listed on an item: your PR's failing checks or unresolved review threads, threads you started on an awaywork PR, a task back from QA, an error report from a [custom source](./custom-sources.md#recipe-sentry-errors), or this run's review in a [loop](./chains.md#loops) | draft PR |
| `implement` | An issue or task with no PR yet, or one in progress with your PR: it takes the unambiguous next steps, or asks [questions](./how-it-works.md#questions) when it's too vague to build | draft PR |
| `review` | A PR awaiting your review, or this run's work as a `then` step; nothing is posted, unless a rule's `deliver: pending_review` leaves it as your pending review. Writes a verdict: `approve`, `comments` or `changes`, and under `pending_review` its line comments to `review.json` | report |
| `plan` | A task with no PR: an implementation plan, no code, or [questions](./how-it-works.md#questions) when none of its readings is likely enough to plan on | report |
| `judge` | A slice about to be published, as a [gate's judge](./configuration.md#judges): writes the verdict `fires` when it holds a change a human must decide on, one line per decision in its report | report |

```sh
awaywork skills list   # every skill a rule can name, and where it comes from
```

The skill decides the work; the [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md) wrapped around every skill decides the limits (no forge access, targeted tests only, no background commands, when to stop). A skill can't lift them.

## Where skills come from

A skill name, a rule's or one in `skills`, is looked up, first match wins, in:

1. `skills/<name>/` next to your config, yours: `~/.config/awaywork/skills/` for the default config;
2. `.awaywork/skills/<name>/` in the unit's repo, the team's;
3. the built-ins.

An extra skill, one in `skills`, also falls back to the repo's own skill folders: see [Bring your repo's skills](#bring-your-repo-s-skills).

A config outside `~/.config/awaywork/` (`--config`, `AWAYWORK_CONFIG`) uses its own `skills/`, so move or link the folder there; `doctor` warns while `~/.config/awaywork/skills/` holds skills it doesn't use. On a PR someone else opened, `.awaywork/skills/` is the author's and is skipped. To use a skill from `~/.claude/skills/`, link it into yours: `ln -s ~/.claude/skills/<name> ~/.config/awaywork/skills/<name>`.

On a runner, yours are the copy `schedule install --with github-actions` puts next to the repo's config: `.awaywork/skills/`.

Claude Code gets the unit's skills as a plugin outside the clone (`--plugin-dir`), named `awaywork:<name>`, so they are callable on every unit, someone else's PR included. Codex gets them copied into the clone's `.agents/skills/`: a repo that already has a skill of that name there keeps it, except on someone else's PR, where awaywork's copy replaces it. `doctor` and `config edit` see user and built-in skills only, so they warn about a name they can't find; an in-repo skill resolves at run time, and a unit naming a skill that's nowhere fails with `unknown skill`.

## Tweak a built-in

```sh
awaywork skills eject fix
$EDITOR ~/.config/awaywork/skills/fix/SKILL.md
```

The ejected copy shadows the built-in from then on.

## Bring your repo's skills

Your repo already has skills for Claude Code or Codex? Name them in a rule scoped to that repo, no ejecting or copying. They only resolve at run time, so `doctor` and `config edit` warn about them; `config edit` saves anyway.

```yaml
queue:
  - skill: implement
    skills: [tdd-implementation, writing-migrations]
    where: { type: issue, repo: acme/api }
```

Not in top-level `skills`: that list joins every unit, on your other repos and on PRs someone else opened too, and there they fail with `unknown skill`.

An extra skill that isn't yours, in `.awaywork/skills/` or built in, is looked up in the clone's `.claude/skills/`, then `.agents/skills/`. Those folders only fill in names: a rule's main skill never comes from them, so a repo's own `.claude/skills/implement` doesn't replace the built-in. To make one a main skill, move it to `.awaywork/skills/`. Like `.awaywork/skills/`, they are skipped on a PR someone else opened, where a unit naming one fails with `unknown skill`.

Claude Code loads `.claude/skills/` on its own anyway, so naming one there mostly matters for Codex, which gets a copy in `.agents/skills/`.

Skills the model reaches for by itself port fine: a TDD loop, a migration checklist, the rules for a tricky domain. Workflow skills don't: one that waits for your approval, fetches or posts through `gh`, or is marked `disable-model-invocation` has nobody to approve, no forge login, or can't be called at all. Keep the built-in for the job and port the standard instead, e.g. a rule's instruction file saying "review against `.claude/skills/pr-review/references/review-standard.md`".

## Try an edit on a past unit

```sh
awaywork replay 20261006-020000 acme-api-1
```

Replay rebuilds the first step of a unit of a past run: a clone at the commit the unit started from and its saved context. The unit is as recorded in that run: its skills and its rule's `model`, `with` and `instructions` list, so editing those in the config changes nothing. What is read fresh is the files: each `SKILL.md`, every instruction file, and the repo's and provider's config. It runs the unit's provider and model once, outside the run's quota ceilings, under the config's [isolation](./configuration.md#isolation), and never pushes or opens a PR. The clone stays on the unit's local branch under `replays/` in the run's state directory (in its own `/tmp/awaywork-*` under `user`), with the worker's `out/` next to it. The saved context is the post-run copy, so files the worker edited under `context/` are replayed as edited. Setup gets none of the repo's `secrets`, and MCP servers are not started. Only a unit's first step replays, on the first model of its rule's list: a later [`then`](./chains.md#then) step starts from commits that only ever existed in the chain's clone, and records no `replay.json`, nor does a [retry on the next model](./configuration.md#retry-on-the-next-model). Nor does a unit that never started, or one from a run before replay existed.

That clone is still the worker's, `.git` included. Read its files, but run no git in it, not even `git status`, `git diff` or a `git log` at a terminal, and none of its scripts. A submodule the worker added keeps its own config, whose `core.fsmonitor` your `git status` would run as you; so would the clone's own `core.pager` if the replay couldn't put its config back; and an `.envrc`, a `package.json` script or an editor's workspace tasks run as you too, the very thing `user` and `container` keep from happening. awaywork puts back its `.git/config` and removes its `.git/hooks`, nothing else, unless the clone is lost, and prints where it stays, even when the replay fails. To look at the work or keep it, fetch the branch into your own checkout (`git fetch <clone> away/acme-api-1`), which runs nothing of the clone's.

## Write your own

```
~/.config/awaywork/skills/triage-flaky/
  SKILL.md
```

```markdown
---
name: triage-flaky
description: Find out why a test is flaky and make it deterministic. Use when a PR's only failing check is a known flaky test.
metadata:
  deliver: draft_pr
---

# Triage a flaky test

The unit is a pull request whose failing check is a test that passes on
retry. ...

In the PR body, name the test, the cause you found, and the command you
ran 20 times to show it no longer fails.
```

Then name it in a rule:

```yaml
queue:
  - skill: triage-flaky
    where: { type: pr, mine: true, checks: failing, label: flaky }
```

- `metadata.deliver: report` makes the skill report instead of commit; without it, it commits. Where its commits go is the rule's [`deliver`](./chains.md#then): a draft PR unless the rule opts in to a ready one or a `push`.
- `metadata.type` is the conventional-commit type (`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `style` or `revert`) that fills `{type}` in a [branch name](./configuration.md#branch-names), e.g. `{type}/{key}-{title}` gives `feat/ENG-12-login-with-sso` for `implement` and `fix/ENG-14-null-token` for `fix`. The first skill that commits decides, and a [stacked slice](./chains.md#stack) takes its own first skill's; without one, or with any other word, it's `chore`. It's read at plan time, before the clone, so `.awaywork/skills/` in the repo doesn't set it: a repo skill that replaces a built-in gets the built-in's type, any other `chore`.
- `with: { key: value }` on a rule or step lists those values in a Parameters section of the prompt, after the skill; a multi-line value comes JSON-quoted on one line. Document the keys your skill reads under `metadata`, e.g. `metadata: { depth: "quick or thorough" }`; awaywork doesn't check them.

- A skill that judges can write one lowercase word to `.away/out/verdict`, such as `pass` or `fail`. The report shows it, and a [loop](./chains.md#loops)'s `until` can match it.
- A skill that reviews a PR can write its line comments to `.away/out/review.json`, as `review` does: `[{ "path": "src/limit.ts", "line": 42, "body": "Burst should come from config." }]`, `line` on the PR's new side, at most 100 comments and 100 KB. Under [`deliver: pending_review`](./how-it-works.md#delivery) they land on those lines, which must be ones the PR's diff adds or shows as context, with `report.md` as the review's body; when GitHub refuses one, they all go in the body, and an invalid file is left out, the result saying why. Under any other delivery nobody reads it.
- A skill that can't go on without a person's answer writes the questions to `.away/out/questions.md`, in plain text since Jira and Asana show no Markdown, at most 30 KB, and commits nothing, as `implement` and `plan` do on an item too vague to work on. awaywork posts them on your item and waits for a reply there ([Questions](./how-it-works.md#questions)); the next run's `item.md` shows them headed `awaywork's questions`, the replies after them. A step that committed went on, and nobody reads it.
- Any other file a skill writes in `.away/out/` is kept with the run and reaches the [notify](./configuration.md#notify) hook as `$AWAYWORK_OUT_DIR`; awaywork doesn't read it. A hook should treat those files as untrusted input: the model wrote them after reading other people's items. The folder also holds what earlier steps of its [slice](./chains.md#stack) left, so a hook acting on an extra file should check `$AWAYWORK_SKILL` first.
- Say what the output must state, as the built-ins do: what was checked, how, and what couldn't be.
- Context is in `.away/context/<item>/`: `item.md` for every item, plus `diff.patch`, `threads.md` and `checks.md` for a PR.
- `skills: [name]` on a rule, or at the top level for every unit, adds extra skills the agent may call, such as your team's conventions.
