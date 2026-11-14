# awaywork's daemon, its units run as the worker user: docs/guide/scheduling/container.md.
# Built from a control repo's root, with the config in .awaywork/config.yml and its skills in .awaywork/skills/.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends acl ca-certificates curl git procps sudo tini \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Upgrading is a rebuild: change these and push.
ARG AWAYWORK_VERSION=0.1.0-rc.3
ARG PACKAGES=@anthropic-ai/claude-code
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g "awaywork@$AWAYWORK_VERSION" $PACKAGES && npm cache clean --force

# Your repos' toolchains go here, as RUN lines: setup runs as the worker user.

# The developer's user runs awaywork; sudoers' chown names its uid and gid.
RUN groupadd --gid 1001 away \
  && useradd --uid 1001 --gid away --create-home --shell /bin/bash away \
  && mkdir -p /home/away/.local/state/awaywork /home/away/.codex \
  && chown -R away:away /home/away \
  && chmod 700 /home/away

# The worker user, as scripts/worker-user.sh makes it on a GitHub-hosted runner.
RUN useradd --no-create-home --user-group --shell /usr/sbin/nologin awaywork \
  && echo awaywork | tee -a /etc/cron.deny /etc/at.deny > /dev/null
COPY --chmod=440 <<"EOF" /etc/sudoers.d/awaywork
away ALL=(awaywork) NOPASSWD:SETENV: ALL
away ALL=(root) NOPASSWD: /usr/bin/chown -R -h -P awaywork\: /tmp/awaywork-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9], /usr/bin/chown -R -h -P 1001\:1001 /tmp/awaywork-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]
EOF
# Nothing world-writable to plant in, nor a default ACL that makes it so again.
RUN visudo -c \
  && find / -xdev -perm -o+w ! -type l ! \( -type d -perm -1000 \) -exec chmod o-w {} + \
  && find / -xdev -type d -print0 | xargs -0 -r getfacl -s -p | sed 's/^\(default:other::.\)w/\1-/' | setfacl --restore=-

COPY --chmod=755 entrypoint.sh /usr/local/bin/awaywork-entrypoint
COPY .awaywork /home/away/.awaywork

USER away
WORKDIR /home/away
ENV AWAYWORK_CONFIG=/home/away/.awaywork/config.yml AWAYWORK_IMAGE=1
# tini reaps the orphans units leave, which node doesn't.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/awaywork-entrypoint"]
