# Customization

Squad-kit's prompts are plain Markdown files in your repo. Edit them. That is the feature.

## Files you can safely edit

| File | What it drives |
|---|---|
| `.squad/prompts/intake.md` | The scaffold used by `squad new-story` |
| `.squad/prompts/generate-plan.md` | The meta-prompt the agent follows when planning |
| `.squad/prompts/story-skeleton.md` | Structural reference for plan files |
| `.squad/config.yaml` | Project name, tracker, naming, agents |

Commit them. They are project artifacts, not framework internals.

## Common customizations

### Add language-specific verification

Edit `.squad/prompts/generate-plan.md`, section `## Verification Steps`:

```diff
 6. **`## Verification Steps`** — Numbered list. Bold lead-ins: **`Frontend runs:`**, **`Backend builds:`**, **`Regression:`**.
+   For Rust stories, always require `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test`.
+   For Python stories, always require `ruff check`, `mypy`, and `pytest`.
```

### Pin your project's review conventions

Add a "Product rules" bullet to `generate-plan.md` reminding the planner about non-obvious constraints — feature flags, monorepo build order, mandatory i18n keys, etc.

### Change filename convention

`.squad/config.yaml`:

```yaml
naming:
  includeTrackerId: false   # NN-story-<slug>.md
  # or
  includeTrackerId: true    # NN-story-<slug>-<id>.md
  globalSequence: false     # reset NN per feature folder
```

## Handling NN collisions on branches

`NN` is computed globally when `naming.globalSequence: true`. Two teammates branching from the same commit and each creating a new plan will both pick the same number. On merge:

1. Identify the conflicting files in `.squad/plans/`.
2. Renumber one of them. `git mv 15-story-foo.md 16-story-foo.md`.
3. Update the corresponding `00-overview.md` row and any cross-references.

If this happens often, switch to `globalSequence: false` and accept per-feature numbering.

## Adding agents post-init

```bash
squad init --force --agents claude-code,cursor,copilot,gemini
```

`--force` overwrites only the agent slash-command files and the templates in `.squad/prompts/`. Your plans, stories, and `config.yaml` are left alone.

## Upgrading squad-kit

```bash
npm update -g squad-kit
```

CLI upgrades do not touch your `.squad/` contents. If a new squad-kit version changes the default templates meaningfully, the release notes will say so and you can re-run `squad init --force` to pull the new defaults (then re-apply your customizations).
