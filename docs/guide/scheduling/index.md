---
description: Run awaywork in its windows on your machine with launchd, systemd or cron, in GitHub Actions on GitHub's runners or your own, or in a container on Coolify or any Docker host.
---

# Scheduling

A scheduled run is one [window](../config/providers.md#windows-limits-and-budget) opening: it starts when the window opens and starts no unit after it ends. A unit still running at the end stops with `stopped: window ended`, and what it left is published as for a quota stop.

## Pick where it runs

|  | [This machine](./machine.md) | [GitHub Actions](./actions.md) | [A container](./container.md) |
| --- | --- | --- | --- |
| What starts runs | `awaywork watch` under launchd, systemd or cron | A cron in your control repo's workflow runs `awaywork run --scheduled` | `awaywork watch` in Docker Compose, on Coolify or a VPS |
| [`run: soon`](./machine.md#soon-runs) rules | Within minutes | In the windows: no daemon | Within minutes |
| Attempts, skips, a `push` head | Kept | Kept on a self-hosted runner; a GitHub-hosted one starts empty | Kept on a volume |
| Codex | Yes | Self-hosted runners only | Yes, its login on a volume |
| Run length | The window | About 6 hours on a GitHub-hosted runner | The window |
| Bitbucket, `extends` | Yes | No | No |
| Needs | The machine awake | A private control repo and its secrets | A Docker host and its env vars |

A daemon on a box of yours, the container or a machine you ssh into, also takes your laptop's commands, `/away` included: [From your laptop](./laptop.md).

In a terminal, `awaywork schedule install` asks where:

```
◆  Where should it run on a schedule?
│  ● this machine
│  ○ GitHub Actions, from the repo in this directory
│  ○ a container (Docker Compose, e.g. Coolify), from the repo in this directory
└
```

`--with` answers up front; without a terminal it takes this machine. Pick one per machine: with a local schedule and a runner on the same machine, both start at the window and work the same items on the same state dir. Moving to the runner, run `schedule remove` outside the control repo first; inside it, that deletes the workflow too.
