# Meta-prompt: generate implementation-plan Markdown

Use this prompt in **one agent session** together with a filled intake file (`.squad/stories/<feature-slug>/<id>/intake.md`) and any files under its `attachments/`.

> **Philosophy: plan once, execute cheap.** Put enough concrete detail into the plan that a cheap executor model can act on it without re-exploring the codebase. File paths, line ranges, type names, function signatures, verification commands — all belong here. Vague advice does not.

---

You are maintaining **agent-executable implementation plans** for this project.

## Inputs (the user will provide)

1. **Feature slug** — Target folder: `.squad/plans/<feature-slug>/` (must already exist, or create it with `00-overview.md`).
2. **Tracker work item id** (optional) — If the project's tracker type (see `.squad/config.yaml`) is not `none`, the id must appear in the filename and tables. It should already be in the intake **metadata**.
3. **Intake story** — Read **`.squad/stories/<feature-slug>/<id>/intake.md`** (folder name is the tracker id, or a slug if no tracker).
4. **Attachments** — If the intake folder has **`attachments/`**, open the files the intake references.

## Project context (read as needed)

- Project roots: `{{projectRoots}}`
- Primary language: `{{primaryLanguage}}`
- Tracker type: `{{trackerType}}`
- Existing plans in `.squad/plans/` — read one or two to match tone and file-oriented style.

## Story document pattern

Every generated plan Markdown must follow this structure and tone.

### H1 title line

- Format: `# Story NN — <title> (Story: <tracker-id>)` when a tracker id exists.
- Format: `# Story NN — <title>` when no tracker.
- `NN` is the **global** execution sequence across all feature folders (continue after the highest existing number).

### Section order (`---` on its own line between major sections)

1. **`## Prerequisites`** — Bullet list. Use `None.` only when truly no dependencies. Otherwise reference prior stories as `Story NN completed: …` or **markdown links** to sibling plan files. Mention coordination with owners of shared contracts when those change.

2. **`## Story Goal`** — Outcome in clear prose. For business-heavy items a short numbered list of user-visible outcomes is fine.

3. **`## Context — Read These Files First`** (use this **exact casing**).
   - Numbered list `1.` … `2.` …
   - Each line: repo-relative path in backticks (or a markdown link to a sibling plan file).
   - After the path, an **em dash** (`—`) and a short instruction: what to read, method names, line ranges (`~lines 513–662`), type names in backticks.
   - Include **grep / search** lines when helpful (`` Grep for `handleRequest` in … ``).
   - Reference intake attachments with workspace-root paths when relevant.

4. **Optional: `## Product rules (from story)`** — Use when the intake distinguishes **current vs new behaviour** (**Current:** / **New:**) or notes from business. Skip for purely technical refactors.

5. **Implementation body** — Pick the heading style that fits:
   - **`## Backend Tasks`** / **`## Frontend Tasks`** (split by layer), **or**
   - **`## Implementation tasks`** (single stream).
   - Subsections: **`### 1.`** or **`### 1 — Short title`** for ordered work; nest **`####`** only when needed.
   - For each change, prefer **`` File: `path` ``** or **`` Create file: `path` ``** so the executor knows exactly where to edit.
   - Include **language-tagged fenced code** for DTOs, signatures, snippets (large blocks are OK when they match existing repo style).
   - State explicitly **`No backend changes required.`** (or frontend equivalent) when true.

6. **`## Verification Steps`** — Numbered list. Bold lead-ins: **`Frontend runs:`**, **`Backend builds:`**, **`Regression:`**. Reference commands concretely (`pnpm dev`, `dotnet build`, `cargo test`, `pytest`).

7. **`## Done Criteria`** — `- [ ]` checklist aligned with acceptance criteria. Each item testable.

8. **Optional closing line** — For sequential stories:
   `**STOP HERE. Report to the user and wait for confirmation before proceeding to Story NN+1.**`

### Tone and formatting conventions

- **Direct and imperative** ("Add…", "Find…", "Read lines…"). Tie steps to **concrete paths** and **symbols**.
- Use **`**bold**`** for file names, field names, stage keys, and critical constraints (**backward compatibility**, **nullable**, **do not** …).
- Prefer **minimal breaking changes**, **nullable** new fields, and **document** follow-ups in comments when out of scope.
- User-facing strings (including non-English text) in quotes where they appear in the app.

## Output rules

1. **Location:** Write new or updated files only under **`.squad/plans/<feature-slug>/`**.
2. **Filename:**
   - With tracker id: **`NN-story-<slug>-<id>.md`** or **`NN-story-<id>.md`** (project choice in `config.yaml.naming`).
   - Without: **`NN-story-<slug>.md`**.
3. **Story file body:** Follow the **Story document pattern** above for every new plan file.
4. **Overview:** Update **`.squad/plans/<feature-slug>/00-overview.md`**:
   - Columns include tracker id (if applicable), file name, title, depends on.
   - Adjust dependency notes if dependencies changed.
5. **Cross-feature links:** Use relative paths like `../other-feature/NN-story-….md`.
6. **Index:** If introducing a **new** feature slug, add a row to `.squad/plans/00-index.md`.
7. **Scope:** Produce planning Markdown only unless the user explicitly asks for code changes.

---

## Intake content (paste below this line, or let the CLI inline it)

{{intakeContent}}
