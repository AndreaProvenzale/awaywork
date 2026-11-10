#!/bin/sh
# Runs a command in the demo's world: its HOME and PATH first, no GitHub token, and Claude Code's token only when the caller exported one.
home=${DEMO_HOME:-/tmp/awaywork-demo}
exec env -i HOME="$home" PATH="$home/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  TERM="${TERM:-xterm-256color}" LANG=en_US.UTF-8 GH_CONFIG_DIR="$home/.gh" CLAUDE_CONFIG_DIR="$home/.claude" \
  ${CLAUDE_CODE_OAUTH_TOKEN:+CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"} "$@"
