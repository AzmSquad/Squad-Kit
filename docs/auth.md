---
title: Anthropic authentication
description: Plan on your Claude subscription instead of an API key — logins, precedence, CI, usage limits, and troubleshooting.
---

From **0.12.0**, the direct planner can authenticate with Anthropic in two ways:

- **Subscription** — the Claude login you already have (Pro, Max, or Team/Enterprise). No API key. No per-token API bill.
- **API key** — `ANTHROPIC_API_KEY` / `.squad/secrets.yaml`, exactly as in 0.11.0 and earlier.

OpenAI and Google are unchanged and remain **API-key only**. `planner.auth` is a per-provider map, but 0.12.0 populates `anthropic` alone.

> **Not free, and not unlimited.** Subscription planning replaces a per-token API invoice with your Claude plan's **usage limits**. See [Usage limits](#usage-limits) before you switch a team over.

## The short version

```bash
squad auth login          # browser flow, stores a token, sets auth: subscription
squad auth status         # what resolved, and which account it belongs to
squad new-plan --api      # plans on your Claude plan, no ANTHROPIC_API_KEY anywhere
```

## Choosing a mode

`planner.auth.anthropic` in `.squad/config.yaml` takes three values. The merged default — what you get when the key is absent entirely — is **`auto`**.

| Value | Behaviour |
| --- | --- |
| `subscription` | Always use the Claude login. Never reads an API key. Fails at run time with a `squad auth login` hint if no login works. |
| `api-key` | Always use an API key. Identical to 0.11.0 behaviour. Fails if no key resolves. |
| `auto` (default) | Prefer a detected Claude login; fall back to a resolvable API key; otherwise fail naming **both** recovery paths. |

```yaml
planner:
  enabled: true
  provider: anthropic
  auth:
    anthropic: subscription
```

`squad init` writes `subscription` explicitly for new workspaces. Existing workspaces that never had the key merge to `auto`.

> **Upgrade note.** Under `auto`, a Claude login **outranks** a stored API key. If you upgraded a working 0.11.0 API-key workspace on a machine that also has a Claude Code login, planning now runs on the subscription. Nothing errors, and `squad doctor` says so out loud — the `planner auth mode` row reads `… · ignoring the API key from .squad/secrets.yaml`. To keep billing on API credits, set `planner.auth.anthropic: api-key`.

## The two login paths

### 1. `squad auth login` — squad-kit stores a token

```bash
squad auth login
```

Runs the Anthropic browser authorization flow (via `claude setup-token`, using the `claude` binary the Agent SDK already ships — a separate Claude Code install is never required), captures the resulting OAuth token, and writes it to **`.squad/secrets.yaml`** under `planner.anthropicOauthToken`. If the workspace has a planner block it also sets `planner.auth.anthropic: subscription` in `.squad/config.yaml`; if the planner is not configured yet it says so and points at `squad config set planner`. Finally it verifies the login and prints the account.

Pick this when the credential should be **scoped to this workspace**, or when you are on a machine where the OS credential store is awkward (containers, remote shells, CI images).

Flags:

| Flag | What it does |
| --- | --- |
| `--token <value>` | Consume a `claude setup-token` value you already have. Skips the browser entirely. |
| `--print-only` | Run the browser flow, print the token to **stdout**, store nothing and change no config. Works outside a `.squad/` workspace. |
| `-y`, `--yes` | Overwrite an already-stored token without confirming. |

`--token` and `--print-only` are mutually exclusive.

The token is shape-checked before it is stored: it must be a single line, and a value that starts with `sk-ant-` but not `sk-ant-oat` is rejected as "that looks like an API key, use `squad config set planner`".

### 2. `claude` + `/login` — the OS credential store

```bash
claude          # then type /login
```

This is Claude Code's own login. squad-kit stores nothing; under `auth: subscription` (or `auto`) it detects the credential and lets the Agent SDK read it.

Pick this when you would rather **not have a token on disk in your repo's `.squad/`**, or when you are already signed in to Claude Code and want squad-kit to reuse it. It is the path `squad auth login` itself suggests as an alternative.

### Where those credentials live

squad-kit never reads the OS credential store — it only checks whether one **exists**, and lets the Agent SDK do the reading.

| Platform | Location |
| --- | --- |
| macOS | Keychain, generic password under the service name **`Claude Code-credentials`**. squad-kit probes existence with `security find-generic-password -s "Claude Code-credentials"` and never `-w` / `-g`. |
| Linux | `~/.claude/.credentials.json`, mode `0600`. |
| Windows | `%USERPROFILE%\.claude\.credentials.json`. |
| Any | `CLAUDE_CONFIG_DIR` relocates the `.claude` directory; squad-kit honours it (relative paths are resolved against the cwd). |

Tokens squad-kit itself stored live in **`.squad/secrets.yaml`** (git-ignored, `0600` on POSIX) under `planner.anthropicOauthToken`. That key is **rejected in `config.yaml`** — the loader refuses to load a config file containing it and tells you to move it.

## Precedence

Two orderings matter, and they are not the same thing.

### What squad-kit picks

`resolvePlannerAuth()` in `src/core/planner-auth.ts` decides the **mode**, then the **credential**:

1. `planner.auth.anthropic: api-key` → the API key chain (`ANTHROPIC_API_KEY` → `SQUAD_PLANNER_API_KEY` → `.squad/secrets.yaml`). Fails if nothing resolves.
2. `planner.auth.anthropic: subscription` → the login, in this order:
   1. `CLAUDE_CODE_OAUTH_TOKEN` in the environment
   2. `planner.anthropicOauthToken` in `.squad/secrets.yaml`
   3. the OS credential store (Keychain / `.credentials.json`)
   Deliberately never fails at resolution time — the Agent SDK is the authority on whether the login works, and a stale local probe must not block a user who is genuinely signed in.
3. `planner.auth.anthropic: auto` → a detected login (same three sources) if present, otherwise the API key chain, otherwise fail naming both recovery paths.

Because `CLAUDE_CODE_OAUTH_TOKEN` sits above the stored token, `squad auth login` warns you when it is exported: the stored token is ignored until you unset it.

### What Claude Code does with it — and why the key is cleared

Inside the Agent SDK subprocess, Anthropic's own credential precedence puts `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` **above** the `/login` subscription credential. A developer with `ANTHROPIC_API_KEY` exported would therefore be silently billed against API credits on every "subscription" run.

So in subscription mode squad-kit **removes both variables from the planner subprocess environment**:

```
ANTHROPIC_API_KEY      → deleted
ANTHROPIC_AUTH_TOKEN   → deleted
```

Matching is **case-insensitive**, because a `{...process.env}` copy is a plain JavaScript object and would otherwise miss `Anthropic_Api_Key` on Windows. Your shell is untouched — this only affects the child process squad-kit spawns. `SQUAD_PLANNER_API_KEY` is left alone: it is squad-kit's own variable and the SDK never reads it.

If you have a key exported and wondered why it is being ignored: this is why. Set `planner.auth.anthropic: api-key` to use it.

In **api-key** mode nothing is cleared; `ANTHROPIC_API_KEY` is set to the resolved key, exactly as in 0.11.0.

## CI and headless machines

There is no browser in CI, and `squad auth login` refuses to pretend otherwise:

> A browser login needs a terminal. Generate a token elsewhere with `claude setup-token` and pass it with `squad auth login --token <value>`, or set `CLAUDE_CODE_OAUTH_TOKEN`.

The guard runs **before** anything is spawned, so a non-TTY run never launches a flow nothing can complete.

Two supported patterns:

```bash
# A — inject the token as an environment variable (nothing on disk)
export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN"   # from your secret store
squad new-plan --api

# B — store it into the workspace once, non-interactively
squad auth login --token "$CLAUDE_TOKEN" -y
```

Generate the token on a machine that *does* have a browser:

```bash
squad auth login --print-only     # prints the token, stores nothing, changes no config
# or, without squad-kit:
claude setup-token
```

`--print-only` writes the token to **stdout** and everything else to stderr, so `squad auth login --print-only 2>/dev/null` is pipeable.

`squad auth status --json --offline` never spawns a subprocess, which makes it safe as a CI assertion:

```bash
squad auth status --json --offline | jq -e '.mode == "subscription"'
```

The JSON payload is a stable shape and never carries the token or the key:

```json
{
  "mode": "subscription",
  "reason": "auto — Claude login detected",
  "credentialHint": "Claude login (macOS Keychain)",
  "runtime": "agent-sdk",
  "loggedIn": true,
  "account": { "email": "…", "organization": "…", "subscriptionType": "…" },
  "apiKeySource": "oauth"
}
```

Without `--offline`, `status` runs one live Agent SDK check to fill in `account`. That probe is also skipped automatically when `CI=true` / `CI=1` or `GITHUB_ACTIONS` is set — the same guard `squad doctor` uses.

## Usage limits

Read this before moving a team onto subscription planning.

Per Anthropic's support article, [**Use the Claude Agent SDK with your Claude plan**](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):

- Usage through the **Agent SDK**, `claude -p`, and third-party applications **draws on your Claude subscription's usage limits** — the same limits Claude and Claude Code consume.
- The separately announced **monthly SDK credit is not currently available**.

What that means in practice:

- The honest claim is **"no per-token API bill"**, not "free" and not "unlimited". You are spending an allowance you already pay for.
- A planning run is not small. Opus, extended thinking, and a multi-turn tool loop over a real repo is a meaningful chunk of a window. On **Claude Pro** you will notice the window draining noticeably faster than on **Max** — Pro users planning large stories with Opus should expect to hit the ceiling within a handful of runs, where Max absorbs the same work comfortably.
- Cheaper levers, if you are hitting the ceiling: keep prompt caching on (the default), leave the scout stage enabled so the draft model starts warm, tighten `planner.budget`, or set `planner.modelOverride.anthropic` to Sonnet for routine stories.

### What hitting the limit looks like

The run fails with a mapped message rather than a raw provider error:

> Claude subscription usage limit reached. Planning draws on the same limits as Claude and Claude Code — wait for your usage window to reset, or switch to an API key for this run with `squad config set planner`.

In the console's Generate page the same state renders as **"Claude usage limit reached"** with a countdown ring, not as a provider API rate limit.

The fixes are exactly two: **wait for the window to reset**, or **switch to an API key** (`planner.auth.anthropic: api-key` plus a resolvable key). There is no third option, and squad-kit will not offer one.

## Requirements and incompatibilities

**Subscription auth requires the Claude Agent SDK runtime.** `@ai-sdk/anthropic` (the `vercel` runtime) authenticates with an `x-api-key` header against `api.anthropic.com`; an OAuth subscription credential is not an API key and will be rejected. So:

- `planner.auth.anthropic: subscription` + `planner.runtime.anthropic: vercel` is a **hard failure before any network call**, never a silent downgrade to API-key billing.
- `planner.auth.anthropic: subscription` + `planner.provider: openai` (or `google`) fails the same way — those providers are API-key only.

`squad doctor`'s `planner auth vs. runtime` check catches both **before** you attempt a run, and the console's Config page disables Save on the conflicting combination.

## `squad auth`

| Command | What it does |
| --- | --- |
| `squad auth login [--token <v>] [--print-only] [-y]` | Browser authorization flow; stores the token in `.squad/secrets.yaml` and sets `auth: subscription`. |
| `squad auth status [--json] [--offline]` | Resolved mode, the credential behind it, the signed-in account, and the runtime a run would use. |
| `squad auth logout [-y]` | Removes **only** the OAuth token squad-kit stored. |

`squad auth logout` is deliberately narrow. It deletes `planner.anthropicOauthToken` from `.squad/secrets.yaml` and nothing else — every other planner key and every tracker secret survives. It **never** touches your global Claude Code login; it prints how to do that yourself (`claude`, then `/logout`). It also leaves `planner.auth.anthropic` alone: logging out is not a decision to switch to API keys. If the mode is still `subscription` and no login remains on the machine, it says so, and the next run fails with a message pointing back at `squad auth login`.

## Doctor checks

`squad doctor` gained two auth rows and changed the behaviour of two existing ones.

| Check | What it tells you |
| --- | --- |
| `planner auth mode` | The resolved mode, why it resolved that way, and the credential hint. In subscription mode it also names an API key it is **ignoring**, so the switch is never silent. |
| `planner credential resolves` | For subscription auth, a live Agent SDK check of the login (skipped in CI, where it degrades to the offline answer). |
| `planner auth vs. runtime` | Fails on `subscription` + `vercel`, and on `subscription` with a non-Anthropic provider. |
| `planner model resolves at provider` | **Skips** on subscription auth — the model-list probe needs an API key, and there is none. |
| `planner tier vs. model` | **Skips** on subscription auth — a Claude plan has no API rate tier to warn about. |

**`--fix` does not pin an implicit `auto`.** When `auto` falls back to an API key, doctor reports `ok` with an explanatory hint and writes nothing. Pinning `api-key` would look like tidying up, but `auto` exists precisely so that a Claude login takes over once one appears — pinning would silently prevent that forever. Set it yourself with `squad config set planner` if you want it fixed.

## Troubleshooting

| What you see | What it means | Fix |
| --- | --- | --- |
| doctor: `planner auth mode` **fail** | Neither a login nor a key resolved. | `squad auth login`, or save a key with `squad config set planner`. |
| doctor: `planner credential resolves` **fail**, `not-logged-in` / `expired` | The Agent SDK could not authenticate. | `squad auth login`. |
| doctor: `planner credential resolves` **fail**, "did not report an account" | The credential handshake succeeded but returned no account — an invalid or expired token. | `squad auth login`. See [the caveat below](#a-successful-handshake-is-not-a-valid-credential). |
| doctor: `planner credential resolves` **warn**, `timeout` / `unknown` | The live check could not complete. Not necessarily a credential problem. | Re-run; if a local login is detected, this stays a warning by design. |
| doctor: `planner credential resolves` **warn**, `no-binary` | No `claude` executable found. | Reinstall squad-kit so the Agent SDK platform binary is present, or put `claude` on your `PATH`. |
| doctor: `planner auth vs. runtime` **fail** | Subscription auth with the `vercel` runtime, or with a non-Anthropic provider. | Remove `planner.runtime.anthropic: vercel`, or set `auth: api-key`. |
| run: `authentication_failed` | Login rejected or expired. | `squad auth login`. If the run used `CLAUDE_CODE_OAUTH_TOKEN`, unset or replace it first; if it used the stored token, `squad auth logout` then log in again. |
| run: `oauth_org_not_allowed` | Your Claude account's organization does not permit this login. | Ask your admin, or switch to an API key. |
| run: `billing_error` | Your Claude plan cannot run the request. | Check your plan at claude.ai/settings, or switch to an API key. |
| run: `rate_limit` (subscription) | Claude usage window exhausted. | Wait for the reset, or switch to an API key for the run. See [Usage limits](#usage-limits). |
| `squad auth login` refuses in CI | Non-TTY. | Use `--token`, or export `CLAUDE_CODE_OAUTH_TOKEN`. See [CI](#ci-and-headless-machines). |
| "That looks like an Anthropic API key" | You passed `sk-ant-api…` to `--token`. | `--token` takes the `sk-ant-oat…` value from `claude setup-token`. Use `squad config set planner` for keys. |
| Config page: "Subscription auth cannot use this runtime" | Same as the doctor runtime-fit failure, caught before saving. | Switch the runtime back to `agent-sdk`. |

### A successful handshake is not a valid credential

`accountInfo()` resolves from the SDK subprocess's `initialize` response, which succeeds **whether or not the credential is any good** — the CLI does not validate it until a real request. A working login answers with an email, organization, and plan; an invalid or expired one answers with nothing.

squad-kit therefore treats **subscription** auth that reports no account *and* no `apiKeySource` as **unverified**, not as signed in. API-key auth is exempt: it legitimately has no claude.ai account attached.

## Known limitation: managed-settings `apiKeyHelper`

`apiKeyHelper` is a Claude Code settings key that produces a credential and outranks `CLAUDE_CODE_OAUTH_TOKEN`. squad-kit runs the Agent SDK with `settingSources: []`, which stops it reading `~/.claude/settings.json`, project settings, and local settings — so an ordinary **user-level** `apiKeyHelper` cannot hijack a subscription run.

**Policy settings are always merged regardless of `settingSources`.** That means an enterprise **managed-settings** `apiKeyHelper`, deployed by MDM, is still honoured and still outranks the login credential. On a managed device, `planner.auth.anthropic: subscription` may resolve through your organization's helper rather than through your Claude login — quietly, and with the resulting usage billed wherever that helper points.

This was established by **reading the credential resolver in the bundled `claude` binary** (Agent SDK 0.2.126), **not** by testing on a live MDM-managed device. Treat it as a strong reading of the shipped code rather than a confirmed field observation.

If you are on a managed device and need certainty about where planning usage lands, run `squad auth status` and check `apiKeySource` — it reports what the SDK actually resolved.

## What is never persisted

Account details — email, organization, plan — are fetched live and shown in `squad auth status`, `squad doctor`, and the console's Claude Account card. They are **never** written to `.squad/runs/`.

Persisted run records (`.squad/runs/<id>.json` and `<id>.events.jsonl`) carry the resolved **mode** and `apiKeySource` only. No token, no API key, no email, no organization. This extends the 0.11.0 precedent of redacting thinking text on disk, and is asserted by a test.

## See also

- [Config, credentials, and safe deletes](customization.md) — every `planner.*` key, including `auth` and the environment variables.
- [Getting started](getting-started.md) — the first run, including the subscription path.
- [Squad console](console.md) — the Config auth control, the Claude Account card, and the auth badge on runs.
