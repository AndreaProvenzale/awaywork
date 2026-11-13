# awaywork prove

How a change is proven differs per repo, so awaywork ships no skill for it and you name no tool they don't already use. Write the repo's own with the developer: a skill that proves a change against the card and leaves the files that show it, a script gate that checks the files are there, a judge gate that checks they show what the card asks, and the store's routing for them. Docs: https://andreaprovenzale.github.io/awaywork/guide/workflows.md#proving-a-change

You come here from [`setup.md`](setup.md) or [`suggest.md`](suggest.md), on their draft, or from [`queue.md`](queue.md) when the developer asks for proof, evidence or QA of what awaywork ships. The [ground rules](SKILL.md#ground-rules) hold: nothing is written unasked, real names only, widening shown on its own.

## 1. Find how they prove a change

Read first, per repo in scope, without asking:

- what the repo already runs: the scripts in `package.json`, `pyproject.toml` or the `Makefile`, the CI workflows, an end-to-end or smoke folder, a `CONTRIBUTING.md` or `AGENTS.md` section on testing by hand;
- the checks on a recent PR of theirs, spelled as the forge spells them: `gh pr view <n> -R <repo> --json statusCheckRollup --jq '.statusCheckRollup[] | [.name // .context, .detailsUrl // .targetUrl] | @tsv'`. One that deploys the PR (its link opens the app) is the preview.

Then one question, its options built from what you found, the one closest to how they work first: "How is a change proven in `acme/web` before you review it?" with, say, "the `e2e` script against the PR's preview (`<check name>`)", "the smoke script, run in the clone". Found nothing: ask in free text, and offer no tool. "Not now" ends this file: write nothing.

Their answer has to give a command a worker can run. The harness, which no skill lifts, rules out dev servers, builds, `docker`, background commands and forge access: a worker proves against something already deployed, or with a command that starts, checks and stops in one call. When their way needs a device or a login a worker doesn't have, say so and stop here.

## 2. Pick the shape

**A step of its own, after the change is published** is the default: it starts from the card, not from the code it just wrote, so it checks what was asked, not what was built. Which form depends on the queue:

- **The queue plans cards into tasks** (`deliver: plan` and `planned` rules): a `planned` rule for the skill that reports, and a line in an `instructions` file of the plan rule so plans end with its task (`End every plan that changes what a user sees with a task for prove, after the tasks it proves`). With a preview the task waits on it, `after: { <task>: <check name> }`; without, `after: { <task>: opened }`. In the same repo its clone is cut from that task's branch.
- **No plan:** a rule on awaywork's own PRs once their checks pass, the preview's with them: `where: { type: pr, ours: true, checks: passing }`, after the rules that fix those PRs.

**The same step proving its own work** is the fallback, for a repo with no preview where the proof is a command the step can run anyway: `skills: [prove]` on the rule that implements, and a line in its `instructions` file telling the step to use it before it stops. Say what it gives up: the agent that wrote the change picks what counts as proof.

Where the preview's URL comes from, to write into the skill:

- On a PR rule, `.away/context/<item>/checks.md` lists every check of the PR, the ones that didn't fail under `## Not failing`, one line each: name, state, link. The skill names the check and the host its link must be on, since on a public repo anyone can report a check.
- A plan's task gets the card, not the PR: no `checks.md`. The skill builds the URL from the branch its own was cut from, which its prompt names, when the host has a stable address per branch; ask the developer for the pattern. No such address: use the PR rule.

## 3. The manifest

`evidence.yml` is a convention between the skill and its gates. awaywork never reads it: change it with them freely, the gate script along with it.

```yaml
# .away/out/evidence.yml
criteria:
  - criterion: The Export button downloads the month's VAT report as CSV
    files: [export-click.png, export.csv]
  - criterion: A month with no invoices shows "Nothing to export"
    files: [empty-month.png]
  - criterion: The CSV's total matches the invoice list's
    files: []
    gap: the preview has no seeded invoices
```

- One entry per acceptance criterion of the card, in the card's order and words. A card with none: the skill lists what the card's description asks for and says so in the report.
- `files`: the files in `.away/out/` that show it, by their path there, on one line. Any kind: a screenshot, a recording, a response body, a query's rows, a log.
- A criterion the step couldn't prove keeps its entry with `files: []` and a `gap` line. The gate fires on it, and the developer's `approve` accepts the gap.

## 4. Write it with them

Show each file before writing it, and write only on their yes.

**The skill,** `skills/prove/SKILL.md` in the config's folder (`<control>/.awaywork/skills/` with a control folder), never in the repo: a repo skill is whoever can push there's to change. Name it as they would; `prove` here. Keep it to their repo:

```markdown
---
name: prove
description: Prove a change against its card's acceptance criteria and leave the files that show it. Use on a task that proves other tasks' work.
metadata:
  deliver: report
---

# Prove

The unit proves work another step did. The card is in its context: its acceptance criteria are what you prove, not what the code seems to do.

1. List the criteria, one line each, in the card's words.
2. <Where the change runs: the preview's URL, from `checks.md` or the branch, and the host it must be on.>
3. For each criterion, <their command>, and save what shows it in `.away/out/`: <the files their command leaves>.
4. Write `.away/out/evidence.yml`: <the manifest above, with one made-up entry>.
5. In `report.md`, per criterion: the command you ran, what it showed, and the file. A criterion you couldn't prove gets `files: []`, a `gap` line and why.

Change no code. A criterion that fails is a finding: report it, with the file that shows it failing.
```

Same step: drop `metadata.deliver` and the first paragraph's "another step", and the description says when to use it ("Use before you stop, on a change a card's criteria describe").

**The script gate,** [`scripts/evidence-gate.sh`](scripts/evidence-gate.sh) beside this file, POSIX sh: it reads `$AWAYWORK_OUT_DIR/evidence.yml` and fires with one line per problem (`no evidence.yml`, `no file for criterion 3`, `criterion 2: empty-month.png is missing or empty`). It sees that files exist, nothing more. A gate's command names its script by a path from the repo's root, and awaywork runs it only when that file is the one the clone started with, so the script goes in each repo the rule takes, as `scripts/evidence-gate.sh`: a local change the developer commits and merges themselves. Until it's on the default branch the gate fires unrun (`changed, not run`): say so. Try it with them on a folder holding a sample manifest: `AWAYWORK_OUT_DIR=<folder> sh scripts/evidence-gate.sh; echo $?`.

**The judge gate** beside it compares the files with the card: the built-in `judge` with an instructions file of theirs, `judges/evidence.md` beside the config, never the repo's:

```markdown
You judge proof of a change. The step left `evidence.yml`: each of the card's acceptance criteria with the files that show it.

Fire when a criterion of the card is missing from it or reworded into something easier, when a file doesn't show what its criterion says (open each one), or when the report says a criterion failed. One line per criterion you fire on, naming it.
```

**The rules.** Both gates go on every rule that uses the skill, as its skill or in its `skills`:

```yaml
queue:
  - skill: prove
    where: { planned: true } # or { type: pr, ours: true, checks: passing }
    deliver: report
    gates:
      proof: { command: sh scripts/evidence-gate.sh }
      shown: { skill: judge, instructions: [judges/evidence.md] }
```

On a rule that reports, clear gates post the result on the item and go ahead; one that fires makes it wait for their reply, and on a plan's task holds the card's other tasks until then (https://andreaprovenzale.github.io/awaywork/guide/workflows.md#a-gate-on-a-report-task). On the rule that implements (same step) the gates run with the chain's commits, and one that fires puts its line on the PR's decision card. Either way it's a widening, `gates` on a report posting on the item: show it as [`queue.md`](queue.md#widening) says. The judge is one more model run per unit.

**The store's routing,** when the config has a `store`: its `put` gets each file's name under `.away/out/` as `kind`. With them, add to the script where each kind of file goes: screenshots and recordings where the store keeps bytes as put, `evidence.yml` and the report beside them, and `{"skip": true}` for a file too big to keep (a trace). A skip keeps a file out of the store, not off the item, and redacting what a recording or log may hold is the script's job. No store: the post is full, and the files stay in the run dir, where only a `notify` hook reaches them; say so, and offer a store as [`setup.md`](setup.md)'s step 5 writes one.

## 5. Check

`awaywork --config <draft> plan --rules --json` as [`queue.md`](queue.md)'s step 5 reads it: a `planned` rule takes nothing until a plan hands it a task, a PR rule shows the awaywork PRs it takes now. `awaywork --config <draft> skills list` names `prove` once its folder is beside the draft. Then back to the file you came from, with the rule in the draft.

In the end's summary: the skill's path, each repo's gate script and that it's theirs to commit, the judge's instructions file, what changed in the store script, and the rules that carry the gates.
