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

### Anthropic subscription credentials (0.12.0+)

The Anthropic planner can authenticate with a Claude subscription instead of an API key. That path resolves, in order: **`CLAUDE_CODE_OAUTH_TOKEN`** → **`planner.anthropicOauthToken` in `.squad/secrets.yaml`** → the **OS credential store** managed by Claude Code.

- The OAuth token is a credential and is treated as one: it lives in `.squad/secrets.yaml` only (git-ignored, `0600` on POSIX), is masked everywhere it is displayed, and is rejected by name if it appears in `.squad/config.yaml`.
- squad-kit **never reads** the OS credential store. It checks only whether an entry **exists** (on macOS via `security find-generic-password -s "Claude Code-credentials"`, never `-w` / `-g`) and leaves the reading to the Claude Agent SDK.
- In subscription mode, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are **removed from the planner subprocess environment** (case-insensitively). Both outrank the subscription credential inside Claude Code, so an inherited one would silently redirect usage to API billing. The parent shell is not modified.
- `squad auth logout` removes **only** the token squad-kit stored. It never deletes the user's global Claude Code credential.
- Persisted run records (`.squad/runs/*.json`, `*.events.jsonl`) carry the resolved auth **mode** and `apiKeySource` only — never a token, key, email, or organization. Account details are fetched live for display and never written to disk.

### Non-goals

- `.squad/config.yaml` must never contain secrets. Loading it with a key whose lowercased name is exactly `apikey`, `api_key`, `token`, `oauthtoken`, `anthropicoauthtoken`, `secret`, `credential`, or `credentials` raises a loud error. Matching is exact rather than substring so that legitimate keys such as `planner.maxOutputTokens` keep loading; new credential-shaped keys must be added to that list by name.
- squad-kit does not **store** credentials in an OS keychain. It will detect and use a Claude Code login held in one (see above), but its own secrets model remains the `.squad/secrets.yaml` file: inspectable, excluded by ignore rules, and portable.
- Credentials are never logged. Tracker error messages redact tokens; planner provider errors do the same.

### Known limitation — enterprise managed settings

squad-kit runs the Agent SDK with `settingSources: []`, which prevents it from reading user, project, and local settings files. An ordinary user-level `apiKeyHelper` therefore cannot redirect a subscription run. **Policy settings are always merged regardless**, so an enterprise **managed-settings** `apiKeyHelper` deployed by MDM is still honoured and still outranks the login credential. On a managed device, `planner.auth.anthropic: subscription` may resolve through the organization's helper. This was established by reading the credential resolver in the bundled `claude` binary, not by testing on a live managed device. `squad auth status` reports the `apiKeySource` the SDK actually resolved.

## Scope

squad-kit is a local-only CLI. It can call **optional** network APIs (tracker fetch, direct planner) when the user enables those flows and provides credentials. It does not execute user code. Reports in scope include:

- Arbitrary file read/write outside the workspace caused by malformed input (e.g. path-traversal via feature slugs or intake paths).
- Command injection via clipboard helpers or spawned processes.
- Supply-chain concerns in shipped dependencies (`@inquirer/prompts`, `commander`, `fs-extra`, `js-yaml`, `kleur`).

Out of scope:

- Content of user-authored intakes and plans under `.squad/stories/` and `.squad/plans/` (treat as trusted project input to your agents).
- Vulnerabilities in the AI agents that consume squad-kit output (Claude Code, Cursor, Copilot, Gemini). Report those upstream.
