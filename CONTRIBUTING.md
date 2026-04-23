# Contributing

Thanks for considering a contribution to squad-kit.

## Scope

Squad-kit aims to stay small. Before opening a PR, please check:

- Does this add a command, or can it be an edit to a prompt template that ships with `init`?
- Does this change the shape of `.squad/`? Breaking that is a major version bump.
- Does this increase context cost per implementation turn? That is the cardinal sin.

Issues marked `scope-review` or `help-wanted` are good starting points. For large proposals, open a discussion first.

## Dev setup

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Link locally:

```bash
pnpm link --global
squad --version
```

## Tests

- Unit tests in `test/*.test.ts`, run with `pnpm test`.
- Every code path that touches the filesystem should have a test using a `os.mkdtempSync` fixture.
- Prefer testing behaviour, not implementation. If the refactor is obvious, the test should survive it.

## Command authoring guidelines

Every new command must:

1. Accept `-y` / `--yes` as an explicit opt-out for prompts.
2. Detect `process.stdin.isTTY && process.env.CI !== 'true'` as the condition for prompting (and honour `--yes`).
3. Validate prompt input with clear error messages.
4. When non-interactive and input is missing, throw a clear error with the canonical usage line.
5. Use `@inquirer/prompts` for prompts; use `src/ui/*` for all other output.

## Style

- TypeScript strict mode.
- No comments that restate the code. Only comments for WHY, not WHAT.
- No `any`. Use narrow union types.
- Keep dependencies lean — adding one is a discussion, not a PR.

## PR checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Updated docs if the user-facing behaviour changed
- [ ] No new runtime dependencies (or justified in the PR description)

## Releases

Maintainers publish to npm via CI on tagged releases. Bump version in `package.json` and create a tag `vX.Y.Z`.
