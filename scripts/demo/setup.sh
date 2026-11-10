#!/bin/sh
# Builds the demo's made-up world in DEMO_HOME: a config, its tracker, fake gh and claude, and the awaywork from this checkout.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
demo=$repo/scripts/demo
home=${DEMO_HOME:-/tmp/awaywork-demo}

rm -rf "${home:?}"
mkdir -p "$home/bin" "$home/.config/awaywork" "$home/.gh" "$home/fixtures/gh"
cp "$demo/config.yml" "$demo/tracker.mjs" "$demo/tasks.json" "$home/.config/awaywork/"
cp "$repo"/test/fixtures/gh/* "$home/fixtures/gh/"
cp "$demo/bin/claude" "$demo/bin/gh" "$home/bin/"
printf '#!/bin/sh\nexec node %s/dist/index.js "$@"\n' "$repo" >"$home/bin/awaywork"
chmod +x "$home/bin/"*

# acme/api and acme/web as local repos: git's clones and pushes to github.com land here.
git config --file "$home/.gitconfig" user.name 'Demo Dev'
git config --file "$home/.gitconfig" user.email dev@example.com
git config --file "$home/.gitconfig" init.defaultBranch main
git config --file "$home/.gitconfig" url."file://$home/remotes/".insteadOf https://github.com/
for name in api web; do
  bare=$home/remotes/acme/$name.git
  git init -q --bare "$bare"
  work=$home/work/$name
  HOME=$home git init -q "$work"
  echo "# acme/$name" >"$work/README.md"
  HOME=$home git -C "$work" add README.md
  HOME=$home git -C "$work" commit -qm 'First commit'
  HOME=$home git -C "$work" push -q "$bare" main
  [ "$name" = api ] && HOME=$home git -C "$work" push -q "$bare" main:rate-limits main:sessions
done
rm -rf "$home/work"

# Claude Code for the pane: the plugin, and a config dir past onboarding that trusts the demo's home.
cp -R "$repo/plugin" "$home/plugin"
mkdir -p "$home/.claude"
trusted='{"hasTrustDialogAccepted":true}'
printf '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"%s":%s,"%s":%s}}\n' \
  "$home" "$trusted" "$(cd "$home" && pwd -P)" "$trusted" >"$home/.claude/.claude.json"
