---
description: Research on which task trackers a script can read headless, their tokens and limits, and why night-shift uses thin adapters instead of MCP.
---

# Sources

Where work units come from besides the forge: the developer's task
tracker. Researched from vendor docs, repos and changelogs, same tags as
`providers.md`: **[V]** vendor docs or repo read, **[C]** community or
press, **[I]** inference.

## What a source must return

From the prototype, which read a private tracker over REST:

- My open items, filtered by the tracker's own status, column or sprint.
- Per item: key, title, description, url, assignee, labels (opt-out).
- Comments with author, body, time. QA feedback lives here.
- Items where I am a reviewer, if the tracker has reviewers.
- Linked PRs, if the tracker exposes them.

Only a script reads the tracker, with a stored token, and prefetches into
files. The model never holds the credential. Nothing is written back.

## Summary

| Tracker | Headless credential | Read-only token | "Mine" query | Linked PRs via API | Nightly limits | Official MCP, static token |
|---|---|---|---|---|---|---|
| Jira Cloud | API token, 1–365 days [V] | Scoped `read:jira-work` [V] | JQL `assignee = currentUser()` on `/rest/api/3/search/jql` [V] | Only private `dev-status` [V] | Burst, 429 + `Retry-After` [V] | Only if an org admin enables it [V] |
| Asana | PAT, full user access [V] | No, scopes are OAuth-only [V] | `/tasks?assignee=me` [V] | App attachments [C] | 150/min free, 1,500 paid [V] | No, OAuth [V] |
| Trello | Key + user token [V] | `read` scope [V] | `/members/me/cards` [V] | No [C] | 100 per 10 s per token [V] | No [V] |
| Linear | Personal API key, no expiry [C] | Read-only, per team [C] | `viewer.assignedIssues` [I] | Attachments [V/C] | 2,500 req/h [V] | Yes, Bearer; `/mcp/readonly` [V] |
| GitHub | Fine-grained or classic PAT, `gh` login [V] | Yes [V] | `assignee:@me`, `review-requested:@me` [V] | Native [V] | 5,000/h [V] | Yes, PAT; `--read-only` [V] |
| GitLab | PAT `read_api`, ≤365 days [C] | Yes [C] | `scope=assigned_to_me` [I] | `related_merge_requests` [I] | 2,000/min [V] | No, OAuth DCR only [V] |
| Azure DevOps | Org-scoped PAT [V] | Work Items: Read [V] | WIQL `@Me`, `@CurrentIteration` [C] | `ArtifactLink` relations [I] | 200 TSTU / 5 min [V] | Local server only, PAT [V] |
| ClickUp | Personal token, no expiry [C] | No [C] | `assignees[]` [I] | Not found | 100/min and up [V] | No, OAuth [V] |
| Monday | Personal token [V] | No [V] | `assigned_to_me` rule [V] | Not found | 1k–25k calls/day [C] | Yes, Bearer [V] |
| Notion | PAT, 7–365 days [V] | Capabilities [V] | People property = user id [I] | Page property only [I] | 180/min [V] | No, OAuth [V] |
| YouTrack | Permanent token [V] | No scopes found | `for: me` [V] | `/vcsChanges` [V] | Not documented | Yes, Bearer, built in [V] |
| Shortcut | API token, full access [V] | No [V] | Search `owner:` [V] | Branches, PRs on stories [V] | 200/min [V] | No, OAuth [V] |
| Plane | `X-API-Key` PAT [V] | None seen | Not verified | Not verified | 60/min [V] | Yes, Bearer [V] |

Every tracker has a personal token that works without a browser. A nightly
poll fits every rate limit; Plane is the tightest [I].

## Borrow, depend, or build

### No library to depend on

No OSI-licensed project covers this set with the read shape above [V
unless noted]:

| Project | License | Why not |
|---|---|---|
| bugwarrior (Taskwarrior) | GPL-3.0 | Closest: read-only "assigned to me" for Jira, GitHub, GitLab, Linear, Trello, ClickUp, Azure DevOps, YouTrack. GPL, bound to Taskwarrior, uneven comments (Linear none). Reference only |
| OpenAI Symphony | Apache-2.0 | Closest concept: a tracker-polling agent orchestrator for Linear, Jira, GitHub, GitLab, Asana. A spec plus an Elixir reference, not a library; no comments in its `Issue` |
| Airbyte sources, Nango | ELv2 | Not OSI. Nango also holds and proxies users' OAuth tokens |
| Composio, Merge, Apideck, Unified.to | MIT SDK / commercial | Hosted; they store the user's credentials |
| Activepieces pieces | MIT outside `ee/` | Write actions and triggers, few "my items" reads |
| n8n nodes | Sustainable Use, not OSI | Can't copy |
| Singer taps | AGPL-3.0 mostly | ELT shape |
| git-bug bridges | GPL-3.0 | Three trackers, own data model |
| OpenHands integrations, Cyrus | PolyForm / Apache-2.0 | Webhook-driven; need an inbound endpoint, not a nightly poll |
| Panora, supaglue | — | Dead |

Using any of the hosted unified APIs would break the rule that nobody
else stores the user's credential.

### MCP instead of adapters: no, not for the prefetch step

- 7 of 13 official servers are OAuth-only headless: Trello, Asana,
  GitLab, ClickUp, Notion, Shortcut, and Jira unless an admin opts in [V].
  The fallback is community servers, some archived or paid [V/C].
- A script can call MCP without a model (`tools/call` is plain JSON-RPC;
  `mcptools`, the SDKs) [V], but tool names, arguments and outputs are
  per server and unversioned; `outputSchema` is optional, so many return
  free text [V]. One MCP client over N servers saves auth and transport
  code only, and swaps versioned REST for moving targets [I].
- Handing the model the tool instead puts a credential within reach of
  prompt injection from ticket comments. Read-only is enforced server-side
  only by Linear, GitHub and Rovo scopes [V]; elsewhere it is a local flag
  or nothing.
- Headless client wiring has open bugs: Claude Code sends `${VAR}` in HTTP
  `headers` literally (#51581) [C]; Copilot CLI disables a Bearer server
  after OAuth discovery (#3100) [C].

MCP stays a possible opt-in for the worker, limited to servers with
server-side read-only and `--strict-mcp-config` [I].

### Recommendation: thin adapters of our own

Each adapter is one file of REST or GraphQL calls with a personal token.
Borrowed:

- **Interface** from Symphony's spec (Apache-2.0, credit in NOTICE): an
  opaque `id` plus a human `key`, provider-native state names, a raw
  payload escape hatch, and each adapter declaring its config and secret
  names [V]. Its tracker contract:

  ```elixir
  @callback fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  @callback fetch_issues_by_ids([String.t()])    :: {:ok, [Issue.t()]} | {:error, term()}
  @callback secret_environment_names(map()) :: [String.t()]
  ```

- **Queries** as reference, reimplemented: bugwarrior's per-service
  filters (GPL, read not copied), `ankitpokhrel/jira-cli` `pkg/jira`
  (MIT), `schpet/linear-cli` (ISC), Activepieces pieces (MIT) [V].
- **GitHub and GitLab**: shell out to `gh` and `glab` with `--json`, reusing
  the user's login [V].

No reuse argument decides the language: bugwarrior is Python, jira-cli,
`gh` and `glab` are Go, the Linear and Activepieces code is TypeScript [V].

## Adapter shape [I]

```
items(scope) -> [Item]    # my open items in the configured statuses
item(key)    -> Item      # refresh one, with comments
secrets()    -> [env var names]

Item: id, key, title, description, url, status, assignee, reviewers[],
      labels[], comments[{author, body, at}], linked_prs[], raw
```

- **Status to kind is config**, not code: the user maps their own
  columns, e.g. `QA -> qa_feedback`, `In progress -> in_progress`,
  `Current sprint -> plan`, `Code review -> review_requested`.
- **PR linking falls back to the forge**: search PRs whose branch or
  title carries the item key, as the prototype did. Native links (GitHub,
  Azure DevOps, YouTrack, Shortcut, Linear attachments) are a bonus, and
  Jira's only native path is the private `dev-status` endpoint [V].
- **Read-only by default**, with the least-privilege token documented per
  tracker. Where none exists (Asana, ClickUp, Monday, Shortcut, YouTrack)
  the docs say so.

Suggested order, by reach and headless ease [I]: GitHub, Jira, Linear,
GitLab, Asana, Trello; then Azure DevOps, ClickUp, Monday, Notion,
YouTrack, Shortcut, Plane.

## Per tracker

### Jira
- Tokens now expire after 1–365 days; scoped tokens call
  `https://api.atlassian.com/ex/jira/{cloudId}`, not the site URL [V]
  https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- `/rest/api/3/search` is gone; `/search/jql` pages by `nextPageToken`
  [V] https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
  with reported pagination bugs [C].
- No native reviewer field; a custom field or the PR's own reviewers [I].
- Dev-panel PRs only via private `/rest/dev-status/1.0/issue/detail` [V]
  https://support.atlassian.com/jira/kb/how-to-retrieve-pull-request-and-bitbucket-repo-and-branch-information-from-an-issue-using-rest-api/
- Points-based rate limits apply to apps, not API tokens [V]
  https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Data Center: bearer PATs, API v2 [V/I].
- Rovo MCP token auth, admin opt-in [V]
  https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token/

### Asana
- PAT has the user's full access; read scopes exist for OAuth apps only
  [V] https://developers.asana.com/docs/oauth-scopes
- **Token for night-shift.** There is no read-only PAT: the token in
  `token_env` can do anything the user can [V, above]. Service accounts
  need "Full Permissions" for the task endpoints [V]. night-shift only
  sends `GET`s and never hands the token to the worker. Make a PAT for
  night-shift alone so it can be revoked on its own.
  https://developers.asana.com/docs/personal-access-token
- `GET /tasks` needs `workspace` with `assignee`; `completed_since`
  keeps incomplete tasks plus ones completed after it; pages of up to
  100 follow `next_page.offset` [V]
  https://developers.asana.com/reference/gettasks
  https://developers.asana.com/docs/pagination
- A user id may be `"me"`, an email or a gid [V]
  https://developers.asana.com/reference/getuser
- Status is a section (per project membership) or a custom field [I].
  Comments are stories filtered by `resource_subtype=comment_added` [V]
  https://developers.asana.com/reference/getstoriesfortask
- Custom IDs (`EX-1`) are a custom field with `representation_type`
  `custom_id`, and a task can be fetched by one [V]; that its
  `display_value` holds the `EX-1` string is [I].
  https://developers.asana.com/reference/gettaskforcustomid
- Rate limits: 150/min free, 1,500 paid, 50 concurrent `GET`s, a lower
  60/min on search; every limiter answers `429` with `Retry-After` [V]
  https://developers.asana.com/docs/rate-limits
- **PR links.** `GET /attachments?parent=<task>` lists a task's
  attachments, including `external` ones with a `view_url` [V]
  https://developers.asana.com/reference/getattachmentsforobject.
  Asana's GitHub Action "creates an attachment" for a PR whose
  description carries the task URL, through an Asana-hosted service [V]
  https://github.com/Asana/create-app-attachment-github-action; the
  attachment's subtype and URL fields are not documented [I]. The
  in-task GitHub widget is an app component whose resource lives on the
  app's server [V] https://developers.asana.com/reference/attachresource,
  so it may not show in `/attachments` at all [I]. night-shift links
  tasks through the forge instead: my PRs whose branch or title carries
  the task key.
- **Repo for a task.** Asana has no notion of a repo, so a task with no
  linked PR takes its repo from `project_repos` (project gid to
  `owner/repo`) in the source config.

### Trello
- Key + token, `read` scope, expiry up to `never` [V]
  https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
- OAuth 2.0 with short-lived tokens is launching; no end date for key +
  token found [V] https://developer.atlassian.com/cloud/trello/changelog/
- Comments: `/1/cards/{id}/actions?filter=commentCard` [V].

### Linear
- API key restricted to read and to teams [C]; limits [V]
  https://linear.app/developers/rate-limiting
- MCP with Bearer key and read-only endpoint [V] https://linear.app/docs/mcp

### GitHub
- `@me` works in GraphQL `search` queries (`author:`, `assignee:`,
  `review-requested:`) [V]; `gh pr list --json` has no review threads, so
  items come from `gh api graphql` [V].
- `gh run view --job <id> --log-failed` prints the whole job log, not
  just the failed step [V].
- Projects v2 is GraphQL-only; fine-grained PATs reported to fail on it
  [C] https://github.com/orgs/community/discussions/156512

### GitLab
- Official MCP is OAuth-only; PAT support is issue #586184 [V]
  https://gitlab.com/gitlab-org/gitlab/-/issues/586184

### Azure DevOps
- Global PATs are retired; use organization-scoped ones [V]
  https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/

### Notion
- PATs act as the user; internal connections are a bot, so "me" must be
  configured [V]
  https://developers.notion.com/guides/get-started/personal-access-tokens

### Others
- ClickUp: https://developer.clickup.com/docs/rate-limits
- Monday: https://developer.monday.com/api-reference/reference/people
- YouTrack: https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html
- Shortcut: https://help.shortcut.com/hc/en-us/articles/205701199-Shortcut-API-Tokens
- Plane: https://developers.plane.so/api-reference/introduction

## Unverified, check before relying on it

- Linear: PRs from the GitHub integration appear in `issue.attachments`.
- Asana: GitHub integration attachments readable via `/attachments`,
  and in which field the PR URL sits.
- Asana: the whole source against a live workspace (`real-asana.test.ts`).
- Plane: filtering by assignee and state, PR links.
- ClickUp, Monday: any PR link in the API.
- YouTrack: rate limits.
- Rovo MCP exposes Jira dev-panel PRs.
