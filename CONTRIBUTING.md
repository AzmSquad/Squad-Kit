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

## Build squad-kit with squad-kit

You can use squad-kit's own squad to work on squad-kit.

1. **Install.** Node 22 or newer, and pnpm 9 (`corepack enable` gives you the one in `package.json`). Then
   `npm install -g squad-kit` and sign in to your AI tool once.
2. **Clone your fork.** Fork the repo on GitHub, then `git clone https://github.com/<you>/squad-kit.git`. You can add the
   main repo as `upstream`: `git remote add upstream https://github.com/AzmSquad/squad-kit.git`.
3. **Add it as a project.** Run `squad`, press Add project and pick the clone's folder.

What squad-kit does for you:

- It sees that this is squad-kit's own code and says so. The agents are told too.
- The setup installs both packages (the engine and `console-ui`) from their lock files.
- The checks for each story: the type checks of the engine and the board, the tests your change reaches plus the
  board's server test, the build, and the npm size limit. The whole suite takes about 9 minutes; run `pnpm test` yourself
  before you send a bigger change.
- Each story runs its own separate squad-kit, a sample board with sample data, in a folder of its own. The Tester's
  pictures come from it. Your own board and your other projects are never touched.
- Releases are for the maintainers, so the Releases page has no Release button here. The story's notes stay on your
  computer and out of the pull request.

Open the pull request:

- Press Looks right. The story merges into `main` on your computer, and its branch is kept.
- The story then shows **Send it as a pull request**: run the push command it shows (it pushes the branch to your fork),
  then press **Open the pull request page**. GitHub opens a pull request from your fork into `AzmSquad/squad-kit`.

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
