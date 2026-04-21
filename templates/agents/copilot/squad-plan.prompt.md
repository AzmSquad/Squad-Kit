---
mode: agent
description: Generate an implementation plan from a squad-kit story intake file.
---

Generate an implementation plan using the squad-kit workflow.

- Read `.squad/prompts/generate-plan.md` and follow its instructions exactly.
- Read the intake file provided by the user (under `.squad/stories/`) plus any referenced files in its `attachments/`.
- Read `.squad/config.yaml` for tracker type and naming rules.
- Scan `.squad/plans/**/NN-story-*.md` to determine the next global sequence number.
- Write the plan file to `.squad/plans/<feature-slug>/NN-story-<slug>[-<id>].md` and update `00-overview.md` / `00-index.md` as needed.

Planning only. Do not modify application source code in this session.
