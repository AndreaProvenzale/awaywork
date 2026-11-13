# awaywork queue

Turn what the developer wants offloaded into rules, check them on their real items, and write only what they accept. The [ground rules](SKILL.md#ground-rules) hold throughout.

## Set up

1. **Read the config** `awaywork config path` prints, and the file its `extends` names. Queue rules are in https://andreaprovenzale.github.io/awaywork/guide/configuration.md#queue-rules, every key in https://andreaprovenzale.github.io/awaywork/reference/config.md. `awaywork config schema` is 120 KB: search it, don't read it whole.
2. **Ask what to offload,** in their words: "my PRs with red CI", "bugs in QA", "review requests from my team". Don't make them speak YAML. On a first setup, when the `queue` is missing, empty or holds only the rules `awaywork init` writes (https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#the-queue, a section or status maybe renamed), offer once before asking: you can read their recent agent sessions and PRs for work they already hand off by reflex and suggest rules from it, asking first what to read. On a yes, follow [`suggest.md`](suggest.md); its picks come back to step 4.
3. **Learn the names.** `awaywork sources --json`, or `awaywork sources <id> --json`, prints one object keyed by source id: `github` `login` and `orgs`; `asana` `workspaces` with `gid`, `name`, `projects` (`gid`, `name`) and `sections`; `linear` `teams` with `key`, `name`, `states`; `jira` `projects` (`key`, `name`) and `statuses`. A source it can't read goes to stderr as `<id>: <why>` and exits 1; a missing token is the first ground rule. The fields a `where` takes differ per source (`label` on GitHub, `labels` on Linear and Jira): https://andreaprovenzale.github.io/awaywork/guide/how-it-works.md#items, and an unknown key's config error lists them.
4. **Draft on a copy.** Copy the config to `config.draft.yml` in the same folder (relative paths in it resolve from there) and edit the queue there. The first rule an item matches takes it, so order matters. With no `queue` key nothing runs, unless the config `extends` a base: then the base's applies, and a `queue` you write replaces it whole, so carry over the rules the developer keeps. A rule looks like:

   ```yaml
   queue:
     - skill: fix # awaywork skills list
       source: github
       where: { type: pr, mine: true, checks: failing }
     - skill: implement
       source: jira
       where: { status: Ready, labels: awaywork }
   ```

   A rule takes `gates` of its own, `{ <name>: { skill: judge } }`, `{ <name>: { command: <script> } }` or `{ <name>: { changed: [<glob>] } }`, under no name a top-level or repo gate has (https://andreaprovenzale.github.io/awaywork/guide/workflows.md#gates-of-a-rule-s-own). A gate checks what the unit leaves, and where it fires decides what happens:

   - On a rule that opens a PR or pushes, a `planned` one included, they run with the top-level and repo gates when the chain has commits: one that fires puts its line on the PR's decision card and keeps a `deliver: pr` PR a draft. A command reads the diff from `$AWAYWORK_FROM` and the files the steps left in `$AWAYWORK_OUT_DIR`. A chain that left no commits and has `on_done` to write runs the rule's own first, on those files alone: one that fires holds the comment and the move back.
   - On a `deliver: plan` or `report` rule they are the only gates, on the step's files in `$AWAYWORK_OUT_DIR`, with no `changed`: one that fires makes the post wait, so `wait: false` with a judge waits only when the judge fires. On a `planned` rule that reports, one that fires posts the task's result to wait, ends the card's tasks for that run (one post of a card waits at a time, a task's questions too) and holds them until the developer's first reply under it: `approve` counts the task as done, anything else runs it again (https://andreaprovenzale.github.io/awaywork/guide/workflows.md#a-gate-on-a-report-task).
   - Not on `pending_review`. A rule whose skills all report (`review`) needs `deliver: report` to take them: without it its items are skipped (`set deliver: report (review commits nothing, so its gates would never run)`) and `doctor` warns.

   A plan or report rule takes more keys, none of them on a `planned` rule, whose task waits only when a gate fires (the rest: https://andreaprovenzale.github.io/awaywork/guide/workflows.md#posts-that-wait):

   - `wait`, `deliver: plan` or `report` only, a PR rule refuses it: the post waits for their `approve`. Default `true` on a plan, `false` on a report.
   - `post`: `summary`, the default with a `store` and an error without one, or `full`, the report inline.
   - `thread`: `item` (the default), `github` (an issue in the item's repo, assigned to them, for a source that can't write) or a custom source with `thread: true`.

   A gate that checks proof of the change (screenshots, a recording, a response) comes with the skill that leaves it: [`prove.md`](prove.md).

   `where: { approved: <skill> }` takes the items whose newest post that they approved or that went ahead is that skill's, even on a tracker awaywork can't move cards on. Top-level `store: { command, secrets, read }` is a script that keeps the files a post pins, or skips one by printing `{"skip": true}` (https://andreaprovenzale.github.io/awaywork/guide/workflows.md#store); with one, posts are lean.

5. **Check on real items.** `awaywork --config <draft> plan --rules --json` reads the sources and probes no provider. It prints:

   ```json
   {
     "rules": [{ "rule": 1, "skill": "fix", "summary": "source=github type=pr mine=true checks=failing", "taken": [{ "source": "github", "key": "acme/api#12", "title": "…", "url": "…" }], "takenBy": [{ "rule": 2, "items": [] }] }],
     "unmatched": [{ "source": "github", "key": "acme/api#9", "title": "…", "url": "…", "reason": "matched no rule; closest #1 fix: checks is passing, wants failing" }],
     "warnings": []
   }
   ```

   `taken` is what the rule runs on now (`"plan": true` on a card its `deliver: plan` rule keeps though its `where` no longer matches), `takenBy` what it matches but another rule takes, `unmatched` what no rule takes, with the closest rule's failed conditions. A config error goes to stderr with exit 1: fix the draft and rerun. Show the developer, for each new or changed rule, the items it takes (key and title), the ones another rule takes, and the unmatched ones that sound like what they asked for, with the reason. Nothing taken today isn't proof the rule is right: say so, and show the closest misses. Then one question: write it, change a rule, or leave the config as it is.

6. **Write,** on their yes to that question. Apply the accepted rules to the real config by editing only the lines that change: keep comments, order and style as you found them, and don't round-trip the file through a YAML library. With `extends`, that's the role file, never its base, which every role extending it shares. Delete the draft.
7. **Validate.** `awaywork doctor --json` prints an array of `{ status, what, detail }`, `status` being `ok`, `warn` or `FAIL`, and exits 1 on any `FAIL`. A `FAIL` on the config (its `what` is the config's path, or its base's) is yours to fix; one on a binary or a login is the developer's: say which and how. It probes each provider's quota, a tiny model call, so run it once here, not in the loop. Then rerun `plan --rules --json` on the real config and check it takes what the draft did.

## Tweak

Start from the item: "why did or didn't X run", "stop doing Y on Z".

1. `awaywork plan --why <key>`, with the key as `plan` shows it (`acme/api#12`, `ENG-12`, or `source:key`), says which rule plans it, or why it's skipped: `no_rule` with the closest rule and the condition that failed, or a kind such as `unchanged`, `over_cap`, `waiting_for_review`, `skipped_by_you`. It probes quota like `plan`. For a past run, `awaywork report --json`.
2. Not the rules' doing (skipped by them, waiting on their review or answer, a cap): say what unblocks it, e.g. `awaywork unskip <source:key>`, and stop.
3. Otherwise change the rule in a draft as above and show the before and after of `plan --rules --json`: the items each changed rule gains and loses. Then step 5's question, and on their yes write and validate (steps 6 and 7).

## Widening

A change that lets awaywork write more, or exposes the agent to more, is shown on its own: the rule before and after, what it means, and the items it applies to now. One the developer named ("push onto my PR", "open them ready for review") goes into step 5's question with the rest; any other, one you'd add to make another request work or one that reaches items they didn't describe, gets a question of its own. A blanket "yes to everything" names nothing. Widening is:

- `deliver: pr` (opens ready for review, pinging reviewers and code owners), `push` (pushes onto the developer's own PR branch), `pending_review` (leaves their pending review on the PR), `plan` (posts a plan on the item and waits for approval).
- `on_done`, or a wider one: posts the result on the item, moves it in the tracker.
- Dropping `trusted: true`, or `trusted: false`, on a rule over other people's PRs: the agent then reads untrusted authors' text.
- `mcp` servers, `secrets` or `isolation` changes.
- `notify` commands, and dropping a `gates` entry or `verify`.
- `wait: false` on a plan (it goes ahead unless a gate fires), `wait: true` or `gates` on a report (it posts on the item), `thread` (opens an issue or page for the item), `store` (sends the step's files off the machine).

New rules leave `deliver` unset (draft PRs) or use `report`, unless the developer names one.

## End

Summarize in a few lines: each rule added, changed or removed, by number and what it takes now; the widening changes they approved; doctor's result. Then the commands for them to run: `awaywork plan` to preview the next run, `awaywork run --unit <id>` to try one unit, `awaywork schedule install` if nothing is scheduled yet.
