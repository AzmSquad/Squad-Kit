# Customization

Plan meta-prompts (`generate-plan.md`, `intake.md`, `story-skeleton.md`) ship inside the **squad-kit npm package** (`templates/prompts/`). They are not copied into `.squad/` — you always get the version that matches your installed CLI. To change them, **fork squad-kit** and patch `templates/prompts/`, or open a discussion on the main repo if the change should be upstream.

## Files you can safely edit

| File | What it drives |
|---|---|
| `.squad/config.yaml` | Project name, tracker, naming, agents, planner |
| `.squad/secrets.yaml` | API keys (git-ignored) |

Project workflow files under `.squad/stories/` and `.squad/plans/` are yours.

## Common customizations

### Conventions in intake and plans

Put language-specific verification commands, product rules, and review expectations in the **story intake** (and reflect them in generated plans). The bundled meta-prompt is shared across all users; project-specific rules belong in your story content.

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

`--force` overwrites agent slash-command files in the repo root. Your plans, stories, and `config.yaml` are left alone.

## Upgrading squad-kit

```bash
npm update -g squad-kit
```

CLI upgrades do not touch your `.squad/` story and plan content. New squad-kit versions may change bundled prompts in the package; upgrade the CLI to pick them up.
