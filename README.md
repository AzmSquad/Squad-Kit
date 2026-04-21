# squad-kit

[![npm version](https://img.shields.io/npm/v/squad-kit.svg)](https://www.npmjs.com/package/squad-kit)
[![CI](https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/AzmSquad/Squad-Kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Website](https://img.shields.io/badge/site-squad--kit.netlify.app-7cffa0?labelColor=0a0a0c)](https://squad-kit.netlify.app)

**Plan once, execute cheap.** A 3-step SDD-style workflow CLI for AI-assisted coding: **raw story → good plan → implementation**.

Website & docs: **[squad-kit.netlify.app](https://squad-kit.netlify.app)**


Your expensive model plans once. A cheap model executes many times. Squad-kit owns the folder conventions, the plan meta-prompt, and the agent slash-commands so the token cost goes where it pays off.

```
.squad/
├── prompts/                # meta-prompts you can edit
├── stories/<feature>/<id>/ # intake + attachments (one per story)
└── plans/<feature>/        # NN-story-<slug>.md (one per executable plan)
```

---

## Why not Spec-Kit?

Both aim at spec-driven development. They make different bets.

| | squad-kit | Spec-Kit |
|---|---|---|
| Commands | `init`, `new-story`, `new-plan`, `status`, `list`, `tracker link` | `constitution`, `specify`, `clarify`, `plan`, `tasks`, `analyze`, `checklist`, `implement` |
| `/implement` turn starts with | one plan file (~5–15 KB) | 5–7 command templates + cross-artifact reads (~15–25 KB) |
| Model-tier awareness | Built into the philosophy (planner ≠ executor) | Not prescribed |
| Generated artifacts per story | `intake.md`, `NN-story-<slug>.md`, overview row | `spec.md`, `plan.md`, `data-model.md`, `contracts/`, `research.md`, `quickstart.md`, `tasks.md` |
| Customization | Prompts live in your repo as plain Markdown. Edit freely. | Template override stack with presets/extensions |
| Runtime | Node + TypeScript, npm-distributable | Python + `uv` |
| Scope | Intentionally small | Broad, with safety nets (`clarify`, `analyze`) |

Spec-Kit ships safety rails. Squad-kit ships the cheap path and gets out of the way. Pick squad-kit when your planner already produces trustworthy plans; pick Spec-Kit when you want the process to catch planning mistakes for you.

See [`docs/philosophy.md`](docs/philosophy.md) for the token math and [`docs/vs-spec-kit.md`](docs/vs-spec-kit.md) for the full comparison.

---

## Install

```bash
npm install -g squad-kit
# or
pnpm add -g squad-kit
```

Requires Node 18+.

---

## Quickstart

In your project root:

```bash
squad init                        # interactive: tracker, agents, name
squad new-story auth --title "SSO support"
# → edit .squad/stories/auth/sso-support/intake.md (paste title, description, criteria)

# then, in your agent (Claude Code / Cursor / Copilot / Gemini):
/squad-plan .squad/stories/auth/sso-support/intake.md

# → produces .squad/plans/auth/01-story-sso-support.md

# implementation: new agent chat, attach ONLY the plan file.
# a cheap model can execute it end-to-end.
```

No slash commands in your agent? Pipe the prompt directly:

```bash
squad new-plan .squad/stories/auth/sso-support/intake.md   # prints to stdout, copies to clipboard
```

---

## Commands

| Command | What it does |
|---|---|
| `squad init` | Bootstrap `.squad/` with prompts, config, and agent slash-commands |
| `squad new-story <feature> [--id ID] [--title ...]` | Scaffold a story intake folder |
| `squad new-plan <intake-path>` | Compose the plan-generation meta-prompt with the intake inlined; print to stdout + copy to clipboard |
| `squad status` | Count stories/plans, show next global `NN`, warn on duplicates |
| `squad list [--feature <slug>]` | Table of stories + their plan state |
| `squad tracker link <story> <id>` | Attach or update a tracker id on an intake |

---

## Agent integration

At `squad init` you pick which agents get native slash commands. Supported:

- **Claude Code** → `.claude/commands/squad-plan.md`, `.claude/commands/squad-new-story.md`
- **Cursor** → `.cursor/commands/squad-*.md`
- **GitHub Copilot** → `.github/prompts/squad-plan.prompt.md`
- **Gemini CLI** → `.gemini/commands/squad-plan.toml`

Unsupported agents work fine too — `squad new-plan` prints the composed prompt on stdout.

---

## Trackers

Optional. Configure in `.squad/config.yaml`:

```yaml
tracker:
  type: linear     # none | github | linear | jira | azure
naming:
  includeTrackerId: true
  globalSequence: true
```

`--id` on `new-story` is validated against the tracker's id format (e.g. `ENG-42` for Linear, `843806` for Azure). No API calls in v0.1.

---

## What's *not* in v0.1

We ship lean on purpose. Current non-goals:

- Direct Anthropic/OpenAI API invocation (cost stays with your agent subscription)
- MCP server
- `/clarify`, `/analyze`, constitution-equivalent
- Tracker API calls (id validation only)
- Telemetry

Open to revisiting these for v0.2 based on usage.

---

## Tradeoffs to know

- **Quality depends on the planning model.** squad-kit has no safety-net commands. Use a strong model for `new-plan`.
- **Plans are project-coupled.** They reference real file paths. That is the point — do not expect portability between projects.
- **Global `NN` can collide on parallel branches.** Rebase-and-renumber is the resolution. Documented in [`docs/customization.md`](docs/customization.md).

---

## License

MIT. Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
