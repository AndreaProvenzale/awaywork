---
description: A notify hook that posts to a Slack incoming webhook once per finished review step.
---

# A Slack message when a review is ready

A [`notify`](../guide/results.md#notify) hook. A config has one `notify.command`: to run several, see [Examples](../guide/results.md#examples).

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
