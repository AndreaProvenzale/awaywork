#!/usr/bin/env bash
# Makes the user repo code runs as on a GitHub-hosted runner: no sudo, docker or cron, no way into the
# runner's home, nothing world-writable to plant in (docs/guide/safety/isolation.md). The action runs it, and so does CI.
set -euo pipefail

# Without them, a link the worker makes could hand it a file of the runner's.
for key in fs.protected_hardlinks fs.protected_symlinks; do
  if [ "$(sysctl -n "$key")" != 1 ]; then
    echo "::error::$key is off on this runner, so a worker user would isolate nothing"
    exit 1
  fi
done

id awaywork > /dev/null 2>&1 || sudo useradd --no-create-home --user-group --shell /usr/sbin/nologin awaywork
sudo grep -qsx awaywork /etc/cron.deny || echo awaywork | sudo tee -a /etc/cron.deny > /dev/null
sudo chmod 700 "$HOME"

# Every disk filesystem, whole. Reading its inodes in parallel first makes the find that follows take seconds.
for fs in / $(findmnt -rn -t ext2,ext3,ext4,xfs,btrfs -o TARGET | grep -vx /); do
  sudo find "$fs" -xdev -mindepth 2 -maxdepth 2 -type d -print0 |
    sudo xargs -0 -r -P 16 -I{} find {} -xdev -perm -o+w -printf '' 2> /dev/null || true
  sudo find "$fs" -xdev -perm -o+w ! -type l ! \( -type d -perm -1000 \) -exec chmod o-w {} +
  # A default ACL that lets others write makes what's created under it world-writable again.
  sudo find "$fs" -xdev -type d -print0 | sudo xargs -0 -r getfacl -s -p |
    sed 's/^\(default:other::.\)w/\1-/' | sudo setfacl --restore=-
done

# Nothing the worker sends leaves but over loopback, where awaywork's proxy lets a phase's hosts through, and no resolver answers it (docs/guide/safety/isolation.md). A test keeps these equal to `wallLines`.
sudo iptables -C OUTPUT -m owner --uid-owner awaywork -j REJECT 2> /dev/null || sudo iptables -I OUTPUT -m owner --uid-owner awaywork -j REJECT
sudo iptables -C OUTPUT -m owner --uid-owner awaywork -o lo -j ACCEPT 2> /dev/null || sudo iptables -I OUTPUT -m owner --uid-owner awaywork -o lo -j ACCEPT
sudo iptables -C OUTPUT -m owner --uid-owner awaywork -o lo -p udp --dport 53 -j REJECT 2> /dev/null || sudo iptables -I OUTPUT -m owner --uid-owner awaywork -o lo -p udp --dport 53 -j REJECT
sudo iptables -C OUTPUT -m owner --uid-owner awaywork -o lo -p tcp --dport 53 -j REJECT 2> /dev/null || sudo iptables -I OUTPUT -m owner --uid-owner awaywork -o lo -p tcp --dport 53 -j REJECT
sudo ip6tables -C OUTPUT -m owner --uid-owner awaywork -j REJECT 2> /dev/null || sudo ip6tables -I OUTPUT -m owner --uid-owner awaywork -j REJECT
sudo ip6tables -C OUTPUT -m owner --uid-owner awaywork -o lo -j ACCEPT 2> /dev/null || sudo ip6tables -I OUTPUT -m owner --uid-owner awaywork -o lo -j ACCEPT
sudo ip6tables -C OUTPUT -m owner --uid-owner awaywork -o lo -p udp --dport 53 -j REJECT 2> /dev/null || sudo ip6tables -I OUTPUT -m owner --uid-owner awaywork -o lo -p udp --dport 53 -j REJECT
sudo ip6tables -C OUTPUT -m owner --uid-owner awaywork -o lo -p tcp --dport 53 -j REJECT 2> /dev/null || sudo ip6tables -I OUTPUT -m owner --uid-owner awaywork -o lo -p tcp --dport 53 -j REJECT
[ ! -d /run/systemd/resolve ] || command -v setfacl > /dev/null || sudo apt-get install -y acl
[ ! -d /run/systemd/resolve ] || sudo setfacl -m u:awaywork:--- /run/systemd/resolve
[ ! -d /run/systemd/resolve ] || printf 'd /run/systemd/resolve 0755 systemd-resolve systemd-resolve -\na+ /run/systemd/resolve - - - - u:awaywork:---\n' | sudo tee /etc/tmpfiles.d/awaywork-awaywork.conf > /dev/null
[ ! -d /etc/dbus-1/system.d ] || echo '<busconfig><policy user="awaywork"><deny send_destination="org.freedesktop.resolve1"/></policy></busconfig>' | sudo tee /etc/dbus-1/system.d/awaywork-awaywork.conf > /dev/null
sudo systemctl reload dbus 2> /dev/null || true
