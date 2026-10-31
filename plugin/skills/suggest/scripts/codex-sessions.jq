# One line per interactive Codex session: jq -nc -f codex-sessions.jq rollout-*.jsonl
[inputs] as $l
| ($l | map(select(.type == "session_meta")) | first | .payload) as $h
| select($h != null and $h.originator != "codex_exec")
| [$l[] | select(.type == "event_msg" and .payload.type == "user_message") | .payload.message] as $p
| {
    session: $h.id, start: $h.timestamp, cwd: $h.cwd, branch: $h.git.branch,
    first: ($p[0] // "" | .[0:200]),
    turns: ($p | length),
    aborted: [$l[] | select(.type == "event_msg" and .payload.type == "turn_aborted")] | length
  }
