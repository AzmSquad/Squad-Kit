---
description: Scaffold a new squad-kit story intake file.
---

`$ARGUMENTS`: `<feature-slug> [--id <tracker-id>] [--title "..."]`

1. If arguments are empty, ask the user for feature slug (kebab-case), optional tracker id, optional title.
2. Run: `squad new-story $ARGUMENTS`
3. Report the created path. Remind the user to paste the tracker title, description, and acceptance criteria into the generated `intake.md` before running `/squad-plan`.
