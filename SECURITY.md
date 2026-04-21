# Security Policy

## Supported versions

Only the latest minor release of squad-kit receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
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

## Scope

squad-kit is a local-only CLI — it does not make network requests, does not read credentials, and does not execute user code. Reports in scope include:

- Arbitrary file read/write outside the workspace caused by malformed input (e.g. path-traversal via feature slugs or intake paths).
- Command injection via clipboard helpers or spawned processes.
- Supply-chain concerns in shipped dependencies (`@inquirer/prompts`, `commander`, `fs-extra`, `js-yaml`, `kleur`).

Out of scope:

- Issues in user-authored prompts (`.squad/prompts/*.md`). Those are project artifacts you own.
- Vulnerabilities in the AI agents that consume squad-kit output (Claude Code, Cursor, Copilot, Gemini). Report those upstream.
