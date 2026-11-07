#!/bin/sh
# The folders interactive agent sessions ran in over the last N days (default 30), from metadata and config alone.
# Usage: folders.sh [days] [claude-folder...], the Claude folders defaulting to ~/.claude and $CLAUDE_CONFIG_DIR.
# A header, then one tab-separated line per agent, Claude folder and folder: agent, sessions, MB, memories,
# claude (the Claude folder, - for Codex), mcp (the servers set up for that folder, enabled or not), folder, repo.
# Then the MCP servers by name, scope, type and URL host; then the user-level files suggest would read.
days=${1:-30}
[ $# -gt 0 ] && shift
[ $# -gt 0 ] || set -- "$HOME/.claude" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"}
roots=$(printf '%s\n' "$@" | sed 's#//*$##' | awk 'NF && !seen[$0]++')
tab=$(printf '\t')
seen=$(mktemp)
trap 'rm -f "$seen"' EXIT

sessions() {
  printf '%s\n' "$roots" | while read -r root; do
    [ -d "$root/projects" ] || continue
    find "$root/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -"$days" | while read -r f; do
      jq -rn --arg kb "$(($(wc -c <"$f") / 1024))" --arg root "$root" \
        'first(inputs | select(.entrypoint)) | select(.entrypoint != "sdk-cli")
        | ["claude", .sessionId, $kb, .cwd, "", $root] | @tsv' "$f" 2>/dev/null
    done
  done
  codex="${CODEX_HOME:-$HOME/.codex}/sessions"
  [ -d "$codex" ] && find "$codex" -name 'rollout-*.jsonl' -mtime -"$days" | while read -r f; do
    # A file with no turn_context is a Claude Code session Codex Desktop imported.
    jq -en 'any(inputs; .type == "turn_context")' "$f" >/dev/null 2>&1 || continue
    head -1 "$f" | jq -r --arg kb "$(($(wc -c <"$f") / 1024))" \
      'select(.type == "session_meta") | .payload | select(.originator != "codex_exec")
      | ["codex", .id, $kb, .cwd, (.git.repository_url // ""), "-"] | @tsv' 2>/dev/null
  done
}

# owner/repo from a GitHub remote, else the remote without credentials, query or fragment.
repo() {
  printf '%s\n' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#; s|[?#].*$||; s#^(git@|ssh://|https?://)github\.com(:[0-9]+)?[:/]##; s#\.git$##'
}

# Claude Code keeps the default folder's settings in ~/.claude.json, any other's inside it.
settings() {
  if [ "$1" = "$HOME/.claude" ]; then printf '%s' "$HOME/.claude.json"; else printf '%s' "$1/.claude.json"; fi
}

# A Claude folder's memory files for a folder; Codex keeps none per folder.
memories() {
  [ "$1" = - ] && { printf -- '-'; return; }
  slug=$(printf '%s' "$2" | sed 's/[^A-Za-z0-9]/-/g')
  ls "$1/projects/$slug/memory" 2>/dev/null | grep '\.md$' | grep -vxc 'MEMORY\.md'
}

# The MCP server names set up for a folder: the Claude folder's own for it, disabled ones too, and the repo's .mcp.json.
mcp() {
  [ "$1" = - ] && { printf -- '-'; return; }
  names=$({
    jq -r --arg d "$2" '.projects[$d] // {} | (.mcpServers // {} | keys[]), (.disabledMcpServers // [])[]' "$(settings "$1")" 2>/dev/null
    jq -r '.mcpServers // {} | keys[]' "$3/.mcp.json" 2>/dev/null
  } | awk 'NF && !seen[$0]++' | paste -sd ',' - | sed 's/,/, /g')
  printf '%s' "${names:--}"
}

# name, scope, type and URL host of each server in a settings file's mcpServers; never its headers, env, args or full URL.
servers() {
  jq -r --arg scope "$2" '.mcpServers // {} | to_entries[]
    | (.value.type // (if .value.url then "http" else "stdio" end)) as $type
    | ((.value.url // "") | sub("^[A-Za-z][A-Za-z0-9+.-]*://"; "") | sub("[/?#].*$"; "") | sub("^.*@"; "") | sub(":[0-9]+$"; "")) as $host
    | [.key, $scope, (if $type | test("^[a-z-]+$") then $type else "?" end),
       (if $host == "" then "-" elif $host | test("^[A-Za-z0-9.-]+$") then $host else "?" end)] | @tsv' "$1" 2>/dev/null
}

home() {
  case $1 in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac
}

printf 'agent\tsessions\tMB\tmemories\tclaude\tmcp\tfolder\trepo\n'
sessions | awk -F'\t' '!seen[$1 FS $2]++ { k = $1 FS $6 FS $4; n[k]++; kb[k] += $3; if ($5) url[k] = $5 }
  END { for (k in n) { split(k, p, FS); printf "%s\t%d\t%.1f\t%s\t%s\t%s\n", p[1], n[k], kb[k] / 1024, p[2], p[3], url[k] } }' |
  sort -t "$tab" -k2,2nr | while IFS="$tab" read -r agent n mb root dir url; do
    # A removed worktree's remote is its repo's: the nearest folder above it that still exists.
    at=$dir
    while [ -n "$at" ] && [ ! -d "$at" ]; do at=${at%/*}; done
    top=$(git -C "${at:-/}" rev-parse --show-toplevel 2>/dev/null || printf '%s' "${at:-/}")
    remote=$(git -C "${at:-/}" remote get-url origin 2>/dev/null || printf '%s' "$url")
    [ "$root" = - ] || printf '%s\t%s\t%s\n' "$root" "$dir" "$top" >>"$seen"
    shown=$root
    [ "$root" = - ] || shown=$(home "$root")
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$agent" "$n" "$mb" "$(memories "$root" "$dir")" "$shown" "$(mcp "$root" "$dir" "$top")" "$dir" "$(repo "${remote:--}")"
  done

printf '\nmcp servers\nname\tscope\ttype\thost\n'
{
  printf '%s\n' "$roots" | while read -r root; do servers "$(settings "$root")" user; done
  sort -u "$seen" | while IFS="$tab" read -r root dir top; do
    jq --arg d "$dir" '.projects[$d] // {}' "$(settings "$root")" 2>/dev/null | servers /dev/stdin local
    servers "$top/.mcp.json" project
  done
} | sort -u

printf '\nuser-level files\n'
{
  printf '%s\n' "$roots" | while read -r root; do
    [ -f "$root/CLAUDE.md" ] && realpath "$root/CLAUDE.md"
    ls "$root/rules" 2>/dev/null | grep '\.md$' | while read -r f; do realpath "$root/rules/$f"; done
  done
  f="${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
  [ -f "$f" ] && realpath "$f"
} | sort -u
