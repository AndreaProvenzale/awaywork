---
description: Run awaywork's image on Coolify, a VPS or any Docker host, and living with it there.
---

# In a container

No machine to leave on? Run `awaywork watch` in a container, on [Coolify](https://coolify.io) or any VPS with `docker compose`. Setup, the agent and the checks run as a [worker user](../safety/isolation.md#a-worker-user-in-awaywork-s-image) inside. Unlike Actions, state lives on a volume (attempts, skips, a [`push`](../config/chains.md#push) head), soon rules run all day, there's no 6-hour cap, and Codex works, its login on a volume. From a private control repo:

```
$ cd my-awaywork-repo
$ awaywork schedule install
[...]
◇  Where should it run on a schedule?
│  a container (Docker Compose, e.g. Coolify), from the repo in this directory
Wrote Dockerfile
Wrote compose.yml
Wrote entrypoint.sh
Copied ~/.config/awaywork/config.yml to .awaywork/config.yml
Before the first run:
  commit Dockerfile, compose.yml, entrypoint.sh and .awaywork/config.yml
  set these env vars in Coolify, or in .env beside compose.yml on a VPS: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, LINEAR_API_KEY
  GH_TOKEN is a classic personal access token of yours with the `repo`, `workflow` and `read:org` scopes (…)
  once it runs, log Codex in: docker exec -it <container> codex login --device-auth
```

| File | What it does |
| --- | --- |
| `Dockerfile` | Debian with Node 22, git, gh, sudo and tini; awaywork and your providers' CLIs, pinned to the awaywork that wrote it; `away`, the user awaywork runs as, and `awaywork`, the worker user, with the sudoers lines [`isolation: user`](../safety/isolation.md) needs |
| `compose.yml` | `restart: unless-stopped`, `stop_grace_period: 2m`, `mem_limit: 4g`, volumes for the state dir and Codex's login, each secret your config needs as an env var, `TZ` defaulting to your timezone; `AWAYWORK_REMOTE_TOKEN` and port 7480, exposed to the proxy, for [your laptop](./laptop.md) |
| `entrypoint.sh` | Fails on an empty `GH_TOKEN`, commits as the token's user (env vars, as the action does), then `exec awaywork watch`, its log on the container's output |

Commit and push: that's a deploy. Details:

- `--with docker` asks nothing; the files come from awaywork's `docker/`, fit to your config. Values are never printed: you set them where it runs.
- The config is copied into `/home/away/.awaywork/config.yml` at build, so a push is how a change gets there. Only `.awaywork/` goes in, so files the config names by path live there too.
- GitHub only for now (no twg, no SSH key for Bitbucket pushes), and no `extends` (the base wouldn't come along): install refuses both.
- Rerun install after config, skill or awaywork changes. As for Actions, a differing file shows its diff and is replaced only on your yes; without a terminal it keeps yours and exits 1:

  ```
  $ awaywork schedule install --with docker
  [...]
   # Your repos' toolchains go here, as RUN lines: setup runs as the worker user.
  -RUN npm install -g pnpm@10
  [...]
  Kept Dockerfile; run this again in a terminal to replace it
  compose.yml is up to date
  ```

- `schedule remove` in the repo deletes the three files if the Dockerfile is awaywork's, leaving `.awaywork/`. `doctor` warns while the Dockerfile builds another awaywork than yours.

## On Coolify

Add a resource from the control repo with the **Docker Compose** build pack, compose location `/compose.yml`. Coolify lists the variables it names: `GH_TOKEN` is required (the [classic token](./actions.md)), `CLAUDE_CODE_OAUTH_TOKEN` is Claude's (`claude setup-token`), `CURSOR_API_KEY` Cursor's, the rest your config's. `TZ` defaults to install's timezone. Deploy; every push redeploys.

Not the Dockerfile build pack: its [rolling updates](https://coolify.io/docs/applications/deployments/rolling-updates) start the new container before stopping the old, and awaywork's locks, checked by pid and start time, mean nothing across containers, so two daemons would share a state dir for a moment. Compose apps are replaced, not rolled.

## On a VPS

Any box with Docker and the compose plugin; `.env` takes the variables install listed:

```sh
git clone git@github.com:you/my-awaywork-repo.git && cd my-awaywork-repo
printf 'GH_TOKEN=%s\nCLAUDE_CODE_OAUTH_TOKEN=%s\nTZ=Europe/Rome\n' "$GH_TOKEN" "$CLAUDE_CODE_OAUTH_TOKEN" > .env && chmod 600 .env
docker compose up -d --build
```

Keep `.env` out of git. Without `GH_TOKEN`, compose refuses: `required variable GH_TOKEN is missing a value`. After a `git pull`, `docker compose up -d --build` again.

## Living with it

- **Secrets are env vars**, no env file: Coolify passes only what `compose.yml` names, so install lists every secret your config needs as `NAME: ${NAME:-}`. Added one? Run install again.
- **Codex:** install adds `@openai/codex` to the Dockerfile's `PACKAGES`. Log in once into the volume, `docker exec -it <container> codex login --device-auth`; it survives redeploys.
- **Toolchains** go in the Dockerfile as `RUN` lines at the marked spot, system-wide, since the worker can't enter `/home/away` (`RUN npm install -g pnpm@10`), [your own CLI](../config/providers.md#bring-your-own-cli) too.
- **Cursor:** no npm package, so install puts [the installer](./actions.md#running-cursor) at that spot as one `RUN`, without `sudo` (the build is root):

  ```dockerfile
  RUN install -d /opt/cursor \
    && curl -fsS https://cursor.com/install | HOME=/opt/cursor bash \
    && ln -sf "$(readlink -f /opt/cursor/.local/bin/agent)" /usr/local/bin/agent \
    && agent --version
  ```

  On arm64 the worker ran `agent --version` (`2026.10.22-27dcf5f`) and couldn't write `/opt/cursor`. Set `CURSOR_API_KEY`.

- **A [custom source](../config/custom-sources.md)'s `setup`** runs at build, right after the config is copied, in its folder, as root, without secrets, after the sweep for world-writable paths: keep its output there, readable by awaywork, not the worker.
- **Upgrading** is a rebuild: upgrade, rerun install, push. Claude Code's auto-updater is off, so it moves with rebuilds.
- **A push stops a running unit:** the redeploy's SIGTERM stops it, unpublished and uncounted, and the new container runs it again. `stop_grace_period: 2m` matches the 2 minutes install gives the daemon on your machine, where Docker's default kills after 10 s. Here a stop hit a unit mid-run:

  ```
  2026-11-03 23:14:39   acme-api-196: stopped: aborted
  2026-11-03 23:14:39 awaywork watch stopped
  2026-11-03 23:14:53 awaywork watch started, pid 7, config /home/away/.awaywork/config.yml
  2026-11-03 23:14:58   acme-api-196: implement on fake
  ```

- **Memory:** capped at 4 GB, and the watchdog's 1.5 GB floor counts against the cap (`process.availableMemory()` was 2.99 GB under `-m 3g`, 7.19 GB without). Raise `mem_limit` for big builds.
- **Reaching it:** `docker exec`, ssh to the host, or Coolify's terminal. `watch.log` is the container's output (`docker logs -f <container>`, Coolify's Logs tab), and `docker exec <container> awaywork doctor`, `report` or `schedule status` work as usual; `status` says `No scheduled job installed`, which is right, since the container keeps `watch` running.
