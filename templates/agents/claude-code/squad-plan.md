---
description: Generate an implementation plan from a squad-kit story intake file.
---

You are generating an agent-executable implementation plan for this project using the squad-kit workflow.

## Inputs

- **Intake file path:** `$ARGUMENTS`
  - If empty, ask the user for the path to a story intake file (under `.squad/stories/`).
- **Meta-prompt:** `generate-plan.md` from the **installed squad-kit package** (`templates/prompts/` — not under `.squad/`; locate via `npm root -g`/your package manager under `squad-kit`, or run `squad new-plan <intake> --copy` to print the composed meta-prompt). Follow it exactly.
- **Project config:** `.squad/config.yaml` — read `project.projectRoots`, `tracker.type`, `naming.includeTrackerId`, `naming.globalSequence`.

## Steps

1. Read `generate-plan.md` from the installed squad-kit package completely. Treat it as your operating instructions for structure, tone, and output rules.
2. Read the intake file at `$ARGUMENTS`, plus any files in its `attachments/` directory that the intake references.
3. Read one or two existing plan files under `.squad/plans/` (if any) to match established tone. If none exist, use `story-skeleton.md` from the same `templates/prompts/` directory in the squad-kit package as the structural reference.
4. Determine the next sequence number by scanning `.squad/plans/**/NN-story-*.md` for the highest `NN` (global sequence) or the highest within the target feature folder (per-feature sequence), per `config.yaml.naming.globalSequence`.
5. Write the plan file to `.squad/plans/<feature-slug>/NN-story-<slug>[-<id>].md`.
6. Update `.squad/plans/<feature-slug>/00-overview.md` with the new story row.
7. If this is a new feature slug, add it to `.squad/plans/00-index.md`.

## Rules

- **Planning only.** Do not modify application source code in this session.
- **Concrete over clever.** File paths, line ranges, type names, function signatures, verification commands. No "consider" or "might".
- **Respect existing conventions.** Read neighbouring plan files before inventing a new pattern.
- If a plan file already starts with `<!-- squad-kit:`, **never change or remove that first line** when editing. New plans start with `# Story NN — …` per `generate-plan.md`; do not invent the API metadata comment. In later implementation sessions, treat the plan file as read-only unless the user explicitly asks to revise the plan.
- Report back the path(s) you wrote and a one-line summary per file.
