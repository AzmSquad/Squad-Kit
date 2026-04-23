# Security Policy

## Supported versions

Only the latest minor release of squad-kit receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| 0.1.x   | ❌        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Email the maintainer privately at **momenysr@gmail.com** with:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept preferred).
- Affected version(s) and environment (OS, Node version).
- Any suggested mitigation, if you have one.

You can expect:

1. **Acknowledgement** within 72 hours.
2. **Initial assessment** within 7 days.
3. **Fix + coordinated disclosure** as quickly as the severity warrants — typically a patch release within 14 days for high-severity issues.

Credit will be given in the release notes unless you prefer to remain anonymous.

## Handling credentials

squad-kit reads API tokens from (in order):

1. **Environment variables** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `SQUAD_PLANNER_API_KEY` for planner; `JIRA_API_TOKEN`, `AZURE_DEVOPS_PAT`, `SQUAD_TRACKER_API_KEY` for trackers.
2. **`.squad/secrets.yaml`** — created with mode `0600` on POSIX; always included in `.gitignore` by `squad init`.
3. **Interactive prompt** — when the terminal is a TTY and the command needs a credential that is missing.

### Non-goals

- `.squad/config.yaml` must never contain secrets. Loading it with a key matching `apiKey`, `api_key`, `token`, `secret`, `credential`, or `credentials` raises a loud error.
- squad-kit does not integrate with OS keychains in 0.2.0. The secrets file model is intentional: it is inspectable, excluded by ignore rules, and portable.
- Credentials are never logged. Tracker error messages redact tokens; planner provider errors do the same.

## Scope

squad-kit is a local-only CLI. It can call **optional** network APIs (tracker fetch, direct planner) when the user enables those flows and provides credentials. It does not execute user code. Reports in scope include:

- Arbitrary file read/write outside the workspace caused by malformed input (e.g. path-traversal via feature slugs or intake paths).
- Command injection via clipboard helpers or spawned processes.
- Supply-chain concerns in shipped dependencies (`@inquirer/prompts`, `commander`, `fs-extra`, `js-yaml`, `kleur`).

Out of scope:

- Content of user-authored intakes and plans under `.squad/stories/` and `.squad/plans/` (treat as trusted project input to your agents).
- Vulnerabilities in the AI agents that consume squad-kit output (Claude Code, Cursor, Copilot, Gemini). Report those upstream.
