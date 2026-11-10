---
description: The awaywork plugin for Claude Code, from installing it and letting /away set awaywork up in rounds of questions to the pane beside the chat with what needs you, what ran and your config, and the skill that writes your queue.
---

# `/away` in Claude Code

The awaywork plugin gives Claude Code the `/away` skill, which sets awaywork up with you and writes your queue, and a pane beside the chat with what needs you, what ran and your config.

## Install

```text
/plugin marketplace add AndreaProvenzale/awaywork
/plugin install awaywork@awaywork
/away
```

On Claude Code 2.1.275 or later, `/plugin install awaywork --marketplace AndreaProvenzale/awaywork` does the first two in one go.

Third-party marketplaces don't auto-update by default: `/plugin marketplace update awaywork` pulls the latest skill, or turn auto-update on under `/plugin` > Marketplaces.

`awaywork init` does all three from your shell: it offers the install, or on a no loads the package's plugin for that one session, and opens Claude Code on `/away set up awaywork`.

## Set up

No config yet? `/away`, bare or with anything after it, sets awaywork up with you, and writes the config only on your yes.

It asks `awaywork config path` where the config goes, and the CLI's answer is the only place it looks. With [`AWAYWORK_REMOTE`](./scheduling.md#from-your-laptop) set, that's the server's config, so there's nothing to set up. A pane opens beside the chat on its [Config tab](#the-config-tab), empty until the draft exists.

Then it looks around without asking:

- `awaywork doctor --json`, for your agent CLIs and `gh` login;
- every gh account and the orgs each one reaches;
- the login in each Claude Code folder (a shell function that switches `CLAUDE_CONFIG_DIR` counts);
- whether a job is already scheduled here;
- the folders your Claude Code and Codex sessions ran in over the last 30 days, with the MCP servers set up for each, from metadata and config alone, mapped to repos by their git remotes.

The rest comes in rounds of up to four multiple-choice questions, its pick first, every option built from what it found. The first round, renamed:

```text
←  ☐ Work  ☐ Claude login  ☐ Runs on  ✔ Submit  →

Whose GitHub work should this awaywork config take care of?

❯ 1. octocat (Recommended)
     Reaches octocat, widgets; ~215 sessions in these repos, mostly api (124) and site (41).
  2. octocat-acme
     Reaches acme; ~125 sessions across acme/app, acme/backend, acme/web and others.
  3. octocat-labs
     Reaches acme-labs; no sessions seen in those owners' repos.
  4. Type something.
```

One config is one account's work; the other gets its own setup later. The same round asks which Claude login runs it, each Claude Code folder with its account and plan (`$CLAUDE_CONFIG_DIR, Max 5x (Recommended)`, the one holding that work's sessions), and where it runs: this machine, GitHub Actions or a box with Docker. A machine that already runs an awaywork job isn't the default, and the option says why.

The next rounds ask:

- **Repos,** from your sessions. A remote that isn't github.com is never guessed: an ssh alias (`git@github-work:widgets/art`) waits until you name its repo, and a Bitbucket Cloud repo is left out, since the setup doesn't write a [Bitbucket source](./configuration.md#bitbucket-and-jira).
- **Tracker:** an MCP server pointing at one is a hint. Jira also needs your Cloud site, your Atlassian email and whether its API token is scoped.
- **Window:** 01:00–07:00 your time by default.
- **Providers,** with more than one ready: which takes units first, the next taking over when its quota runs out.
- **Your PRs:** fix red checks, or review threads, each a draft PR stacked on yours. Keeping them up to date with main is marked as a widening: it pushes a merge onto your PR, and a conflict is resolved by a model and waits for your review.
- **Review requests:** a report only you read, or your pending GitHub review, which widens what it writes.
- **Tracker cards:** QA notes fixed, in-progress cards implemented, the sprint's cards planned. For the sprint, a later round with your tracker's real names asks how: plan then implement across repos, waiting for you only when a judge finds a product decision the card leaves open; or wait on every plan; or just a plan report.
- **Learn from my sessions:** whether to [suggest](./suggest.md) more rules from your sessions. The option says what it would read first, and a yes is also suggest's consent for this run: `Reads 124 Claude Code sessions (233.7 MB) in the api folder plus memories and your global CLAUDE.md; it goes to Anthropic.`

Claude Code, which `awaywork init` opens, has the question tool. In an agent without one, each round comes as one numbered message instead, each question with its default, and you answer in your own words.

A tracker needs a token, and it never goes through the chat. The skill tells you to run `awaywork secret LINEAR_API_KEY`, which saves it in `~/.config/awaywork/env` (mode 600) and prints only that it did. In your own terminal it asks at a hidden prompt; in Claude Code, copy the token and type `! pbpaste | awaywork secret LINEAR_API_KEY`. Say done, and it reads your teams and statuses with `awaywork sources linear --json` and asks only which repo each team's code lives in.

The draft is `config.draft.yml` beside the config. `awaywork init --yes` renders it right after the round that picks repos and a window, so you watch it fill in on the Config tab, and then the skill edits in:

- your repos;
- the gh account and Claude login it runs on, pinned as `sources.github.user` and `config_dir` wherever a scheduled job wouldn't find them on its own ([Which login](./configuration.md#which-login));
- your tracker;
- the rules you picked, with your tracker's real status names.

`awaywork plan --rules --json` shows what each rule takes now. Nothing taken today doesn't make a rule wrong, so it shows the closest misses too. On your yes the draft becomes the config and `doctor` runs once:

```text
Rules (none takes anything today)
1. fix: your PRs with failing checks.
2. fix: your PRs with unresolved threads.
3. fix: your awaywork PRs with threads you started.
4. review: PRs where your review is requested, trusted authors.
5. implement: Linear NIG issues in In Progress.
6. plan: Linear NIG issues in Todo.

Commands for you to run (I never run these):
- awaywork plan previews the next run.
- awaywork run --unit <id> tries one unit.
- awaywork schedule install runs it in the window.
```

It left out the default `QA` rule, saying so: that team has no `QA` status. It runs none of those commands itself. `/exit` drops you back in your shell.

## The pane

With a config, bare `/away` opens a pane beside the chat, straight from `awaywork report --json`: what needs you, what ran, what's next.

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

It lands on the first tab with something in it, or on [Config](#the-config-tab) while a draft is waiting. Next run stays empty until you press `p`: `awaywork plan` probes your quota (one Haiku call) and reads your forge, so it waits to be asked.

### Cards

A tab is a strip of cards, a page at a time, under their repo, or their tracker and project key. Needs you lists a repo's cards by what they ask of you, so the PRs to review sit together.

- A Needs you card shows what it asks: `◉` review, `?` answer, `◆` approve in yellow, `⚑` stuck in red, `✓` close a finished card in green.
- A Last run card starts with how it ended (`✓`, `✗`, `■` for stopped) and keeps the skill on the right.
- Elsewhere the card says why the item waits (`no rule`, `over cap`, `skipped by you`, ...).

The line above the strip says whose card you're on and where (`acme/shop  1/14`). Under the strip sit the card's buttons, and under the rule its detail: the title, the whole reason and the link.

Every part keeps its height, so nothing jumps while you browse. The wheel over the cards steps through them; anywhere else it scrolls the detail. A pane too short for all that (a small window, or the pane above the prompt outside fullscreen) drops the fixed heights and scrolls as a whole.

### Keys

| Key | Does |
| --- | --- |
| `1`–`5` | switch tab |
| `r` | read the last run again, and nothing else; on Config, what each rule takes |
| `p` | plan the next run, for Next run |
| `h` `l` | previous, next card |
| `o` | open the card's PR, issue or tracker item, named for the job when that's it (`review PR`, `answer question`) |
| `s` | skip the item in the coming runs, or unskip one you skipped |
| `a` | `approve`: approve the plan or result the item waits on, replying `approve` on it |
| `g` | `run now`: start the item in the background, with `awaywork run --unit <source:key> --detach` |
| `v` | `view report`: a last-run unit's `awaywork report <run> --unit <id>`, in the detail |
| `c` | `ask Claude`: put the card in the prompt box |
| `y` `n` | answer the question `s`, `a` or `g` asked |
| `b` | back, from a report or the skill list |

A card shows only the buttons it has. When the fix is elsewhere, like `add repo`, the detail says it first, and `o` just opens the item.

The pane has the keyboard when it opens, so `h` and `l` step card to card. Click a card and the strip takes every key: ←/→ (or Tab) move at once, ↑/↓ scroll the detail and the letters still press their buttons, until Esc hands the keyboard back to the prompt. That's how the desktop app gets keys too, where the prompt keeps them otherwise. In VS Code, click a card's ref to pick it; `h` and `l` work there too.

### What the buttons do

`s`, `a` and `g` ask first, in place of the buttons, saying what they'll do and whether there's an undo: `skip #101 in the coming runs? awaywork unskip undoes it`, `Run #109 now with fix? Draft PR, uses your quota.` On `y` the card shows `skipped`, `unskipped`, `approved` or `started` in place of its symbol. The cards are what the last run or `p` saw, so the next `p` is what shows the change.

`g` is on Next run's cards and on the skips only the schedule was holding: `unchanged`, `skipped by you`, `over cap`, `gave up`. It's the only thing here that starts a run, and only on your press; the pane schedules nothing. A `g` that can't start, the run lock taken or no provider for it, says why in the status line and leaves the card as it was.

On a card no rule takes (`no rule`), `g` first lists the skills from `awaywork skills list --json`, so one only a repo carries isn't among them. `g` again takes the first, `fix` on a PR and `implement` on anything else, a digit another, `b` goes back. It then asks the same question and starts it with [`--skill`](./skills.md#run-one-on-an-item-no-rule-takes).

`c` leaves the rest to you: `About awaywork item github:acme/shop#7 "Retry webhooks on 5xx" (waiting for review): `, or on a last-run unit the line that carries on from `awaywork report <run> --unit <id>`. Nothing's sent until you press Enter, and whatever you'd typed stays. If you clicked a card first, Esc hands the keyboard to the box.

For the full why of an item, quota probe and all, ask `/away why didn't <key> run?`, which runs `plan --why`.

No `awaywork` on your `PATH`, or one too old for `--json` or `config explain`, and the pane says so, with `npm i -g awaywork@latest`. Under `claude -p`, where nothing draws a pane, bare `/away` goes to the skill instead.

### The Config tab

Tab 5 is your config the way it reads to a human: the draft while there is one, else the file. No config yet, or a `config.draft.yml` waiting, and the pane lands here, with this as its only tab until the config exists. A config behind [`AWAYWORK_REMOTE`](./scheduling.md#from-your-laptop) isn't on this machine, so there's no tab for it, just the run tabs.

```text
☾ awaywork · last run 01:00 · 9 PRs · 14 need you
r: refresh p: plan
1: Needs you (14)  2: Last run (12)  3: Next run
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

Takes now
acme/shop#42  Coupon codes with per-customer limits

↑↓ rule  c: ask Claude  o: open config.yml:11
```

Each rule is one row: what it takes, in words, and what it does. `· 2` is what it takes right now, from a `plan --rules` in the background, which reads your sources and no quota. `◆` means the rule can stop for you: a plan that waits, `wait: true`, or a gate. Every skill keeps one color, the same on the Last run and Next run cards; a card too narrow for the skill and a readable ref drops the skill.

| Key | Does |
| --- | --- |
| ↑ ↓ | move between rules and redraw the flow under the table, loops included; `j` `k` in the desktop app, or click a rule's number |
| `f` `y` `d` | the flow, the YAML, or the last write's diff |
| `c` | ask Claude about the rule |
| `o` | open the rule at its line in VS Code, or the file if `code` isn't around |

In the desktop app arrows only nudge the pane's scrollbar, hence `j` and `k`. A pane too short for it all lets the wheel and the page keys scroll it, and the arrows still step and bring the rule back into view. A draft that doesn't validate keeps the last good drawing, its problems on top.

There's no polling: the plugin watches the config's folder, and the chat's own writes to the draft land right away. That's why it runs `awaywork config path` at session start, with `mkdir -p` on that folder only when there's no config yet, so a first setup's files have somewhere to appear. A control folder picked during setup gets followed the moment Claude writes the draft there.

## The skill

`/away` with anything after it goes to the skill; `/awaywork:away` works the same, for when another command already has the name. Say what you want in your own words, or ask about an item: `/away fix my PRs when CI goes red`, `/away why didn't acme/api#12 run last night?`. The skill:

- reads your config and learns real names with `awaywork sources --json`, so a section is spelled the way Asana spells it;
- drafts rules on a copy beside your config and runs `awaywork plan --rules --json` on it, showing you the items each rule takes now, the ones another rule takes first, and the near misses with the condition they failed;
- asks before writing, and on your yes writes the rules into your config, keeping your comments and layout, then runs `awaywork doctor --json`;
- starts a tweak from the item, with `awaywork plan --why <key>`, and shows the before and after.

What it won't do:

- see a token: you put one in with `awaywork secret <NAME>`, and `~/.config/awaywork/env` is off limits;
- start a run or install a schedule: it gives you the commands;
- skip, unskip or approve an item without asking;
- turn on anything that lets awaywork write more, like `deliver: push`, `deliver: pr`, `on_done` or dropping `trusted`, without showing you the rule before and after.

Nothing reaches your config without your yes in that session, a change you asked for by name included; a widening you didn't ask for gets its own question.

Not sure what to hand over? `/away what could you take off my plate?` reads your recent agent sessions and PRs, with your say-so every time, and proposes the rules, routines and `AGENTS.md` lines for the work you already do by reflex, each checked on your real items: [Suggested rules](./suggest.md). The skill offers it once, on a first setup.

Asked to "fix my PRs when CI goes red, and implement my issues labelled skill-smoke" on a test repo, it ran `sources` and tried the rules on a draft. It hit `labels` (that's Linear's and Jira's field; GitHub's is `label`), fixed it from the config error, wrote the two rules under the existing one and ended with, trimmed:

```text
I added two rules to your queue and kept your existing review rule as rule 1. The config
passes `awaywork doctor`, and `plan --rules` on the real config takes the same items the
draft did.

| # | Rule                                                   | Takes now      |
|---|--------------------------------------------------------|----------------|
| 1 | review: PRs where your review is requested (unchanged) | nothing        |
| 2 | fix: your PRs with failing checks                      | nothing        |
| 3 | implement: your issues labelled `skill-smoke`          | `acme/api#133` |

- Rule 2 is unproven. None of your PRs has red CI right now, so the rule takes nothing
  today. It will start taking PRs the next time CI goes red on one.
- Both new rules only open draft PRs. I left `deliver` unset. If you'd rather it push onto
  the branch, add `deliver: push` to rule 2, but that lets awaywork write more, so it needs
  your explicit yes.

To try it:
- `awaywork plan` previews the next run.
- `awaywork run --unit <id>` runs one unit, for example #133.
- `awaywork schedule install` sets up the schedule, if nothing is scheduled yet.
```
