---
description: Scaffold a new squad-kit story intake file.
---

Scaffold a new story intake folder using the squad-kit CLI.

## Usage

`$ARGUMENTS` should be: `<feature-slug> [--id <tracker-id>] [--title "..."]`

## Steps

1. If `$ARGUMENTS` is empty, ask the user for:
   - feature slug (kebab-case, e.g. `checkout`, `auth-rewrite`)
   - optional tracker id (only if `.squad/config.yaml` tracker.type is not `none`)
   - optional title
2. Run: `squad new-story $ARGUMENTS`
3. Report the created path. Remind the user to paste the tracker title, description, and acceptance criteria into the generated `intake.md` before running `/squad-plan`.
