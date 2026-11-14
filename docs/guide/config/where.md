---
description: "How a rule's where picks items, and the fields each source gives: GitHub, Asana, Linear, Jira, routines and your own."
---

# Matching items

A rule runs on the items its `where` matches, by the fields their source gives.

## `where`

Every key must hold; `any` lists alternatives:

```yaml
where:
  type: pr                          # equals
  checks: [failing, pending]        # any of
  review_requested: { not: true }   # not
  unresolved_threads: { gte: 2 }    # on a number field: gt, gte, lt, lte; combine for a range
  updated: { older_than: 3d }       # on a date field: older_than, newer_than; m, h, d or w
  title: { matches: '^\[bug\]' }    # on title, description or a text field: case-insensitive regex
  label: awaywork                # on a list field: contains; GitHub issues must also be assigned to you
  behind: { gt: 0 }                 # GitHub: your PR's base has commits its branch lacks; see sync
  conflicts: false                  # GitHub: it merges cleanly into its base
  "fields.Priority": High           # an Asana custom field
  blocked: false                    # Linear, Jira, Asana: no open blocker
  any:                              # at least one entry holds; each is a where, ANDed with the keys above
    - { label: urgent }
    - { checks: failing }
```

Strings compare ignoring case (`section: In progress` matches `In Progress`); numbers and booleans exactly; fixed values like `type` are lowercase. The keys are the item's [fields](#fields).

Details:

- A missing field equals nothing and is neither older nor newer than anything. Spans count back from when the plan runs.
- Config errors: an unknown key (the error lists each source's keys), an invalid regex, an empty `any` entry.
- `plan` names the match an item failed, for `any` each entry's.
- GitHub reads only issues assigned to you, so a labelled issue nobody assigned to you plans nothing, unless a `search` reads it; then `mine: true` keeps a rule to yours.

## Fields

Every item has:

- `type` (`pr`, `issue` or `task`), `title` and `description`;
- `approved`: the skill of awaywork's newest result on it that you approved or that [went ahead](../workflows/posts.md#posts-that-wait); `approved: true` is an error that says so;
- `state`: `open`, or `merged` or `closed` for the [finished items](./queue-rules.md#finished-items) a rule asks for; `closed` is when it finished;
- `planned`: it's a [task](../workflows/tasks.md) of a plan you approved.

The trackers' fields, shared ones first:

| Field | Sources | Value |
| --- | --- | --- |
| `repo` | All | `owner/name`; on a tracker, from `repo_map` |
| `created`, `updated` | All | ISO times; a routine's are the occurrence |
| `project` | Asana, Linear, Jira | Its name; Jira's key |
| `status` | Linear, Jira | The workflow state |
| `labels` | Linear, Jira | Asana calls them `tags`, GitHub `label` |
| `priority` | Linear, Jira | `High` |
| `blocked` | Asana, Linear, Jira | An open blocker: an incomplete dependency, a blocking issue, an "is blocked by" link |
| `fields.<custom field>` | Asana, Jira | The custom field's value |
| `section` | Asana | Its section in the project |
| `due` | Asana | Date, or date and time |
| `team` | Linear | Its key |
| `issuetype` | Jira | `Bug` |
| `name` | Routines | The routine's name |

GitHub's own:

| Field | On | Value |
| --- | --- | --- |
| `label` | PRs, issues | Its labels |
| `author` | PRs, issues | The author's login |
| `trusted` | PRs, issues | The author is an owner, member or collaborator |
| `mine` | PRs, issues | A PR you authored, an issue assigned to you |
| `ours` | PRs | awaywork opened it |
| `draft` | PRs | It's a draft |
| `review_requested` | PRs | Your review is requested |
| `checks` | PRs | `failing`, `pending` or `passing` |
| `unresolved_threads` | PRs | Those [shown to the agent](../safety/index.md#public-repos) |
| `my_unresolved_threads` | PRs | Those you started |
| `files` | PRs | The first 500 paths it touches; test with `matches` |
| `changed_lines` | PRs | Additions plus deletions |
| `conflicts` | PRs | It doesn't merge cleanly into its base; unset while GitHub works it out |
| `behind` | Your open PRs | Commits on its base its branch lacks |

A custom source's are the `fields` its config lists ([Custom sources](./custom-sources.md)).
