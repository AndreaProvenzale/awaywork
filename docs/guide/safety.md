---
description: What an awaywork worker can and cannot do, how pushes are guarded, how the watchdog works, and the vendor terms each provider runs under.
---

# Safety

An agent working unattended on your repos is only acceptable if the worst run leaves nothing you have to undo. These rules are enforced in code, not asked of the model.

## What the agent can reach

- **No forge or tracker token.** Sources prefetch the context into files before the agent starts, and awaywork makes any [tracker write](#what-awaywork-publishes) itself once the chain ended; a custom source's `write` command gets its `secrets`, which the agent never does. The agent's environment has `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` replaced with `none`, similar variables removed, and an empty `GH_CONFIG_DIR`. gh prefers the placeholders, so a plain `gh` call fails instead of using your login, but your keyring login is still there for whatever unsets them ([Not a sandbox](#not-a-sandbox)). twg gets the same whatever the forge, since you may be logged in to it for Jira alone: an empty `TWG_CONFIG_DIR`, and every other `TWG_` variable removed (`TWG_BBC_TOKEN`, `TWG_TOKEN`, `TWG_KEY_CONTENT` and whatever the next release adds), so a `twg` call fails with `AUTH_INVALID`. `TWG_` names are reserved like `GH_`: an MCP server's `secrets` can't use them. Nor does it or the checks get credentials that aren't tokens: your ssh agent (`SSH_AUTH_SOCK`), `SSH_ASKPASS`, `GIT_ASKPASS`, and git config passed in `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_COUNT` and friends. Their git skips the system config (`GIT_CONFIG_NOSYSTEM`) and reads a global one awaywork writes in `.away/` (`GIT_CONFIG_GLOBAL`) instead of yours: your `user.name` and `user.email` and git-lfs's `filter.lfs` entries, no signing, credential helpers, hooks or includes. A gate's command and judge get those same entries in a copy awaywork writes afresh, plus no attributes file, so nothing the steps added to theirs reaches it. Workers' commits aren't signed, which costs nothing: the [trailer](#what-awaywork-publishes) drops a signature anyway. `setup` keeps all of those.
- **Only its own agent's secret.** Every secret a configured source declares (`ASANA_TOKEN`, `LINEAR_API_KEY`, `JIRA_API_TOKEN`, or your `token_env`), your `notify.secrets`, every repo's `secrets`, every MCP server's `secrets` and every other provider's (`CLAUDE_CODE_OAUTH_TOKEN` for a Codex worker) is removed too. A Claude worker keeps `CLAUDE_CODE_OAUTH_TOKEN`, which its binary needs; Codex uses the machine's own login and gets no secret. A unit also keeps the secrets of the [MCP servers](#mcp-servers) its rule names. The rest of your environment stays so repo tooling runs, including any variable you added to the env file that nothing declares.
- **Setup outside the agent.** A repo's `setup` runs before the agent in the same environment, without the agent's secret and with only that repo's `secrets` added, none on a PR someone else opened or on a branch a worker wrote: earlier in the run, an awaywork PR a rule took up again, or the task PR a plan's task stacks on. On a PR by someone without write access or org membership it doesn't run at all. Whatever it leaves running is stopped before the agent starts.
- **Context outside the agent.** A built-in source's `context` command fetches what an item points at with its own `secrets`, kept out of the agent's environment. It runs in the config file's folder, not the clone, so nothing the branch commits runs with them, and only the regular files it writes reach the agent: don't write a secret there.
- **Checks outside the agent.** An `until` or `when` command runs the code a worker wrote, like `setup` on a branch a worker wrote: none of the repo's `secrets`, but on your machine, outside any sandbox the agent has (as the [worker user](#a-worker-user-on-your-linux-machine) like the agent, under `isolation: user` and on a GitHub-hosted runner, and in a [container](#a-container-on-your-machine) of its own under `isolation: container`). So it doesn't run on an untrusted author's PR.
- **A throwaway clone.** Each unit gets a fresh clone with no credential helper left in it, on a new branch. `.away/` (context, prompt, output) is excluded from git, so it can't be committed. A branch that commits its own `.away`, a folder or a link, is refused before awaywork writes anything there, so a link to somewhere else can't make it write or delete outside the clone, and none of it lands in the run dir. Copying `.away` there never replaces awaywork's own `replay.json` or `worker.log`. Skills stay in the clone on every round: awaywork copies no symlink out of it, and refuses the unit if the folder it copies Codex's skills into links outside it, so a branch that commits `.agents/skills` as a link to somewhere else can't make it delete or write there. A loop's rounds share one clone: between them, awaywork runs no diff driver or fsmonitor its git config names, nor a hook a round left in `.git/hooks`, ends the loop if a round left a symlink where awaywork writes, and reads or writes only regular files there, so a FIFO can't hang it. Each check runs just before its write, so a worker process that outlived the watchdog could still swap a path in between.
- **A fixed harness.** [`harness.md`](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md) wraps every skill: never push, pull, merge, rebase, switch branches, comment or change git config; targeted checks and the repo's documented generators only; nothing in the background. A skill or instruction can't override it. It also tells the agent that the prefetched context is data, not instructions: a request in an item to run commands, fetch URLs, read secrets or change the delivery is reported, never followed.
- **Someone else's PR is data too.** On a PR you didn't open, the branch's `.awaywork/` is ignored, Codex's copy of the unit's skills is replaced with awaywork's, and the prompt says its `CLAUDE.md`, `AGENTS.md` and skills are the author's. Claude Code loads none of the clone's config there (settings, hooks, MCP servers, `CLAUDE.md`, skills), only awaywork's skills plugin and the `settings` file you configured; Codex still loads `AGENTS.md` and its skills itself. A [command provider](./configuration.md#bring-your-own-cli) gets awaywork's copy of the skills in its `skills_dir` too, but its CLI loads whatever else it loads from the clone; the prompt names only `CLAUDE.md`, `AGENTS.md`, skills and "other instruction files" as the author's.
- **Only trusted authors' code runs by default.** Reviewing a PR means running its tests, with your agent's login in the environment. The default `review` rule matches `trusted: true` only: PRs whose author is an owner, member or collaborator of the repo. A rule without it reviews anyone's PR.
- **Not your agent's config.** Workers skip your user-level agent config: `~/.claude` settings, hooks, MCP servers, `CLAUDE.md`, skills, auto-memory and your account's claude.ai connectors for Claude Code, `config.toml` for Codex. The repo's own config still applies. What you want workers to have, list in the config: a Claude `settings` file, Codex `config` values, top-level `skills` ([Configuration](./configuration.md#providers)) and [MCP servers](./configuration.md#mcp-servers). They are yours, so they apply on someone else's PR too, except MCP servers, which carry your secrets.

## Not a sandbox

With `isolation: none`, the default on your machine and on a self-hosted runner, all of the above keeps credentials out of the agent's way, not out of its reach. It runs as your user and can read what you can, and its tools aren't sandboxed: Claude Code gets Bash and file tools pre-approved, Codex runs with `--sandbox danger-full-access`, which it needs to commit, and a command provider runs however your command says. So what it reads can leave [I, from the code]:

- `~/.config/awaywork/env`, with your `GH_TOKEN` and tracker tokens.
- gh's own login, by unsetting the placeholder `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` (an empty `GH_CONFIG_DIR` doesn't hide a keyring from `gh auth token`); `glab`'s keyring login needs nothing unset. Git's credential helpers too: the worker's git config names none, but your `~/.gitconfig` and the system one are readable and a helper still answers when run directly.
- twg's login, in `~/.config/twg`: the empty `TWG_CONFIG_DIR` only points twg elsewhere. Its encrypted storage, with a root key in your OS keychain, hasn't been tried with the empty dir, so `doctor` warns about it.
- Your ssh keys, and your ssh agent: the worker doesn't get `SSH_AUTH_SOCK`, but the socket is still there to find (on macOS, `launchctl getenv SSH_AUTH_SOCK` hands it back). On [Bitbucket](./configuration.md#bitbucket-and-jira) those keys are what awaywork pushes with, so a worker that reads `~/.ssh` can push as you.
- A VS Code terminal's git askpass (`VSCODE_GIT_*`).
- On Linux, awaywork's own environment under `/proc`, `GH_TOKEN` included. On a self-hosted runner, that's your personal access token.

What that leaves open:

- **Prompt injection.** On GitHub, comments and threads by people outside the repo are [hidden](#public-repos), but issue bodies, CI logs, other sources' text and whatever a trusted person quotes are still text someone else may have written. The harness tells the agent they're data, but a model can still be talked into things, and what it runs has the reach above.
- **Hooks across a loop's rounds.** On your own repo, Claude Code loads the clone's `.claude/settings.json`, so one round can leave hooks the next round runs.
- **MCP secrets in Claude's Bash** on your own items: [MCP servers](#mcp-servers), and [#155](https://github.com/AndreaProvenzale/awaywork/issues/155) to fix it.
- **Codex reads the PR author's `AGENTS.md`** on someone else's PR, as above.
- **A command provider's repo config** on someone else's PR: its CLI loads whatever repo config it loads, e.g. MCP servers or hooks in its config dir, and awaywork can't stop that.

So run awaywork on a machine or runner where that's acceptable, or give it a [worker user](#a-worker-user-on-your-linux-machine) on Linux, or a [container](#a-container-on-your-machine) wherever Docker runs, your Mac included. GitHub's hosted runners [always get a worker user](#a-worker-user-on-github-hosted-runners).

### A worker user on your Linux machine

With [`isolation: user`](./configuration.md#isolation), setup, the agent and the checks run as `awaywork`, a user you make once, instead of you. It's the same machinery as on a [hosted runner](#a-worker-user-on-github-hosted-runners): the clone is the worker's only while repo code runs in it, awaywork kills every process the worker has after each phase, and its own git runs only on a clone that's yours again. Without the user or the sudoers lines, `run` refuses to start rather than run as you. What that closes:

- **Your files.** `~/.config/awaywork/env`, gh's `hosts.yml`, `~/.ssh`, `~/.gitconfig` and the rest of a home closed to others. `doctor` warns until it is (`chmod o-rwx ~`).
- **Your logins in other processes.** `/proc/<pid>/environ` of awaywork, and of anything else you run, is owner-only. Your ssh agent's socket sits in a folder only you can enter. gh's keyring login answers over your session bus in `/run/user/<uid>`, which another user can't open [C, not exercised: the test container has no keyring].
- **A way back in.** The worker has no sudo, `doctor`'s lines deny it cron and `at`, and its shell is `nologin`, so no `ssh` or `su` as it either: once its phase is killed, nothing of its runs until the next one.
- **What one unit leaves for the next.** The worker's `HOME` is a fresh `/tmp/awaywork-XXXXXX` for each clone, removed with it, and there's no `/home/awaywork`. So an `~/.npmrc`, a Claude hook in `~/.claude`, a shim in `~/.local/bin` or anything else a unit plants in `~` never reaches another repo's setup or agent.
- **The clone swapped under you.** `/tmp` is sticky, so the worker can rename its own folder and leave a link to one of yours in its place. After each phase awaywork checks that the clone and the home are the very folders it handed over (`lstat`, same inode), and closes them to everyone else (`chmod -R u+rwX,go-rwx`, the top folder `711` so the next phase can start in it). A fresh clone stays `700`, yours alone, until its first phase gets the same. Anything else and the clone is lost: no more phases, no git of awaywork's, nothing published, left where it is. A lost clone keeps the worker's `.git`, config and hooks included: run no git in it, or anything else, as with [replay's](./skills.md#try-an-edit-on-a-past-unit). `git fetch <clone> <branch>` from your own checkout runs nothing of it. Tried: a worker that moved its clone or its `HOME` and linked one of the developer's repos in its place lost the clone, and that repo's `.git/config` stayed as it was; a `chmod 777` on the clone, a `.git` in it and `~` left `711`, `700` and `711`, which another local user couldn't write into.

A real run in a Debian 12 container, a command provider running a leak script as the agent, with the developer's home at 755 and then after `chmod o-rwx ~`. With `none`:

```
agent: as runner (runner), HOME=/home/runner, cwd=/home/runner/.local/state/awaywork/runs/20261020-235218/work/leak-1
agent: LEAK the env file
agent: LEAK lists the developer's home
agent: LEAK gh's hosts.yml
agent: LEAK the ssh agent at /tmp/ssh-xYgFG31ii9el/agent.9433
agent: left a detached sleep 4242 behind
```

The sleep was still running after the run. With `user`, home 755, then 750:

```
agent: as awaywork (awaywork), HOME=/tmp/awaywork-5zbDJu, cwd=/tmp/awaywork-EgYoce
agent: ok   the env file
agent: LEAK lists the developer's home
agent: LEAK gh's hosts.yml
agent: ok   the ssh agent at /tmp/ssh-*/agent.*

agent: as awaywork (awaywork), HOME=/tmp/awaywork-6etN3Q, cwd=/tmp/awaywork-lLAmqr
agent: ok   the env file
agent: ok   the developer's home refused
agent: ok   awaywork's env /proc/10571/environ
agent: ok   any /proc/*/environ
agent: ok   gh's hosts.yml
agent: ok   the ssh agent at /tmp/ssh-*/agent.*
agent: ok   sudo -n true refused
agent: left a detached sleep 4242 behind
```

And nothing of the worker's was left running, nor any of its folders.

The sudoers lines give your user no more than that. The first runs anything as the worker, which can do nothing you can't. The second is the only thing awaywork runs as root: `chown -R` of a clone to the worker and back to you. A loose rule there would be root for anything running as you, which could chown `/etc/shadow` to the worker and edit it as the worker. So:

- **No `*`.** sudoers' `*` matches spaces too: `chown … /tmp/awaywork-*` also allows `/tmp/awaywork-x /etc/hostname`, which chowned it. Six character classes match six letters or digits, no space, slash or dot, on any sudo version.
- **Straight under `/tmp`.** Each clone is its own `/tmp/awaywork-XXXXXX`, so no folder of yours sits on the path. A deeper rule, regex or not, loses to a link: with `/tmp/awaywork-??????/work/*` allowed, a folder of yours with `work -> /etc` in it chowned `/etc/passwd`.
- **No link followed.** `-h -P` changes a link itself, at the top or below, and `doctor` and `run` refuse a kernel with `fs.protected_hardlinks` off, which would let you hardlink a file you can't write into the folder.
- **No env.** The root line has no `SETENV`: sudo refuses `--preserve-env=PATH` and drops `LD_PRELOAD`.

Tried as a user with only those two lines (sudo 1.9.13p3), everything but the exact two commands asked for a password: `/etc/shadow` itself, a seventh character, `../`, a space in the name, a second path, `-L`, `root:` as the owner, `-u root`, `-g root`. The same words split differently, `"-R -h"` as one argument say, got past sudo and `chown` refused them. Through a link `/tmp/awaywork-Lnk001 -> /etc` and links to `/etc/shadow` inside a folder, the `chown`s went through and changed only the links; `ln /etc/shadow` failed with `Operation not permitted`; 30 round trips while a loop swapped subfolders for links to `/etc` changed nothing there. Afterwards no file under `/etc` belonged to anyone but root.

What it doesn't close:

- **The network**, open as everywhere.
- **The worker's own login.** The agent's token is in its env, as it has to be: Claude's `CLAUDE_CODE_OAUTH_TOKEN`, or a copy of your Codex `auth.json` in its `HOME` for the run. awaywork has no Codex login of its own: that's the file your own `codex` uses, `$CODEX_HOME/auth.json` as awaywork sees it, its env file included, else `~/.codex/auth.json`. The worker can read that login, as it could without isolation. It can also write what comes back, since a refresh rotates it: awaywork saves only a refresh, the tokens and `last_refresh` over the file it lent, refused when the worker's mode, API key or account differs, and only while yours is still the one it lent. The tokens themselves are the worker's word, though. A hostile worker can hand back the tokens of an account it controls, labelled with your `account_id`, and from then on your Codex runs on that account, awaywork's later runs and your own sessions alike, your prompts and code with them, until you `codex login` again. Codex being experimental, that ships as is; lending it a login it can't swap is [#315](https://github.com/AndreaProvenzale/awaywork/issues/315).
- **What one unit leaves in `/tmp`.** Every unit runs as the same user, so a file the worker leaves in `/tmp` or `/var/tmp` outside its folders is still there, and readable, for a later unit's worker. Nothing runs it unless something looks for it.
- **What's on the machine.** A database or dev server on localhost answers the worker too, and anything world-writable is a place to plant a binary you run later; on a hosted runner the action takes that write bit off, on your machine it's on you (`find / -xdev -perm -o+w ! -type l ! -perm -1000` lists them).
- **Other developers on the machine.** The `chown` line lets whoever has it chown any awaywork clone folder, so keep the worker user to one developer.

### A container on your machine

With [`isolation: container`](./configuration.md#in-a-container), setup, every agent run and every check start in a fresh container of the repo's image, which sees the clone and the skills plugin and nothing else of your machine. That doesn't hang on a list of things to hide, so it closes more than the worker user, on a Mac too:

- **Your files.** Your home isn't mounted, only the clone in it: the env file, gh's `hosts.yml`, `~/.ssh`, `~/.gitconfig` and the keychain's files aren't there, and a Linux container has no `security` to ask the keychain for a login either.
- **Your logins in other processes.** It has its own process table: `/proc` shows its handful of processes, never awaywork's env. Your ssh agent's socket isn't mounted, and neither is the docker socket, so it can't start a container of its own with your disk in it.
- **Root inside.** It runs as your uid and gid with every capability dropped and `no-new-privileges`, so a setuid `sudo` goes nowhere, even in an image that hands everyone `NOPASSWD: ALL`. A setuid file it makes is yours, though, and Colima keeps the bit on your Mac: awaywork drops it when copying the clone's `.away` out, and the run dir is closed to other users (700).
- **Your env.** It gets the image's env, awaywork's placeholders and git config, and that phase's secrets by name, nothing else of yours. Values go in by name (`-e NAME`), never on argv.
- **Nothing outlives its phase.** A container goes when its command exits, detached processes with it, and awaywork removes it itself (`docker rm -f`) on a timeout, the window's end, Ctrl-C or the watchdog. After each phase it checks none is still running before its own git touches the clone; when it can't be sure, one still listed or docker not answering within a minute, the clone is lost, as with the worker user: nothing's published from it and awaywork leaves it alone, Codex's lent login included. It keeps the worker's `.git`, config and hooks included, and a container of it may still run: run no git in it, or anything else, as with [replay's](./skills.md#try-an-edit-on-a-past-unit). `git fetch <clone> <branch>` from your own checkout runs nothing of it.

A real run on a Mac (Colima 0.8.1, Docker 27.4.0) with a leak script as setup, as a `when` check and as a Claude stand-in agent, in a test image that gives everyone `NOPASSWD: ALL`:

```
agent: as dev (501:20), HOME=~/.local/state/awaywork/runs/20261021-003248/work/leak-1/.away/home
agent: ok   the env file
agent: ok   your home holds only the folder on the clone's path
agent: ok   gh's hosts.yml
agent: ok   ~/.ssh
agent: ok   the keychain (no security, no ~/Library/Keychains)
agent: ok   no ssh agent socket
agent: ok   GH_TOKEN=none in its env
agent: ok   /proc/*/environ
agent: ok   no docker socket found
agent: info mounts from the host: …/work/leak-1 (rw) …/plugins/leak-1 (ro)
agent: ok   sudo -n true refused (the image allows everyone NOPASSWD: ALL)
agent: ok   git credential fill has nothing
agent: ok   nothing left from an earlier phase
agent: info .away/home holds: .setup-was-here
agent: ok   the plugin is read-only
agent: left a detached sleep 4242 behind
```

After the run no container was left and no `sleep` ran in the VM; an agent that hung past `unit_minutes: 1` was stopped at 64 s, its container with it.

What it doesn't close:

- **The network.** It's open: what the container reads, the clone included, it can send anywhere. A service on your Mac's `localhost` wasn't reached through Colima's gateway here, but one listening on your LAN is, and Docker Desktop's `host.docker.internal` leads to your Mac. Allowing only listed domains is [#316](https://github.com/AndreaProvenzale/awaywork/issues/316).
- **The agent's own secrets.** Claude's `CLAUDE_CODE_OAUTH_TOKEN`, Codex's `auth.json` for the length of its run, and the secrets of the MCP servers the rule names are inside, as they have to be. The container also writes the Codex login that comes back, with the same limits as [the worker user's](#a-worker-user-on-your-linux-machine).
- **The clone.** What a phase leaves there is what the checks run and what awaywork publishes, as everywhere; awaywork still puts its git config back and refuses links after each phase.
- **The image.** Whatever you baked into it, a token in a layer or an `.npmrc`, every unit gets.
- **The kernel.** A container shares the VM's kernel, on Linux your machine's: it's a namespace, not a VM, and a kernel bug is a way out. On a Mac that lands in the VM, and Colima mounts your whole home read-write (`colima ssh -- mount` shows `/Users/<you>` over sshfs, `rw`), so the VM is no second wall.
- **Memory, on a Mac.** The watchdog's memory floor watches your Mac, not the VM: a container that eats the VM's memory meets the VM's OOM killer instead, which can take `dockerd` with it, and then the clone is lost. The disk floor holds, the clone being on your Mac's disk.

### A worker user on GitHub-hosted runners

A GitHub-hosted runner is where your classic token runs unattended against issue text, with passwordless sudo on top, so there awaywork doesn't run repo code as you at all. Setup, the agent and the checks run as `awaywork`, a user the action makes before the run, and it's always on:

- **A user with nothing.** No sudo, no `docker`, no group but its own, no crontab. The action locks the runner's home (`chmod 700`), where your checkout, the step scripts and `RUNNER_TEMP` live, with `GITHUB_ENV`, which sets the env of the steps after, and takes the write bit off everything world-writable on the disks: the image ships some 800,000 such paths, `/usr/local/bin` and the toolcache's `node` among them, where the worker could plant a `ps` or a `gh` that awaywork runs next with your token. It also takes it off the default ACLs of some 36,000 folders, the toolcache's among them, which would make what a later step installs there world-writable again. That step takes under two minutes of the job, most of it reading the disk. The step refuses a runner whose kernel lets a user hardlink a file it can't write, or follow someone else's symlink in `/tmp` (`fs.protected_hardlinks` and `fs.protected_symlinks`, both on in GitHub's image).
- **The clone is the only thing it shares.** Clones, the worker's `HOME` (a fresh one per clone) and the skills plugin live under `/tmp`, not in the run dir. Each clone belongs to the worker while setup, a check or the agent runs in it, and to the runner again, checked to be the same folder and closed to others, before awaywork's own git touches it. That git takes the clone's own `.git` and nothing else, never a repo it would otherwise find above it in `/tmp`, where the worker can write, and only once the clone's config is awaywork's again: a `.git` the worker turned into a link, put a symlink in outside its hooks, or pointed at another repo's objects, gets no more of it, and nothing's published from that clone. A clone the runner can't take back, say a `chown` that fails on something the worker left there, ends its chain with that error: nothing's published, and awaywork doesn't touch the clone again.
- **Nothing outlives its phase.** After each one, awaywork kills every process the worker has, detached or not, so nothing it left can change the clone later.
- **No value on argv.** The worker's env goes through sudo's own env, with only the names on its command line (`sudo --preserve-env=PATH,CLAUDE_CODE_OAUTH_TOKEN,…`), so `/proc/<pid>/cmdline` shows no value. awaywork's own pushes use gh's credential helper, never a token in a URL.
- **No silent fallback.** A hosted runner without the user, say a workflow that calls `awaywork run` without the action, refuses to start: `can't run as the awaywork user on this GitHub-hosted runner: run awaywork through its action, which creates it`.

A spike ran a script that tries every leak above from setup, a `when` check and two agent runs, with the job's `GITHUB_TOKEN` as `GH_TOKEN`. Before:

```
agent: as runner (5 groups: runner adm users docker systemd-journal), HOME=/home/runner
agent: LEAK awaywork's env /proc/2635/environ
agent: LEAK reads the step scripts in RUNNER_TEMP
agent: LEAK can write GITHUB_ENV for the steps after
agent: LEAK sudo -n true works
agent: LEAK docker works (root by another name)
agent: LEAK crontab: a job outlives any kill
agent: LEAK can plant files the runner runs in: /opt/hostedtoolcache/node/22.23.3/x64/bin /usr/local/bin …
agent: LEAK 2 leftover from an earlier phase still runs
```

And with the worker user:

```
agent: as awaywork (1 groups: awaywork), HOME=/home/awaywork
agent: ok   awaywork's env /proc/2890/environ
agent: ok   any /proc/*/environ
agent: ok   any /proc/*/cmdline
agent: ok   gh auth token, GH_TOKEN and GH_CONFIG_DIR unset
agent: ok   RUNNER_TEMP refused
agent: ok   GITHUB_ENV not writable
agent: ok   sudo -n true refused
agent: ok   docker refused
agent: ok   crontab refused
agent: ok   no PATH or toolchain dir writable
agent: ok   nothing left from an earlier phase
```

That spike predates the `HOME` per clone: the worker's is a `/tmp/awaywork-XXXXXX` now, as in the [local run](#a-worker-user-on-your-linux-machine).

What it doesn't close:

- **The agent's own secrets.** Claude's `CLAUDE_CODE_OAUTH_TOKEN` and the secrets of the MCP servers the rule names are in the worker's env, as they have to be.
- **The network.** It's open: what the worker can read, the clone included, it can send anywhere.
- **The clone.** It's the worker's while it runs, so what it leaves there is what the checks run and what awaywork publishes, as everywhere.
- **What's world-readable.** The toolchains, `/tmp`, and every process's command line (not its env).
- **The machine.** It can still fill the disk or the memory; the watchdog stops the unit then.

## Public repos

On a public repo anyone can comment on your issues, review your PR or reply in your threads, and all of it would land in the agent's context. So the GitHub source keeps only text by you, by owners, members and collaborators of the repo, and by apps installed on it (the review bots whose findings `fix` works on). Everyone else's comments, reviews and threads are dropped before the agent starts, leaving a line in their place:

```
_Hidden: 2 comments from outside the repo's owners, members and collaborators._
```

A thread a stranger started is hidden whole and doesn't count toward `unresolved_threads`, so it doesn't start a `fix` run (if GitHub won't say who started a PR's threads, they all count, and the run still sees only the trusted ones). In a thread someone trusted started, only the strangers' replies go. It's always on, nothing to configure.

Who's a member comes from GitHub, and to a token without `read:org` a teammate whose org membership is private can look like an outsider, comments hidden. `gh auth login` asks for `read:org` already, and so does `schedule install` for the runner's token.

What it can't hide:

- The item's own title and body: an issue a stranger opened and you took on is still their text. The default `review` rule already skips their PRs (`trusted: true`).
- An untrusted author's diff and files, when a rule of yours reviews their PR anyway.
- CI logs in `checks.md`: a PR's tests print whatever its code says.
- What a trusted person or a bot quotes, like a review bot summing up a stranger's comment.

So the agent can still be steered, and without a worker user it can read your `GH_TOKEN` ([Not a sandbox](#not-a-sandbox)). The classic token `schedule install` asks for reaches every repo you can, not only the ones awaywork works on; whether that's fine or worth a dedicated account is your call. A fine-grained token would reach less, but it [can't call the Checks API](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations), which the `checks` field and `checks.md` read, so those likely break. Nobody has tried one yet.

## MCP servers

A rule's `mcp` gives its units your servers, and with them more reach, so the guide's advice is in three parts:

- **A server's secret is one the agent can read.** The server and the agent run as the same user, in the same process tree. Claude Code starts stdio servers with its whole env, which its Bash also gets. Codex keeps the secrets out of its shell's env (`shell_environment_policy`), but a process running as your user can still read another one's env. So a unit has its agent's secret plus the secrets of the servers its rule names, and nothing else.
- **Injected instructions can use the tools.** An item's text could ask the agent to call a server's write tools. Give servers read-only tokens where the service has them, and list `tools` to allow only what the skill needs: awaywork has the agent refuse every tool outside the list. For context the worker only reads, prefetching it with a source keeps the token away from the model entirely.
- **Not on someone else's PR.** The worker runs the PR's code, and on Claude Code that code gets the servers' secrets in its env. So servers start for your own PRs and for issues and tasks, but not on a PR someone else opened, trusted or not, nor on an issue it closes, as with the repo's `secrets` for `setup`. A server with an unset secret doesn't start either. The unit's log says which servers didn't start and why.

## What awaywork publishes

Two kinds of rules here. Integrity rules never move, whatever the config says: no force-push, merge or approval, no push onto someone else's branch, and the model never picks where its work goes or holds a write token. Reach, how loud a PR is, is the rule's choice and quiet by default: a draft that pings nobody, unless a rule opts in to a ready PR (`deliver: pr`) or a push onto your own PR. On someone else's PR there's no choice: only a report, which only you read, or, where a rule says `deliver: pending_review`, the same report as your pending review on the PR, which only you see too. [Where results go](./results.md) lays out who sees what, and what your own hook can add.

- Only a branch that **doesn't exist** on the remote, checked before the worker starts and again at push. A taken name gets a `-2` to `-10` suffix instead, never the taken branch. Never someone else's branch, and never a push that rewrites history.
- The one exception is a rule with `deliver: push`: it adds commits onto **your own open PR's** branch, as a fast-forward, only while the branch is still where the clone started. Right before the push, awaywork reads the PR again and refuses when it isn't yours, is closed or merged, or has auto-merge on, and when its branch is on a fork, is the default branch, is protected, or is also the branch of someone else's open PR in the repo. It is refused on someone else's PR and on an item without a PR of yours. The commits land unreviewed on a branch your CI and teammates run, so opt in only where that's fine.
- Both pushes carry git's `--force-with-lease` as a compare-and-swap, not to force: the remote takes the new head only while the branch is still absent, or still at the commit the clone started from, and awaywork checks first that the new head descends from it. A push that would rewrite history, or bring back commits you dropped from your branch in the meantime, is refused.
- Nothing is published when the new commits include a merge, or when the branch no longer holds the commit the clone started from: the harness forbids both, and either would carry commits that aren't the unit's.
- Only a PR, a **draft** unless the rule says `deliver: pr`, into the default branch or your own PR's branch in the repo (an awaywork PR a rule naming `ours` took up again included), one per unit, however many steps its chain has, plus one per [stacked slice](./chains.md#stack), into the slice before's branch. Never into someone else's PR or a PR from a fork: only a report, or a pending review, delivers there. A fork PR is cloned from the repo's pull ref; nothing goes to the fork. It never merges, approves or requests reviewers, and it writes to a PR or issue only as the next bullet says; your own [`notify` command](./configuration.md#pr-labels-reviewers-and-ready-for-review) can, as you.
- Tracker writes are awaywork's, never the agent's, and only these. A step that can't go on posts its [questions](./how-it-works.md#questions) as one comment on the first of the unit's items from the rule's source that is **yours**, and a `deliver: plan` rule its [plan](./how-it-works.md#plans) the same way, once `plan.yml` passed its checks; the model writes only their text, never where they go, though the item's description can steer that text, mentions included (on GitHub it isn't filtered by author the way comments are), the same exposure as a PR body from `pr.md`. `awaywork approve`, when you run it on an item waiting on a plan, posts your `approve` reply there, through the same check. A plan's [task](./how-it-works.md#tasks) isn't a tracker item, so its questions and its rule's `on_done` go to its card, whose ownership is read again every run. And what a rule's [`on_done`](./configuration.md#on-done) asks: once a unit's chain finished and every slice published, it moves each of the unit's items that is yours, from the rule's own source, to the status, state, section or label the config names. Yours is your own PR, an issue assigned to you, a Jira, Linear or Asana item (they're read only when assigned to you), or a custom source's item. Right before writing to an issue or a Jira, Linear or Asana item, it reads the item again and refuses one no longer assigned to you; a custom source's `write` has to check that itself. Never a PR you were asked to review, never an item only an extra GitHub `search` found, never a new item, never a destination a model picked. It writes as you, with the token the source already reads: GitHub through `gh`, the trackers with their `token_env`, which needs write scope for it. A source that can't write (Bitbucket, a custom source without `write`) leaves its items where they are, and a write that fails is reported, never fails the unit. A comment awaywork writes ends with a `— awaywork` line, and it counts a comment as its own only when that line comes from your account, so nobody can pass one off as awaywork's by pasting it, to hold your item as waiting for an answer or an approval, to approve a plan, or to put text under the `awaywork's questions` or `awaywork's plan` heading the agent reads, nor on GitHub and Jira by editing your comment, since a comment someone else edited last isn't yours there. Linear, Asana and custom sources don't say who edited a comment, so a teammate allowed to edit yours could add the line there.
- A `deliver: pr` PR opens ready for review, so GitHub treats it like one you opened: it requests review from the code owners of what it touches. It still opens as a draft when one of the slice's steps failed or stopped or the run ended before one ran, its `verify` failed, one of its loops ended before its `until` held, or one of its [gates](./configuration.md#gates) fired.
- When the repo has gates, the top of the body is awaywork's, not the model's: after the last step and the gates ran, awaywork puts under the title the decision card when a gate fired, else a `Gates: none fired (…)` line naming the gates that ran, and ends it with a `---` rule. That section always comes first and everything the agent wrote is below the rule, a card it made up included: that's all it guarantees. A `<` in a gate's line is escaped so it can't open a comment that hides the rest.
- Gates fail closed: a `command` gate fires when it can't run, times out, is stopped or isn't run on an untrusted author's PR, and, without running, when a file it names differs from the chain's start. It runs afresh with `$AWAYWORK_FROM`, its git ignoring the clone's replace refs, reading attributes from the chain's start rather than the worktree, and reading a fresh global config rather than the one the steps can edit, which `verify`, `when` and `until` don't. It still runs repo code the agent may have changed, and a worker process that outlived the watchdog could swap the script between the comparison and the run, so `changed` gates are the trustworthy kind. Details in [Gates](./configuration.md#gates).
- A `skill` gate's judge is a model reading what the agent wrote, so it can be fooled, and then it only fails to fire: it can add lines to the card, never clear a script's gate. Its git sees the slice as pushed, like a `command` gate's. It can't change what's published either: when it leaves a commit, a moved HEAD, an uncommitted change or a changed file in `.away/out/`, awaywork puts the clone back as it was and fires the gate, and a judge that errors, stops or can't run fires it too. Only a worker process that outlived the watchdog could still change a file after that comparison. It runs as a unit on [someone else's PR](#what-the-agent-can-reach) does, the clone being the agent's: its skill is yours or built in, never the repo's, and Codex still reads the `AGENTS.md` and skills the agent could have edited. Details in [Judges](./configuration.md#judges).
- A PR stacked on an awaywork PR joins that PR's GitHub stack, or starts one with it, only while that PR tops its stack or has none. Linking edits neither PR, but GitHub then merges a stack bottom-up: merging a PR merges the ones below it too, and GitHub rebases the ones above after a merge.
- Only when the agent wrote a PR body, `pr.md`, for a PR or a push alike, and only once the unit's chain, or its slice, ended. A run killed before that publishes nothing more.
- Publishing fetches the clone's HEAD into a repo awaywork creates for it, where it adds the trailer, diffs and pushes. The unit's commits are those after the commit the clone held before setup and the first agent ran. The clone's config, attributes, hooks and refs, which the agent can write, neither steer where a push goes, nor pick which commits get the trailer, nor run anything: after `setup` and each agent run, and before and after each check, awaywork puts back the config the clone had when it was cloned and deletes `.git/info/attributes`. Its own git there runs no hook, reads history as it is rather than through the clone's replace refs, and diffs only from commits it resolved itself, so a `changed` gate or a `when: { changed }` sees the commits that get pushed. Even with your global `submodule.recurse` or `diff.submodule`, it runs no git in a submodule, whose own config the agent can write too. It refuses a `.git` that holds a symlink outside its hooks, an alternates file, a `commondir` or `info/grafts`, and the step errors: awaywork runs no more git in that clone, so no check or `verify` runs there and its slice isn't published. In the clone, publishing only reads the PR body or report, writes `diff.patch` next to it, puts the gates' section on top of the body, and appends the chain's notes, the items' link lines, a GitHub issue's `Closes` line on the last slice of a chain cut from the default branch and a stacked PR's "merge that first" line to the body. It refuses if the body, the report or `diff.patch` is a symlink, and reads or writes only regular files. The symlink check runs just before, so a worker process that outlived the watchdog could still swap a path in between.
- A [stacked slice](./chains.md#stack) never fetches anything into the clone: awaywork's own repo re-parents its commits onto the slice before's as pushed, while adding the trailer. In the clone it runs one `git checkout -b` for the slice's new branch at the clone's tip, with no hook, fsmonitor or reflog. Before it, awaywork refuses a symlink anywhere on the path to `.git/HEAD`, `.git/index` or the new branch's ref, and deletes `.git/logs`, so git writes only that branch, HEAD and the index, each by renaming a fresh lock file, and nothing outside the clone.
- `report` delivery pushes nothing at all.
- `pending_review` delivery pushes nothing either. When the chain ends, awaywork leaves its last report, with the line comments its step wrote to `review.json`, on the PR it reviewed as your **pending** review, at the commit the clone read. GitHub shows a pending review to its author alone, so nobody else sees it, and nobody gets notified, until you submit it from the PR, edit it first, or discard it. awaywork never submits one, approves or requests changes. It works on any PR, someone else's and a fork's included, and on your own, which you can then submit only as a comment. When a step failed or stopped or the run ended before one ran, awaywork delivers the report alone with the reason, since a cut-short review shouldn't sit there ready to submit; so it does when GitHub refuses the review, as it does when you already have a pending one on that PR, which stays as it was. GitHub refuses the whole review over one line comment off the PR's diff, so then awaywork lists every comment in the body instead.
- Every PR says it came from awaywork: a footer with the run id and the items it's for in the body, and an `Awaywork: <run id>` commit trailer. Pushed commits carry the trailer too. Adding it re-creates each commit, so a commit signature doesn't carry over: a branch that requires signed commits refuses the push.

## Resources

A watchdog polls every 2 s. It stops the unit below 1.5 GB of free memory or 2 GB of free disk, a stop that doesn't count toward the item's 3 attempts, and no unit starts on a machine already below them. At the end it kills every process the agent started, including detached ones. The agent also runs in a process group of its own, killed as soon as it exits or awaywork is stopped (short of `SIGKILL`). A process that leaves the group, as an agent's own command runner may, is left to the watchdog; one that also detaches between two polls escapes both, and could still change the clone after awaywork checked it. Not with a [worker user](#a-worker-user-on-your-linux-machine), under `isolation: user` or on a GitHub-hosted runner: there, after setup, each check and each agent run, awaywork kills every process it has, detached or not, in one `kill -9 -1` as that user, and a timeout or the window's end does the same right away. Nor in a [container](#a-container-on-your-machine): each command's container goes when it exits, detached processes with it, and a timeout or the window's end removes it right away (`docker rm -f`). Each run also has a turn cap and stops at the quota ceiling, except on a command provider, which has neither: `limits.unit_minutes` is what stops its unit. However it's stopped, a process that keeps the output of the agent, setup or a check open can't hold the unit up: a second after the stopped command exits, awaywork closes its end of the pipe and moves on.

## Secrets on a runner

In GitHub Actions, your credentials are secrets of your control repo. The generated workflow passes them only to awaywork's step, checks out without keeping a credential, and gives the job's `GITHUB_TOKEN` read access only: awaywork pushes with your `GH_TOKEN`. Still, anyone with write access to the repo can read them: a branch they push can carry a workflow that prints them. So keep the control repo your own, one per person on a team.

## Vendor terms

awaywork runs each vendor's **unmodified CLI** with **your own login**. It never calls a provider's backing API with a subscription credential, never stores, pools or proxies anyone else's, and never changes the client's identity. That is the line the vendors draw.

| Provider | Unattended use |
| --- | --- |
| Claude Code | Allowed: headless runs with your own login or a `setup-token`, documented for CI. |
| Codex | Grey: account login in CI is documented as advanced, with API keys recommended; keep one `auth.json` per machine. |
| Command provider | Your call: it's your CLI and your login, and awaywork doesn't know its vendor's terms. `doctor` flags it grey. |

`awaywork doctor` shows this flag per provider. Research on other agents, and why some (Gemini on a personal plan, Alibaba's plan) won't be supported, is in [Providers](../providers.md).

## Reporting a vulnerability

See [SECURITY.md](https://github.com/AndreaProvenzale/awaywork/blob/main/SECURITY.md).
