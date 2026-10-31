# One line per interactive Claude Code session: jq -nc -f claude-sessions.jq <session>.jsonl
def text: if type == "string" then . elif type == "array" then map(select(.type == "text") | .text) | join(" ") else "" end;
def prompt: .message.content | text
  | if test("<command-name>") then (capture("<command-name>(?<n>[^<]*)</command-name>").n) + " " + ((capture("<command-args>(?<a>[^<]*)</command-args>") // {a: ""}).a)
    elif test("^\\s*(<|\\[Request interrupted)") then null else . end;
def human: .type == "user" and (.isSidechain | not) and (.isMeta | not)
  and ((.origin.kind // "human") == "human")
  and (.message.content | type == "string" or (type == "array" and all(.[]; .type == "text")))
  and (prompt | . != null and (test("^/(clear|compact|resume|reload-plugins|plugin|model|config|exit) ") | not));
def edits: .type == "assistant" and any(.message.content[]?; .type == "tool_use" and (.name | test("^(Edit|Write|MultiEdit|NotebookEdit)$")));
[inputs] as $l
| ($l | map(select(.entrypoint)) | first) as $h
| select($h != null and $h.entrypoint != "sdk-cli")
| [$l[] | select((.type == "user" or .type == "assistant") and (.isSidechain | not))] as $t
| [$t[] | select(human)] as $p
| {
    session: $h.sessionId, start: $h.timestamp, cwd: $h.cwd, branch: $h.gitBranch,
    prs: [$l[] | select(.type == "pr-link") | .prUrl] | unique,
    first: ($p[0] | if . then prompt | .[0:200] else null end),
    turns: ($p | length),
    interrupted: [$t[] | select(.type == "user" and (.message.content | text | startswith("[Request interrupted by user")))] | length,
    rejected: [$t[] | .message.content | arrays | .[] | select(.type == "tool_result" and .is_error == true and ((.content | tostring) | startswith("The user doesn't want to proceed")))] | length,
    after_edit: (reduce $t[] as $m ({e: false, n: 0}; if ($m | human) then {e: false, n: (.n + (if .e then 1 else 0 end))} elif ($m | edits) then .e = true else . end) | .n)
  }
