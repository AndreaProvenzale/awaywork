---
description: A notify hook that sends the morning report to ntfy, or Slack.
---

# The morning report on your phone

A [`notify`](../guide/results.md#notify) hook. A config has one `notify.command`: to run several, see [Examples](../guide/results.md#examples).

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
