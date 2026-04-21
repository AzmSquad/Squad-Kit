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
