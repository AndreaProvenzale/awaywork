#!/bin/sh
# Renders docs/public/demo/: the quick-start GIF, then a second night's run and the /away pane's PNGs, Needs you and Config. Needs vhs, and for the pane Claude Code and a token.
set -eu
cd "$(dirname "$0")/../.."
home=${DEMO_HOME:-/tmp/awaywork-demo}

pnpm build
sh scripts/demo/setup.sh
vhs scripts/demo/quickstart.tape

# The next night: a card moved to Ready, so the run has a unit and the pane has the drafts and questions of both.
tasks=$home/.config/awaywork/tasks.json
sed 's/"Backlog"/"Ready"/' "$tasks" >"$tasks.next" && mv "$tasks.next" "$tasks"
sh scripts/demo/env.sh sh -c 'cd && awaywork run' >/dev/null
vhs scripts/demo/pane.tape
