# squad-kit vs Spec-Kit

Both are spec-driven-development workflow tools for AI coding agents. Same problem, different shape.

## TL;DR

- **Pick Spec-Kit** if you want clarification and consistency-analysis phases baked in; you're okay with heavier context per command; you prefer Python tooling.
- **Pick squad-kit** if you trust your planner and want every implementation turn to start with as little ceremony as possible; you prefer Node tooling; you are fine with **shared meta-prompts in the package** and **project rules in your intakes and plans**.

---

## Commands

| Stage | squad-kit | Spec-Kit |
|---|---|---|
| Governance | (none — project-coupled by design) | `/speckit.constitution` |
| Intake | `squad new-story` (tracker auto-fetch for Jira / Azure DevOps) | `/speckit.specify` |
| Clarification | (manual during intake review) | `/speckit.clarify` (optional) |
| Plan | `/squad-plan` or `squad new-plan` / `squad new-plan --api` | `/speckit.plan` |
| Task breakdown | (inlined in the plan file) | `/speckit.tasks` |
| Quality gates | `squad doctor` (config / credential / layout checks) | `/speckit.analyze`, `/speckit.checklist` |
| Execution | open plan file in a fresh agent session | `/speckit.implement` |
| Housekeeping | `squad status`, `squad list`, `squad rm`, `squad config`, `squad migrate`, `squad upgrade` | — |

Squad-kit's `/squad-plan` merges what Spec-Kit splits into `plan → tasks → implement`. One artifact, one contract.

---

## Artifacts per story

| | squad-kit | Spec-Kit |
|---|---|---|
| Intake | `intake.md` | `spec.md` |
| Plan | `NN-story-<slug>.md` | `plan.md` + `data-model.md` + `contracts/` + `research.md` + `quickstart.md` + `tasks.md` |
| Reference | `00-overview.md` (feature), `00-index.md` (global) | `.specify/memory/constitution.md` |

## Context cost per implementation turn

Both measurements include only *framework-induced* context — not your actual code.

| | squad-kit | Spec-Kit |
|---|---|---|
| Command template loaded | none (plan file is the prompt) | `/implement` template: ~13 KB |
| Cross-artifact reads | none | tasks + plan + data-model + contracts + research + quickstart |
| Typical starting context | one plan file (5–15 KB) | 15–25 KB before code is touched |

Across dozens of implement turns per feature, that delta compounds.

---

## Customization model

| | squad-kit | Spec-Kit |
|---|---|---|
| Prompt location | Bundled inside the squad-kit npm package (`templates/prompts/`), not user-editable at runtime | `.specify/templates/` + overrides + presets |
| How to customize | fork squad-kit and patch, or request upstream changes | template override stack, preset priority |
| Per-project rules | in intakes, plans, and `.squad/config.yaml` (via `squad config`) | managed via overrides |

Squad-kit keeps shared meta-prompts in the package; project-specific detail lives in your story and plan files. Spec-Kit uses a template override stack.

---

## Agent integration

| | squad-kit | Spec-Kit |
|---|---|---|
| Supported agents (v0.2) | Claude Code, Cursor, Copilot, Gemini CLI | 30+ agents |
| Install style | `squad init --agents <list>` copies slash-command files | Agent-specific install steps |
| Works without slash commands | yes (`squad new-plan` / `squad new-plan --api` for direct API; copy-paste mode prints to stdout) | yes (CLI-only mode) |

---

## Runtime & distribution

| | squad-kit | Spec-Kit |
|---|---|---|
| Language | Node + TypeScript | Python 3.11+ |
| Install | `npm i -g squad-kit` | `uv tool install specify-cli --from git+…` |
| Binary size | single ~174 KB minified JS bundle (~44 KB gzip) | Python package with deps |

---

## When Spec-Kit is the right choice

- You ship to production and want `/analyze` to catch spec-plan drift automatically.
- Your team includes non-engineers who need `/clarify` to iterate on specs.
- You are already in the Python/`uv` ecosystem.
- You want the constitution/governance layer.

## When squad-kit is the right choice

- You trust yourself (or a strong planner like Opus) to produce correct plans without a clarification phase.
- You want every implementation turn to be as token-lean as possible.
- You live in Node/TypeScript tooling already.
- You are fine with **shared meta-prompts in the package**; project rules live in intakes, plans, and `squad config`, not a parallel template tree.
- You want **config and credential** changes to be a `squad config set …` away, not a hand-edit-YAML task.
- You want to use a cheap model for the execution step with confidence.
