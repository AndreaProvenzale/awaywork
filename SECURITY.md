# Security

night-shift runs coding agents unattended with the developer's
credentials, so its guardrails are its most important feature
([docs/guide/safety.md](docs/guide/safety.md)).

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/AndreaProvenzale/night-shift/security/advisories/new),
not in a public issue. Especially:

- a way for the agent to reach a forge or tracker token, or to push,
  merge or comment itself;
- a push to a branch that already existed, or a force push;
- a credential written to disk, a log or a report where it shouldn't be;
- prompt injection from an item's content that escapes the harness.

Only the latest release is supported.
