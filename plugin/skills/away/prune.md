# awaywork prune

Propose lines to delete or rewrite in what's already written down for agents, each with the evidence it checked, and edit only the lines the developer picks. Docs: https://andreaprovenzale.github.io/awaywork/guide/suggest.md#prune

It reads no sessions or memories, so it asks nothing first: go straight to the files. The [ground rules](SKILL.md#ground-rules) hold: no credentials, read freely, nothing written without their yes, real names only.

## 1. Read

The repo is the one you're in (`git rev-parse --show-toplevel`); not in one, ask which of the config's repos and where its clone is. Read, whole:

- the repo's root `AGENTS.md` and `CLAUDE.md`. A `CLAUDE.md` that only imports `@AGENTS.md` has no lines of its own;
- its `.awaywork/instructions.md`;
- the `instructions` files this repo's units get from the config `awaywork config path` prints, merged with the one its `extends` names, where a list replaces the base's: the top level's and the rules (the config's own, or the base's when it sets none), the repo's (the last `repos` key naming it that sets one, its own key after globs), and each rule's and step's. Each path is relative to the config that names it. Not a gate's: those are a judge's criteria.

A config not on this machine (`AWAYWORK_REMOTE`): its `instructions` files are in the control repo. Prune the repo's files and say so.

## 2. Test each line

A line is a bullet or a paragraph. Try the tests in this order and stop at the first that fits. Each finding names its evidence: a path, a script, a rule, a test, a config key. No evidence, no finding.

1. **Contradicted by the code:** it names a path, script or command that doesn't exist. Check the path in the tree, the script in `package.json`, `pyproject.toml` or the `Makefile`. Evidence: what's missing, e.g. "no `scripts/release.sh`". Delete, or rewrite to what the tree shows replaced it ("`package.json` has `release`").
2. **Enforced already:** a check does what the line asks. Name it: the lint rule on in the linter's config or the preset it extends (`biome.json`, `eslint.config.*`, `ruff`/`[tool.ruff]`, `.golangci.yml`, `.rubocop.yml`, clippy), the test that asserts it, `repos.<repo>.verify`, or the gate. The mistake has to be one the check catches: a linter being installed isn't enough. `verify` and gates run only in awaywork's chains, so they enforce a line in `.awaywork/instructions.md` or a config `instructions` file, for the units they run on, never an `AGENTS.md` or `CLAUDE.md` one, which the developer's own sessions read. Delete.
3. **Emphatic:** `IMPORTANT`, `MUST`, a word or a line in all caps, "never ever". A name or an acronym (`GH_TOKEN`, `API`) isn't emphasis. Evidence: the words, e.g. `IMPORTANT`, `MUST`. Rewrite: the same line, plain.
4. **Shown by the code, listings only:** the stack, a directory tree, an inventory of scripts or dependencies, which the manifest or the tree already says. Evidence: the file that says it. Delete.

A line saying when to run what ("run `pnpm format`; `pnpm lint` checks") fits neither test 2 nor test 4: neither a check nor the tree tells an agent when. It stays.

A config file can reach other repos too: the top level's reaches them all, a glob key's those it matches, a rule's or step's those its items come from. Tests 1, 2 and 4 take a line in it only when they hold in each repo it reaches; where you can't check one, only test 3 applies.

The tests are static: whether a line ever mattered isn't in the files, so one that fits no test stays.

## 3. Show and pick

Numbered, per file, each with the line as it is, the test, the evidence and the edit:

```text
Read AGENTS.md (38 lines), CLAUDE.md (imports AGENTS.md), .awaywork/instructions.md (5 lines),
and notes/acme-api.md from your config (repos.acme/api).

AGENTS.md
  1  "Release with scripts/release.sh."            contradicted by the code
     no scripts/release.sh; package.json has "release"
     → "Release with `pnpm release`."
  2  "Never use `any` in TypeScript."              enforced already
     biome.json: suspicious.noExplicitAny is "error"; `pnpm lint` runs biome
     → delete
  3  "IMPORTANT: you MUST NEVER push to main."     emphatic
     IMPORTANT, MUST, NEVER
     → "Never push to main."
  4  "Stack: Next.js, Prisma, Postgres, Tailwind." shown by the code
     package.json dependencies, prisma/schema.prisma
     → delete

notes/acme-api.md
  5  "Flag any change to migrations/ in the PR body."   enforced already
     gates.schema: changed ["**/migrations/**"] puts it on the PR's decision card
     → delete

Apply which? (e.g. 1, 3)
```

Nothing found: say so in one line. The developer accepts, tweaks or declines each.

## 4. Edit

On their yes, edit only the picked lines, in place: keep the rest of the file, its order and its style. It's a local change they commit themselves, in the repo or the control folder; never commit or push it. Nothing declined is written, and nothing is remembered: a declined line comes back next run.

## End

Summarize in a few lines what changed in which file, and that it's theirs to commit.
