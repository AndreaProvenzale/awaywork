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
| `address-review` | Your PR with unresolved review threads | draft PR |
| `qa-feedback` | A task back from QA, with your PR | draft PR |
| `continue` | A task in progress, with your PR | draft PR |
| `implement` | An issue or task with no PR yet | draft PR |
| `review` | A PR awaiting your review; nothing is posted | report |
| `plan` | A task with no PR: an implementation plan, no code | report |

```sh
nightshift skills list   # every skill a rule can name, and where it comes from
```

The skill decides the work; the [harness](https://github.com/AndreaProvenzale/night-shift/blob/main/harness.md)
wrapped around every skill decides the limits (no forge access, targeted
tests only, no background commands, when to stop). A skill can't lift
them.

## Where skills come from

A rule's skill name is looked up, first match wins, in:

1. `~/.config/night-shift/skills/<name>/`, yours;
2. `.night-shift/skills/<name>/` in the unit's repo, the team's;
3. the built-ins.

A repo that already has a skill of that name in the agent's own folder
(`.claude/skills/`, `.agents/skills/`) keeps it. On a PR someone else
opened, those are the author's: night-shift skips `.night-shift/skills/`
and replaces the agent folder's copy with its own. `config check` sees user
and built-in skills only; an in-repo skill resolves at run time.

## Tweak a built-in

```sh
nightshift skills eject fix-ci
$EDITOR ~/.config/night-shift/skills/fix-ci/SKILL.md
```

The ejected copy shadows the built-in from then on.

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
- Say what the output must state, as the built-ins do: what was checked,
  how, and what couldn't be.
- Context is in `.nightshift/context/<item>/`: `pr.md`, `diff.patch`,
  `threads.md`, `checks.md` for a PR; `issue.md` or `task.md` otherwise.
- `skills: [name]` on a rule adds extra skills the agent may call, such
  as your team's conventions.
