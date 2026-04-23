# Philosophy — plan once, execute cheap

Spec-driven development with AI agents has two distinct phases that people conflate:

1. **Thinking.** Reading code, weighing tradeoffs, deciding what to change and why. This is expensive per token and benefits from the best model you have.
2. **Typing.** Applying the plan: edit files, run tests, fix typos, wire things up. This is verbose and repetitive. A weak model can do it — *if* the plan is concrete enough.

Squad-kit is built around the observation that most SDD tooling fails to separate these. Every "implement" turn reloads the planner-level context, reruns synthesis, and re-reads meta-artifacts the executor does not need. You pay top-tier tokens for typing work.

---

## The rule

**Plan once. Execute cheap.**

- One expensive session produces `NN-story-<slug>.md`.
- That file is **the contract**: paths, line ranges, signatures, verification commands, done criteria.
- Implementation sessions attach only that file. No meta-prompt reload. No cross-artifact consistency checks.
- If the plan is wrong, fix the plan. If the executor is wrong, tighten the plan next time.

---

## Token math

Rough numbers from a real story in a production repo:

| Phase | Squad-kit context on turn 1 | Spec-Kit context on turn 1 |
|---|---|---|
| Plan generation | intake (~2 KB) + meta-prompt (~5 KB) + repo files the planner chooses to read | `spec.md` + `plan.md` template (~4 KB) + constitution (~2 KB) + `/plan` orchestration (~4 KB) + model-driven research |
| Implementation | the plan file (~5–15 KB), nothing else | `/implement` template (~13 KB) + `tasks.md` + `plan.md` + `data-model.md` + `contracts/` + `research.md` + `quickstart.md` |

The implementation delta is what matters: you run that loop dozens of times per feature. Five extra kilobytes of boilerplate loaded 40 times is 200 KB of wasted cache/tokens. Worse when you factor in that the cheap executor pays the same per-token rate as the expensive planner when those tokens sit in context.

---

## What makes a plan "concrete enough"?

Every task in a squad-kit plan meets this bar:

- A **file path** (or `Create file:`) so the executor knows exactly where to edit.
- A **symbol, line range, or regex** when the change is in-place.
- **Type signatures or DTOs** when adding new structures, in language-tagged code fences.
- A **verification command** at the end: what to run, what passing looks like.

Vague guidance ("consider introducing a service layer") does not belong here. That is a planning decision and belongs in the plan *before* it becomes a task.

---

## What squad-kit gives up

Spec-Kit's `/clarify` and `/analyze` catch planning mistakes before implementation. Squad-kit does not have those. The tradeoff:

- **You trust your planner.** If the planning model is weak, the plan is weak, and no squad-kit command saves you.
- **Planning is a single session, human-reviewed.** That review replaces `/clarify`.
- **Cross-artifact consistency is unnecessary** when there is only one artifact.

This is a deliberate choice, not an oversight. If you want safety nets, Spec-Kit is the right tool.

---

## Why Markdown prompts, not embedded logic

Squad-kit's default planning rules live in three Markdown files shipped **inside the npm package** (`templates/prompts/`). Your **project** conventions — verification commands, product rules, acceptance criteria — belong in intakes and plans under `.squad/stories/` and `.squad/plans/`, which you own and commit.
