---
title: Getting started
description: A complete first run, from zero to a planned story a cheap model can execute.
---

A complete first run: zero → planned story → executable.

**Already on squad-kit 0.1.x?** See [Migrating from 0.1.x](migrating-from-0.1.md) first.

## 0. Install

```bash
pnpm add -g squad-kit@0.2.0     # or: npm install -g squad-kit@0.2.0
squad --version                 # expect 0.2.0
```

## 1. Initialize in your project

```bash
cd your-project
squad init
```

### Interactive prompts

`init` walks you through (order matches the CLI):

- **Project name** — defaults to the current directory name.
- **Primary language** — e.g. `typescript`; used as a hint in planning.
- **Issue tracker** — `none`, `github`, `linear`, `jira`, or `azure`.
- **Slash commands** — which agents get `squad-plan` (and friends): `claude-code`, `cursor`, `copilot`, `gemini`.
- **Tracker id in filenames** — when the tracker is not `none`, you can require `NN-story-<slug>-<id>.md` names (`naming.includeTrackerId`).
- **Jira or Azure** — if you pick either, you are prompted for host / org, email or PAT, and API token. Values are written to **`.squad/secrets.yaml`** (git-ignored, `0600` on POSIX).
- **Direct planner (optional)** — “Enable automatic plan generation?” If yes, you choose **Anthropic**, **OpenAI**, or **Google**, then either save an API key into `.squad/secrets.yaml` or opt to **export the provider env var** instead (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`).

### What it creates

```text
.squad/
├── config.yaml           # committed
├── secrets.yaml          # git-ignored, chmod 0600 (if planner / tracker creds were saved)
├── README.md
├── stories/
└── plans/
    └── 00-index.md

# plus agent slash-command files, e.g.
.claude/commands/squad-plan.md
.cursor/commands/squad-plan.md
```

Intake, plan meta-prompt, and skeletons are **not** copied here — they ship inside the `squad-kit` package. The 0.1.x local override under `.squad/prompts/` was **removed in 0.2.0**; the CLI you install owns those templates.

### Non-interactive

```bash
squad init -y \
  --tracker jira \
  --planner anthropic \
  --agents claude-code,cursor \
  --name my-app
```

For CI or headless runs where you do not want key prompts, use **`--skip-secrets-prompt`** (alias **`--no-prompt-secrets`**) to leave `.squad/secrets.yaml` unchanged and supply credentials via env or a later `squad config set …`.

Jira and Azure in `-y` mode may need **`--tracker-workspace`** and, for Azure, **`--tracker-project`**. See `squad init --help`.

## 2. Create a story

### Without a tracker (manual intake)

```bash
squad new-story checkout --title "Add guest checkout"
```

This scaffolds `.squad/stories/checkout/<folder>/intake.md` and the feature’s `attachments/` folder. Fill in title, description, and acceptance criteria yourself.

### With a tracker id (auto-fetch for Jira or Azure)

When the workspace tracker is **Jira** or **Azure DevOps** and credentials resolve (env → `.squad/secrets.yaml` → prompt), passing **`--id`** fetches the work item:

```bash
squad new-story checkout --id ENG-42
# squad: fetching ENG-42 from Jira…
# squad: wrote intake (… fields, … attachments)
```

Auto-fetch typically fills in **title**, **description**, **labels**, and, when the tracker provides them, **acceptance-style content** from the description (e.g. from Jira ADF). **Attachments** are downloaded up to **10 MB each** by default. Override or skip with:

- **`--no-fetch`** — never call the tracker; empty scaffold.
- **`--no-attachments`** — metadata only.
- **`--attachment-mb <n>`** — change the per-file size cap.

### Skip tracker for one story

If the repo normally **requires** a tracker id for new stories, you can still do a one-off manual story:

```bash
squad new-story checkout --no-tracker --title "quick experiment"
```

The important part is **`--no-tracker`** when the workspace would otherwise require an id.

### Resulting layout (examples)

**Title-based folder:**

```text
.squad/stories/checkout/add-guest-checkout/
├── intake.md
└── attachments/
```

**Tracker-id folder (e.g. `ENG-42/`):**

```text
.squad/stories/checkout/ENG-42/
├── intake.md
└── attachments/
```

Open `intake.md`, review the **Source** block if it was auto-fetched, and add anything missing before planning.

## 3. Generate a plan

You need one concrete **`NN-story-*.md` plan file** per story. There are three supported paths.

### Option A — inside your agent (unchanged from 0.1)

In **Claude Code**, **Cursor**, **Copilot**, or **Gemini CLI**:

```text
/squad-plan .squad/stories/checkout/add-guest-checkout/intake.md
```

Use the real path to your `intake.md`. The agent runs the bundled meta-prompt, reads the intake and attachments, and should write a plan under `.squad/plans/<feature>/` and update the feature’s **`00-overview.md`** (and **`.squad/plans/00-index.md`** when you add a new feature — follow your installed slash-command text).

### Option B — direct from the terminal (`0.2.0`)

With the direct planner enabled and credentials set:

```bash
squad new-plan --api
# interactive picker over un-planned intakes
# → reads intake.md + only the repo files the planner requests (read_file / list_dir)
# → writes .squad/plans/checkout/01-story-add-guest-checkout.md
# → updates the feature's 00-overview.md
```

The planner does **not** map the whole repo up front. It uses **demand-driven context**: a tool-use loop with caps from **`planner.budget`** in `.squad/config.yaml` (file reads, context bytes, wall-clock). For how that relates to “plan once, execute cheap,” see [Where the direct planner fits](philosophy.md#where-the-direct-planner-fits) in the philosophy doc.

### Option C — copy-paste (compose prompt to stdout / clipboard)

```bash
squad new-plan
# prints the composed prompt to stdout; copies to the clipboard; paste into any chat
```

Use **`--copy`** to force this mode when the direct planner is configured, or **`--no-clipboard`** to print without touching the clipboard.

`new-plan` may show an **interactive intake picker** when you omit the path. Filter with **`--feature <slug>`** or include already-planned stories with **`--all`**.

## 4. Execute the plan

Open a **new, scoped agent session**. Attach **only** the generated `NN-story-*.md` file. A smaller / cheaper model can usually follow it end to end. If something is wrong, **fix the plan** (or the intake) and regenerate — not the other way around.

## 5. Track progress

```bash
squad status              # counts, next NN, planner + tracker rows
squad list                # all stories and plan state
squad list --feature auth  # filter by feature
# attach a tracker id to an existing intake when you skipped one earlier:
# squad tracker link .squad/stories/<feature>/<id>/intake.md ENG-42
```

## 6. When something feels off

- **`squad doctor`** — read-only health check (config, credentials, model id probe via the provider’s **models API** — **no** paid completion calls, secrets stay masked in normal output).
- **`squad doctor --fix`** — **non-destructive** repairs only (e.g. missing dirs, `.gitignore` block, `secrets.yaml` permissions on POSIX).
- **`squad migrate`** — **one-shot, destructive** upgrades from 0.1.x layout (e.g. deleting the pre-0.2 local prompts copy — **removed in 0.2.0** in favour of package-bundled templates). Use when upgrading the **package**; confirm with the prompt, or pass **`--yes`** in automation. **`--dry-run`** shows the plan first.

```bash
squad doctor
squad doctor --fix
squad migrate --dry-run
squad migrate            # or: squad migrate -y
```

For the full list of checks and all configuration knobs, see [customization.md](customization.md).

## Multi-repo workspaces

If the codebase spans several roots (e.g. `api/`, `web/`, `worker/`), list them in `.squad/config.yaml`:

```yaml
project:
  projectRoots:
    - api
    - web
    - worker
```

The meta-prompt and direct planner use this to anchor paths.

## Prompts

Intake template, plan **generate-plan** meta-prompt, and plan skeleton are **bundled inside the squad-kit npm package** (`templates/` in the source tree). They are **not** copied into `.squad/prompts/`, which was **removed in 0.2.0** — upgrade the CLI to change them. To customise beyond config and your own story text, **fork squad-kit** and patch `templates/prompts/`; see [customization.md](customization.md).
