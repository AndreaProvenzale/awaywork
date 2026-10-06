---
description: The built-in night-shift skills, how skills are resolved, ejecting one to tweak it, and writing your own as an Agent Skills folder.
---

# Skills

A skill tells the worker what to do with a unit. Every skill is an
[Agent Skills](https://agentskills.io) folder with a `SKILL.md`, so the
same folder works for Claude Code and Codex.

## Built-in skills

| Skill | For | Delivers |
|---|---|---|
| `fix-ci` | Your PR with failing checks | draft PR |
| `address-review` | Your PR with unresolved review threads, a night-shift PR with unresolved threads you started, or tonight's review in a [loop](./configuration.md#loops) | draft PR |
| `qa-feedback` | A task back from QA, with your PR | draft PR |
| `continue` | A task in progress, with your PR | draft PR |
| `implement` | An issue or task with no PR yet | draft PR |
| `review` | A PR awaiting your review, or tonight's own after a `then`; nothing is posted. Writes a verdict: `approve`, `comments` or `changes` | report |
| `plan` | A task with no PR: an implementation plan, no code | report |

```sh
nightshift skills list   # every skill a rule can name, and where it comes from
```

The skill decides the work; the [harness](https://github.com/AndreaProvenzale/night-shift/blob/main/harness.md)
wrapped around every skill decides the limits (no forge access, targeted
tests only, no background commands, when to stop). A skill can't lift
them.

## Where skills come from

A skill name, a rule's or one in `skills`, is looked up, first match
wins, in:

1. `~/.config/night-shift/skills/<name>/`, yours;
2. `.night-shift/skills/<name>/` in the unit's repo, the team's;
3. the built-ins.

On a PR someone else opened, `.night-shift/skills/` is the author's and
is skipped. To use a skill from `~/.claude/skills/`, link it into yours:
`ln -s ~/.claude/skills/<name> ~/.config/night-shift/skills/<name>`.

Claude Code gets the unit's skills as a plugin outside the clone
(`--plugin-dir`), named `nightshift:<name>`, so they are callable on
every unit, someone else's PR included. Codex gets them copied into the
clone's `.agents/skills/`: a repo that already has a skill of that name
there keeps it, except on someone else's PR, where night-shift's copy
replaces it. `config check` sees user and built-in skills only; an
in-repo skill resolves at run time.

## Tweak a built-in

```sh
nightshift skills eject fix-ci
$EDITOR ~/.config/night-shift/skills/fix-ci/SKILL.md
```

The ejected copy shadows the built-in from then on.

## Try an edit on a past unit

```sh
nightshift replay 20261006-020000 acme-api-1
```

Replay rebuilds a unit of a past run: a clone at the commit the unit started
from, its saved context, and today's skills, instructions and config. It
runs the unit's provider and model once, outside the night's quota ceilings,
and never pushes or opens a PR. The clone stays on the unit's local branch
under `replays/` in the run's state directory, with the worker's `out/` next
to it. The saved context is the post-run copy, so files the worker edited
under `context/` are replayed as edited. MCP servers are not started. Only a
unit's first run replays: a [loop](./configuration.md#loops) round after the
first reuses the first round's clone and records no `replay.json`, so does a
unit that never started or one from a run before replay existed.

## Write your own

```
~/.config/night-shift/skills/triage-flaky/
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
  thorough" }`; night-shift doesn't check them.
- A skill that judges can write one lowercase word to
  `.nightshift/out/verdict`, such as `pass` or `fail`. The report shows
  it, and a [loop](./configuration.md#loops)'s `until` can match it.
- Say what the output must state, as the built-ins do: what was checked,
  how, and what couldn't be.
- Context is in `.nightshift/context/<item>/`: `pr.md`, `diff.patch`,
  `threads.md`, `checks.md` for a PR; `issue.md` or `task.md` otherwise.
- `skills: [name]` on a rule, or at the top level for every unit, adds
  extra skills the agent may call, such as your team's conventions.
