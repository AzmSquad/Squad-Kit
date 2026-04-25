<p align="center">
  <a href="https://squad-kit.com">
    <img src="https://squad-kit.com/logo-wordmark.svg?v=2" alt="squad-kit logo" width="360">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/squad-kit"><img src="https://img.shields.io/npm/v/squad-kit.svg" alt="npm version"></a>
  <a href="https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml"><img src="https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://squad-kit.com"><img src="https://img.shields.io/badge/site-squad--kit.com-7cffa0?labelColor=0a0a0c" alt="Website"></a>
</p>

**Plan once, execute cheap.** A 3-step SDD-style workflow CLI for AI-assisted coding: **raw story → good plan → implementation**. Your expensive model plans once. A cheap model executes many times. Squad-kit owns the folder conventions, the plan meta-prompt, and the agent slash-commands so the token cost goes where it pays off. Deeper product notes live on **[squad-kit.com](https://squad-kit.com)** and in [`docs/`](docs/philosophy.md).

```
.squad/
├── stories/<feature>/<id>/  # intake + attachments (one per story)
└── plans/<feature>/         # NN-story-<id>.md (one per executable plan)
```

## What's new in 0.4.0

- **`squad new-plan --api` limits UX.** When a budget or cap stops the planner, the CLI asks before more API spend. Stop saves a `*.partial.md` with a clear status flag; exit code **2** when the run did not finish cleanly.
- **`planner.maxOutputTokens`** in merged config (default **16384** tokens per model round).
- **Shorter plan filenames** — new plans use the story folder id (`NN-story-<id-slug>.md`), not a long title slug; the overview table still shows the title.
- **Richer intakes** when `squad new-story` fetches Jira / Azure work items (more fields wired into the template).
- **`squad list`** reads `<!-- squad-kit: … -->` metadata from the first matching line near the top of a plan file, not only line 1.

## What's new in 0.3.0

- **Prompt caching** across Anthropic, OpenAI, and Google — ~70% fewer billed input tokens on
  a typical planning run, and Anthropic Tier 1 ITPM pressure roughly 5× lower.

## What's new in 0.2.0

- **Direct planner.** `squad new-plan --api` runs Anthropic, OpenAI, or Google from your terminal and writes the plan file. Demand-driven context keeps tokens bounded.
- **Tracker auto-fetch.** `squad new-story --id <ID>` pulls title, description, labels, and attachments (≤ 10 MB each) from Jira Cloud or Azure DevOps Services.
- **Secrets split.** API tokens live in `.squad/secrets.yaml` (git-ignored, `0600` on POSIX). `.squad/config.yaml` never holds secrets; the loader rejects secret-shaped keys.
- **Interactive-first UX.** Missing input prompts in a TTY; `-y` / `--yes` or `CI=1` opts out and fails fast.
- **`squad doctor`.** Full read-only health check; `--fix` for non-destructive repairs, `--json` for scripting.
- **`squad migrate`.** One-shot 0.1.x → 0.2.0 structural migrations (delete legacy `.squad/prompts/`, permissions, config normalisation). Destructive; use `--dry-run` first.
- **`squad upgrade`.** Safe npm-backed self-update (`--check` to verify only).
- **`squad config`.** `show`, `set planner` / `set tracker`, `unset …`, `remove-credential …` — edit config and secrets without hand-editing YAML.
- **`squad rm`.** `rm story` / `rm plan` / `rm feature` with `--dry-run`, `--trash`, and cascading overview updates.
- **Bundled prompts.** `generate-plan.md`, `intake.md`, and `story-skeleton.md` ship inside the npm package; upgrade the CLI to update them.

Full list in [`CHANGELOG.md`](CHANGELOG.md).

## Upgrading from 0.1.x

Existing squad-kit users should run two commands, once per repo:

```bash
pnpm add -g squad-kit@0.2.0       # or: npm install -g squad-kit@0.2.0 — or: squad upgrade
cd your-project && squad migrate
```

`squad migrate` deletes the now-unused `.squad/prompts/` directory, appends the managed `.gitignore` block, tightens `.squad/secrets.yaml` permissions to `0600`, and normalises `.squad/config.yaml`. It is idempotent but destructive — run it with `--dry-run` first if you forked the prompt files.

Full upgrade walkthrough, including what-if scenarios and how to recover customised prompts: [migration guide (repo)](docs/migrating-from-0.1.md) · [migration guide (site)](https://squad-kit.com/docs/migrating-from-0.1).

## Install

```bash
npm install -g squad-kit@0.2.0
# or
pnpm add -g squad-kit@0.2.0
```

Requires Node 18+.

## Quickstart

```bash
cd your-project
squad init                                              # interactive: tracker, planner, agents, name
squad new-story auth --title "SSO support"              # or: squad new-story auth --id ENG-42 to auto-fetch
# → edit .squad/stories/auth/ENG-42/intake.md

/squad-plan .squad/stories/auth/ENG-42/intake.md        # in your agent (Claude / Cursor / Copilot / Gemini)
# → .squad/plans/auth/01-story-sso-support.md

# new agent chat · attach ONLY the plan file · a cheap model ships it
```

No slash commands in your agent? Skip the meta-prompt copy-paste entirely:

```bash
squad new-plan --api   # interactive picker, direct provider call, writes the plan file
```

Configuration, credential edits, and non-interactive flags: see [`docs/customization.md`](docs/customization.md) and `squad config show`. Full walkthrough: [`docs/getting-started.md`](docs/getting-started.md).

## Commands

| Command | What it does |
| --- | --- |
| `squad init` | Scaffold `.squad/` with config, bundled prompts reference, and agent slash-commands. See [`docs/getting-started.md`](docs/getting-started.md). |
| `squad new-story [feature] [--id ID] [--title …] [--no-tracker] [--no-fetch] [--no-attachments] [--attachment-mb n]` | Create a story intake. Auto-fetches from the configured tracker when `--id` is given. |
| `squad new-plan [intake] [--api] [--copy] [--feature <slug>] [--all]` | Generate a plan from an intake. `--api` calls the configured planner; without `--api`, copy-paste mode prints the prompt to stdout and clipboard (`--no-clipboard` to skip the clipboard). |
| `squad status` | Counts, next `NN`, planner and tracker rows (including credential source). |
| `squad list [--feature <slug>]` | Table of stories and plan state. |
| `squad tracker link [story] [id]` | Attach or update a tracker id on an intake. |
| `squad config <show\|set\|unset\|remove-credential> …` | View and edit `.squad/config.yaml` and `.squad/secrets.yaml` interactively. See [`docs/customization.md`](docs/customization.md). |
| `squad rm <story\|plan\|feature> [target] [--dry-run] [--trash] [-y]` | Safely delete with cascading overview updates. |
| `squad doctor [--fix] [--json]` | Full health check; `--fix` applies non-destructive repairs. |
| `squad migrate [--dry-run] [-y]` | One-shot 0.1.x → 0.2.0 structural migrations. Destructive. |
| `squad upgrade [--check] [-y]` | Check npm and install a newer squad-kit release. |

Deeper option lists: `squad <command> --help` and the `docs/` pages above.

## Direct planner (optional)

Off by default. Enable during `squad init` (answer **yes** to *Enable automatic plan generation?*) or later with `squad config set planner`. Supported providers: Anthropic, OpenAI, Google.

Credential resolution order:

1. Provider env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`).
2. `.squad/secrets.yaml` under `planner.<provider>.apiKey` (or cross-provider `SQUAD_PLANNER_API_KEY`).
3. Interactive prompt (TTY only).
4. Fail with a recovery hint.

Override the default plan-phase model without editing squad-kit:

```yaml
planner:
  enabled: true
  provider: anthropic
  cache:
    enabled: true   # default; turn off via squad config set planner
  modelOverride:
    anthropic: claude-opus-5-0      # riding a newer provider release early
```

`squad status` marks the planner row `(override)` when a `modelOverride` is active. `squad doctor` probes the provider's `/v1/models` endpoint (no paid completion) and tells you what to do if the id is no longer served.

Slash commands inside your agent (`/squad-plan`) continue to work unchanged — the agent already has your repo in scope. The direct planner is an alternative path, not a replacement. For where keys live, see [Secrets](#secrets) below and [`docs/customization.md`](docs/customization.md).

## Tracker auto-fetch

`squad new-story <feature> --id <ID>` pulls the work item's title, description, labels, and attachments (≤ 10 MB each) straight into the intake. Supported trackers in 0.2.0: **Jira Cloud**, **Azure DevOps Services**.

Credentials follow the same resolution order as the planner (env → `.squad/secrets.yaml` → prompt → fail). `squad init` prompts for them when a supported tracker is selected.

Flags:

- `--no-fetch` — scaffold an empty intake; never call the tracker.
- `--no-attachments` — fetch metadata only.
- `--attachment-mb <n>` — override the 10 MB per-file cap.
- `--no-tracker` — skip the tracker id requirement for this story even when `naming.includeTrackerId: true`.

Full example with Azure DevOps: [`docs/getting-started.md`](docs/getting-started.md).

## Secrets

squad-kit stores settings in two files:

| File | Purpose | Git-tracked? | Editable by hand? |
| --- | --- | --- | --- |
| `.squad/config.yaml` | Project name, tracker, naming, agents, planner shape. | yes — commit it | yes, but `squad config set` is safer |
| `.squad/secrets.yaml` | Planner + tracker API tokens. | **no** — auto-ignored, `0600` on POSIX | no — use `squad config set` / `squad init` |

`config.yaml` rejects any key matching `apiKey`, `token`, `secret`, or `credential` at load time, so accidental commits fail loud. Rotate a credential with `squad config set planner` or `squad config set tracker`; remove one with `squad config remove-credential <section>`.

## Why not Spec-Kit?

Both aim at spec-driven development. They make different bets.

| | squad-kit | Spec-Kit |
| --- | --- | --- |
| Commands | `init`, `new-story`, `new-plan`, `status`, `doctor`, `migrate`, `upgrade`, `list`, `rm`, `tracker link`, `config` | `constitution`, `specify`, `clarify`, `plan`, `tasks`, `analyze`, `checklist`, `implement` |
| `/implement` turn starts with | one plan file (~5–15 KB) | 5–7 command templates + cross-artifact reads (~15–25 KB) |
| Model-tier awareness | Built into the philosophy (planner ≠ executor) | Not prescribed |
| Generated artifacts per story | `intake.md`, `NN-story-<id>.md`, overview row | `spec.md`, `plan.md`, `data-model.md`, `contracts/`, `research.md`, `quickstart.md`, `tasks.md` |
| Customization | Prompts ship with the CLI (fork squad-kit to change them). | Template override stack with presets/extensions |
| Runtime | Node + TypeScript, npm-distributable | Python + `uv` |
| Scope | Intentionally small | Broad, with safety nets (`clarify`, `analyze`) |

Spec-Kit ships safety rails. Squad-kit ships the cheap path and gets out of the way. Pick squad-kit when your planner already produces trustworthy plans; pick Spec-Kit when you want the process to catch planning mistakes for you.

See [`docs/philosophy.md`](docs/philosophy.md) for the token math and [`docs/vs-spec-kit.md`](docs/vs-spec-kit.md) for the full comparison.

## Tradeoffs to know

- **Quality depends on the planning model.** squad-kit has no safety-net commands. Use a strong model for `new-plan`.
- **Plans are project-coupled.** They reference real file paths. That is the point — do not expect portability between projects.
- **Global `NN` can collide on parallel branches.** Rebase-and-renumber is the resolution. Documented in [`docs/customization.md`](docs/customization.md).
- **Anthropic Tier 1 + Opus** shares a tight input-token-per-minute bucket. **0.3.0** added prompt caching (on by default) so typical multi-turn plans stay viable; see [Prompt caching](docs/customization.md#prompt-caching) in the customization docs.

## Non-goals for 0.2

We ship lean on purpose. Current non-goals:

- OpenAI-compatible generic endpoint (local models, OpenRouter, etc.); [Direct planner (optional)](#direct-planner-optional) covers hosted Anthropic, OpenAI, and Google
- MCP server
- `squad implement` (future release)
- `/clarify`, `/analyze`, constitution-equivalent
- Telemetry

## License

MIT. Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
