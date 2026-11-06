#!/bin/sh
# The folders interactive agent sessions ran in over the last N days (default 30), from metadata alone.
# A header, then one tab-separated line per agent and folder: agent, sessions, MB, memories, folder, repo (owner/repo, the remote URL, or -).
# Then the user-level files suggest would read, one path per line.
days=${1:-30}
roots=$(printf '%s\n' "$HOME/.claude" ${CLAUDE_CONFIG_DIR:+"$CLAUDE_CONFIG_DIR"} | awk '!seen[$0]++')

sessions() {
  printf '%s\n' "$roots" | while read -r root; do
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

# Claude Code's memory files for a folder, under either root; Codex keeps none per folder.
memories() {
  [ "$1" = claude ] || { printf -- '-'; return; }
  slug=$(printf '%s' "$2" | sed 's/[^A-Za-z0-9]/-/g')
  printf '%s\n' "$roots" | while read -r root; do
    ls "$root/projects/$slug/memory" 2>/dev/null | grep '\.md$' | grep -vx 'MEMORY\.md'
  done | sort -u | wc -l | tr -d ' '
}

printf 'agent\tsessions\tMB\tmemories\tfolder\trepo\n'
sessions | awk -F'\t' '!seen[$1 FS $2]++ { n[$1 FS $4]++; kb[$1 FS $4] += $3; if ($5) url[$1 FS $4] = $5 }
  END { for (k in n) { split(k, p, FS); printf "%s\t%d\t%.1f\t%s\t%s\n", p[1], n[k], kb[k] / 1024, p[2], url[k] } }' |
  sort -t "$(printf '\t')" -k2,2nr | while IFS="$(printf '\t')" read -r agent n mb dir url; do
    # A removed worktree's remote is its repo's: the nearest folder above it that still exists.
    at=$dir
    while [ -n "$at" ] && [ ! -d "$at" ]; do at=${at%/*}; done
    remote=$(git -C "${at:-/}" remote get-url origin 2>/dev/null || printf '%s' "$url")
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$agent" "$n" "$mb" "$(memories "$agent" "$dir")" "$dir" "$(repo "${remote:--}")"
  done

printf '\nuser-level files\n'
{
  printf '%s\n' "$roots" | while read -r root; do
    [ -f "$root/CLAUDE.md" ] && realpath "$root/CLAUDE.md"
    ls "$root/rules" 2>/dev/null | grep '\.md$' | while read -r f; do realpath "$root/rules/$f"; done
  done
  f="${CODEX_HOME:-$HOME/.codex}/AGENTS.md"
  [ -f "$f" ] && realpath "$f"
} | sort -u
