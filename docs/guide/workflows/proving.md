---
description: A skill of your own shows the change does what the card asks, and gates check what it left.
---

# Proving a change

How a change is proven differs per repo: an end-to-end run against the PR's preview, a flow on a simulator, a curl script, a seeded query (Playwright, Maestro and friends). So awaywork ships no skill for it and reads no proof format. You write your repo's skill, or [`/away`](../away.md#the-skill) writes it with you, and the pieces above carry it: a [report task](./tasks.md#report-tasks) that [waits on the preview](./tasks.md#waiting-on-a-check), [gates](./tasks.md#a-gate-on-a-report-task) on what it left, the [store](./store.md) for the files.

The example: `acme/web` gets a preview per PR, reported as the `Preview` check that links to it, and its `pnpm smoke <url> <flow>` drives one flow there, saving a screenshot per step.

The skill is yours, `skills/prove/SKILL.md` beside your config, never the repo's:

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
2. The change runs at the link of the check your task waits on, in `item.md`'s plan: `after app's check Preview (passed, <link>)`. Open it only when its host ends in `.preview.acme.dev`, and open no other host.
3. For each criterion, run `pnpm smoke <url> <flow>` with the flow in `smoke/` that covers it, and copy the screenshots that show it from `smoke/out/` to `.away/out/`.
4. Write `.away/out/evidence.yml`: `criteria:` alone on the first line, then one entry per criterion, in these lines and no others, each text on its one line:

       criteria:
         - criterion: A month with no invoices shows "Nothing to export"
           files: [empty-month.png]
         - criterion: The CSV's total matches the invoice list's
           files: []
           gap: the preview has no seeded invoices

   The names are plain paths under `.away/out/` (ASCII letters, digits, `.`, `_`, `-`, `/`), never the step's own files, `report.md` and the manifest among them.
5. In `report.md`, per criterion: the command you ran, what it showed, and the file. A criterion you couldn't prove gets `files: []`, a one-line `gap`, and why.

Change no code. A criterion that fails is a finding: report it, with the file that shows it failing.
```

`evidence.yml` is a convention between your skill and your gates, so shape it as you like, the gate script along with it; awaywork never reads it:

```yaml
criteria:
  - criterion: The Export button downloads the month's VAT report as CSV
    files: [export-click.png, export.csv]
  - criterion: A month with no invoices shows "Nothing to export"
    files: [empty-month.png]
  - criterion: The CSV's total matches the invoice list's
    files: []
    gap: the preview has no seeded invoices
```

The queue gives the skill a `planned` rule with two gates, and a plan hands it a task that waits for the preview:

```yaml
queue:
  - skill: plan
    where: { label: awaywork-feature }
    deliver: plan
    instructions: [notes/plan-proof.md] # "End a plan that changes what a user sees with a prove task, after the others' Preview."
  - skill: implement
    where: { planned: true }
  - skill: prove
    where: { planned: true }
    deliver: report
    gates:
      proof: { command: sh scripts/evidence-gate.sh } # the files are there
      shown: { skill: judge, instructions: [judges/evidence.md] } # and show what the card asks
```

```yaml
tasks:
  - { id: app, title: Export screen }
  - { id: qa, title: Proof, skill: prove, after: { app: Preview } }
```

A step of its own starts from the card, not from code it wrote, so it checks what was asked rather than what was built. Its clone is cut from `app`'s branch, so it has the change but not the session that made it, and its context is the card and the plan.

The script gate is [`evidence-gate.sh`](https://github.com/AndreaProvenzale/awaywork/blob/main/plugin/skills/away/scripts/evidence-gate.sh), POSIX sh, copied into the repo and named by its path from the root, so awaywork can tell the agent [didn't rewrite it](./gates.md#gates-fail-closed). Its contract:

- It fires unless every criterion names at least one file that is in `.away/out/`, not empty, not a link nor in a linked folder. A `gap` line excuses nothing.
- It sees that the files exist, not what they show, and runs nothing the manifest says.
- It reads the manifest as plain lines, not as YAML: `criteria:`, then per entry `- criterion: <text>`, `files` as a list on one line or a name per line, and `gap: <text>`, each on one line. Any other line fires it with the line's number, a `|` block, a list carried onto the next line or a quoted key included, so nothing it can't read passes.
- A name is a path of ASCII letters, digits, `.`, `_` and `-`, with `/` between folders.
- The step's own files aren't proof: `evidence.yml`, `report.md`, `summary.md`, `pr.md`, `push.md`, `questions.md`, `plan.yml`, `review.json`, `status`, `verdict`, `diff.patch`, `check.log`, `verify.log` and any `judge-*.log`, at the top of `.away/out/`.

On the manifest above, with the first two criteria's files in place:

```text
$ AWAYWORK_OUT_DIR=out sh scripts/evidence-gate.sh; echo $?
no file for criterion 3
1
```

And with its `gap` written as a block:

```text
$ AWAYWORK_OUT_DIR=out sh scripts/evidence-gate.sh; echo $?
evidence.yml line 8: a block of text isn't read: put the text on this line
1
```

The judge beside it opens the files. Its instructions come from your config, `judges/evidence.md` here:

```markdown
You judge proof of a change. The step left `evidence.yml`: each of the card's acceptance criteria with the files that show it.

Fire when a criterion of the card is missing from it or reworded into something easier, when a file doesn't show what its criterion says (open each one), or when the report says a criterion failed. One line per criterion you fire on, naming it.
```

With both clear the result is posted on the card and the task is done. One that fires [posts it to wait](./tasks.md#a-gate-on-a-report-task), `- proof: no file for criterion 3` on top: `approve` accepts the gap, anything else runs the task again.

With a [store](./store.md), each file goes through its `put`, `kind` being the file's name under `.away/out/`, so the script decides where screenshots go and what stays behind:

```js
if (op.op === 'put' && op.kind.endsWith('.zip')) {
  console.log(JSON.stringify({ skip: true })) // a trace stays in the run dir
  process.exit(0)
}
```

Other shapes:

- **No plan:** a rule on awaywork's own PRs once their checks pass, the preview's among them. Its context has the PR's `checks.md`, whose `## Not failing` part lists each check with its link, so the skill reads the preview's URL there, and names the host it must be on. The issue is in the unit, for the step to read, only while a rule still takes it, as `implement` does here while it stays open and labelled. Clear gates then post the result on the PR and the issue; one that fires makes it wait on both. A card no rule takes any more (it moved column, lost the label) leaves the PR alone in the unit: the step proves against the PR's body, which the implementing agent wrote, and posts there only.

  ```yaml
  queue:
    - skill: implement
      where: { type: issue, label: awaywork }
    - skill: prove
      where: { type: pr, ours: true, checks: passing }
      deliver: report
      gates:
        proof: { command: sh scripts/evidence-gate.sh }
        shown: { skill: judge, instructions: [judges/evidence.md] }
  ```

- **No preview:** the step that made the change proves it itself, with a command that needs nothing started: a curl script against staging, a query, a run of the repo's CLI. It's the fallback: the agent that wrote the change picks what counts as proof. The gates go on that rule, and one that fires puts its line on the PR's [decision card](./gates.md#the-decision-card).

  ```yaml
  queue:
    - skill: implement
      skills: [prove]
      instructions: [notes/prove-first.md] # "Before you stop, prove the change with the prove skill."
      where: { type: issue, label: awaywork }
      gates:
        proof: { command: sh scripts/evidence-gate.sh }
        shown: { skill: judge, instructions: [judges/evidence.md] }
  ```

- **No preview, serve:** awaywork starts the app itself, for the steps that ask, under `isolation: none`. The repo says how, and the step gets the URL:

  ```yaml
  repos:
    acme/web:
      setup: pnpm i --frozen-lockfile
      serve:
        command: pnpm dev --port $AWAYWORK_PORT # awaywork picks a free port
        ready: http://localhost:$AWAYWORK_PORT/healthz # polled until it answers with less than a 500
  queue:
    - skill: prove
      where: { planned: true }
      deliver: report
      serve: true # a rule or step key, inherited like mcp
  ```

  After setup and `when`, awaywork starts `command` on a free port (`$AWAYWORK_PORT`), polls `ready` for up to 5 minutes, then runs the agent with `The app runs at http://localhost:52113, started by awaywork from `pnpm dev --port $AWAYWORK_PORT`; it stops with you. Don't start it again.` in its prompt and `AWAYWORK_SERVE_URL` in its env. The agent still starts nothing. Output goes to `serve.log` in the step's run dir.

  The app stops with the agent, before `until`, `verify` and the gates, so a gate judges the files the step left, not the app. A step that wants the app again, say each round of a loop, asks again and gets a fresh one on the tree the step before left. Without secrets, the app boots on what the repo commits: `.env.example`, SQLite or mocks.

  If it never answers, or exits first, the step runs without the app: the prompt says `Serve didn't come up` with `serve.log`'s tail, and the report shows it. The proof gate fires on its own, so a change that broke the boot is what the next step reads. Not started on an untrusted author's PR, as setup isn't. Under `isolation: user` or `container` it isn't supported yet: the step runs without it, and `awaywork doctor` warns.

Details:

- The [harness](https://github.com/AndreaProvenzale/awaywork/blob/main/harness.md) lets a worker run no dev server, build, `docker` or background command, and gives it no forge access: the skill proves against something deployed, or with a command that needs nothing started. A script that boots the app is still a dev server: a repo whose proof needs the app running and has no preview needs `serve`, or can't be proven by a worker.
- A plan's task gets the card, not the PR, so no `checks.md`: its `item.md` plan names the check it waits on with its link, while that PR is open. A check that links elsewhere, as Vercel's links its dashboard, leaves the skill to build the address from the branch its own was cut from, as in `https://<branch>.preview.acme.dev`, each `/` a `-`. Without a stable one per branch, use the PR rule.
- A check's name and link are whatever reported them, on a public repo anyone: the skill names the host it opens.
- The gate fires until the script is on the default branch where the clone started: as cloned, or, on an awaywork PR or a task stacked on one, where that PR left it. In neither that commit nor the clone, the command runs and fails: `- proof: Command failed with exit code 127: 'sh scripts/evidence-gate.sh'`. Added or edited on the PR's own branch, it isn't run: ``- proof: `scripts/evidence-gate.sh` changed, not run``.
- The gates go on every rule that uses the skill. A judge is one more model run per unit.
- Without a store the files stay in the run dir, where only your [notify](../results.md#notify) hook reaches them.
