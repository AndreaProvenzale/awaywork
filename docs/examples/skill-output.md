---
description: A notify hook that reads a file the skill wrote in .away/out/ and labels the issue, treating the file as untrusted.
---

# Acting on a skill's own output

A [`notify`](../guide/results.md#notify) hook. A config has one `notify.command`: to run several, see [Examples](../guide/results.md#examples).

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

The file is untrusted, written after reading others' text: the hook picks from labels it knows rather than passing lines on, reads a regular file, not a symlink, and never runs or `eval`s it. `$AWAYWORK_SOURCE` being exactly `github` also means one item, from GitHub. The folder also holds earlier [chain](../guide/config/chains.md#then) steps' files, so check `$AWAYWORK_SKILL`.
