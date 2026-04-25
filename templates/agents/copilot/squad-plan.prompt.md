---
mode: agent
description: Generate an implementation plan from a squad-kit story intake file.
---

Generate an implementation plan using the squad-kit workflow.

- Read `generate-plan.md` from the installed squad-kit package (`templates/prompts/`; not under `.squad/` — use `npm root -g`/your package manager path to `squad-kit`, or `squad new-plan <intake> --copy` for the composed prompt) and follow its instructions exactly.
- Read the intake file provided by the user (under `.squad/stories/`) plus any referenced files in its `attachments/`.
- Read `.squad/config.yaml` for tracker type and naming rules.
- Scan `.squad/plans/**/NN-story-*.md` to determine the next global sequence number.
- Write the plan file to `.squad/plans/<feature-slug>/NN-story-<slug>[-<id>].md` and update `00-overview.md` / `00-index.md` as needed.

Planning only. Do not modify application source code in this session.

If a plan file already starts with `<!-- squad-kit:`, never change or remove that first line when editing (tooling / `squad list`). New plans start with `# Story NN — …` per `generate-plan.md`; do not fake the API metadata comment. In later implementation sessions, keep the plan file read-only unless the user explicitly asks to revise the plan.
