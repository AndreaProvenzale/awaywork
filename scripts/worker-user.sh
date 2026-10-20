#!/usr/bin/env bash
# Makes the user repo code runs as on a GitHub-hosted runner: no sudo, docker or cron, no way into the
# runner's home, nothing world-writable to plant in (docs/guide/safety.md). The action runs it, and so does CI.
set -euo pipefail

# Without them, a link the worker makes could hand it a file of the runner's.
for key in fs.protected_hardlinks fs.protected_symlinks; do
  if [ "$(sysctl -n "$key")" != 1 ]; then
    echo "::error::$key is off on this runner, so a worker user would isolate nothing"
    exit 1
  fi
done

sudo useradd --create-home --user-group --shell /bin/bash awaywork
echo awaywork | sudo tee -a /etc/cron.deny > /dev/null
sudo chmod 700 "$HOME"

# Every disk filesystem, whole. Reading its inodes in parallel first cuts the pass from minutes to about one.
for fs in / $(findmnt -rn -t ext2,ext3,ext4,xfs,btrfs -o TARGET | grep -vx /); do
  sudo find "$fs" -xdev -mindepth 2 -maxdepth 2 -type d -print0 |
    sudo xargs -0 -r -P 16 -I{} find {} -xdev -perm -o+w -printf '' 2> /dev/null || true
  sudo find "$fs" -xdev -perm -o+w ! -type l ! \( -type d -perm -1000 \) -exec chmod o-w {} +
  # A default ACL that lets others write makes what's created under it world-writable again.
  sudo find "$fs" -xdev -type d -print0 | sudo xargs -0 -r getfacl -s -p |
    sed 's/^\(default:other::.\)w/\1-/' | sudo setfacl --restore=-
done
