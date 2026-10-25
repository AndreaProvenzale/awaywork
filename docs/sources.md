---
description: Research on which task trackers a script can read headless, their tokens and limits, and why awaywork uses thin adapters instead of MCP.
---

# Sources

Where work units come from besides the forge: the developer's task tracker. Researched from vendor docs, repos and changelogs, same tags as `providers.md`: **[V]** vendor docs or repo read, **[C]** community or press, **[I]** inference.

## What a source must return

From the prototype, which read a private tracker over REST:

- My open items, filtered by the tracker's own status, column or sprint.
- Per item: key, title, description, url, assignee, labels (opt-out).
- Comments with author, body, time. QA feedback lives here.
- Items where I am a reviewer, if the tracker has reviewers.
- Linked PRs, if the tracker exposes them.

Only a script reads the tracker, with a stored token, and prefetches into files. The model never holds the credential. Nothing is written back, except what a rule's `on_done` asks awaywork itself to write, on the developer's own items ([Writes](#writes)).

## Summary

| Tracker | Headless credential | Read-only token | "Mine" query | Linked PRs via API | Nightly limits | Official MCP, static token |
| --- | --- | --- | --- | --- | --- | --- |
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

Every tracker has a personal token that works without a browser. A nightly poll fits every rate limit; Plane is the tightest [I].

## Borrow, depend, or build

### No library to depend on

No OSI-licensed project covers this set with the read shape above [V unless noted]:

| Project | License | Why not |
| --- | --- | --- |
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

Using any of the hosted unified APIs would break the rule that nobody else stores the user's credential.

### MCP instead of adapters: no, not for the prefetch step

- 7 of 13 official servers are OAuth-only headless: Trello, Asana, GitLab, ClickUp, Notion, Shortcut, and Jira unless an admin opts in [V]. The fallback is community servers, some archived or paid [V/C].
- A script can call MCP without a model (`tools/call` is plain JSON-RPC; `mcptools`, the SDKs) [V], but tool names, arguments and outputs are per server and unversioned; `outputSchema` is optional, so many return free text [V]. One MCP client over N servers saves auth and transport code only, and swaps versioned REST for moving targets [I].
- Handing the model the tool instead puts a credential within reach of prompt injection from ticket comments. Read-only is enforced server-side only by Linear, GitHub and Rovo scopes [V]; elsewhere it is a local flag or nothing.
- Headless client wiring has had bugs: Claude Code sent `${VAR}` in HTTP `headers` literally (#51581) [C], though 2.1.289 expands it [V, tested, `providers.md`]; Copilot CLI disables a Bearer server after OAuth discovery (#3100) [C].

MCP is an opt-in for the worker, per rule (`mcp` in the config); see the configuration guide for the servers' secrets and `tools` lists.

### Recommendation: thin adapters of our own

Each adapter is one file of REST or GraphQL calls with a personal token. Borrowed:

- **Interface** from Symphony's spec (Apache-2.0, credit in NOTICE): an opaque `id` plus a human `key`, provider-native state names, a raw payload escape hatch, and each adapter declaring its config and secret names [V]. Its tracker contract:

  ```elixir
  @callback fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  @callback fetch_issues_by_ids([String.t()])    :: {:ok, [Issue.t()]} | {:error, term()}
  @callback secret_environment_names(map()) :: [String.t()]
  ```

- **Queries** as reference, reimplemented: bugwarrior's per-service filters (GPL, read not copied), `ankitpokhrel/jira-cli` `pkg/jira` (MIT), `schpet/linear-cli` (ISC), Activepieces pieces (MIT) [V].
- **GitHub and GitLab**: shell out to `gh` and `glab` with `--json`, reusing the user's login [V].

No reuse argument decides the language: bugwarrior is Python, jira-cli, `gh` and `glab` are Go, the Linear and Activepieces code is TypeScript [V].

## Adapter shape [I]

```
items(scope) -> [Item]    # my open items in the configured statuses
item(key)    -> Item      # refresh one, with comments
secrets()    -> [env var names]

Item: id, key, title, description, url, status, assignee, reviewers[],
      labels[], comments[{author, body, at}], linked_prs[], raw
```

- **Status to kind is config**, not code: the user maps their own columns, e.g. `QA -> qa_feedback`, `In progress -> in_progress`, `Current sprint -> plan`, `Code review -> review_requested`.
- **PR linking falls back to the forge**: search PRs whose branch or title carries the item key, as the prototype did. Native links (GitHub, Azure DevOps, YouTrack, Shortcut, Linear attachments) are a bonus, and Jira's only native path is the private `dev-status` endpoint [V].
- **Read-only by default**, with the least-privilege token documented per tracker. Where none exists (Asana, ClickUp, Monday, Shortcut, YouTrack) the docs say so.

Suggested order, by reach and headless ease [I]: GitHub, Jira, Linear, GitLab, Asana, Trello; then Azure DevOps, ClickUp, Monday, Notion, YouTrack, Shortcut, Plane.

## Per tracker

### Jira

- Tokens now expire after 1–365 days; scoped tokens call `https://api.atlassian.com/ex/jira/{cloudId}`, not the site URL [V] https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- `/rest/api/3/search` is gone; `/search/jql` pages by `nextPageToken` [V] https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/ with reported pagination bugs [C].
- No native reviewer field; a custom field or the PR's own reviewers [I].
- Dev-panel PRs only via private `/rest/dev-status/1.0/issue/detail` [V] https://support.atlassian.com/jira/kb/how-to-retrieve-pull-request-and-bitbucket-repo-and-branch-information-from-an-issue-using-rest-api/
- Points-based rate limits apply to apps, not API tokens [V] https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Data Center: bearer PATs, API v2 [V/I].
- Rovo MCP token auth, admin opt-in [V] https://support.atlassian.com/atlassian-rovo-mcp-server/docs/configuring-authentication-via-api-token/
- **Adapter.** Cloud only. Basic auth with `email:token` [I, tested]; the site URL for a classic token, `api.atlassian.com/ex/jira/{cloudId}` for a scoped one, with the cloud id from the site's `/_edge/tenant_info` [I]. `POST /rest/api/3/search/jql` with `assignee = currentUser() AND resolution = Unresolved`, the configured `jql` ANDed in, fields `*all,-comment`, paged by `nextPageToken` until `isLast`, an empty page or a repeated token; custom field names from `/rest/api/3/field`; comments per issue from `/issue/{id}/comment`, paged by `startAt`, oldest first, ADF turned into minimal Markdown [I]. 429s wait out `Retry-After`, as for Asana. Key is the issue key (`ENG-12`).
- **PR links.** `dev-status` stays unused: awaywork links issues through the forge by key, which Jira's own branch names carry [I].
- **Blocked.** `blocked` is true when `fields.issuelinks` holds a link of type `Blocks` with an `inwardIssue` (the issue blocking this one) whose `status.statusCategory.key` is not `done` [I, tested by `real-jira.test.ts`]. A site that renamed the `Blocks` link type is not seen.
- **Repo for an issue.** `repo_map` maps a project key to `owner/repo`.
- **Writes.** A comment is `POST /rest/api/3/issue/{id}/comment` with an ADF `body`; a move posts `{ transition: { id } }` to `/issue/{id}/transitions` for the transition whose `to.name` is the configured status. `GET /issue/{id}?fields=updated,assignee&expand=transitions` reads the issue's `updated`, its assignee and its transitions in one call, `expand=transitions` "Returns all possible transitions for the issue" [V, the OpenAPI spec] https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json; `?fields=updated` reads it again after [I, tested against fixtures only]. The write is refused when `assignee.accountId` is no longer the one the plan read, which was the developer's [I]. A comment is the developer's when `author.accountId` is the issue's `assignee.accountId`, since the JQL reads only `assignee = currentUser()`, and `updateAuthor`, "the user who updated the comment last" [V, same spec], is absent or the same account. `GET /rest/api/3/myself` would name the token's account but needs `read:jira-user` [V, same spec, `x-atlassian-oauth2-scopes`], beyond the `read:jira-work` the guide asks for, so awaywork doesn't call it. A scoped token needs `write:jira-work` for both writes [I]. ADF has no hidden markup that round-trips through `adfToMarkdown`, so awaywork's mark is a visible last paragraph [I].

### Asana

- PAT has the user's full access; read scopes exist for OAuth apps only [V] https://developers.asana.com/docs/oauth-scopes
- **Token for awaywork.** There is no read-only PAT: the token in `token_env` can do anything the user can [V, above]. Service accounts need "Full Permissions" for the task endpoints [V]. awaywork sends only `GET`s, plus the `POST`s of a rule's `on_done`, and never hands the token to the worker. Make a PAT for awaywork alone so it can be revoked on its own. https://developers.asana.com/docs/personal-access-token
- `GET /tasks` needs `workspace` with `assignee`; `completed_since` keeps incomplete tasks plus ones completed after it; pages of up to 100 follow `next_page.offset` [V] https://developers.asana.com/reference/gettasks https://developers.asana.com/docs/pagination
- A user id may be `"me"`, an email or a gid [V] https://developers.asana.com/reference/getuser
- Status is a section (per project membership) or a custom field [I]. Comments are stories filtered by `resource_subtype=comment_added` [V] https://developers.asana.com/reference/getstoriesfortask
- Custom IDs (`EX-1`) are a custom field with `representation_type` `custom_id`, and a task can be fetched by one [V]; that its `display_value` holds the `EX-1` string is [I]. https://developers.asana.com/reference/gettaskforcustomid
- Rate limits: 150/min free, 1,500 paid, 50 concurrent `GET`s, a lower 60/min on search; every limiter answers `429` with `Retry-After` [V] https://developers.asana.com/docs/rate-limits
- **Blocked.** `GET /tasks/{gid}/dependencies` lists the tasks this one waits on; `blocked` is true when one has `completed: false` [I, not run against the live API]. One extra call per task; when it fails, as it may on a plan without dependencies, the task has no `blocked`.
- **PR links.** `GET /attachments?parent=<task>` lists a task's attachments, including `external` ones with a `view_url` [V] https://developers.asana.com/reference/getattachmentsforobject. Asana's GitHub Action "creates an attachment" for a PR whose description carries the task URL, through an Asana-hosted service [V] https://github.com/Asana/create-app-attachment-github-action; the attachment's subtype and URL fields are not documented [I]. The in-task GitHub widget is an app component whose resource lives on the app's server [V] https://developers.asana.com/reference/attachresource, so it may not show in `/attachments` at all [I]. awaywork links tasks through the forge instead: my PRs whose branch or title carries the task key, or whose body holds any `app.asana.com` URL ending in the task gid. Asana's GitHub app writes `/0/0/<gid>`, not the `permalink_url` form [V, its PR descriptions].
- **Repo for a task.** Asana has no notion of a repo, so a task with no linked PR takes its repo from `repo_map` (project gid to `owner/repo`) in the source config.
- **Writes.** `POST /sections/{section_gid}/addTask` with `{ data: { task } }` moves a task: "This will remove the task from other sections of the project", OAuth scope `tasks:write` [V] https://developers.asana.com/reference/addtaskforsection. awaywork looks the section up by name in each of the task's projects that `projects` names (all of them without it), the first that has it. A comment is a story, `POST /tasks/{gid}/stories` with plain `text`, which comes back in `text` as sent [I]; a story is the developer's when `created_by.gid` is the task's `assignee.gid`, since tasks are read with `assignee: 'me'` [I]. Stories carry no last editor [I]. `modified_at` is read right before and after the write, with `assignee` before it, and the write is refused when its `gid` is no longer the plan's [I]. All tested against fixtures only.

### Trello

- Key + token, `read` scope, expiry up to `never` [V] https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/
- OAuth 2.0 with short-lived tokens is launching; no end date for key + token found [V] https://developer.atlassian.com/cloud/trello/changelog/
- Comments: `/1/cards/{id}/actions?filter=commentCard` [V].

### Linear

- API key restricted to read and to teams [C]; limits [V] https://linear.app/developers/rate-limiting
- MCP with Bearer key and read-only endpoint [V] https://linear.app/docs/mcp
- **Adapter.** One GraphQL endpoint, `https://api.linear.app/graphql`; a personal key goes in `Authorization` without `Bearer` [I, tested]. `viewer.assignedIssues` filtered on `state.type` not in `completed`, `canceled`, paged by `pageInfo.endCursor`; comments per issue through `issue(id).comments` [I]. Key is the `identifier` (`ENG-12`).
- **PR links.** Not read from `attachments` until the claim below is verified: awaywork links issues through the forge by key, which matches Linear's own branch names (`dev/eng-12-title`) [I].
- **Blocked.** `blocked` is true when `inverseRelations` holds a `blocks` relation whose issue's `state.type` is not `completed` or `canceled` [I, tested by `real-linear.test.ts`]. Only the first 10 relations are read: at 50, the issues query would pass the 10,000-point complexity limit [V] https://linear.app/developers/rate-limiting.
- **Repo for an issue.** `repo_map` maps a team key to `owner/repo`.
- **Writes.** `commentCreate(input: { issueId, body })` and `issueUpdate(id, input: { stateId })`, both returning `success`; `User.isMe` says whether a comment's user is the key's own; a team's `states` lists its workflow states; `Comment` has `editedAt` but no editor [V, the SDK's `schema.graphql`] https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql. `updatedAt` and `assignee { isMe }` are read with the states before a move, on their own before a comment, and again after; the write is refused unless `isMe` [I]. Whether a Markdown HTML comment survives Linear's editor is not checked, so awaywork's mark is a visible last line, as everywhere [I]. Not run against the live API.

### GitHub

- `@me` works in GraphQL `search` queries (`author:`, `assignee:`, `review-requested:`) [V]; `gh pr list --json` has no review threads, so items come from `gh api graphql` [V].
- `gh run view --job <id> --log-failed` prints the whole job log, not just the failed step [V].
- Projects v2 is GraphQL-only; fine-grained PATs reported to fail on it [C] https://github.com/orgs/community/discussions/156512
- **Writes.** A PR is an issue: "Every pull request is an issue, but not every issue is a pull request", and labels and conversation comments go through the issues endpoints [V] https://docs.github.com/en/rest/issues/labels. `POST /repos/{owner}/{repo}/issues/{n}/labels` takes `{ labels: [...] }`, "the labels to add to the issue's existing labels" [V, same page]; it creates a label the repo lacks, which that page doesn't say: on a sandbox repo, `GET .../labels/<name>` was a 404, and after the `POST` the label existed with color `ededed` [V, live]. awaywork calls it and `.../comments` through `gh api`, as the developer, reading `updated_at` right before and after [V, `real-github.test.ts` on a sandbox repo: the label added, the time returned, the comment read back as awaywork's]. That read is GraphQL's `issueOrPullRequest` with `viewer { login }`, and an issue's assignees: its `updatedAt` is the REST `updated_at` [V, live, an issue and a PR], and an issue no longer assigned to the viewer is refused [I, fixtures]. A PR isn't checked, its author can't change. A comment counts as the developer's by `viewerDidAuthor` and an `editor` that is null or its own author: a collaborator's edit sets `editor { login }` to theirs and `lastEditedAt`, while `viewerDidAuthor` stays true [V, live, a second account editing a sandbox comment]. A classic token's `repo` scope covers both [I]; the Actions workflow's `GITHUB_TOKEN` stays read-only, since awaywork writes with `GH_TOKEN`.

### GitLab

- Official MCP is OAuth-only; PAT support is issue #586184 [V] https://gitlab.com/gitlab-org/gitlab/-/issues/586184

### Azure DevOps

- Global PATs are retired; use organization-scoped ones [V] https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/

### Notion

- PATs act as the user; internal connections are a bot, so "me" must be configured [V] https://developers.notion.com/guides/get-started/personal-access-tokens

### Others

- ClickUp: https://developer.clickup.com/docs/rate-limits
- Monday: https://developer.monday.com/api-reference/reference/people
- YouTrack: https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues.html
- Shortcut: https://help.shortcut.com/hc/en-us/articles/205701199-Shortcut-API-Tokens
- Plane: https://developers.plane.so/api-reference/introduction

## Writes

What `on_done` writes, in one place [I]:

- Only items the rule matched as the developer's own (`Item.mine`): their PRs and issues assigned to them on GitHub, every Jira, Linear and Asana item (all read as assigned to them), every custom source item by its house rule. Never a review-requested PR, an item only an extra GitHub `search` found, or a new item. `mine` is the plan's, so each built-in source reads the assignee again in its read right before the write and refuses an item reassigned or unassigned since; a custom source's `write` must, by its house rule.
- Every comment ends with a visible `— awaywork` line. It counts as awaywork's only when it also comes from the token's own user, so a pasted line doesn't hide a comment from awaywork.
- The item's updated time after the write is recorded as the attempt's only when the one read right before it is still the plan's, so awaywork's own write doesn't read as a change next run, and someone else's change during the run still does.
- `on_done` moves only items of the rule's own source (its `source`, else the source of the item the rule matched): a destination is one tracker's name.

## Unverified, check before relying on it

- Linear: PRs from the GitHub integration appear in `issue.attachments`.
- Linear: personal keys limited to read and to teams; comment paging used by `linear.ts`.
- Jira: basic auth of a scoped token on the gateway, `-comment` in `fields`, `*all` returning custom fields on `search/jql`.
- Writes on Jira, Linear and Asana: none has run against a live account yet.
- Asana: GitHub integration attachments readable via `/attachments`, and in which field the PR URL sits.
- Plane: filtering by assignee and state, PR links.
- ClickUp, Monday: any PR link in the API.
- YouTrack: rate limits.
- Rovo MCP exposes Jira dev-panel PRs.
