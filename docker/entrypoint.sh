#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN is empty: set it in the container's environment (on Coolify, the app's Environment Variables)" >&2
  exit 1
fi

# Commits are the token's user's; env vars, so no git config of the developer's gets them.
user=$(gh api user --jq '"\(.id)+\(.login)"')
export GIT_AUTHOR_NAME=${user#*+} GIT_COMMITTER_NAME=${user#*+}
export GIT_AUTHOR_EMAIL=$user@users.noreply.github.com GIT_COMMITTER_EMAIL=$user@users.noreply.github.com

# Only this container uses the state volume, so no lock in it is held: a lock's pid may be ours again after a restart.
state=~/.local/state/awaywork
rm -f "$state"/{run,watch,worker,codex}.lock

# The worker's way out is awaywork's proxy only; without NET_ADMIN the rules fail, the daemon stays up and runs are refused.
sudo -n /usr/local/sbin/awaywork-wall || echo "network wall not set (see above); without cap_add: [NET_ADMIN] the container can't set it" >&2

# The daemon's log is the container's output, for `docker logs` and Coolify's Logs tab.
tail -n0 -F ~/.local/state/awaywork/watch.log 2> /dev/null &
exec awaywork watch
