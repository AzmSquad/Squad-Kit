# Getting started

A complete first run: zero → planned story → executable.

## 0. Install

```bash
npm install -g squad-kit
# or pnpm add -g squad-kit
squad --version
```

## 1. Initialize in your project

```bash
cd your-project
squad init
```

Interactive prompts:

- **Project name** — defaults to the current folder name.
- **Primary language** — `typescript`, `python`, `go`, `csharp`, etc. Used as a hint in prompts.
- **Tracker** — `none`, `github`, `linear`, `jira`, `azure`.
- **Agents** — which agents get slash commands installed (`claude-code`, `cursor`, `copilot`, `gemini`).

What it creates:

```
.squad/
├── config.yaml
├── README.md
├── prompts/
│   ├── intake.md
│   ├── generate-plan.md
│   └── story-skeleton.md
├── stories/
└── plans/
    └── 00-index.md

# plus agent-specific command files, e.g.
.claude/commands/squad-plan.md
.cursor/commands/squad-plan.md
```

Non-interactive:

```bash
squad init --yes --tracker linear --agents claude-code,cursor --name my-app
```

## 2. Create your first story

```bash
squad new-story checkout --title "Add guest checkout"
```

With a tracker:

```bash
squad new-story checkout --id ENG-42 --title "Add guest checkout"
```

This creates:

```
.squad/stories/checkout/add-guest-checkout/        # or ENG-42/ with a tracker id
├── intake.md                                      # scaffolded from template
└── attachments/                                   # drop screenshots, PDFs here
```

Open `intake.md` and paste the tracker title, description, and acceptance criteria. List any files you dropped into `attachments/`.

## 3. Generate a plan

### Option A — inside your agent (recommended)

In Claude Code, Cursor, Copilot, or Gemini CLI:

```
/squad-plan .squad/stories/checkout/add-guest-checkout/intake.md
```

The agent reads your meta-prompt, the intake, any referenced attachments, and neighbouring plans. It writes `.squad/plans/checkout/01-story-add-guest-checkout.md` and updates `00-overview.md`.

### Option B — pipe the prompt out

```bash
squad new-plan .squad/stories/checkout/add-guest-checkout/intake.md
```

Prints the composed prompt to stdout and copies it to your clipboard. Paste into any chat.

## 4. Execute the plan

Open a **new, scoped agent session**. Attach **only** `01-story-add-guest-checkout.md`. That is intentionally the entire context — the plan is the contract.

A cheap model can usually execute it end-to-end. If you hit gaps, fix the plan (not the agent) and re-run.

## 5. Track progress

```bash
squad status              # counts + next NN
squad list                # table of all stories + plan state
squad list --feature auth # filter
```

## Multi-repo workspaces

If your project spans multiple repos side-by-side (e.g. `api/`, `web/`, `worker/`), set them in `.squad/config.yaml`:

```yaml
project:
  projectRoots:
    - api
    - web
    - worker
```

The planner sees this hint in the meta-prompt and anchors file paths across the declared roots.

## Prompts

Intake template, plan meta-prompt, and plan skeleton are **bundled in the squad-kit package** (not under `.squad/`). Upgrade the CLI to get updates. Customisation requires forking squad-kit; see [customization.md](customization.md).
