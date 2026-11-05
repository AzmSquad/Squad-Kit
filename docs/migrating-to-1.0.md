---
title: Moving to 1.0
description: Bring a squad-kit 0.x project, or a board from an early 1.0 build, to squad-kit 1.0. What stays, what moves, and what is new.
slug: migrating-to-1.0
---

squad-kit 1.0 is a new way of working. In 0.x you wrote a story and squad-kit wrote a plan for your AI tool. In
1.0 a squad of AI agents takes a ticket from a plain-words ask all the way to a release, on a board in one app.

Moving is one step: open the project in 1.0. squad-kit does the rest, once, and prints what it did. This page
says what happens, so nothing surprises you.

- [From squad-kit 0.x](#from-squad-kit-0x): a project with `.squad/stories/` and `.squad/plans/`.
- [From an early 1.0 board](#from-an-early-10-board): a project with a `.squad/board/board.yaml` file. Only this kind
  is moved, and only this kind gets a backup copy.

## Before you start

1. Install 1.0:

   ```bash
   npm i -g squad-kit
   ```

2. Check that you have **Node.js** 22 or newer, **git**, and an **AI tool** installed and signed in. Today the
   squad runs on **Claude Code**. Run `claude` once and sign in, if you have not already.

## From squad-kit 0.x

### What you do

Open a terminal in the project folder and run:

```bash
squad console
```

Or run `squad`, press **Add project** on Home and pick the project's folder. Both do the same.

The terminal shows each thing squad-kit did, for example:

```
✓ Git: found the repo, on main
✓ Sign-ins: moved out of .squad, to this computer only
✓ Board: ready, with rules for the five roles; tickets are named OL-1, OL-2
✓ AI tools: Claude Code ready, Codex not installed
```

Then a setup page opens with live steps while the Architect reads the project for a few minutes, and the
**Overview** shows you what it understood.

squad-kit adds its own files beside your old ones, in the same `.squad/` folder. It makes no backup copy for a 0.x
project: it only adds files, adds one section to `config.yaml` and moves `secrets.yaml`. **Your stories and plans do
not become tickets.** They stay where they are, and you start new work on the board.

### What stays

- **`.squad/stories/` and `.squad/plans/`** stay exactly as they are. The board leaves them untouched.
- **`.squad/config.yaml`** stays. Your project name and your **tracker settings** stay in it, and the board
  uses them. squad-kit adds one new section, `board:`, with the project's id and the board's settings.
- **Your own files in `.squad/`** stay. One small case: the board writes `knowledge/project.md`, `lessons.md`
  and `stack.md`. If you already had files with those names, squad-kit keeps them as
  `project.before-squad-kit.md` and so on, and tells you.
- **The 0.x commands** (`squad new-story`, `squad new-plan`, `squad list`, `squad auth`, `squad config`,
  `squad doctor`) still ship and still work on your stories and plans.
- **Nothing is moved into a new layout.** A `.squad/board/` folder without a `board.yaml` file in it is left as it is
  too.

### What moves

- **Sign-ins move to this computer.** In 0.x, tokens and keys were in `.squad/secrets.yaml`. In 1.0 they live in
  `~/.squad-kit/projects/<id>/secrets.yaml`, which only you can read. The old file is removed from the project
  folder. The 0.x commands find your keys in the new place.

That is the only thing that moves. Each person keeps their own sign-ins on their own computer, so a teammate
enters their own token once in Settings.

### What is new

- **The board and the squad.** Tickets, questions, spec, design, build, checks, review, proof and release, with
  you in control through **Waiting for you**. Start with [Getting started](getting-started.md).
- **New folders in `.squad/`**: `rules/` now, and `tickets/`, `decisions/`, `releases/` and `knowledge/` as you
  work. They hold the project's memory, in Markdown.
- **This computer's folder, `~/.squad-kit/`**: live progress, agent chats, screenshots, sign-ins and cost.
- **Git stays quiet.** squad-kit adds `.squad/` to the repo's local ignore list (`.git/info/exclude`). That file
  is never committed, and your `.gitignore` is not changed. squad-kit commits each ticket's documents itself,
  on the ticket's branch.

### If you committed `.squad/` in 0.x

0.x told you to commit `.squad/config.yaml`, and you may have committed `stories/` and `plans/` too. Those
files stay in git as they were.

After the first open, `git status` shows `.squad/config.yaml` as changed. That is expected: it gained the
`board:` section. squad-kit commits it with your next release. You can also commit it yourself now.

### Trackers

- **Azure DevOps** settings from 0.x work right away for the whole loop: pull work items, move them along,
  post comments, close items on release, and, when the code is on Azure Repos, open and merge pull requests.
  The token that moved keeps working. To change it, use **Settings → Azure DevOps**.
- **Jira and GitHub** settings from 0.x stay in `config.yaml`. In 1.0 they can still bring in one item at a time
  with `squad pull <id>`. Moving items along, comments and pull requests work with Azure DevOps only today.

## From an early 1.0 board

The first 1.0 builds kept the whole board in `.squad/board/`, with its settings in `.squad/board/board.yaml`: specs
and decisions next to live progress, agent chats, screenshots and tokens. 1.0 splits these into two homes:

- the **project's memory** in `.squad/`
- **this computer's part** in `~/.squad-kit/projects/<id>/`

### What you do

Close the old board if it still runs (Ctrl-C in its terminal). Then open the project in 1.0, the same way as
above: `squad console` in its folder, or **Add project** on Home.

squad-kit moves the board once, and prints:

```
✓ Moved this board to the new layout: 11 tickets, 5 decisions and 4 releases, all checked.
✓ The project's files are in .squad/; this computer's are in ~/.squad-kit/projects/<id>. A copy of the old files: ~/.squad-kit/backups/<folder>-<date and time>
```

### How the move works

1. **A backup first.** squad-kit copies the whole `.squad/` folder to `~/.squad-kit/backups/<folder>-<date and
   time>/` before it changes anything.
2. **The move.** Each file goes to its new home:

   | Before, in `.squad/board/` | After |
   | --- | --- |
   | `board.yaml` | the project's part in `.squad/config.yaml` (under `board:`); the project map, lessons and stack in `.squad/knowledge/`; this computer's part in `~/.squad-kit/projects/<id>/` |
   | `tickets/<ID>.yaml` | `.squad/tickets/<ID>/` as Markdown documents, plus live progress on this computer |
   | `decisions/`, `releases/` | `.squad/decisions/`, `.squad/releases/` as Markdown |
   | `agents/*.md` (house rules) | `.squad/rules/` |
   | `context/wiki/` | `.squad/knowledge/wiki/` |
   | `attachments/` | the ticket's folder (`files/` and `mockup.html`); voice and video notes stay on this computer |
   | `proof/` (screenshots) | `~/.squad-kit/projects/<id>/proof/` |
   | `sessions/` (agent chats) | `~/.squad-kit/projects/<id>/chats/` |
   | `.squad/secrets.yaml` | `~/.squad-kit/projects/<id>/secrets.yaml` |

3. **A check.** Every ticket, decision and release is read back from the new files and compared with the old
   one, field by field.
4. **Done.** Only when everything matches does squad-kit remove `.squad/board/`. The backup stays.

### What stays the same

- **Names.** Existing tickets and decisions keep their names, so branches, pull requests and links keep
  working. New tickets get the tracker's name (like `AB-80`), and new decisions are named after their ticket
  (like `AB-80.1`).
- **Work in progress.** A ticket in the middle of building carries on from where it was.
- **Git.** If `.squad/` sits outside your code repos (a folder with several repos), nothing goes into git, as
  before. If it sits inside your one repo, squad-kit keeps it out of your `git status` and commits each
  ticket's documents on the ticket's branch from now on. If you had committed `.squad/board/` yourself,
  `git status` now shows those files as deleted. That is expected: commit the deletion. The backup has a copy.

### If the move refuses because a board is running

squad-kit moves files only while nothing runs. If the old board is still open somewhere, you see:

```
This board is open somewhere else. Close it first (or run: squad console --restart): squad-kit moves its files
to the new layout once, while nothing runs.
```

Or, from `squad console`: "This project's board is already open."

Do one of these:

- Go to the terminal where the old board runs and press Ctrl-C. Then run `squad console` again.
- Or run `squad console --restart` in the project folder. It stops the old board, moves the files and opens the
  project in the app.

Running work is not lost. The squad picks up where it stopped.

### If the check fails

If the new files would not match the old ones, squad-kit puts everything back the way it was and stops. The
message starts with "The new files did not match the old ones, so nothing changed" and names what differed.
Your old board is untouched, and the backup is there too. Please report the message as an issue, so it can be
fixed.

## Where things are now

| What | Where |
| --- | --- |
| Settings, tickets, decisions, releases, rules, knowledge | `.squad/` in the project folder |
| Live progress, agent chats, screenshots, voice notes, sign-ins, cost | `~/.squad-kit/projects/<id>/` |
| The squad's copies of the code, one per ticket | `~/.squad-kit/worktrees/` |
| Your settings: tickets at once, your own model choices | `~/.squad-kit/settings.yaml` |
| The app's list of projects | `~/.squad-kit/projects.json` |
| Backups made by moving an early 1.0 board | `~/.squad-kit/backups/` |
| 0.x stories and plans | `.squad/stories/`, `.squad/plans/`, unchanged |

The project's id in `config.yaml` links the two homes. If you move the project folder, or clone it on a
computer that had it before, squad-kit finds this computer's files again by that id.
