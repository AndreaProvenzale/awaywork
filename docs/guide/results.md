---
description: Where a unit's results go and who sees them, from the morning report and pending reviews to draft and ready PRs, plus notify hook recipes for Notion, Slack and a skill's own output files.
---

# Where results go

The model writes the content, the config picks the destination, and the write is done by awaywork or by your own [notify](./configuration.md#notify) hook, never by the model. The integrity rules in [Safety](./safety.md#what-awaywork-publishes) never move. How far a result reaches is your call, per rule, and quiet by default.

## Reach and ownership

Two questions: who gets to see the result, and whose thing it lands on.

| Reach | Your PR, issue or task | Someone else's PR |
| --- | --- | --- |
| Only you | awaywork: `report` into the morning report, `pending_review` on your own PR (you can submit it only as a comment). Your hook: a note to yourself, like the ntfy recipe in [Notify](./configuration.md#notify) | awaywork: `report`, `pending_review`. Your hook: the same note to yourself |
| Visible, nobody asked to look | awaywork: `draft_pr` (the default), `push` onto your own PR's branch. Your hook: labels on the PR, a page in your Notion, a Slack message | awaywork: nothing, it stays private. Your hook: a page in your Notion, a Slack message |
| Pings someone | awaywork: `pr`, a ready PR, which asks the code owners. Your hook: reviewers | awaywork: nothing; submitting the pending review is you, by hand. Your hook: a Slack message that @mentions someone |

The `deliver` values are in [Delivery](./how-it-works.md#delivery), set per rule in [Queue rules](./configuration.md#queue-rules).

## Built in

- **Ready PRs:** `deliver: pr` on the rule, a draft still when something in the slice went wrong. See [Delivery](./how-it-works.md#delivery).
- **Review comments:** `deliver: pending_review` leaves the report and its line comments as your pending review, unseen until you submit it. See [Delivery](./how-it-works.md#delivery).

## Recipes

Each one is a `notify` block on its own. A config has one `notify.command`, so to run several, put them in a script and point `command` at its full path. The `unit` event fires for every step of a unit, which is why each recipe starts by picking the steps it cares about. `AWAYWORK_ITEM_URL`, `AWAYWORK_ITEM_KEY` and `AWAYWORK_SOURCE` hold one line per item; most units have one.

### Labels and reviewers

Not config: `gh` in your hook does it, see [PR labels, reviewers and ready for review](./configuration.md#pr-labels-reviewers-and-ready-for-review).

### A Notion page per plan

The hook holds your Notion token and decides where the page goes; the model only wrote `report.md`. A sketch against Notion's [create a page](https://developers.notion.com/reference/post-page) endpoint, with an integration token and a parent page shared with that integration:

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

Swap `plan` for whichever skill's output you want there. A step that commits has the PR body in `$AWAYWORK_REPORT` and the PR in `$AWAYWORK_PR_URL`.

You could instead give the rule a Notion [MCP server](./configuration.md#mcp-servers) and have the skill write the page. The hook wins:

- **Deterministic.** The page gets written whenever the step is done, in the shape your script says, not when the model remembers to.
- **The token stays with you.** A server's secret is one the agent can read, and its write tools are tools an item's injected instructions can call ([Safety](./safety.md#mcp-servers)). The hook runs once the worker is done, and the agent never sees its secrets.
- **It works on every PR.** MCP servers never start on someone else's PR, so a `review` rule on a teammate's PR would have no Notion at all. The hook still sees that step.

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

What lands in the channel:

```
Review of acme/api#14, verdict approve
https://github.com/acme/api/pull/14
```

A shared channel shows it to everyone in it, so that's your reach to pick: a channel of your own keeps it to you. Add `@` mentions to the text and it pings people.

### Acting on a skill's own output

Any file a skill writes in `.away/out/` besides the report reaches the hook in `$AWAYWORK_OUT_DIR`, and awaywork doesn't read it. Say your own `triage` skill writes the labels it would put on an issue to `.away/out/labels.txt`, one per line:

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

That file is untrusted input: the model wrote it after reading other people's text. So the hook picks from a list it knows instead of passing the file's lines on, reads a regular file and not a symlink, and never runs or `eval`s what's in it. `$AWAYWORK_SOURCE` matching `github` exactly also means one item, from GitHub. The folder holds what earlier steps of the [slice](./chains.md#stack) left too, so check `$AWAYWORK_SKILL` before trusting a file to be this step's.

## What awaywork won't do

- **Built-in Notion or Slack posting.** Every service has its own API and token, and your hook already covers it in a few lines, with your token and not awaywork's.
- **Submit a review, approve, or comment on someone else's PR.** Its author wrote the diff and the description the model read, so they can steer what the model says. A pending review waits for you to read it first.
- **Let a skill pick where its result goes.** A skill writes files into `.away/out/` and holds no write token. Where they go is the rule's `deliver` and your hook.
