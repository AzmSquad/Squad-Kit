---
title: Config, credentials, and safe deletes
description: .squad config, secrets, squad config, rm, doctor, and upgrades.
---

squad-kit intentionally gives you two places to customise: **`.squad/config.yaml`** (and **`.squad/secrets.yaml`** for credentials) and the **story and plan content** you own under `.squad/stories/**` and `.squad/plans/**`. Everything else — default prompts, meta-prompt assembly, and planner defaults that ship with the package — is updated by **upgrading the `squad-kit` npm install**, not by editing files beside the workspace.

If you only remember one command after reading this page, make it **`squad config show`** — it is the safest way to see how the CLI will interpret your workspace before you run **`squad new-plan --api`** or **`squad doctor`**.

## What you own vs. what squad-kit owns

| Path | Who owns it | How to change |
| --- | --- | --- |
| `.squad/config.yaml` | You (commit this) | Prefer **`squad config set …`**; hand-editing is possible but easy to get wrong. |
| `.squad/secrets.yaml` | You (git-ignored, `0600` on POSIX) | **`squad config set planner` / `set tracker`**, or **`squad config remove-credential …`**. |
| `.squad/stories/**`, `.squad/plans/**` | You | Normal file operations; use **`squad rm`** to delete in sync with overviews. |
| `templates/prompts/*.md` (inside the installed package) | squad-kit | Fork, patch, then `pnpm link` (or publish a fork). No runtime override. |
| Agent slash files (`.claude/`, `.cursor/`, `.github/prompts/`, `.gemini/`) | You (committed) | Regenerate with **`squad init --force --agents …`** (overwrites only those files). |

## Managing configuration (`squad config`)

Secrets never belong in **`.squad/config.yaml`**: the loader rejects secret-shaped key names, by design. Anything sensitive goes to **`.squad/secrets.yaml`** (or the provider env vars squad-kit already documents). For both planner and tracker keys, **resolution order** in normal operation is: **env var** → **`.squad/secrets.yaml`** → **prompt** in a TTY → **fail with a recovery hint** (see `CHANGELOG` for the exact list per provider).

**`squad config show`** — prints the current config and a **masked** view of secrets (values are **never** echoed in full). Use **`--json`** for machine-readable output (secrets still masked).

**`squad config set planner`** — interactive flow to enable or change the direct planner: provider (Anthropic / OpenAI / Google), optional `modelOverride`, and where to put the API key (`.squad/secrets.yaml` or remind you to use a provider env var). Updates `.squad/config.yaml` and, when you choose in-file storage, `.squad/secrets.yaml`.

**`squad config set tracker`** — set tracker type (`none`, `github`, `linear`, `jira`, `azure`), workspace / org / project fields, and tracker credentials for APIs that need them. Secrets go to `.squad/secrets.yaml` only.

**`squad config unset planner`** — removes the `planner` block from `config.yaml` (disables the direct planner). **By default, planner keys in `secrets.yaml` are left in place** so you can re-enable without re-entering. Pass **`--remove-credentials`** to delete planner keys from `secrets.yaml` as well. Use **`-y`** in scripts.

**`squad config unset tracker`** — sets the tracker to **`none`** in config. **By default, existing tracker entries in `secrets.yaml` are preserved**. Pass **`--remove-credentials`** to drop `tracker` secrets. Use **`-y`** when you need non-interactive confirmation.

**`squad config remove-credential <planner|tracker>`** — removes only the matching credential subtree from **`.squad/secrets.yaml`**, without touching non-secret fields in `config.yaml`. Handy for rotation when you do not want to re-run a full `set` flow.

### Environment variables the CLI respects

The docs track **`CHANGELOG.md`**; typical planner vars are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GOOGLE_API_KEY`, plus a cross-provider fall-back **`SQUAD_PLANNER_API_KEY`**. Jira and Azure have host/org/project in **`config.yaml`** and tokens in **`secrets.yaml`** (or the env var names the tracker clients document). `squad status` and `squad config show` are the best way to see what your current workspace *resolves* without printing raw secrets.

Tracker-specific env names are the ones implemented in the squad-kit version you have installed; when in doubt, prefer **`squad config set tracker`** so the right keys are written to **`secrets.yaml`** in the shape the clients expect.

### If you must hand-edit `config.yaml`

Some teams check in a **template** and expand secrets in CI. For local work, prefer **`squad config set …`** so you never write `apiKey:` into the wrong file. If you do edit YAML by hand, keep `planner.budget` limits positive, avoid secret keys in the committed file, and run **`squad doctor`** after edits.

## Model override

You can pin a different **plan-phase** model id per provider with **`planner.modelOverride`**, without editing squad-kit source. Example:

```yaml
planner:
  enabled: true
  provider: anthropic
  modelOverride:
    anthropic: claude-opus-5-0
```

Use this when you need to **ride ahead** of a squad-kit release (provider ships a new id) or **pin** a specific snapshot. **`squad status`** appends **`(override)`** to the planner line when an override is active for the current provider. **`squad doctor`** checks the resolved id against the provider’s **model list** API (a cheap HTTP call — **not** a paid chat completion) and reports if the id is missing.

## Copy-paste vs direct API for plans

- **Copy-paste** (`squad new-plan` without a working key, or with **`--copy`**) — composes the **generate-plan** prompt with your intake, prints to **stdout**, and **copies to the clipboard** unless **`--no-clipboard`**. You paste into any agent. No provider bill from squad-kit for the compose step; your agent session may still charge.
- **Direct API** (`squad new-plan --api` or default when the planner is enabled and the key resolves) — squad-kit calls the provider, runs the **bounded** tool loop, and **writes the plan file** and **updates `00-overview.md`** the same way the writer always has.

`--api` and **`--copy`** are mutually exclusive; **`--feature`** and **`--all`** work with both modes. See [getting-started.md](getting-started.md) (section **3. Generate a plan**).

## Planner budget (direct API)

When the planner is enabled, **`planner.budget`** caps the **`squad new-plan --api`** loop. Defaults (if omitted) are **25** file reads, **50 000** bytes of read context, and **180** seconds wall-clock, per `0.2.0`’s `mergePlanner` logic.

```yaml
planner:
  enabled: true
  provider: anthropic
  budget:
    maxFileReads: 25
    maxContextBytes: 50000
    maxDurationSeconds: 180
    # maxCostUsd: <optional cap when the provider reports cost>
```

If the planner hits a cap mid-run, the CLI still writes partial output and warns. Raise limits carefully — the point of squad-kit is to **bound** work, not map the whole monorepo. For hand-edits, run **`squad doctor`** after changing numbers (it validates **> 0**).

`maxCostUsd` is optional: when the provider returns usage cost and you set a cap, the run can stop early. Most setups rely on the read/time caps instead.

## Prompt caching

Starting in 0.3.0, squad-kit uses provider prompt caching on every planning run. Cached tokens
bill at ~10% (Anthropic), ~25% (Google), and ~50% (OpenAI) of the normal input rate — and on
Anthropic they **don't count against your per-minute rate limit the same way**, which is the
difference between "Tier 1 Opus works" and "Tier 1 Opus hits 429 after five tool reads."

### How it works per provider

- **Anthropic** — explicit `cache_control: { type: 'ephemeral' }` on the system prompt (stable)
  and the most recent tool-result block (rolling forward each turn). 5-minute TTL.
- **OpenAI** — automatic prefix caching on prompts ≥1024 tokens. No code or config needed; just
  a stable prefix, which 0.3.0 guarantees.
- **Google** (Gemini 2.0+ / 2.5) — implicit caching enabled by default. Same prefix-stability
  guarantee makes it work.

### Reading the telemetry

Every `squad new-plan --api` run prints a cache line:

    cache hit 68% (22.4k read / 32.9k total · 1.2k written)

- `68%` — fraction of input tokens served from cache (higher is cheaper).
- `22.4k read` — tokens this run served from cache.
- `32.9k total` — total input tokens this run.
- `1.2k written` — tokens newly written into the cache (first turn of a session only).

A fresh run against a new repo shows low hit % on turn 1 and rising through turn 3-4 as the
cache warms up. By turn 5 you should see 60–80% hits on Anthropic.

### Turning it off

    squad config set planner

…and answer `No` to the caching prompt. You'll see `cache disabled` in the run summary.
`squad doctor` will warn that caching is off (noisy for a reason — you're paying 3-10× more).

### Troubleshooting

Run `squad doctor`. The `planner cache effectiveness` check has four outcomes:

- **skip** — no runs yet, or planner disabled. Run `squad new-plan --api` once.
- **ok** — caching is working. You'll see the last run's hit rate.
- **warn** — hit rate < 30% after 3+ turns. Something is busting the prefix. Check your
  `.squad/config.yaml` for anything that changes per-run. Run with
  `NODE_ENV=development squad new-plan --api` to surface prefix-mismatch warnings.
- **fail** — 0% hits across multiple turns. Same causes as warn, more severe.

## Naming convention

`.squad/config.yaml`:

```yaml
naming:
  includeTrackerId: false   # NN-story-<slug>.md
  # or
  includeTrackerId: true    # NN-story-<slug>-<id>.md
  globalSequence: false     # reset NN per feature folder
```

**`squad rm`** accepts plans and stories by either filename shape; interactive pickers show the same entries you see in `squad list`.

## NN collisions on branches

`NN` is computed globally when `naming.globalSequence: true`. Two branches cut from the same commit can each allocate the same `NN` for a new plan. On merge:

1. Find the conflicting files under `.squad/plans/`.
2. Renumber one of them. `git mv` is fine.
3. Update the feature’s `00-overview.md` row and any cross-references.

If this is painful, switch to `globalSequence: false` and accept per-feature numbering.

After a messy rebase, **`squad rm plan`** (or trash + restore) **plus `squad new-plan --api`** is a clean way to regenerate with a fresh global `NN` if you are willing to drop the local plan file only.

## Removing things safely (`squad rm`)

| Command | What it does |
| --- | --- |
| `squad rm story` | Interactive picker; removes the **intake folder**, the **matching plan file**, and the **overview row**. |
| `squad rm story <path or id>` | Same, but targets one story. |
| `squad rm plan` | Interactive picker; removes the **plan file only** (intake stays; use `squad new-plan` to regenerate). |
| `squad rm feature` | Removes **every** story, plan, and overview content under a feature. |
| `… --dry-run` | Print what would be deleted. |
| `… --trash` | Move into **`.squad/.trash/<timestamp>/`** instead of deleting. |
| `… -y` / `… --yes` | Skip confirmation (for scripts and CI). |

**Recovery:** the trash folder is under `.squad/` and is **git-ignored**. Inspect `.squad/.trash/<timestamp>/` and move files back if you trashed something by mistake.

The trash directory is for recovery only — it is not a long-term backup strategy.

## Common workflows (quick reference)

- **First-time planner key after a `skip-secrets` init** — `squad config set planner`, choose provider, paste or defer to env.
- **Rotate a leaked Jira token** — `squad config remove-credential tracker`, then `squad config set tracker` to write a new PAT, or edit `secrets.yaml` with `squad doctor` to verify.
- **Temporarily drop the tracker API** — `squad config unset tracker` (keeps `secrets.yaml` unless you add `--remove-credentials`); re-enable with `squad config set tracker`.
- **Regenerate one plan, keep the intake** — `squad rm plan` (or target the plan path), then `squad new-plan --api` or `squad new-plan --copy`.
- **Nuke a feature safely** — `squad rm feature --dry-run`, then re-run with `--trash` if you want a safety net, or without if you are sure.
- **CI / scripts** — pass **`-y`** on mutating `config` and `rm` subcommands when stdin is not a TTY; pair with explicit paths instead of pickers.
- **Inspect machine-readable state** — `squad config show --json` and `squad doctor --json` for scripts (secrets remain masked in `config show`).

## Project structure hints

- **`project.projectRoots`** — list repo roots the planner and meta-prompts should know about (see [getting-started.md](getting-started.md#multi-repo-workspaces)).
- **`naming.includeTrackerId` + tracker type** — when both are set, new stories may require a work-item id unless you pass **`--no-tracker`**.
- **`.squad/plans/00-index.md`** — global index; feature work lives under **`.squad/plans/<feature>/`**, with **`00-overview.md`** per feature updated when plans are created or removed via the supported commands.

## Health checks (`squad doctor`)

**`squad doctor`** runs this checklist (and exits non-zero on failures), in order:

1. `.squad/` directory structure
2. `.squad/config.yaml` readable
3. `.gitignore` managed block (e.g. secrets patterns)
4. `.gitignore` includes `.squad/.trash/`
5. `.squad/secrets.yaml` permissions (POSIX; skipped on Windows)
6. `.squad/secrets.yaml` parseable
7. **Legacy prompts directory** (0.1.x; same check name in the CLI: legacy `.squad/prompts/` when present — **removed in 0.2.0** for new installs)
8. planner configuration (shape, budget, `modelOverride` when set)
9. planner credential resolves
10. planner model resolves at provider (models list API — not a chat completion)
11. tracker configuration (required fields for Jira / Azure, etc.)
12. tracker credential resolves
13. tracker connectivity (Jira or Azure when applicable)

**`squad doctor --fix`** applies **non-destructive** fixes only (directories, `gitignore`, `chmod` on `secrets.yaml`). It does **not** remove legacy `prompts/` or rewrite config the way **`squad migrate`** does.

**`squad doctor --json`** prints `{ root, checks }` for scripts.

squad-kit **never** runs a **paid** planner completion during `squad doctor`; “model resolves” is a **models-API** probe with your key.

## Upgrading the CLI

```bash
squad upgrade             # preferred — detects pnpm / npm / yarn / bun
squad upgrade --check     # report only
squad upgrade --yes       # skip confirmation
```

**`squad upgrade`** fetches the **latest** release from npm and refuses **dev** installs and **major** version jumps (it prints a manual guide instead) so you do not jump across breaking changes by accident. Patch and minor updates within the same major are the sweet spot.

After installing a new **version** of the package, run **`squad migrate` once per repo** the first time the CLI reports structural drift, or when upgrading from **0.1.x** → **0.2.x**, so `.squad/` matches what the new CLI expects. The full 0.1.x → 0.2.x walkthrough (including what gets deleted) is on the site: [migration guide](https://squad-kit.com/docs/migrating-from-0.1) (a repo-local `docs/migrating-from-0.1.md` is maintained alongside the project).

`npm install -g squad-kit@x` or `pnpm add -g squad-kit@x` is still valid if you pin versions in automation; **`squad upgrade`** is the interactive default.

### `squad list` and `squad status`

These read-only commands complement config work:

- **`squad list`** — table of intakes, plan filenames, and whether a plan was last produced by **API** or **copy-paste** (per `squad` metadata).
- **`squad status`** — global **next `NN`**, story/plan counts, **planner** row (provider, model, `(override)` when `modelOverride` applies, key presence), and **tracker** row (type, workspace, credential source: `env` / `secrets.yaml` / `missing`).

Use them after any `squad config` change to confirm the workspace is coherent before running `squad new-plan --api`.

## Adding agents post-init

```bash
squad init --force --agents claude-code,cursor,copilot,gemini
```

`--force` overwrites the generated slash-command files in the repo root. Your `config.yaml`, stories, and plans are not wiped.

## Forking to change prompts

The plan meta-prompts (`generate-plan.md`, `intake.md`, `story-skeleton.md`) are **not** user-editable at runtime. They ship inside the npm package at `templates/prompts/`. To change them, **fork** `squad-kit`, edit those files, and **`pnpm link`** your fork (or publish a package under a different name). There is **no** `.squad/prompts/` override; it was **removed in 0.2.0** so user copies and CLI behaviour could not drift silently.
