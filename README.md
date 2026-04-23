# squad-kit

[![npm version](https://img.shields.io/npm/v/squad-kit.svg)](https://www.npmjs.com/package/squad-kit)
[![CI](https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/site-squad--kit.netlify.app-7cffa0?labelColor=0a0a0c)](https://squad-kit.netlify.app)

**Plan once, execute cheap.** A 3-step SDD-style workflow CLI for AI-assisted coding: **raw story → good plan → implementation**.

Website & docs: **[squad-kit.netlify.app](https://squad-kit.netlify.app)**


Your expensive model plans once. A cheap model executes many times. Squad-kit owns the folder conventions, the plan meta-prompt, and the agent slash-commands so the token cost goes where it pays off.

```
.squad/
├── stories/<feature>/<id>/ # intake + attachments (one per story)
└── plans/<feature>/        # NN-story-<slug>.md (one per executable plan)
```

Plan meta-prompts (`generate-plan.md`, `story-skeleton.md`, intake template) are **bundled inside the squad-kit npm package**, not copied into your repo. Upgrade the CLI to change them; to fork and customise, patch `templates/prompts/` in a fork of squad-kit.

---

## Why not Spec-Kit?

Both aim at spec-driven development. They make different bets.

| | squad-kit | Spec-Kit |
|---|---|---|
| Commands | `init`, `new-story`, `new-plan`, `status`, `doctor`, `migrate`, `upgrade`, `list`, `rm`, `tracker link` | `constitution`, `specify`, `clarify`, `plan`, `tasks`, `analyze`, `checklist`, `implement` |
| `/implement` turn starts with | one plan file (~5–15 KB) | 5–7 command templates + cross-artifact reads (~15–25 KB) |
| Model-tier awareness | Built into the philosophy (planner ≠ executor) | Not prescribed |
| Generated artifacts per story | `intake.md`, `NN-story-<slug>.md`, overview row | `spec.md`, `plan.md`, `data-model.md`, `contracts/`, `research.md`, `quickstart.md`, `tasks.md` |
| Customization | Prompts ship with the CLI (fork squad-kit to change them). | Template override stack with presets/extensions |
| Runtime | Node + TypeScript, npm-distributable | Python + `uv` |
| Scope | Intentionally small | Broad, with safety nets (`clarify`, `analyze`) |

Spec-Kit ships safety rails. Squad-kit ships the cheap path and gets out of the way. Pick squad-kit when your planner already produces trustworthy plans; pick Spec-Kit when you want the process to catch planning mistakes for you.

See [`docs/philosophy.md`](docs/philosophy.md) for the token math and [`docs/vs-spec-kit.md`](docs/vs-spec-kit.md) for the full comparison.

### Tracker auto-fetch (new in 0.2.0)

When a supported tracker is configured, `squad new-story <feature> --id <ID>` pulls the work item's title, description, labels, and attachments (≤ 10 MB each) directly into the intake. No more manual copy-paste.

Supported trackers in 0.2.0: **Jira Cloud**, **Azure DevOps Services**.

Credentials are prompted during `squad init` and stored in `.squad/secrets.yaml`, which squad-kit auto-adds to your `.gitignore`. Environment variables (`JIRA_API_TOKEN`, `AZURE_DEVOPS_PAT`, or the cross-provider `SQUAD_TRACKER_API_KEY`) also work if you prefer them.

Pass `--no-fetch` to skip the call and scaffold an empty intake; `--no-attachments` to fetch metadata only.

---

## Install

```bash
npm install -g squad-kit@0.2.0
# or
pnpm add -g squad-kit@0.2.0
```

Requires Node 18+.

---

## Quickstart

In your project root:

```bash
squad init                        # interactive: tracker, agents, name
squad new-story auth --title "SSO support"
# → edit .squad/stories/auth/sso-support/intake.md (paste title, description, criteria)

# Write an intake without a tracker id (even when naming.includeTrackerId would normally require one):
squad new-story feature-slug --no-tracker --title "quick exploration"
# Per-invocation only — .squad/config.yaml is not modified.
```

### Managing configuration

squad-kit stores settings in two files:

- `.squad/config.yaml` — project name, tracker type, naming rules, planner provider.
- `.squad/secrets.yaml` — API keys and tokens, `.gitignore`-d and chmod 0600.

Never edit these by hand. Use:

| Command | What it does |
| --- | --- |
| `squad config show` | Detailed view of both files (secrets masked). |
| `squad config set planner` | Interactively change provider, model, and key. |
| `squad config set tracker` | Interactively change tracker type, host, token. |
| `squad config unset planner` | Disable the direct planner; keeps credentials. |
| `squad config unset tracker` | Set tracker to `none`; keeps credentials. |
| `squad config remove-credential planner` | Delete planner keys without touching config. |
| `squad config remove-credential tracker` | Delete tracker keys without touching config. |
| `squad status` | Quick operational summary (stories, plans). |
| `squad doctor` | Full health check. |

```bash
# then, in your agent (Claude Code / Cursor / Copilot / Gemini):
/squad-plan .squad/stories/auth/sso-support/intake.md

# → produces .squad/plans/auth/01-story-sso-support.md

# implementation: new agent chat, attach ONLY the plan file.
# a cheap model can execute it end-to-end.
```

No slash commands in your agent? Pipe the prompt directly:

```bash
squad new-plan .squad/stories/auth/sso-support/intake.md   # prints to stdout, copies to clipboard
```

---

## Commands

| Command | What it does |
|---|---|
| `squad init` | Bootstrap `.squad/` with config and agent slash-commands (prompts are bundled in the package) |
| `squad new-story [feature] [--id ID] [--title ...]` | Scaffold a story intake folder (optional feature prompts in a TTY) |
| `squad new-plan <intake-path>` | Compose the plan-generation meta-prompt with the intake inlined; print to stdout + copy to clipboard |
| `squad status` | Count stories/plans, show next global `NN`, tracker/planner credential hints, warn on duplicates |
| `squad doctor` | Run a health check on your `.squad/` workspace |
| `squad doctor --fix` | Apply non-destructive repairs (`.gitignore` block, `secrets.yaml` mode `0600`, missing dirs) |
| `squad doctor --json` | Emit results as JSON on stdout (for scripting) |
| `squad list [--feature <slug>]` | Table of stories + their plan state |
| `squad rm` | Delete stories, plans, or whole features (`rm story` / `rm plan` / `rm feature`) with `--dry-run`, `--trash`, `-y` |
| `squad tracker link [story] [id]` | Attach or update a tracker id on an intake (optional args prompt in a TTY) |
| `squad migrate` | One-shot structural migrations from 0.1.x to 0.2.0 |
| `squad migrate --dry-run` | Show what would change without applying |
| `squad migrate --yes` | Skip the confirmation prompt |
| `squad upgrade` | Check npm for a newer squad-kit release and install it |
| `squad upgrade --check` | Only check; do not install |
| `squad upgrade --yes` | Skip the confirmation prompt |

### Removing things safely

squad-kit never asks you to `rm -rf` by hand. Use:

| Command | What it does |
| --- | --- |
| `squad rm story` | Interactive picker; deletes intake + plan + overview row. |
| `squad rm story <path\|id>` | Same, targeted. |
| `squad rm plan` | Interactive picker; deletes the plan file only. |
| `squad rm feature` | Interactive picker; deletes every story + plan + overview. |
| `... --dry-run` | Preview without changing anything. |
| `... --trash` | Move into `.squad/.trash/<ts>/` instead of deleting. |
| `... -y` | Skip the confirmation prompt (non-interactive). |

`.squad/.trash/` is git-ignored automatically. Recover with `mv .squad/.trash/<ts>/<item> .squad/...`. Empty it when you are sure: `rm -rf .squad/.trash`.

### `squad upgrade`

`squad upgrade` queries `registry.npmjs.org` for the latest squad-kit release, detects your package manager (pnpm, npm, yarn, bun), and runs the appropriate global-install command with your confirmation. After upgrading, run `squad migrate` in each project to update the `.squad/` structure if needed.

### `squad doctor`

Use this when something feels misconfigured. By default it is read-only: it loads `.squad/config.yaml` and `.squad/secrets.yaml`, checks directory layout, warns if a legacy `.squad/prompts/` directory is still present (removed in 0.2.0), validates planner settings and API keys (including a lightweight `/v1/models` probe — never a paid completion), checks Jira/Azure tracker config and credentials, and optionally hits a small REST endpoint to verify connectivity.

`--fix` only performs safe, idempotent fixes: creating missing `.squad/stories` or `.squad/plans`, appending the managed `.gitignore` block (including `.squad/.trash/` when missing), and tightening `secrets.yaml` permissions on POSIX. It does not delete files or rewrite config; for legacy prompts cleanup and other migrations, use `squad migrate`.

### Upgrading from 0.1.x

After upgrading the squad-kit package (`pnpm add -g squad-kit@latest`), run `squad migrate` once in each repo that uses squad-kit. This deletes the now-unused `.squad/prompts/` directory, ensures your `.gitignore` has the squad-kit block, tightens permissions on `.squad/secrets.yaml`, and normalises `.squad/config.yaml` formatting. Comments inside `config.yaml` will be dropped.

---

## CLI conventions

### Interactive-first

Every squad-kit command prompts for missing required input when run in a TTY. Use `-y` or `--yes` to opt out — missing input then fails fast instead of prompting. Useful in scripts and CI, e.g. `CI=1 squad new-story user-auth --id ENG-42 --yes`.

Set `CI=1` to force non-interactive behaviour even in a TTY (matches how other tools behave in CI environments).

## Direct planner (optional)

Squad can call a strong planning model for you from the terminal so you do not have to paste the prompt into your agent. Off by default.

1. `squad init --force` and answer **yes** to *Enable automatic plan generation?* (or re-run `squad init -y --planner anthropic`). Use `--skip-secrets-prompt` (or `--no-prompt-secrets`) if you want to skip all secret prompts in a TTY session.
2. Export the provider's API key:

   ```bash
   export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY / GOOGLE_API_KEY
   ```

3. `squad new-plan` — pick an un-planned intake; squad reads only the files the planner asks for (bounded by `planner.budget`), writes the plan to `.squad/plans/<feature>/NN-story-<slug>.md`, and prints a summary.

Optional: override the default plan-phase model id (per provider) without changing squad-kit:

```yaml
planner:
  enabled: true
  provider: anthropic
  # Optional: pin a specific model for the plan phase, overriding the squad-kit default.
  # Useful when riding a newer provider release ahead of a squad-kit update, or when the
  # default has been deprecated.
  modelOverride:
    anthropic: claude-opus-5-0
```

Slash commands inside your agent (`/squad-plan`) continue to work unchanged — the agent already has your repo in scope.

Squad-kit never reads API keys from `.squad/config.yaml`. You can set keys via environment variables, save them in `.squad/secrets.yaml` (prompted by `squad init` when the planner is enabled), or a mix. See [Secrets](#secrets) below.

#### Secrets

- `.squad/config.yaml` — shape and non-sensitive settings. Safe to commit.
- `.squad/secrets.yaml` — API tokens for the planner and tracker. **Always git-ignored** (managed by squad-kit).
- Environment variables override `.squad/secrets.yaml`.
- Priority: env var → `.squad/secrets.yaml` → prompt (interactive) → fail.

---

## Agent integration

At `squad init` you pick which agents get native slash commands. Supported:

- **Claude Code** → `.claude/commands/squad-plan.md`, `.claude/commands/squad-new-story.md`
- **Cursor** → `.cursor/commands/squad-*.md`
- **GitHub Copilot** → `.github/prompts/squad-plan.prompt.md`
- **Gemini CLI** → `.gemini/commands/squad-plan.toml`

Unsupported agents work fine too — `squad new-plan` prints the composed prompt on stdout.

---

## Trackers

Optional. Configure in `.squad/config.yaml`:

```yaml
tracker:
  type: linear     # none | github | linear | jira | azure
naming:
  includeTrackerId: true
  globalSequence: true
```

`--id` on `new-story` is validated against the tracker's id format. For **Jira** and **Azure DevOps**, with credentials configured, the CLI can [auto-fetch](#tracker-auto-fetch-new-in-020) issue metadata and attachments. Other trackers (GitHub, Linear) use id format validation only in v0.2.

---

## What's *not* in v0.2

We ship lean on purpose. Current non-goals:

- OpenAI-compatible generic endpoint (local models, OpenRouter, etc.); [Direct planner (optional)](#direct-planner-optional) covers hosted Anthropic, OpenAI, and Google
- MCP server
- `/clarify`, `/analyze`, constitution-equivalent
- Telemetry

---

## Tradeoffs to know

- **Quality depends on the planning model.** squad-kit has no safety-net commands. Use a strong model for `new-plan`.
- **Plans are project-coupled.** They reference real file paths. That is the point — do not expect portability between projects.
- **Global `NN` can collide on parallel branches.** Rebase-and-renumber is the resolution. Documented in [`docs/customization.md`](docs/customization.md).

---

## License

MIT. Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
