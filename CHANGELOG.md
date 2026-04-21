# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-21

First public release.

### Added

- `squad init` — scaffolds `.squad/` with `config.yaml`, prompt templates, and agent slash commands.
- `squad new-story <feature-slug>` — creates `.squad/stories/<feature>/<id>/intake.md` with `attachments/`.
- `squad new-plan <intake-path>` — composes the plan-generation meta-prompt inline with the intake, prints to stdout, and copies to clipboard.
- `squad status` — reports story / plan counts and next global `NN`.
- `squad list [--feature <slug>]` — table of stories and their plan state.
- `squad tracker link <story> <id>` — upserts a tracker id on an existing intake.
- Agent slash-command templates for **Claude Code**, **Cursor**, **GitHub Copilot**, and **Gemini CLI**.
- Tracker id validators for **GitHub**, **Linear**, **Jira**, and **Azure DevOps** (no API calls; format validation only).
- Plan-generation meta-prompt (`generate-plan.md`), intake template (`intake.md`), and plan skeleton reference (`story-skeleton.md`).
- Documentation: `docs/philosophy.md`, `docs/getting-started.md`, `docs/customization.md`, `docs/vs-spec-kit.md`.

[Unreleased]: https://github.com/AzmSquad/squad-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AzmSquad/squad-kit/releases/tag/v0.1.0
