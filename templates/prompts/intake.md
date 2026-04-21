# Story intake

Fill this template for each story you want planned. Keep it copy-paste-friendly: the planner reads **this file and the files in `attachments/`**, nothing else.

- Folder: `.squad/stories/{{featureSlug}}/{{storyId}}/intake.md`
- Binaries (screenshots, PDFs, exports): put them in `attachments/` next to this file and list them below.
- Do **not** rely on external links (tracker URLs, wiki, chat) — the planner cannot open them. Paste the content you want considered.

This is **not** an implementation prompt. It is the input to `.squad/prompts/generate-plan.md`.

---

## Feature

- **Feature name (display):**
- **Feature slug (folder under `plans/`):** `{{featureSlug}}`

## Tracker (metadata only)

- **Tracker type:** `{{trackerType}}`
- **Work item id:** (used in filenames and plan tables; leave blank if tracker type is `none`)
- **Work item type:** Story / Bug / Task / Chore / …

External tracker links are **not** followed by the planner. Keep the id for naming and traceability only.

---

## Title

*(Paste the work item title verbatim.)*

```

```

---

## Description

*(Paste the full work item description, including any formatting you rely on.)*

```

```

---

## Acceptance criteria

*(Paste the acceptance criteria — checklist, bullets, Gherkin, whatever the tracker stores.)*

```

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
