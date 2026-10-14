---
description: The built-in awaywork skills, how skills are resolved, ejecting one to tweak it, and writing your own as an Agent Skills folder.
---

# Skills

A skill tells the worker what to do with a unit. Every skill is an
[Agent Skills](https://agentskills.io) folder with a `SKILL.md`, so the
same folder works for Claude Code and Codex.

## Built-in skills

| Skill | For | Delivers |
|---|---|---|
| `fix` | Problems listed on an item: your PR's failing checks or unresolved review threads, threads you started on an awaywork PR, a task back from QA, an error report from a [custom source](./custom-sources.md#recipe-sentry-errors), or this run's review in a [loop](./configuration.md#loops) | draft PR |
| `implement` | An issue or task with no PR yet, or one in progress with your PR: it takes the unambiguous next steps | draft PR |
| `review` | A PR awaiting your review, or this run's own after a `then`; nothing is posted. Writes a verdict: `approve`, `comments` or `changes` | report |
| `plan` | A task with no PR: an implementation plan, no code | report |

```sh
awaywork skills list   # every skill a rule can name, and where it comes from
```

The skill decides the work; the [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md)
wrapped around every skill decides the limits (no forge access, targeted
tests only, no background commands, when to stop). A skill can't lift
them.

## Where skills come from

A skill name, a rule's or one in `skills`, is looked up, first match
wins, in:

1. `skills/<name>/` next to your config, yours: `~/.config/awaywork/skills/`
   for the default config;
2. `.awaywork/skills/<name>/` in the unit's repo, the team's;
3. the built-ins.

A config outside `~/.config/awaywork/` (`--config`, `AWAYWORK_CONFIG`)
uses its own `skills/`, so move or link the folder there; `doctor` warns
while `~/.config/awaywork/skills/` holds skills it doesn't use. On a PR someone
else opened, `.awaywork/skills/` is the author's and is skipped. To use a
skill from `~/.claude/skills/`, link it into yours:
`ln -s ~/.claude/skills/<name> ~/.config/awaywork/skills/<name>`.

On a runner, yours are the copy `schedule install --with github-actions`
puts next to the repo's config: `.awaywork/skills/`, or, in a
[shared control repo](./scheduling.md#shared-control-repo), each
person's own `.awaywork/<person>/skills/`. A teammate's skills never
reach your units.

Claude Code gets the unit's skills as a plugin outside the clone
(`--plugin-dir`), named `awaywork:<name>`, so they are callable on
every unit, someone else's PR included. Codex gets them copied into the
clone's `.agents/skills/`: a repo that already has a skill of that name
there keeps it, except on someone else's PR, where awaywork's copy
replaces it. `doctor` and `config edit` see user and built-in skills
only, so `doctor` warns about a name it can't find and `config edit`
refuses it; an in-repo skill resolves at run time.

## Tweak a built-in

```sh
awaywork skills eject fix
$EDITOR ~/.config/awaywork/skills/fix/SKILL.md
```

The ejected copy shadows the built-in from then on.

## Try an edit on a past unit

::: warning Experimental
`replay` has only run in tests so far, never in a real run. Tried it?
[Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
:::

```sh
awaywork replay 20261006-020000 acme-api-1
```

Replay rebuilds a unit of a past run: a clone at the commit the unit started
from and its saved context. The unit is as recorded in that run: its skills
and its rule's `model`, `with` and `instructions` list, so editing those in
the config changes nothing. What is read fresh is the files: each
`SKILL.md`, every instruction file, and the repo's and provider's config.
It runs the unit's provider and model once, outside the run's quota
ceilings, and never pushes or opens a PR. The clone stays on the unit's local
branch under `replays/` in the run's state directory, with the worker's
`out/` next to it. The saved context is the post-run copy, so files the
worker edited under `context/` are replayed as edited. Setup gets none of the
repo's `secrets`, and MCP servers are not started. Only a unit's first run
replays: a [loop](./configuration.md#loops) round after the first reuses the
first round's clone and records no `replay.json`, so does a unit that never
started or one from a run before replay existed. A loop's first round
replays without the prompt's loop section.

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

- `metadata.deliver` sets the default delivery: `draft_pr` or `report`.
  `push` is only a rule's to set.
- `with: { key: value }` on a rule or step lists those values in a
  Parameters section of the prompt, after the skill; a multi-line value
  comes JSON-quoted on one line. Document the keys your skill reads under `metadata`, e.g. `metadata: { depth: "quick or
  thorough" }`; awaywork doesn't check them.

  ::: warning Experimental
  `with` has only run in tests so far, never in a real run. Tried it?
  [Open an issue](https://github.com/AndreaProvenzale/awaywork/issues/new) with how it went.
  :::

- A skill that judges can write one lowercase word to
  `.away/out/verdict`, such as `pass` or `fail`. The report shows
  it, and a [loop](./configuration.md#loops)'s `until` can match it.
- Say what the output must state, as the built-ins do: what was checked,
  how, and what couldn't be.
- Context is in `.away/context/<item>/`: `item.md` for every item, plus
  `diff.patch`, `threads.md` and `checks.md` for a PR.
- `skills: [name]` on a rule, or at the top level for every unit, adds
  extra skills the agent may call, such as your team's conventions.
