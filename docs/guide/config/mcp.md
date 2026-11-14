---
description: Declaring MCP servers in the config and giving them to rules and chain steps, with their secrets and tools.
---

# MCP servers

Declare servers under `mcp`; rules and steps name the ones they get:

```yaml
mcp:
  sentry:                       # HTTP
    url: https://mcp.sentry.dev/mcp
    headers: { Authorization: "Bearer ${SENTRY_TOKEN}" }
    secrets: [SENTRY_TOKEN]
  db:                           # stdio
    command: npx
    args: [-y, some-postgres-mcp]
    env: { READ_ONLY: "1" }
    secrets: [DATABASE_URL]     # in the server's env as DATABASE_URL
    tools: [query]              # default: all the server's tools

queue:
  - skill: implement
    where: { type: issue, label: bug }
    mcp: [sentry]
    then:
      - { skill: review, mcp: [db] }
```

The shape is a subset of Claude Code's `.mcp.json`, translated per agent. A `then` step inherits its rule's servers unless it names its own; `mcp: []` gives none. Details:

- A stdio server gets its `secrets` in its env; an HTTP one in headers, as `${NAME}` or `Bearer ${NAME}`. Never in `command`, `args` or `url` (the process list shows them) or `env` (Codex takes literals only).
- `GH_`, `GITHUB_` and `TWG_` names are reserved: workers never get forge logins, and Actions refuses `GITHUB_` secrets.
- `tools` limits what the agent may call. Only units naming a server get its secrets; `schedule` maps them into Actions, and `doctor` shows whether each is set.
- Servers start for your own PRs, issues and tasks, never on someone else's PR or an issue it closes, nor with a secret unset.
- Only token-based servers work unattended; workers never get your claude.ai connectors. Its secret is one the agent can read, its tools ones injected text can call: [Safety](../safety/index.md#mcp-servers).
