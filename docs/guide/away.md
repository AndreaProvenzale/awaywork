---
description: The awaywork plugin for Claude Code, from installing it and letting /away set awaywork up in rounds of questions to the pane beside the chat with what needs you, what ran and your config, and the skill that writes your queue.
---

# `/away` in Claude Code

The awaywork plugin adds the `/away` skill to Claude Code, which sets awaywork up and writes your queue, and a pane beside the chat: what needs you, what ran, your config.

## Install

```text
/plugin marketplace add AndreaProvenzale/awaywork
/plugin install awaywork@awaywork
/away
```

- On Claude Code 2.1.275 or later, `/plugin install awaywork --marketplace AndreaProvenzale/awaywork` does the first two.
- Third-party marketplaces don't auto-update by default: run `/plugin marketplace update awaywork`, or turn auto-update on under `/plugin` > Marketplaces.
- `awaywork init` does it all from your shell: see [Getting started](./getting-started.md#configure).

## Set up

With no config, `/away` sets awaywork up with you, whatever follows it, and writes the config only on your yes.

It asks `awaywork config path` where the config goes and looks nowhere else. With [`AWAYWORK_REMOTE`](./scheduling.md#from-your-laptop) set that's the server's config, so there's nothing to set up.

First it looks around, without asking:

- `awaywork doctor --json`: your agent CLIs and `gh` login;
- each gh account and the orgs it reaches;
- the login in each Claude Code folder (a shell function switching `CLAUDE_CONFIG_DIR` counts);
- whether a job is already scheduled here;
- the folders your Claude Code and Codex sessions used in the last 30 days, with their MCP servers, mapped to repos by git remote (metadata and config only).

### The rounds

Then come rounds of up to four multiple-choice questions, its pick first, each option built from what it found, or type your own answer. The first round, renamed:

```text
←  ☐ Work  ☐ Claude login  ☐ Runs on  ✔ Submit  →

Whose GitHub work should this awaywork config take care of?

❯ 1. octocat (Recommended)
     Reaches octocat, widgets; ~215 sessions in these repos, mostly api (124) and site (41).
  2. octocat-acme
     Reaches acme; ~125 sessions across acme/app, acme/backend, acme/web and others.
  [...]
```

One config covers one account's work; another account gets its own setup later. This round also asks which Claude login runs it (each Claude Code folder with its account and plan, the one holding that work's sessions recommended) and where: this machine, GitHub Actions or a box with Docker. A machine already running an awaywork job isn't the default, and says why.

The next rounds:

- **Repos,** from your sessions. Remotes off github.com are never guessed: an ssh alias (`git@github-work:widgets/art`) waits for you to name its repo, and Bitbucket Cloud is left out (setup writes no [Bitbucket source](./configuration.md#bitbucket-and-jira)).
- **Tracker:** an MCP server for one is a hint. Jira also needs your Cloud site, Atlassian email and whether the API token is scoped.
- **Window:** 01:00–07:00 your time by default.
- **Providers,** if several are ready: which goes first; the next takes over when its quota runs out.
- **Your PRs:** fix red checks or review threads (awaywork's own drafts included), as draft PRs stacked on yours. Keeping them up to date with main is flagged as a widening: it pushes merges onto your PR, and a model resolves a conflict, which waits for your review.
- **Review requests:** a report only you read, or your pending GitHub review, a widening.
- **Tracker cards:** fix QA notes, implement in-progress cards, plan the sprint. A later round asks how to plan, in your tracker's names: plan then implement across repos, stopping only when a judge finds a product decision the card leaves open; wait on every plan; or plan reports only.
- **Learn from my sessions:** whether to [suggest](./suggest.md) more rules. The option says what it would read and where that goes, and a yes is also suggest's consent for this run.

Without a question tool (Claude Code, which `init` opens, has one), each round is one numbered message, each question with its default, answered in your own words.

### Tokens

Tokens never go through the chat. You run `awaywork secret LINEAR_API_KEY` (in Claude Code, `! pbpaste | awaywork secret LINEAR_API_KEY` after copying it), which saves it to `~/.config/awaywork/env` and prints only that it did. The skill then reads your teams and statuses (`awaywork sources linear --json`) and asks only which repo each team's code is in.

### The draft

`awaywork init --yes` renders the draft, `config.draft.yml` beside the config, after the round that picks repos and a window. The skill then edits in your repos, your tracker, the rules you picked with real status names, and the gh account and Claude login, pinned as `sources.github.user` and `config_dir` where a scheduled job wouldn't find them ([Which login](./configuration.md#which-login)). It fills in on the Config tab as you watch.

`awaywork plan --rules --json` shows what each rule takes now and the closest misses, since taking nothing today doesn't make a rule wrong. On your yes the draft becomes the config and `doctor` runs once:

```text
Rules (none takes anything today)
1. fix: your PRs with failing checks.
2. fix: your PRs with unresolved threads.
3. fix: your awaywork PRs with threads you started.
4. review: PRs where your review is requested, trusted authors.
5. implement: Linear NIG issues in In Progress.
6. plan: Linear NIG issues in Todo.

Commands for you to run (I never run these):
[...]
```

It left out the default `QA` rule, saying why: that team has no `QA` status. `/exit` drops you back in your shell.

## The pane

With a config, bare `/away` opens the pane, read from `awaywork report --json`:

```text
☾ awaywork · last run 01:00 · 9 PRs · 14 need you
r: refresh p: plan
1: Needs you (14)  2: Last run (12)  3: Next run
4: Skipped (30)
──────────────────────────────────────────────────────────────
acme/shop  1/14                                      h: ‹ l: ›
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ ╭────────────────────────────╮
┃ #101                     ◉ ┃ │ #109                     ◆ │
┃ Coupon codes with          ┃ │ Split the checkout service │
┃ per-customer limits        ┃ │                            │
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ╰────────────────────────────╯
o: review PR  s: skip

──────────────────────────────────────────────────────────────
Coupon codes with per-customer limits
waiting for review: awaywork PR is open
https://github.com/acme/shop/pull/401
```

It opens on the first tab with something in it. Next run stays empty until you press `p`: `awaywork plan` probes your quota (one Haiku call) and reads your forge.

### Cards

Each tab is a strip of cards, a page at a time, under their repo or tracker and project key. Above the strip is where you are (`acme/shop  1/14`); below it the card's buttons, then its detail: title, whole reason, link.

- A Needs you card shows what it asks: `◉` review, `?` answer, `◆` approve in yellow, `⚑` stuck in red, `✓` close a finished card in green. A repo's cards sort by that, so PRs to review sit together.
- A Last run card starts with how it ended (`✓`, `✗`, `■` stopped), the skill on the right.
- Elsewhere a card says why the item waits (`no rule`, `over cap`, `skipped by you`, ...).

Heights stay fixed while you browse; a pane too short for that (a small window, or above the prompt outside fullscreen) scrolls as a whole. Over the strip the wheel steps through cards, elsewhere it scrolls the detail.

### Keys

| Key | Does |
| --- | --- |
| `1`–`5` | switch tab |
| `r` | read the last run again, nothing else; on Config, what each rule takes |
| `p` | plan the next run |
| `h` `l` | previous, next card |
| `o` | open the PR, issue or tracker item, named for the job when it is one (`review PR`, `answer question`) |
| `s` | skip the item in the coming runs, or unskip it |
| `a` | `approve` the plan or result it waits on, replying `approve` there |
| `g` | `run now`: `awaywork run --unit <source:key> --detach` |
| `v` | `view report`: `awaywork report <run> --unit <id>` in the detail |
| `c` | `ask Claude`: put the card in the prompt box |
| `y` `n` | answer what `s`, `a` or `g` asked |
| `b` | back, from a report or the skill list |

A card shows only its own buttons. When the fix is elsewhere (`add repo`), the detail says so and `o` just opens the item.

The pane has the keyboard when it opens. Click a card and the strip takes every key (←/→ or Tab move, ↑/↓ scroll the detail, letters press buttons) until Esc hands it back to the prompt. That's how the desktop app gets keys at all. In VS Code, click a card's ref to pick it; `h` and `l` work there too.

### What the buttons do

- **`s`, `a` and `g` ask first,** saying what they'll do and whether there's an undo: `skip #101 in the coming runs? awaywork unskip undoes it`, `Run #109 now with fix? Draft PR, uses your quota.` On `y` the card shows `skipped`, `unskipped`, `approved` or `started`. Cards are what the last run or `p` saw; the next `p` shows the change.
- **`g` alone starts a run,** on your press; the pane schedules nothing. It's on Next run's cards and on skips only the schedule holds: `unchanged`, `skipped by you`, `over cap`, `gave up`. If it can't start (run lock taken, no provider), the status line says why.
- **On a `no rule` card `g` lists skills first,** from `awaywork skills list --json`, so a repo's own skill isn't there. `g` again takes the first (`fix` on a PR, else `implement`), a digit another, `b` backs out; then it asks and runs [`--skill`](./skills.md#run-one-on-an-item-no-rule-takes).
- **`c` leaves the rest to you:** it types `About awaywork item github:acme/shop#7 "Retry webhooks on 5xx" (waiting for review): `, or on a last-run unit the line that carries on from `awaywork report <run> --unit <id>`. Nothing is sent before Enter, and what you'd typed stays. After clicking a card, Esc hands the keyboard to the box.

Also:

- An item's full why, quota probe and all: ask `/away why didn't <key> run?`, which runs `plan --why`.
- No `awaywork` on your `PATH`, or one too old for `--json` or `config explain`: the pane says so, with `npm i -g awaywork@latest`.
- Under `claude -p`, where nothing draws a pane, bare `/away` goes to the skill.

### The Config tab

Tab 5 is your config as it reads to a human: the draft while there is one, else the file. With no config yet (the tab stays blank until the draft is written), or a draft waiting, the pane opens here, and it's the only tab until a config exists. A config behind [`AWAYWORK_REMOTE`](./scheduling.md#from-your-laptop) isn't on this machine, so it gets no tab.

```text
[...]
4: Skipped (30)  5: Config
──────────────────────────────────────────────────────────────
config.yml  ✓ valid                           f: flow  y: YAML
01:00–07:00 · claude · github · keeps 10% in reserve

    TAKES                                DOES
 1  my PRs, checks failing · 2           fix ▶ draft PR
 2  my PRs, your open threads            fix ▶ draft PR
 3  PRs, review requested, from tru… · 1 review ▶ report
▸4  issues, label sprint · 1             plan ▶ ◆ plan
 5  planned tasks                        implement ▶ draft PR

4. issues, label sprint
plan ▶ ◆ plan ▶ rule 5

↑↓ rule  c: ask Claude  o: open config.yml:11
```

One row per rule: what it takes and what it does. `· 2` is how many items it takes now, from a background `plan --rules` (sources only, no quota). Below the flow, the selected rule lists the items it takes now and those another rule takes first. `◆` marks a rule that can stop for you: a plan that waits, `wait: true`, or a gate. Each skill keeps one color, on the run cards too; a card too narrow for the skill and a readable ref drops the skill.

| Key | Does |
| --- | --- |
| ↑ ↓ | move between rules and redraw the flow below, loops included; `j` `k` in the desktop app, or click a rule's number |
| `f` `y` `d` | the flow, the YAML, or the last write's diff |
| `c` | ask Claude about the rule |
| `o` | open the rule at its line in VS Code, or the file without `code` |

- In the desktop app arrows only nudge the pane's scrollbar, hence `j` and `k`.
- In a pane too short, the wheel and page keys scroll; arrows still step and bring the rule into view.
- A draft that doesn't validate keeps the last good drawing, its problems on top.
- No polling: the plugin watches the config's folder, found with `awaywork config path` at session start (and made with `mkdir -p` when there's no config yet), so the chat's writes show at once. A control folder picked during setup is followed once Claude writes the draft there.

## The skill

`/away` with anything after it goes to the skill (`/awaywork:away` too, when another command has the name). Ask in your own words: `/away fix my PRs when CI goes red`, `/away why didn't acme/api#12 run last night?`. It:

- reads your config and real names from `awaywork sources --json`, so a section is spelled as Asana spells it;
- drafts rules on a copy and runs `awaywork plan --rules --json` on it: what each rule takes, what another rule takes first, and near misses with the condition they failed;
- on your yes writes them, keeping your comments and layout, and runs `awaywork doctor --json`;
- starts a tweak from the item (`awaywork plan --why <key>`) and shows before and after.

It won't:

- see a token: you run `awaywork secret <NAME>`, and `~/.config/awaywork/env` is off limits;
- start a run or install a schedule: it gives you the commands;
- skip, unskip or approve without asking;
- let awaywork write more (`deliver: push`, `deliver: pr`, `on_done`, dropping `trusted`) without showing the rule before and after.

Nothing reaches your config without your yes in that session, even a change you named; a widening you didn't ask for gets its own question.

Not sure what to hand over? `/away what could you take off my plate?` reads your recent sessions and PRs, with your say-so each time, and proposes rules, routines and `AGENTS.md` lines for work you do by reflex, each checked on your real items: [Suggested rules](./suggest.md). Setup offers it once.
