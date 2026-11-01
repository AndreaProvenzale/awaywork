# One line per interactive Codex session, once per file: jq -nc -f codex-sessions.jq <rollout>.jsonl
def prompt: if test("<command-name>") then (capture("<command-name>(?<n>[^<]*)</command-name>").n) + " " + ((capture("<command-args>(?<a>[^<]*)</command-args>") // {a: ""}).a)
  elif test("^\\s*(<|\\[Request interrupted)") then null else . end;
[inputs] as $l
| ($l | map(select(.type == "session_meta")) | first | .payload) as $h
| select($h != null and $h.originator != "codex_exec" and any($l[]; .type == "turn_context"))
| [$l[] | select(.type == "event_msg" and .payload.type == "user_message") | .payload.message] as $e
| [$l[] | select(.type == "response_item" and .payload.type == "message" and .payload.role == "user")
    | [.payload.content[]? | select(.type == "input_text") | .text | select(test("^\\s*(<|# AGENTS\\.md)") | not)] | join(" ")] as $r
| [(if ($e | length) > 0 then $e else $r end)[] | prompt | select(. != null and length > 0)] as $p
| {
    session: $h.id, start: $h.timestamp, cwd: $h.cwd, branch: $h.git.branch,
    first: ($p[0] // "" | .[0:200]),
    turns: ($p | length),
    aborted: [$l[] | select(.type == "event_msg" and .payload.type == "turn_aborted")] | length
  }
