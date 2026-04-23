# User-facing error audit (no-stuck / dead-end pass)

Working notes for Story 04. `docs/` is not published in the npm `files` list (see `package.json`).

## Convention

User-visible errors use one of:

- **Simple:** `<What failed>. Run \`<command>\` to <action>.`
- **Contextual:** short cause, then `Run \`...\`` (and optionally `, or \`...\``).

## Inventory (representative callsites)

| File:line (area) | Status | Notes |
|------------------|--------|--------|
| `commands/new-story.ts` | REWRITE → OK | Missing slug, tracker id, invalid id, folder name, duplicate intake |
| `commands/tracker-link.ts` | REWRITE → OK | Non-interactive usage, invalid id, missing intake |
| `commands/new-plan.ts` | REWRITE → OK | Mode conflict, paths, API/config/copy, empty plan |
| `commands/init.ts` | REWRITE → OK | Existing config (non-interactive), bad `--planner` |
| `commands/config/*.ts` | REWRITE → OK | set planner/tracker, remove-credential |
| `commands/rm/*.ts` | REWRITE → OK | Usage, confirmation, resolve errors, shared pickers |
| `commands/upgrade.ts` | REWRITE → OK | Dev install, registry, major bump, non-interactive, spawn failure |
| `commands/migrate.ts` | REWRITE → OK | Non-interactive confirm, suspicious path |
| `core/config.ts` | REWRITE → OK | Secrets in YAML, YAML/parse, validation, budgets |
| `core/secrets.ts` | REWRITE → OK | Read/parse/structure |
| `core/paths.ts` | OK | Already had `Run \`squad init\`` |
| `planner/provider-errors.ts` | REWRITE → OK | `modelNotFoundMessage` recovery list |
| `planner/loop.ts` | REWRITE → OK | Provider stopReason error |
| `tracker/index.ts` | REWRITE → OK | `ClientResolutionError.detail` for jira/azure/unsupported |

Internal or non-CLI errors (registry fetch, package root resolution, etc.) were reviewed; only user-reachable paths were expanded with `Run \`...\`` hints.

## Maintenance

When adding a new `throw new Error` or `ui.failure` on a command path, keep the same shape and update this table if the command is user-facing.
