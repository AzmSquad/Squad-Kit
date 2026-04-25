# Story intake

Fill this template for each story you want planned. Keep it copy-paste-friendly: the planner reads **this file and the files in `attachments/`**, nothing else.

- Folder: `.squad/stories/{{featureSlug}}/{{storyId}}/intake.md`
- Binaries (screenshots, PDFs, exports): put them in `attachments/` next to this file and list them below.
- Do **not** rely on external links (tracker URLs, wiki, chat) — the planner cannot open them. Paste the content you want considered.

This is **not** an implementation prompt. It is the input to the plan-generation meta-prompt bundled with squad-kit (`generate-plan.md` in the installed package).

---

## Feature

- **Feature name (display):**
- **Feature slug (folder under `plans/`):** `{{featureSlug}}`

## Tracker (metadata only)

- **Tracker type:** `{{trackerType}}`
- **Work item id:** `{{trackerWorkItemId}}` *(used in filenames and plan tables; fill manually if empty)*
- **Work item type:** `{{trackerWorkItemType}}`
- **Status:** `{{trackerStatus}}`
- **Assignee:** `{{trackerAssignee}}`
- **Labels:** `{{trackerLabels}}`

External tracker links are **not** followed by the planner. Keep the id for naming and traceability only.

---

## Title

*(Paste the work item title verbatim. Prefilled when `squad new-story` fetched from a tracker.)*

```
{{trackerTitle}}
```

---

## Description

*(Paste the full work item description. Prefilled when fetched from a tracker.)*

```
{{trackerDescription}}
```

---

## Acceptance criteria

*(Checklist, bullets, Gherkin, etc. Prefilled for Azure DevOps when the work item has acceptance criteria.)*

```
{{trackerAcceptanceCriteria}}
```

---

## Attachments

Place files in `attachments/` next to this `intake.md`, then list them here so the planner knows what to open.

| File (relative to this folder) | What it is |
| ------------------------------ | ---------- |
| *(e.g. `attachments/flow.png`)* | *(e.g. UX flow)* |

*(Add rows per file. If none, write "None.")*

---

## Dependencies

- **Blocked by / related ids:** (tracker ids only; optional short note)
- **Depends on code areas or other stories:**

## Extra notes (optional)

- Anything not captured above (e.g. chat context) — keep short.

## Technical hints (optional)

- APIs, screens, services already discussed. Repos/roots: `{{projectRoots}}`. Primary language: `{{primaryLanguage}}`.

## Out of scope

- What this story explicitly does **not** cover:
