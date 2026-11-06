#!/bin/sh
# The folders interactive agent sessions ran in over the last N days (default 30), from metadata alone.
# One tab-separated line per agent and folder: agent, sessions, KB, folder, repo (owner/repo, the remote URL, or -).
days=${1:-30}

sessions() {
  for root in "$HOME/.claude" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"}; do
    [ -d "$root/projects" ] || continue
    find "$root/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -"$days" | while read -r f; do
      jq -rn --arg kb "$(($(wc -c <"$f") / 1024))" \
        'first(inputs | select(.entrypoint)) | select(.entrypoint != "sdk-cli")
        | ["claude", .sessionId, $kb, .cwd, ""] | @tsv' "$f" 2>/dev/null
    done
  done
  codex="${CODEX_HOME:-$HOME/.codex}/sessions"
  [ -d "$codex" ] && find "$codex" -name 'rollout-*.jsonl' -mtime -"$days" | while read -r f; do
    # A file with no turn_context is a Claude Code session Codex Desktop imported.
    jq -en 'any(inputs; .type == "turn_context")' "$f" >/dev/null 2>&1 || continue
    head -1 "$f" | jq -r --arg kb "$(($(wc -c <"$f") / 1024))" \
      'select(.type == "session_meta") | .payload | select(.originator != "codex_exec")
      | ["codex", .id, $kb, .cwd, (.git.repository_url // "")] | @tsv' 2>/dev/null
  done
}

# owner/repo from a GitHub remote, else the remote as is.
repo() {
  printf '%s\n' "$1" | sed -E 's#^(git@|ssh://git@|https://)github\.com[:/]##; s#\.git$##'
}

sessions | awk -F'\t' '!seen[$1 FS $2]++ { n[$1 FS $4]++; kb[$1 FS $4] += $3; if ($5) url[$1 FS $4] = $5 }
  END { for (k in n) { split(k, p, FS); print p[1] "\t" n[k] "\t" kb[k] "\t" p[2] "\t" url[k] } }' |
  sort -t "$(printf '\t')" -k2,2nr | while IFS="$(printf '\t')" read -r agent n kb dir url; do
    # A removed worktree's remote is its repo's: the nearest folder above it that still exists.
    at=$dir
    while [ -n "$at" ] && [ ! -d "$at" ]; do at=${at%/*}; done
    remote=$(git -C "${at:-/}" remote get-url origin 2>/dev/null || printf '%s' "$url")
    printf '%s\t%s\t%s\t%s\t%s\n' "$agent" "$n" "$kb" "$dir" "$(repo "${remote:--}")"
  done
