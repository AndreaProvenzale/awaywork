---
description: Where a unit's results go and who sees them, from the morning report and pending reviews to draft and ready PRs, plus notify hook recipes for Notion, Slack and a skill's own output files.
---

# Where results go

The model writes the content, the config picks the destination, and awaywork or your own [notify](./configuration.md#notify) hook does the write, never the model. The integrity rules in [Safety](./safety.md#what-awaywork-publishes) never move. How far a result reaches is your call per rule, quiet by default.

## Reach and ownership

Who sees the result, and whose thing it lands on:

| Reach | Your PR, issue or task | Someone else's PR |
| --- | --- | --- |
| Only you | awaywork: `report` into the morning report, `pending_review` on your own PR (submittable only as a comment). Your hook: a note to yourself, like [ntfy](#the-morning-report-on-your-phone) | awaywork: `report`, `pending_review`. Your hook: the same note |
| Visible, nobody asked to look | awaywork: `draft_pr` (default), `push` onto your PR's branch. Your hook: PR labels, a Notion page, a Slack message | awaywork: nothing, it stays private. Your hook: a Notion page, a Slack message |
| Pings someone | awaywork: `pr`, a ready PR, which asks the code owners. Your hook: reviewers | awaywork: nothing; you submit the pending review. Your hook: a Slack @mention |

The `deliver` values are in [Delivery](./how-it-works.md#delivery), set per rule in [Queue rules](./configuration.md#queue-rules).

## Built in

- **Ready PRs:** `deliver: pr`, a draft still when the chain went wrong, a step asked or said `continue`, or a [gate](./workflows.md#gates) fired. A draft a later run [finishes](./workflows.md#continue) turns ready.
- **Decision cards:** a fired gate tops the PR body with a "Needs a decision" card, or a plan or report rule's post for [its own gates](./workflows.md#gates-of-a-rule-s-own); with none fired, a `Gates: none fired (…)` line. On a `push` the body isn't awaywork's, so the card tops the report's summary and the push still happens.
- **Review comments:** `pending_review` leaves the report and line comments as your pending review, unseen until you submit it.
- **[Questions](./workflows.md#questions):** posted as a comment on your own item, your reply the answer; commits made first open as a draft that says so. On an item not yours they stay in the report.
- **[Plans](./workflows.md#plans):** `deliver: plan` posts `plan.yml`'s tasks under the report and contract on your card and waits: a reply starting `approve` approves, anything else replans; `wait: false` goes ahead unless a gate fires.
- **[Posts that wait](./workflows.md#posts-that-wait):** a `report` rule with `wait: true` posts on your card and waits like a plan, holding its `on_done` move; your `approve` hands the card to the rule whose `where` says `approved: <skill>`.
- **[Lean posts](./workflows.md#files-that-come-back):** with a [store](./workflows.md#store), a plan or report posts `summary.md` and a link per file; the next unit gets the files back on any machine, and an edited file counts as feedback.
- **[Task PRs](./workflows.md#tasks):** each approved task opens its own PR, per its `planned` rule's `deliver`, in the card's repo or [another](./workflows.md#across-repos) the config names, with `Part of <card>` instead of `Closes`.
- **Task posts:** a task has no item, so it writes to the card: questions headed `Questions from task api`, a reporting task's report headed `Result of task qa`, and a `planned` rule's `on_done` move.
- **[`on_done`](./configuration.md#on-done):** `move` sends your own items to a status, state, section or label once the chain published, never someone else's PR; `comment: result` first posts the result (a report, or a link to the PR) with a `Status: done` line. A report that said `continue` posts `Status: continue (1 of 3)` and runs again.

## Recipes

Each is a `notify` block. A config has one `notify.command`, so put several in a script and point `command` at its full path. The `unit` event fires for every step, so each recipe first picks its steps. `AWAYWORK_ITEM_URL`, `AWAYWORK_ITEM_KEY` and `AWAYWORK_SOURCE` hold one line per item; most units have one.

### The morning report on your phone

`$AWAYWORK_REPORT` is markdown for GitHub, with folded `<details>` a phone or chat app shows as tags, so send the plain text `awaywork report` prints. Write the full path of `awaywork` there: after an `npx` install the first on your `PATH` is none or another version.

```yaml
notify:                         # ntfy, the morning report only
  command: >-
    [ "$AWAYWORK_EVENT" = run ] || exit 0;
    awaywork report "$AWAYWORK_RUN_ID" |
    curl -sf -H "Title: awaywork $AWAYWORK_RUN_ID" --data-binary @- "https://ntfy.sh/$NTFY_TOPIC"
  secrets: [NTFY_TOPIC]
```

For a Slack incoming webhook, pipe the report through `jq -Rs '{text:.}'` and post it with `curl -sf -H 'Content-Type: application/json' -d @- "$SLACK_WEBHOOK_URL"`, `SLACK_WEBHOOK_URL` in `secrets`.

### Labels and reviewers

`gh` in your hook: [PR labels, reviewers and ready for review](./configuration.md#pr-labels-reviewers-and-ready-for-review).

### A Notion page per plan

The hook holds your Notion token and picks where the page goes; the model only wrote `report.md`. A sketch against Notion's [create a page](https://developers.notion.com/reference/post-page), with an integration token and a parent page shared with it:

```yaml
notify:
  command: |
    set -e
    [ "$AWAYWORK_EVENT" = unit ] && [ "$AWAYWORK_SKILL" = plan ] || exit 0
    [ "$AWAYWORK_STATUS" = done ] && [ -n "$AWAYWORK_REPORT" ] || exit 0
    key=$(printf '%s\n' "$AWAYWORK_ITEM_KEY" | head -n 1)
    links=$(printf '%s\n' "$AWAYWORK_ITEM_URL" "$AWAYWORK_PR_URL" | sed '/^$/d; s/^/- /')
    body=$(jq -Rs --arg parent "$NOTION_PAGE_ID" --arg title "Plan: $key" --arg links "$links" '{
        parent: { page_id: $parent },
        properties: { title: { title: [{ text: { content: $title } }] } },
        markdown: ($links + "\n\n" + .)
      }' "$AWAYWORK_REPORT")
    curl -sSf -o /dev/null https://api.notion.com/v1/pages \
      -H "Authorization: Bearer $NOTION_TOKEN" \
      -H 'Notion-Version: 2026-03-11' \
      -H 'Content-Type: application/json' \
      -d "$body"
  secrets: [NOTION_TOKEN, NOTION_PAGE_ID]
```

Swap `plan` for any skill; a committing step has the PR body in `$AWAYWORK_REPORT` and the PR in `$AWAYWORK_PR_URL`. Why a hook rather than a Notion [MCP server](./configuration.md#mcp-servers) the skill writes through:

- **Deterministic:** the page is written whenever the step is done, in your script's shape, not when the model remembers.
- **The token stays with you:** a server's secret is one the agent can read, and its tools are ones injected text can call ([Safety](./safety.md#mcp-servers)). The hook runs after the worker; the agent never sees its secrets.
- **Every PR:** MCP servers never start on someone else's PR, so a `review` of a teammate's PR would have no Notion. The hook still sees that step.

### A Slack message when a review is ready

A Slack [incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks), once per finished `review` step:

```yaml
notify:
  command: |
    set -e
    [ "$AWAYWORK_EVENT" = unit ] && [ "$AWAYWORK_SKILL" = review ] || exit 0
    [ "$AWAYWORK_STATUS" = done ] || exit 0
    text="Review of $AWAYWORK_ITEM_KEY${AWAYWORK_VERDICT:+, verdict $AWAYWORK_VERDICT}
    $AWAYWORK_ITEM_URL"
    body=$(jq -n --arg text "$text" '{ text: $text }')
    curl -sSf -o /dev/null -H 'Content-Type: application/json' -d "$body" "$SLACK_WEBHOOK_URL"
  secrets: [SLACK_WEBHOOK_URL]
```

```
Review of acme/api#14, verdict approve
https://github.com/acme/api/pull/14
```

A shared channel shows it to everyone in it, so pick your reach: your own channel keeps it to you, `@` mentions ping people.

### Acting on a skill's own output

Files a skill writes in `.away/out/` besides the report reach the hook in `$AWAYWORK_OUT_DIR`; awaywork doesn't read them. Say your `triage` skill writes the labels it would add to `.away/out/labels.txt`, one per line:

```yaml
notify:
  command: |
    set -e
    [ "$AWAYWORK_EVENT" = unit ] && [ "$AWAYWORK_SKILL" = triage ] || exit 0
    [ "$AWAYWORK_STATUS" = done ] && [ "$AWAYWORK_SOURCE" = github ] || exit 0
    file="$AWAYWORK_OUT_DIR/labels.txt"
    [ -n "$AWAYWORK_OUT_DIR" ] && [ -f "$file" ] && [ ! -L "$file" ] || exit 0
    for label in bug docs flaky needs-repro; do
      if grep -qFx "$label" "$file"; then
        gh issue edit "$AWAYWORK_ITEM_URL" --add-label "$label"
      fi
    done
```

The file is untrusted, written after reading others' text: the hook picks from labels it knows rather than passing lines on, reads a regular file, not a symlink, and never runs or `eval`s it. `$AWAYWORK_SOURCE` being exactly `github` also means one item, from GitHub. The folder also holds earlier [chain](./chains.md#then) steps' files, so check `$AWAYWORK_SKILL`.

## What awaywork won't do

- **Post to Notion or Slack itself:** every service has its own API and token, and your hook covers it in a few lines, with your token.
- **Submit a review, approve, or comment on someone else's PR:** its author wrote what the model read, so can steer what it says. A pending review waits for you to read it.
- **Let a skill pick where its result goes:** a skill writes into `.away/out/` and holds no write token. The rule's `deliver` and your hook decide.
