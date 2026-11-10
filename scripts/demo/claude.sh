#!/bin/sh
# Opens Claude Code in the demo's world with the awaywork plugin, taking only CLAUDE_CODE_OAUTH_TOKEN from DEMO_ENV_FILE.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
home=${DEMO_HOME:-/tmp/awaywork-demo}
bin=${CLAUDE_BIN:-$(command -v claude)}
env_file=${DEMO_ENV_FILE:-$repo/.env.local}
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ ! -r "$env_file" ] ||
  CLAUDE_CODE_OAUTH_TOKEN=$(sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' "$env_file" | tr -d "\"'")
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:?export it or add it to $env_file}"
cd "$home"
exec sh "$repo/scripts/demo/env.sh" CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$bin" --plugin-dir "$home/plugin" "$@"
