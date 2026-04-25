---
description: Generate an implementation plan from a squad-kit story intake file.
---

You are generating an agent-executable implementation plan for this project using the squad-kit workflow.

## Inputs

- **Intake file path:** `$ARGUMENTS` (if empty, ask the user for a path under `.squad/stories/`).
- **Meta-prompt:** `generate-plan.md` from the **installed squad-kit package** (`templates/prompts/` — not under `.squad/`; find it via `npm root -g`/your package manager next to `squad-kit`, or run `squad new-plan <intake> --copy` to print the composed meta-prompt on stdout). Follow it exactly.
- **Project config:** `.squad/config.yaml` — read `project.projectRoots`, `tracker.type`, `naming.*`.

## Steps

1. Read `generate-plan.md` from the installed squad-kit package completely. Treat it as your operating instructions for structure, tone, and output rules.
2. Read the intake file, plus any files in its `attachments/` directory that the intake references.
3. Read one or two existing plan files under `.squad/plans/` (if any) to match established tone. If none exist, use `story-skeleton.md` from the same `templates/prompts/` directory in the squad-kit package.
4. Determine the next sequence number by scanning `.squad/plans/**/NN-story-*.md`, honouring `config.yaml.naming.globalSequence`.
5. Write the plan file to `.squad/plans/<feature-slug>/NN-story-<slug>[-<id>].md`.
6. Update the feature's `00-overview.md` and `.squad/plans/00-index.md` if it's a new feature slug.

## Rules

- Planning only. Do **not** modify application source code in this session.
- Concrete over clever. File paths, line ranges, type names, function signatures, verification commands.
- Respect existing conventions — read neighbouring plan files first.
- If a plan file already starts with `<!-- squad-kit:`, **never change or remove that first line** when editing the file. New plans you write start with `# Story NN — …` per `generate-plan.md`; do not fake the API metadata comment (only `squad new-plan --api` emits that header). In later **implementation** chats, treat the plan file as read-only unless the user explicitly asks to revise the plan.
