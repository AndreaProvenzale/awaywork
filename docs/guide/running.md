---
description: Read the plan awaywork would run, with plan --why, --skipped and --rules, run one unit, detached or narrowed to a repo or a rule, and read the morning report, its keys, report.md and stats.
---

# Plan, run, report

`awaywork plan` shows what a run would do, `awaywork run` does it, and `awaywork report` reads back what it did.

## Preview the next run

`awaywork plan` opens at once and shows each step as it loads, as in [Getting started](./getting-started.md#preview-the-next-run). Then the same screen is a view to browse, here with the skipped tracker items unfolded and the `acme/api` ones selected:

```
☾ >_ awaywork  You're away, your agents work

Providers
  present run (outside the windows): present_session_max
  provider  window     used  ceiling  set by  resets in  session / stop at
  claude    seven_day  5%    25.7%    pacing  5 runs     2% / 40%
    other limits: reserve cap 90%

▾ Needs you 1
  ▾ tracker T 1
    T-4  Export invoices as CSV  add repo

▾ Units 3
       item  rule  skill              provider  deliver   title
  ▾ acme/api 2
    1  #1    #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
       + api#5: same feature, matched #3
    3  #2    #2    review (built-in)  claude    report    Cache user sessions
  ▾ acme/web 1
    2  #3    #1    fix (built-in)     claude    draft_pr  WIP: new billing page

▾ Skipped 2: 1 no_rule, 1 over_cap
  ▾ tracker T 1
    T-7  Onboarding emails  no rule
         closest #3 implement: type is task, wants issue
  ▸ acme/api 1

⏎ unfold  o open  s skip  a approve  ? help  q quit
```

`⏎` on an item pages why it's planned or skipped, `o` opens it, `s` skips it in the coming runs; `?` lists the rest, and [the morning report](#the-morning-report) has the full key table. Piped or in CI it prints plain text:

```
$ awaywork plan | cat
Providers
  present run (outside the windows): present_session_max
  provider  window     used  ceiling  set by  resets in  session / stop at
  claude    seven_day  5%    25.7%    pacing  5 runs     2% / 40%
    other limits: reserve cap 90%

Units 3
     item   rule  skill              provider  deliver   title
  1  api#1  #1    fix (built-in)     claude    draft_pr  Add rate limits to the public API
     + api#5: same feature, matched #3
  2  web#3  #1    fix (built-in)     claude    draft_pr  WIP: new billing page
  3  api#2  #2    review (built-in)  claude    report    Cache user sessions

Needs you 1
  tracker T
    T-4  Export invoices as CSV  add repo

Skipped 2: 1 no_rule, 1 over_cap

awaywork plan --skipped [kind]  lists them
awaywork plan --why <key>       says why an item is planned or not
```

Each unit names its item (`api#1` is acme/api#1; a tracker's key stays as is), the rule it matched, its skill, provider and delivery.

**Needs you** lists the skipped items only you can unblock, under their repo or their tracker and project key, each ending on what to do: here `add repo`, for a task with no repo to work in. The rest is the config doing its job, counted by kind:

- `plan --skipped` lists them with the reason, after the Needs you ones;
- `plan --skipped no_rule` lists only one kind;
- `plan --why <key>` explains one item, with the queue when it matched no rule:

```
$ awaywork plan --why T-7
tracker T-7  Onboarding emails
  https://tracker.acme.dev/T-7
  skipped: no_rule
    matched no rule; closest #3 implement: type is task, wants issue

Queue
  #1  fix        type=pr mine=true
  #2  review     type=pr review_requested=true
  #3  implement  type=issue
  #4  fix        column=QA
```

For a planned item it shows the unit, rule, skill, provider and branch instead. With no `queue` in your config, `plan` opens with a line saying it runs the default one.

`awaywork plan --rules` shows the same rules with what each takes now, and skips the quota probe:

```
Queue (default: no queue in config)
  #1  fix     source=github type=pr mine=true checks=failing
       1 taken: acme/api#1
  #2  fix     source=github type=pr mine=true unresolved_threads!=0
       0 taken
  #3  fix     source=github type=pr mine=true ours=true my_unresolved_threads!=0
       0 taken
  #4  review  source=github type=pr review_requested=true trusted=true
       1 taken: acme/api#2
  1 unmatched: acme/api#3
```

An item goes to the first rule it matches, so a later rule that matches it too gets a line like `1 taken by #1: acme/api#1`. To reorder, move the rules in `awaywork config edit`.

## Run one unit

```sh
awaywork run --unit api#1      # one unit, as plan names it
awaywork run --repo 'acme/*'   # only units in matching repos
awaywork run --rule 4          # only units of queue rule #4
awaywork report --list         # recent runs, to pick an id for report <id>
awaywork report --unit 2       # one unit in full: its files, PR body or report
```

`--unit` takes an item as `plan` shows it (`api#1`), its key (`acme/api#1`, or `github:acme/api#1`) or the unit id (`acme-api-1`), in any case. A step of a rule's `then` runs its whole chain, from the first step. A unit you name goes past `limits.units`, `limits.units_per_repo` and its rule's `units`; the rest of the plan stays capped as it was.

`--unit` holds your terminal until the unit ends, hours sometimes. `--detach` starts it and hands the terminal back with one line, its output going to that run's `run.log`:

```text
$ awaywork run --unit api#1 --detach
Started api#1 as run 20261109-095329; awaywork report 20261109-095329 shows it once it ends
```

It plans first, so a unit that can't start says so and exits 1: not in the plan, the run lock taken, or no provider for it. To stop a detached unit, kill the pid in `~/.local/state/awaywork/run.lock`: it ends the way Ctrl-C would, report included.

An item no rule takes needs a skill named for it, [`--skill`](./skills.md#run-one-on-an-item-no-rule-takes), which works detached too.

Outside your windows that's a [present run](./how-it-works.md#budget): workers stop at 40% of the 5-hour window, and a provider whose quota awaywork can't read, like a command provider without a `probe`, sits it out. Run it inside a window or add a probe.

`--repo <glob>` and `--rule <n>` (rules count from 1, as `plan` shows them) work on `plan` and `run`, and together they both have to hold. The caps and ceilings stay the full run's, but only matching units count against them: with `limits.units: 3`, `--repo acme/api` plans up to three acme/api units.

The run directory, `~/.local/state/awaywork/runs/<id>/`, keeps the plan, the worker's log, its context files and the report. The id is the run's start time in UTC. Run dirs stay 30 days, then a run removes them; [`keep_runs`](./configuration.md#old-runs) changes that.

## The morning report

`awaywork report` opens the last run from its `report.json`. Arrow through it, unfold what you care about, and read, open or skip things with one key. It shows each provider's long window before and after against the ceiling, then a row per unit with its result and a line of what it concluded, what needs you, and the skipped items, folded, each under its repo.

Here `web#3` is selected (it's in reverse video on your screen), Skipped is unfolded one level, and `d` just said why it did nothing:

```
☾ >_ awaywork  You're away, your agents work

Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40
away run (inside a window): session_max
claude: seven_day 5% to 17%, ceiling 42.9%; session 2% to 31%, stop at 90%

▾ Needs you 1
  ▾ tracker T 1
    T-4  Export invoices as CSV  add repo

▾ Units 3
       item  skill   status          result
  ▾ acme/api 2
    1  #1    fix     done, 14 turns  https://github.com/acme/api/pull/14
       Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a…
    3  #2    review  done, 6 turns   report, verdict approve
       Approve: the session cache keys on the user id and expires with the token.
  ▾ acme/web 1
    2  #3    fix     done, 9 turns   nothing
       No code changes: the red check is the visual diff job, which fails on main too since #212.

▾ Skipped 2: 1 no_rule, 1 over_cap
  ▸ tracker T 1
  ▸ acme/api 1

⏎ read  o open  l log  d diff  s skip  a approve  ? help  q quit
diff: this unit left no diff
```

`awaywork plan` opens the same view on the next run, without `l` and `d`: a plan has no logs or diffs yet. Both open at once, with a line per step while they load: a run fetched from GitHub, or for `plan` each source and provider.

- Items sit under their repo, or their tracker and project key, so a row shows just `#3`.
- A skipped one ends on what it asks of you (`review PR`, `answer question`, `approve`, `add repo`, ...) or why it waits (`no rule`, `over cap`, ...), and Needs you lists a repo's items by that, so the PRs to review sit together.
- The line under a skipped item is what the reason says beyond that word, if anything, without the closest rule in Needs you; `⏎` has the whole of it. Rows run to the terminal's width, keeping that word on screen.
- It opens on the first Needs you item, else the first unit, else the first skipped one, and leaves out a section with nothing in it; when there's nothing at all, it says why instead.
- The footer dims the keys the selected row has nothing behind, like `d` on a unit that committed nothing, or `l` on a run [from the runner](./scheduling.md#reports-from-the-runner), which keeps no logs.

| Key | Does |
| --- | --- |
| `↑` `↓`, `j` `k` | move |
| `g` `G`, Home End | first, last row |
| PgDn PgUp, Ctrl-D Ctrl-U | a screen down, up |
| `→` `←` Space | unfold, fold, as `⏎` on a heading; `←` on a row goes to its section |
| `⏎` | page the unit in full, as `report --unit` prints it, or why an item is planned or skipped, as `plan --why`; `$PAGER`, else (or if it's `cat`) `less -R -c -+F -+X`, which repaints from the top and stays open on a short text |
| `o` | open the unit's PR, else its item; a skip waiting for review opens the PR it waits on |
| `l` | page the `worker.log` of the chain's last step |
| `d` | page the diff: the commits the unit published, else the step's own |
| `s` | `awaywork skip` the item, after a `y` |
| `a` | `awaywork approve` the item, after a `y`; there's no undo |
| `?` | the keys |
| `q`, Esc, Ctrl-C | quit, also while it loads |

Piped, in CI (`CI` set), or with `--json`, `--list`, `--unit` or `--skipped`, you get plain text instead, so `awaywork report | cat` is the way to print it:

```
$ awaywork report | cat
Run 20261019-220012: 1 draft PR, 1 report, 3 units
2026-10-19 22:00:12 to 2026-10-19 23:47:40

Units 3
     item   skill   status          result
  1  api#1  fix     done, 14 turns  https://github.com/acme/api/pull/14
     Rate limits the public API with a token bucket per client key; bursts get a 429 instead of a 500.
  2  web#3  fix     done, 9 turns   nothing
     No code changes: the red check is the visual diff job, which fails on main too since #212.
  3  api#2  review  done, 6 turns   report, verdict approve
     Approve: the session cache keys on the user id and expires with the token.

Needs you 1
  tracker T
    T-4  Export invoices as CSV  add repo

Skipped 2: 1 no_rule, 1 over_cap

Quota
  away run (inside a window): session_max
  claude: seven_day 5% to 17%, ceiling 42.9%; session 2% to 31%, stop at 90%

awaywork report 20261019-220012 --unit <n|key>    shows one
awaywork report 20261019-220012 --skipped [kind]  lists the skipped items
```

`report --unit <n>` prints a unit in full, what `⏎` pages: its links, each step with its provider and what it left when there are several, the files it left (the ones still there: a run [from the runner](./scheduling.md#reports-from-the-runner) has none), then its PR body or report. It takes the number from that table, the unit id (a step's gives its chain) or an item:

```
$ awaywork report --unit 2
2  web#3  WIP: new billing page
  skill   fix
  status  done, 9 turns
  result  nothing
  item    https://github.com/acme/web/pull/3
  files   ~/.local/state/awaywork/runs/20261019-220012/units/acme-web-3/1-fix/worker.log
          ~/.local/state/awaywork/runs/20261019-220012/units/acme-web-3/out/pr.md

Fix the billing page build

No code changes: the red check is the visual diff job, which fails on main too since #212.

## What I checked

- `pnpm test` passes locally.
- The failing job is `visual`, unrelated to this diff.
```

- An item key that is all digits, like an Asana gid, wins over a row number.
- A name that fits two units, `api#1` under two owners say, is refused with each one's `source:key`, here and in `run --unit` and `plan --why`.
- A long reason, like a failed setup's output, gets its first line in the row and all of it under `--unit`.
- A unit with `then` steps is one row, its chain in the skill column.

`report --skipped [kind]` lists the skipped items with the reason, as `plan --skipped` does. `awaywork report --json` prints the run's results as [JSON](./agents.md).

`awaywork report --list` lists recent runs with their units, PRs and reports; `awaywork report <id>` prints one of them. Both see only the runs [`keep_runs`](./configuration.md#old-runs) kept. Inside a control repo both also show the runs GitHub Actions [uploaded](./scheduling.md#reports-from-the-runner).

While a run is going there is no report yet: `awaywork report` then lists the steps done so far, the one working and the path to its `worker.log`, which you can `tail -f`.

The run dir also keeps `report.md`, the same run as markdown: the units table with every step under its chain and a line per unit that wrote a summary, Needs you, the skipped items folded by kind, and each report folded under its unit. That's the one GitHub Actions puts in the job summary and [`notify`](./configuration.md#notify) gets. A run from before `report.json` prints its `report.md`.

## Stats

`awaywork stats` adds up every run that kept a `units.json`, per rule (by its position in the queue in that run), skill and provider: the units, how many were done, failed or stopped, the share of the long quota window their workers used, and the PRs opened. `--json` prints the same totals.

- The quota share is an estimate. It starts at the quota read before the unit (the plan's probe, then the previous unit's last reading on that provider), includes any other use of the account meanwhile, and is `-` when the window reset mid-unit or the worker read no quota.
- It counts a chain's steps one by one, and only a chain's first step carries its PR, so the rows of the skills after it show no PRs.
- `units.json` is written when the run ends, so a run that is killed leaves none. Older runs without one are left out, as are the runs [`keep_runs`](./configuration.md#old-runs) removed.
