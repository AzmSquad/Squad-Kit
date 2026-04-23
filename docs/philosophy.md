---
title: Philosophy — plan once, execute cheap
description: Why squad-kit splits planning from execution, and how the direct planner fits.
---

Spec-driven development with AI agents has two distinct phases that people conflate:

1. **Thinking.** Reading code, weighing tradeoffs, deciding what to change and why. This is expensive per token and benefits from the best model you have.
2. **Typing.** Applying the plan: edit files, run tests, fix typos, wire things up. This is verbose and repetitive. A weak model can do it — *if* the plan is concrete enough.

Squad-kit is built around the observation that most SDD tooling fails to separate these. Every "implement" turn reloads the planner-level context, reruns synthesis, and re-reads meta-artifacts the executor does not need. You pay top-tier tokens for typing work. Keeping those phases separate is the whole product thesis — see [Getting started](getting-started.md) for the concrete commands.

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

## Where the direct planner fits

The direct planner (`squad new-plan --api`) **does not violate** “plan once, execute cheap”:

- The expensive model still **plans once per story**. squad-kit is the **transport** (API calls, tool loop, file writer), not a second “thinker” in the loop.
- Context is **demand-driven**: the planner requests files through a **bounded** tool loop (`read_file`, `list_dir`) with a budget in config. There is no blind full-repo slurp.
- The output is still **one plan file** the executor session attaches — same contract as the in-agent path.
- The switch is about **shortening the path** from a reviewed intake to that plan on disk, not about adding another expensive planning pass.

| | In-agent (`/squad-plan`) | Direct (`squad new-plan --api`) |
| --- | --- | --- |
| Where planning happens | Inside the agent session you already use. | In the terminal, via the provider API. |
| Who feeds context | The agent (may over-read). | squad-kit (budget-enforced). |
| Credentials | Agent’s existing credentials. | `.squad/secrets.yaml` or a provider env var. |
| Best when | You already have a capable agent open. | You want one-shot CLI output without changing tools. |
| Cost shape | Same planner tier, agent overhead on top. | Same planner tier, no agent session overhead. |

In both cases the “expensive” work is a **single** planning pass per story. The direct path simply avoids an agent session and lets squad-kit enforce **read budgets** the agent might ignore. The executor step stays identical: it still ingests **one** `NN-story-*.md` and nothing else.

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

The in-agent and direct planner paths **share** the same bundled `generate-plan.md` rules; they differ only in **who** reads the repo and **how** reads are bounded. Neither path adds a second “planning pass” before execution — the implementation turn still starts from a single artefact.

Spec-Kit's `/clarify` and `/analyze` catch planning mistakes before implementation. Squad-kit does not have those. The tradeoff:

- **You trust your planner.** If the planning model is weak, the plan is weak, and no squad-kit command saves you.
- **Planning is a single session, human-reviewed.** That review replaces `/clarify`.
- **Cross-artifact consistency is unnecessary** when there is only one artifact.

This is a deliberate choice, not an oversight. If you want safety nets, Spec-Kit is the right tool. For a feature-level comparison, see [squad-kit vs Spec-Kit](vs-spec-kit.md).

---

## Why Markdown prompts, not embedded logic

Squad-kit's default planning rules live in three Markdown files shipped **inside the npm package** (`templates/prompts/`). Your **project** conventions — verification commands, product rules, acceptance criteria — belong in intakes and plans under `.squad/stories/` and `.squad/plans/`, which you own and commit.

A **fork** is the supported customisation path for changing those three files. The 0.1.x **`.squad/prompts/`** override was **removed in 0.2.0** because silent version drift between user copies and CLI behaviour was breaking workflows. The new contract: **the CLI you installed defines the prompts** — upgrade the package to pick up template changes, or maintain a fork.
