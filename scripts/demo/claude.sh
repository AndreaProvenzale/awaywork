#!/bin/sh
# Opens Claude Code in the demo's world with the awaywork plugin, taking only CLAUDE_CODE_OAUTH_TOKEN from DEMO_ENV_FILE.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
home=${DEMO_HOME:-/tmp/awaywork-demo}
bin=${CLAUDE_BIN:-$(command -v claude)}
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || eval "$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "${DEMO_ENV_FILE:-$repo/.env.local}")"
export CLAUDE_CODE_OAUTH_TOKEN
cd "$home"
exec sh "$repo/scripts/demo/env.sh" CLAUDE_CODE_NO_FLICKER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  "$bin" --plugin-dir "$home/plugin" "$@"
