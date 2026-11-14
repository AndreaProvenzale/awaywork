---
description: A notify hook that writes each plan step's report to a Notion page, and why a hook beats an MCP server here.
---

# A Notion page per plan

A [`notify`](../guide/results.md#notify) hook. A config has one `notify.command`: to run several, see [Examples](../guide/results.md#examples).

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

Swap `plan` for any skill; a committing step has the PR body in `$AWAYWORK_REPORT` and the PR in `$AWAYWORK_PR_URL`. Why a hook rather than a Notion [MCP server](../guide/config/mcp.md) the skill writes through:

- **Deterministic:** the page is written whenever the step is done, in your script's shape, not when the model remembers.
- **The token stays with you:** a server's secret is one the agent can read, and its tools are ones injected text can call ([Safety](../guide/safety/index.md#mcp-servers)). The hook runs after the worker; the agent never sees its secrets.
- **Every PR:** MCP servers never start on someone else's PR, so a `review` of a teammate's PR would have no Notion. The hook still sees that step.
